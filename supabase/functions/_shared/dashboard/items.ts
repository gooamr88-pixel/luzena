// Item management. Clover-owned fields are written to Clover first and mirrored only after
// Clover accepts them. Website-owned fields are written to this system's database.
import { type CloverApi, openClover } from "../clover/auth.ts";
import { MAX_CONCURRENT_PER_TOKEN } from "../clover/config.ts";
import { CloverError } from "../clover/errors.ts";
import { createItem, findItemsByName, getItem, setItemAssociations, updateItem } from "../clover/inventory.ts";
import { normalizeItem } from "../clover/normalize.ts";
import { ApiError, json } from "../http.ts";
import { applyRawItems, refreshItem } from "../sync.ts";
import type { Deps, Session } from "../types.ts";
import { cloverId, parseBody, uuid, v } from "../validate.ts";
import { assertLabelsOwned, MAX_LABELS_PER_ITEM, setItemLabels } from "./labels.ts";
import { assertOwned, audit, cloverApiError, idempotent, sameSet } from "./session.ts";

export const DIETARY_TAGS = ["vegetarian", "vegan", "gluten-free", "dairy-free", "nut-free", "halal", "spicy"] as const;

const idList = v.array(cloverId, { max: 50, unique: true });
const cloverShape = {
  name: v.optional(v.string({ min: 1, max: 127 })),
  price_cents: v.optional(v.int({ min: 0, max: 99_999_999 })),
  available: v.optional(v.bool()),
  hidden: v.optional(v.bool()),
  category_ids: v.optional(idList),
  modifier_group_ids: v.optional(idList),
};
const websiteSchema = v.object({
  description: v.optional(v.nullable(v.string({ max: 600 }))),
  featured: v.optional(v.bool()),
  web_hidden: v.optional(v.bool()),
  dietary: v.optional(v.array(v.oneOf(DIETARY_TAGS), { max: DIETARY_TAGS.length, unique: true })),
  // The restaurant's own labels on this dish (see labels.ts): exactly these, by id.
  label_ids: v.optional(v.array(uuid, { max: MAX_LABELS_PER_ITEM, unique: true })),
  archived: v.optional(v.bool()),
});
const updateSchema = v.object({
  clover: v.optional(v.object(cloverShape)),
  // The values the editor loaded for the Clover fields being changed. Used only to detect
  // that Clover changed underneath the owner; it grants nothing.
  expected: v.optional(v.object(cloverShape)),
  website: v.optional(websiteSchema),
});
const createSchema = v.object({
  clover: v.object({
    ...cloverShape,
    name: v.string({ min: 1, max: 127 }),
    price_cents: v.int({ min: 0, max: 99_999_999 }),
  }),
  website: v.optional(websiteSchema),
});
const bulkSchema = v.object({
  ids: v.array(cloverId, { min: 1, max: 200, unique: true }),
  action: v.oneOf(["show", "hide", "archive", "restore", "feature", "unfeature", "available", "unavailable"]),
});

interface CloverPatch {
  name?: string;
  price_cents?: number;
  available?: boolean;
  hidden?: boolean;
  category_ids?: string[];
  modifier_group_ids?: string[];
}

interface CloverState {
  name: string;
  price_cents: number | null;
  available: boolean;
  hidden: boolean;
  category_ids: string[];
  modifier_group_ids: string[];
}

const SCALARS = ["name", "price_cents", "available", "hidden"] as const;
const LISTS = ["category_ids", "modifier_group_ids"] as const;

function stateOf(raw: unknown): CloverState {
  const item = normalizeItem(raw, { categories: true, modifierGroups: true });
  if (!item) throw new CloverError("invalid_response", "Clover returned an item this system could not read");
  return {
    name: item.name,
    price_cents: item.price_cents,
    available: item.available,
    hidden: item.hidden,
    category_ids: item.category_ids ?? [],
    modifier_group_ids: item.modifier_group_ids ?? [],
  };
}

const sameValue = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? sameSet(a as string[], b as string[]) : a === b;

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;

const loadItem = (deps: Deps, session: Session, itemId: string) =>
  deps.db.rpc<Record<string, unknown> | null>("dash_get_item", { p_restaurant: restaurantOf(session), p_item: itemId });

