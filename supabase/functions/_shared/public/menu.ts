// GET /public-menu?restaurant=<slug>
// The only runtime data the public website loads. Served from the local mirror, so the
// page stays up when Clover is down. Contains nothing that is not meant for customers.
import { sha256Hex } from "../crypto.ts";
import { clientIp, corsHeaders, json, preflight } from "../http.ts";
import { errorFields } from "../log.ts";
import { runSync } from "../sync.ts";
import type { Deps } from "../types.ts";
import { upkeep } from "./retention.ts";

const UNAVAILABLE = "Menu temporarily unavailable. Please try again shortly.";
const SLUG = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;
const MAX_REQUESTS_PER_MINUTE = 120;

interface PublicItem {
  image_path?: string | null;
  image_url?: string | null;
  [key: string]: unknown;
}

export async function handlePublicMenu(request: Request, deps: Deps, storagePublicBase: string): Promise<Response> {
  const cors = corsHeaders(request, deps.env, "GET, OPTIONS");
  if (request.method === "OPTIONS") return preflight(request, deps.env, "GET, OPTIONS");
  const fail = (status: number, code: string, headers: Record<string, string> = {}) =>
    json(status, { error: { code, message: UNAVAILABLE } }, { ...cors, ...headers });

  if (request.method !== "GET") return fail(405, "method_not_allowed");

  try {
    const slug = new URL(request.url).searchParams.get("restaurant") ?? "";
    if (!SLUG.test(slug)) return fail(404, "menu_unavailable");

    // This endpoint is open to the internet and each call costs database reads. A browser
    // caches the answer for a minute, so a real visitor makes a handful of calls; the limit
    // is far above that, and high enough for a whole dining room behind one wifi address.
    const ipHash = await sha256Hex(`${deps.env.ipHashSalt}:${clientIp(request)}`);
    const allowed = await deps.db.rpc<boolean>("rate_limit_hit", {
      p_key: `menu:${ipHash}`, p_max: MAX_REQUESTS_PER_MINUTE, p_window_seconds: 60,
    });
    if (!allowed) return fail(429, "rate_limited", { "retry-after": "30" });

    const restaurant = await deps.db.rpc<{ id: string; name: string; currency: string } | null>(
      "restaurant_public", { p_slug: slug });
    if (!restaurant) return fail(404, "menu_unavailable");

    const menu = await deps.db.rpc<{
      synced_at: string | null;
      categories: { id: string; name: string; image_path?: string | null; items: PublicItem[] }[];
      uncategorized: PublicItem[];
    }>("public_menu", { p_restaurant: restaurant.id });

    // Stale-while-revalidate: answer from the mirror now, refresh from Clover after the
    // response is sent. The database lock inside runSync prevents a stampede.
    const due = await deps.db.rpc<boolean>("sync_due", {
      p_restaurant: restaurant.id, p_ttl_seconds: deps.env.menuSyncTtlSeconds,
    });
    if (due) deps.waitUntil(runSync(deps, restaurant.id, "stale"));
    // The hourly chores (see retention.ts), on the back of a page that visitors open.
    deps.waitUntil(upkeep(deps));

    if (menu.synced_at === null && menu.categories.length === 0 && menu.uncategorized.length === 0) {
      // Never synced: there is no menu to show yet.
      return fail(503, "menu_unavailable", { "retry-after": "30" });
    }

    const withUrl = (item: PublicItem) => {
      const { image_path, ...rest } = item;
      return { ...rest, image_url: image_path ? `${storagePublicBase}/${image_path}` : null };
    };
    // A category carries the photo the owner chose for it, as an address; null when none
    // was chosen and the page picks one itself. Never the path inside the bucket.
    const categories = menu.categories.map(({ image_path, ...category }) => ({
      ...category,
      image_url: image_path ? `${storagePublicBase}/${image_path}` : null,
      items: category.items.map(withUrl),
    }));
    if (menu.uncategorized.length > 0) {
      categories.push({ id: "more", name: "More", image_url: null, items: menu.uncategorized.map(withUrl) });
    }

    return json(200, {
      version: 1,
      currency: restaurant.currency,
      synced_at: menu.synced_at,
      categories,
    }, {
      ...cors,
      // Browsers and the CDN may reuse this for a minute; item availability changes are
      // therefore visible within about a minute of the mirror updating.
      "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
    });
  } catch (error) {
    deps.log.error("public_menu_failed", errorFields(error));
    return fail(503, "menu_unavailable", { "retry-after": "30" });
  }
}
