// GET /public-site?restaurant=<slug>
//
// Which photos the website shows where the owner has chosen their own in the dashboard:
// the home page's hero photo, the "our story" photo, the gallery. A slot nobody has set is
// null (the gallery: an empty list), and the page keeps the photo it was built with.
//
// Unlike the menu, this answers whether or not Clover has ever been connected: the photos
// are the website's own.
import { sha256Hex } from "../crypto.ts";
import { clientIp, corsHeaders, json, preflight } from "../http.ts";
import { errorFields } from "../log.ts";
import type { Deps } from "../types.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;
const MAX_REQUESTS_PER_MINUTE = 120;

export interface StoredPhoto {
  id?: string;
  path: string;
  small_path: string | null;
  width: number | null;
  height: number | null;
  small_width: number | null;
  alt: string;
  updated_at?: string;
}

export interface StoredPhotos {
  hero: StoredPhoto | null;
  story: StoredPhoto | null;
  gallery: StoredPhoto[];
}

// A photo as a browser needs it: addresses instead of storage paths, and a `srcset` when
// there is a smaller file for phones.
export function photoForBrowser(photo: StoredPhoto, storagePublicBase: string, fallbackAlt: string) {
  const src = `${storagePublicBase}/${photo.path}`;
  const small = photo.small_path && photo.small_width && photo.width
    ? `${storagePublicBase}/${photo.small_path} ${photo.small_width}w, ${src} ${photo.width}w`
    : null;
  return {
    ...(photo.id ? { id: photo.id } : {}),
    src,
    srcset: small,
    width: photo.width,
    height: photo.height,
    // A photo is never left without a description: a link whose only content is a photo
    // would have no name at all.
    alt: photo.alt.trim() || fallbackAlt,
  };
}

export function photosForBrowser(photos: StoredPhotos, storagePublicBase: string, restaurantName: string) {
  const one = (photo: StoredPhoto | null) => (photo ? photoForBrowser(photo, storagePublicBase, `Photo from ${restaurantName}`) : null);
  return { hero: one(photos.hero), story: one(photos.story), gallery: photos.gallery.map((photo) => one(photo)) };
}

export async function handlePublicSite(request: Request, deps: Deps, storagePublicBase: string): Promise<Response> {
  const cors = corsHeaders(request, deps.env, "GET, OPTIONS");
  if (request.method === "OPTIONS") return preflight(request, deps.env, "GET, OPTIONS");
  // Every failure says the same: the page then simply keeps the photos it was built with.
  const fail = (status: number, code: string, headers: Record<string, string> = {}) =>
    json(status, { error: { code, message: "Not available." } }, { ...cors, ...headers });

  if (request.method !== "GET") return fail(405, "method_not_allowed");

  try {
    const slug = new URL(request.url).searchParams.get("restaurant") ?? "";
    if (!SLUG.test(slug)) return fail(404, "not_found");

    const ipHash = await sha256Hex(`${deps.env.ipHashSalt}:${clientIp(request)}`);
    const allowed = await deps.db.rpc<boolean>("rate_limit_hit", {
      p_key: `site:${ipHash}`, p_max: MAX_REQUESTS_PER_MINUTE, p_window_seconds: 60,
    });
    if (!allowed) return fail(429, "rate_limited", { "retry-after": "30" });

    const restaurant = await deps.db.rpc<{ id: string; name: string } | null>("restaurant_public", { p_slug: slug });
    if (!restaurant) return fail(404, "not_found");

    const photos = await deps.db.rpc<StoredPhotos>("site_photos_for", { p_restaurant: restaurant.id, p_with_id: false });
    return json(200, { version: 1, photos: photosForBrowser(photos, storagePublicBase, restaurant.name) }, {
      ...cors,
      // Reused for a minute, so a photo changed in the dashboard is on the website within
      // about a minute.
      "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
    });
  } catch (error) {
    deps.log.error("public_site_failed", errorFields(error));
    return fail(503, "unavailable", { "retry-after": "30" });
  }
}