// One unit of work against Clover, with a way to tell from a fresh read whether it took
// effect. `satisfied` is what resolves a timeout into a definite answer.
interface Step {
  part: "details" | "categories" | "modifiers";
  run(): Promise<unknown>;
  satisfied(state: CloverState): boolean;
}

function buildSteps(api: CloverApi, itemId: string, patch: CloverPatch, actual: CloverState): Step[] {
  const steps: Step[] = [];
  const changed = SCALARS.filter((key) => patch[key] !== undefined && patch[key] !== actual[key]);
  if (changed.length > 0) {
    const fields = {
      ...(changed.includes("name") ? { name: patch.name } : {}),
      ...(changed.includes("price_cents") ? { price: patch.price_cents } : {}),
      ...(changed.includes("available") ? { available: patch.available } : {}),
      ...(changed.includes("hidden") ? { hidden: patch.hidden } : {}),
    };
    steps.push({
      part: "details",
      run: () => updateItem(api, itemId, fields),
      satisfied: (state) => changed.every((key) => state[key] === patch[key]),
    });
  }
  const categories = patch.category_ids;
  if (categories && !sameSet(categories, actual.category_ids)) {
    steps.push({
      part: "categories",
      run: () => setItemAssociations(api, "category_items", itemId, actual.category_ids, categories),
      satisfied: (state) => sameSet(state.category_ids, categories),
    });
  }
  const groups = patch.modifier_group_ids;
  if (groups && !sameSet(groups, actual.modifier_group_ids)) {
    steps.push({
      part: "modifiers",
      run: () => setItemAssociations(api, "item_modifier_groups", itemId, actual.modifier_group_ids, groups),
      satisfied: (state) => sameSet(state.modifier_group_ids, groups),
    });
  }
  return steps;
}

interface StepOutcome {
  cloverChanged: boolean | "unknown";
  failedParts: string[];
  error: unknown;
}

// Runs the steps in order and stops at the first one that did not take effect. When a step
// ends without a clear answer (timeout, dropped connection, 5xx) the item is read back
// from Clover to find out what actually happened.
async function runSteps(api: CloverApi, itemId: string, steps: Step[]): Promise<StepOutcome> {
  let cloverChanged: boolean | "unknown" = false;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    try {
      await step.run();
      cloverChanged = true;
    } catch (error) {
      if (error instanceof CloverError && error.outcomeUnknown) {
        try {
          if (step.satisfied(stateOf(await getItem(api, itemId)))) {
            cloverChanged = true;
            continue;
          }
        } catch {
          if (cloverChanged === false) cloverChanged = "unknown";
        }
      }
      return { cloverChanged, failedParts: steps.slice(index).map((s) => s.part), error };
    }
  }
  return { cloverChanged, failedParts: [], error: null };
}

const PART_LABEL: Record<string, string> = {
  details: "name, price or availability",
  categories: "category assignment",
  modifiers: "modifier groups",
};

function partialMessage(failedParts: string[]) {
  const parts = failedParts.map((part) => PART_LABEL[part] ?? part).join(", ");
  return `Clover saved part of this change. Not saved: ${parts}. Review the item and try again.`;
}

const hasKeys = (value: object | undefined) => value !== undefined && Object.keys(value).length > 0;

export async function listItems(deps: Deps, session: Session, url: URL): Promise<Response> {
  const q = url.searchParams;
  const pick = <T extends string>(name: string, allowed: readonly T[]) => {
    const value = q.get(name);
    if (value === null || value === "") return undefined;
    if (!(allowed as readonly string[]).includes(value)) {
      throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { [name]: "is not valid" } });
    }
    return value as T;
  };
  const int = (name: string, fallback: number, max: number) => {
    const raw = q.get(name);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { [name]: "is not valid" } });
    }
    return value;
  };
  const category = q.get("category") ?? "";
  if (category !== "" && category !== "none" && !/^[A-Z0-9]{13}$/.test(category)) {
    throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { category: "is not valid" } });
  }

  const filters = {
    search: (q.get("search") ?? "").slice(0, 100),
    category,
    availability: pick("availability", ["available", "unavailable"]),
    visibility: pick("visibility", ["visible", "hidden"]),
    status: pick("status", ["active", "archived", "removed", "all"]),
    featured: pick("featured", ["true", "false"]),
    sort: pick("sort", ["name", "price", "updated", "category", "custom"]),
    dir: pick("dir", ["asc", "desc"]),
    limit: int("limit", 25, 100),
    offset: int("offset", 0, 1_000_000),
  };
  return json(200, await deps.db.rpc("dash_list_items", { p_restaurant: restaurantOf(session), p_filters: filters }));
}

