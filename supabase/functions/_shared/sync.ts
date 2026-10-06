// Bringing the local mirror in line with Clover.
import { type CloverApi, openClover } from "./clover/auth.ts";
import { CloverError } from "./clover/errors.ts";
import { fetchInventory, getItem, getModifierGroup, listCategories } from "./clover/inventory.ts";
import { buildSyncPayload, normalizeCategory, normalizeItem, normalizeModifierGroup } from "./clover/normalize.ts";
import { errorFields } from "./log.ts";
import type { Deps } from "./types.ts";

export type SyncTrigger = "manual" | "webhook" | "stale" | "connect";

export type SyncResult =
  | { status: "succeeded"; stats: Record<string, number> }
  | { status: "failed"; error_code: string }
  | { status: "busy" }
  | { status: "not_connected" };

const SYNC_LOCK_SECONDS = 120;

// Full sync: reads the merchant's whole inventory and applies it. One run at a time per
// restaurant, enforced by a database lock that expires on its own if a run dies.
export async function runSync(deps: Deps, restaurantId: string, trigger: SyncTrigger): Promise<SyncResult> {
  const runId = await deps.db.rpc<string | null>("sync_claim", {
    p_restaurant: restaurantId,
    p_trigger: trigger,
    p_lock_seconds: SYNC_LOCK_SECONDS,
  });
  if (!runId) {
    const status = await deps.db.rpc<{ connected: boolean; status: string }>("clover_connection_status", {
      p_restaurant: restaurantId,
    });
    return status.connected && status.status === "active" ? { status: "busy" } : { status: "not_connected" };
  }

  const correlationId = crypto.randomUUID();
  try {
    const api = await openClover(deps, restaurantId, correlationId);
    const { payload, skipped } = buildSyncPayload(await fetchInventory(api));
    const stats = await deps.db.rpc<Record<string, number>>("menu_apply_sync", {
      p_restaurant: restaurantId,
      p_payload: payload,
      p_full: true,
    });
    const result = { ...stats, skipped };
    await deps.db.rpc("sync_finish", {
      p_run: runId, p_status: "succeeded", p_stats: result, p_error_code: null, p_error_message: null,
    });
    deps.log.info("menu_sync_succeeded", { restaurant_id: restaurantId, trigger, correlation_id: correlationId, ...result });
    return { status: "succeeded", stats: result };
  } catch (error) {
    const code = error instanceof CloverError ? `clover_${error.kind}` : "internal_error";
    deps.log.error("menu_sync_failed", {
      restaurant_id: restaurantId, trigger, correlation_id: correlationId, ...errorFields(error),
    });
    await deps.db.rpc("sync_finish", {
      p_run: runId,
      p_status: "failed",
      p_stats: null,
      p_error_code: code,
      p_error_message: error instanceof Error ? error.message : "Unknown error",
    }).catch(() => {});
    await deps.db.rpc("log_integration", {
      p_restaurant: restaurantId, p_level: "error", p_event: "menu_sync_failed",
      p_correlation: correlationId, p_details: { trigger, code },
    }).catch(() => {});
    return { status: "failed", error_code: code };
  }
}

const applyPartial = (deps: Deps, restaurantId: string, payload: Record<string, unknown>) =>
  deps.db.rpc("menu_apply_sync", { p_restaurant: restaurantId, p_payload: payload, p_full: false });

// Re-reads one item from Clover and writes what Clover says into the mirror. Returns the
// raw Clover item, or null when Clover no longer has it.
export async function refreshItem(deps: Deps, api: CloverApi, restaurantId: string, itemId: string): Promise<unknown> {
  let raw: unknown;
  try {
    raw = await getItem(api, itemId);
  } catch (error) {
    if (error instanceof CloverError && error.kind === "not_found") {
      await applyPartial(deps, restaurantId, { removed_item_ids: [itemId] });
      return null;
    }
    throw error;
  }
  await applyRawItems(deps, restaurantId, [raw], true);
  return raw;
}

// `expanded` says whether the raw items carry their category and modifier-group lists. When
// they do not, links in the mirror are left untouched.
export async function applyRawItems(deps: Deps, restaurantId: string, rawItems: unknown[], expanded: boolean) {
  const items = rawItems
    .map((raw) => normalizeItem(raw, { categories: expanded, modifierGroups: expanded }))
    .filter((item) => item !== null);
  if (items.length > 0) await applyPartial(deps, restaurantId, { items });
  return items;
}

export async function refreshCategories(deps: Deps, api: CloverApi, restaurantId: string): Promise<unknown[]> {
  const raw = await listCategories(api);
  const categories = raw.map(normalizeCategory).filter((category) => category !== null);
  if (categories.length > 0) await applyPartial(deps, restaurantId, { categories });
  return raw;
}

export async function refreshModifierGroup(deps: Deps, api: CloverApi, restaurantId: string, groupId: string) {
  const raw = await getModifierGroup(api, groupId);
  const group = normalizeModifierGroup(raw);
  if (group) {
    await applyPartial(deps, restaurantId, { modifier_groups: [{ ...group, modifiers: group.modifiers ?? [] }] });
  }
  return raw;
}