export async function getItemDetail(deps: Deps, session: Session, itemId: string): Promise<Response> {
  const item = await loadItem(deps, session, itemId);
  if (!item) throw new ApiError(404, "not_found", "This item does not exist.");
  return json(200, { item });
}

export async function updateItemHandler(deps: Deps, session: Session, itemId: string, body: unknown): Promise<Response> {
  const input = parseBody(updateSchema, body);
  const patch: CloverPatch = input.clover ?? {};
  const expected: CloverPatch = input.expected ?? {};
  const touchesClover = hasKeys(patch);
  const touchesWebsite = hasKeys(input.website);
  if (!touchesClover && !touchesWebsite) {
    throw new ApiError(422, "validation_failed", "There is nothing to save.");
  }
  for (const key of [...SCALARS, ...LISTS]) {
    if (patch[key] !== undefined && expected[key] === undefined) {
      throw new ApiError(422, "validation_failed", "Some fields need attention.", {
        fields: { [`expected.${key}`]: "is required when this field is changed" },
      });
    }
  }

  const before = await loadItem(deps, session, itemId);
  if (!before) throw new ApiError(404, "not_found", "This item does not exist.");
  if (touchesClover && before.removed_from_clover) {
    throw new ApiError(409, "removed_in_clover", "This item no longer exists in Clover, so it cannot be edited.");
  }
  await assertOwned(deps, session, "category", patch.category_ids, "clover.category_ids");
  await assertOwned(deps, session, "modifier_group", patch.modifier_group_ids, "clover.modifier_group_ids");
  // Before anything is written: a label that does not exist must not be found out after
  // Clover and the website have already been changed.
  await assertLabelsOwned(deps, session, input.website?.label_ids);

  const restaurantId = restaurantOf(session);
  const base = { action: "ITEM_UPDATED", entityType: "item", entityId: itemId };
  let outcome: StepOutcome = { cloverChanged: false, failedParts: [], error: null };

  if (touchesClover) {
    let api: CloverApi;
    let actual: CloverState;
    try {
      api = await openClover(deps, restaurantId, session.requestId);
      const raw = await refreshItem(deps, api, restaurantId, itemId);
      if (raw === null) {
        throw new ApiError(409, "removed_in_clover", "This item was deleted in Clover.", {
          clover_changed: false, local_changed: false,
        });
      }
      actual = stateOf(raw);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      await audit(deps, session, { ...base, newValues: patch, result: "failed", syncStatus: "FAILED" });
      throw cloverApiError(error, { cloverChanged: false, localChanged: false });
    }

    // Field-level conflict check: if Clover's current value differs from what the editor
    // loaded, someone changed it in Clover. Nothing is written; the owner decides.
    const conflicts: Record<string, { expected: unknown; actual: unknown }> = {};
    for (const key of [...SCALARS, ...LISTS]) {
      if (patch[key] !== undefined && !sameValue(expected[key], actual[key])) {
        conflicts[key] = { expected: expected[key], actual: actual[key] };
      }
    }
    if (Object.keys(conflicts).length > 0) {
      await audit(deps, session, { ...base, newValues: patch, result: "conflict", syncStatus: "CONFLICT" });
      throw new ApiError(409, "conflict", "This item was changed in Clover after you opened it. Review the current values and save again.", {
        conflicts, item: await loadItem(deps, session, itemId), clover_changed: false, local_changed: false,
      });
    }

    outcome = await runSteps(api, itemId, buildSteps(api, itemId, patch, actual));
    if (outcome.cloverChanged !== false) {
      // Mirror whatever Clover now holds, including after a partial failure.
      await refreshItem(deps, api, restaurantId, itemId).catch((error) =>
        deps.log.error("mirror_refresh_failed", { item_id: itemId, error_message: String(error) })
      );
    }
    if (outcome.failedParts.length > 0 && outcome.cloverChanged !== true) {
      await audit(deps, session, { ...base, newValues: patch, result: "failed", syncStatus: "FAILED" });
      throw cloverApiError(outcome.error, { cloverChanged: outcome.cloverChanged, localChanged: false });
    }
  }

  let websiteChanged = false;
  if (touchesWebsite) {
    const saved = await deps.db.rpc("web_update_item", {
      p_restaurant: restaurantId, p_item: itemId, p_patch: input.website,
    });
    websiteChanged = saved !== null;
    if (input.website?.label_ids !== undefined) await setItemLabels(deps, session, itemId, input.website.label_ids);
  }

  const partial = outcome.failedParts.length > 0;
  const item = await loadItem(deps, session, itemId);
  await audit(deps, session, {
    ...base,
    oldValues: before,
    newValues: { clover: patch, website: input.website ?? {} },
    result: partial ? "partial" : "success",
    syncStatus: !touchesClover ? null : partial ? "PARTIAL" : "SYNCED",
  });

  return json(200, {
    result: partial ? "partial" : touchesClover ? "synced" : "saved",
    item,
    clover_changed: outcome.cloverChanged === true,
    website_changed: websiteChanged,
    failed_parts: outcome.failedParts,
    message: partial
      ? partialMessage(outcome.failedParts)
      : touchesClover ? "Saved to Clover and updated on the website." : "Saved.",
  });
}

export async function createItemHandler(deps: Deps, session: Session, request: Request, body: unknown): Promise<Response> {
  const input = parseBody(createSchema, body);
  await assertOwned(deps, session, "category", input.clover.category_ids, "clover.category_ids");
  await assertOwned(deps, session, "modifier_group", input.clover.modifier_group_ids, "clover.modifier_group_ids");
  await assertLabelsOwned(deps, session, input.website?.label_ids);

  const restaurantId = restaurantOf(session);
  const base = { action: "ITEM_CREATED", entityType: "item" };

  return idempotent(deps, session, request, "item.create", input, async (reconcileSince) => {
    let api: CloverApi;
    let created: unknown = null;
    try {
      api = await openClover(deps, restaurantId, session.requestId);
      if (reconcileSince !== null) {
        // An earlier attempt with this key ended without a clear answer. If Clover has an
        // item of this name created since then, that attempt succeeded: adopt it.
        const matches = await findItemsByName(api, input.clover.name, reconcileSince - 60_000);
        created = matches.length > 0 ? matches[matches.length - 1] : null;
      }
      if (created === null) {
        created = await createItem(api, {
          name: input.clover.name,
          price: input.clover.price_cents,
          priceType: "FIXED",
          available: input.clover.available ?? true,
          hidden: input.clover.hidden ?? false,
        });
      }
    } catch (error) {
      const unknown = error instanceof CloverError && error.outcomeUnknown;
      await audit(deps, session, { ...base, newValues: input.clover, result: "failed", syncStatus: "FAILED" });
      const apiError = cloverApiError(error, { cloverChanged: unknown ? "unknown" : false, localChanged: false });
      if (unknown) {
        apiError.extra.retryable = true;
        apiError.message =
          "Clover did not confirm whether the item was created. Press Retry: Clover is checked first, so the item cannot be created twice.";
      }
      throw apiError;
    }

    const itemId = normalizeItem(created, { categories: false, modifierGroups: false })?.id;
    if (!itemId) {
      throw cloverApiError(new CloverError("invalid_response", "Create response had no item id"), {
        cloverChanged: "unknown", localChanged: false,
      });
    }

    const empty: CloverState = { ...stateOf(created), category_ids: [], modifier_group_ids: [] };
    const outcome = await runSteps(
      api,
      itemId,
      buildSteps(api, itemId, {
        category_ids: input.clover.category_ids,
        modifier_group_ids: input.clover.modifier_group_ids,
      }, empty),
    );
    await refreshItem(deps, api, restaurantId, itemId);

    // Items that arrive from Clover start hidden from the website. One the owner creates
    // here is shown unless the form said otherwise, so visibility is always written.
    const website = { web_hidden: false, ...(input.website ?? {}) };
    await deps.db.rpc("web_update_item", { p_restaurant: restaurantId, p_item: itemId, p_patch: website });
    if (input.website?.label_ids !== undefined) await setItemLabels(deps, session, itemId, input.website.label_ids);
    const partial = outcome.failedParts.length > 0;
    await audit(deps, session, {
      ...base, entityId: itemId, newValues: input,
      result: partial ? "partial" : "success", syncStatus: partial ? "PARTIAL" : "SYNCED",
    });
    return {
      status: 201,
      body: {
        result: partial ? "partial" : "synced",
        item: await loadItem(deps, session, itemId),
        clover_changed: true,
        website_changed: hasKeys(input.website),
        failed_parts: outcome.failedParts,
        message: partial ? partialMessage(outcome.failedParts)
          : website.web_hidden ? "Item created in Clover. It is hidden from the website."
          : "Item created in Clover and added to the website.",
      },
    };
  });
}

const WEBSITE_BULK: Record<string, Record<string, boolean>> = {
  show: { web_hidden: false },
  hide: { web_hidden: true },
  archive: { archived: true },
  restore: { archived: false },
  feature: { featured: true },
  unfeature: { featured: false },
};

// Availability goes to Clover one item at a time, so a bulk change is capped.
const MAX_BULK_CLOVER = 50;

export async function bulkItems(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const input = parseBody(bulkSchema, body);
  await assertOwned(deps, session, "item", input.ids, "ids");
  const restaurantId = restaurantOf(session);
  const base = { action: `ITEMS_BULK_${input.action.toUpperCase()}`, entityType: "item" };

  const websitePatch = WEBSITE_BULK[input.action];
  if (websitePatch) {
    // A single statement: either every listed item changes or none does.
    const changed = await deps.db.rpc<string[]>("web_bulk_update_items", {
      p_restaurant: restaurantId, p_items: input.ids, p_patch: websitePatch,
    });
    await audit(deps, session, { ...base, newValues: { ids: changed, ...websitePatch }, result: "success" });
    return json(200, { result: "saved", succeeded: changed, failed: [], message: `${changed.length} items updated.` });
  }

  if (input.ids.length > MAX_BULK_CLOVER) {
    throw new ApiError(422, "validation_failed", `Availability can be changed for at most ${MAX_BULK_CLOVER} items at a time.`);
  }
  const available = input.action === "available";
  let api: CloverApi;
  try {
    api = await openClover(deps, restaurantId, session.requestId);
  } catch (error) {
    throw cloverApiError(error, { cloverChanged: false, localChanged: false });
  }

  const succeeded: string[] = [];
  const failed: { id: string; code: string }[] = [];
  const updated: unknown[] = [];
  const queue = [...input.ids];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        let raw = await updateItem(api, id, { available });
        // The update response is mirrored only if it is a complete item; otherwise re-read.
        if (!normalizeItem(raw, { categories: false, modifierGroups: false })) raw = await getItem(api, id);
        updated.push(raw);
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, code: error instanceof CloverError ? `clover_${error.kind}` : "internal_error" });
      }
    }
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENT_PER_TOKEN }, worker));
  await applyRawItems(deps, restaurantId, updated, false);

  const result = failed.length === 0 ? "synced" : succeeded.length === 0 ? "failed" : "partial";
  await audit(deps, session, {
    ...base,
    newValues: { available, succeeded, failed },
    result: result === "synced" ? "success" : result === "failed" ? "failed" : "partial",
    syncStatus: result.toUpperCase(),
  });
  // Always 200: the body carries a per-item account, which a bare error status cannot.
  return json(200, {
    result,
    succeeded,
    failed,
    message:
      result === "synced"
        ? `${succeeded.length} items updated in Clover.`
        : `${succeeded.length} items updated in Clover, ${failed.length} failed. The failed items were not changed.`,
  });
}
