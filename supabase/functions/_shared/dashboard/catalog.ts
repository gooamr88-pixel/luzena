// Categories and modifiers. Names, order, limits and prices live in Clover and are written
// through; "hidden on the website" and "archived" live in this system.
import { type CloverApi, openClover } from "../clover/auth.ts";
import { CloverError } from "../clover/errors.ts";
import {
  createCategory, createModifier, createModifierGroup, getModifierGroup, listCategories, listModifierGroups,
  updateCategory, updateModifier, updateModifierGroup,
} from "../clover/inventory.ts";
import { normalizeCategory, normalizeModifierGroup } from "../clover/normalize.ts";
import { ApiError, json } from "../http.ts";
import { refreshCategories, refreshModifierGroup } from "../sync.ts";
import type { Deps, Session } from "../types.ts";
import { cloverId, parseBody, v } from "../validate.ts";
import { assertOwned, audit, cloverApiError, idempotent, sameSet } from "./session.ts";

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;
const name = v.string({ min: 1, max: 127 });

async function open(deps: Deps, session: Session): Promise<CloverApi> {
  try {
    return await openClover(deps, restaurantOf(session), session.requestId);
  } catch (error) {
    throw cloverApiError(error, { cloverChanged: false, localChanged: false });
  }
}

const conflictError = (what: string, extra: Record<string, unknown> = {}) =>
  new ApiError(409, "conflict", `${what} changed in Clover after you opened it. The latest values are shown; review and save again.`, {
    clover_changed: false, local_changed: false, ...extra,
  });

// ----------------------------------------------------------------------------------------
// Categories
// ----------------------------------------------------------------------------------------

export async function listCategoriesHandler(deps: Deps, session: Session): Promise<Response> {
  return json(200, { categories: await deps.db.rpc("dash_list_categories", { p_restaurant: restaurantOf(session) }) });
}

export async function createCategoryHandler(deps: Deps, session: Session, request: Request, body: unknown) {
  const input = parseBody(v.object({ name }), body);
  const restaurantId = restaurantOf(session);

  return idempotent(deps, session, request, "category.create", input, async (reconcileSince) => {
    const api = await open(deps, session);
    try {
      if (reconcileSince !== null) {
        // After an unknown outcome: a category of this name that the mirror has never seen
        // is the one the earlier attempt created.
        const existing = (await listCategories(api)).map(normalizeCategory).filter((c) => c?.name === input.name);
        const known = await deps.db.rpc<string[]>("menu_known_ids", {
          p_restaurant: restaurantId, p_kind: "category", p_ids: existing.map((c) => c!.id),
        });
        const adopted = existing.find((c) => !known.includes(c!.id));
        if (!adopted) await createCategory(api, input.name);
      } else {
        await createCategory(api, input.name);
      }
    } catch (error) {
      const unknown = error instanceof CloverError && error.outcomeUnknown;
      await audit(deps, session, { action: "CATEGORY_CREATED", entityType: "category", newValues: input, result: "failed", syncStatus: "FAILED" });
      throw cloverApiError(error, { cloverChanged: unknown ? "unknown" : false, localChanged: false });
    }
    await refreshCategories(deps, api, restaurantId);
    await audit(deps, session, { action: "CATEGORY_CREATED", entityType: "category", newValues: input, result: "success", syncStatus: "SYNCED" });
    return {
      status: 201,
      body: {
        result: "synced",
        categories: await deps.db.rpc("dash_list_categories", { p_restaurant: restaurantId }),
        message: "Category created in Clover.",
      },
    };
  });
}

const categoryUpdateSchema = v.object({
  clover: v.optional(v.object({ name })),
  expected: v.optional(v.object({ name })),
  website: v.optional(v.object({ web_hidden: v.optional(v.bool()), archived: v.optional(v.bool()) })),
});

export async function updateCategoryHandler(deps: Deps, session: Session, categoryId: string, body: unknown) {
  const input = parseBody(categoryUpdateSchema, body);
  await assertOwned(deps, session, "category", [categoryId], "category");
  const restaurantId = restaurantOf(session);
  let renamed = false;

  if (input.clover) {
    if (!input.expected) {
      throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { "expected.name": "is required" } });
    }
    const api = await open(deps, session);
    let current;
    try {
      current = (await refreshCategories(deps, api, restaurantId)).map(normalizeCategory).find((c) => c?.id === categoryId);
    } catch (error) {
      throw cloverApiError(error, { cloverChanged: false, localChanged: false });
    }
    if (!current) throw new ApiError(409, "removed_in_clover", "This category was deleted in Clover.");
    if (current.name !== input.expected.name) {
      await audit(deps, session, { action: "CATEGORY_UPDATED", entityType: "category", entityId: categoryId, newValues: input.clover, result: "conflict", syncStatus: "CONFLICT" });
      throw conflictError("This category", { conflicts: { name: { expected: input.expected.name, actual: current.name } } });
    }
    if (current.name !== input.clover.name) {
      try {
        await updateCategory(api, categoryId, { name: input.clover.name });
      } catch (error) {
        await audit(deps, session, { action: "CATEGORY_UPDATED", entityType: "category", entityId: categoryId, newValues: input.clover, result: "failed", syncStatus: "FAILED" });
        const unknown = error instanceof CloverError && error.outcomeUnknown;
        await refreshCategories(deps, api, restaurantId).catch(() => {});
        throw cloverApiError(error, { cloverChanged: unknown ? "unknown" : false, localChanged: false });
      }
      await refreshCategories(deps, api, restaurantId);
      renamed = true;
    }
  }

  let website = null;
  if (input.website && Object.keys(input.website).length > 0) {
    website = await deps.db.rpc<{ old: unknown; new: unknown } | null>("web_update_category", {
      p_restaurant: restaurantId, p_category: categoryId, p_patch: input.website,
    });
  }

  await audit(deps, session, {
    action: "CATEGORY_UPDATED", entityType: "category", entityId: categoryId,
    oldValues: { name: input.expected?.name, website: website?.old },
    newValues: { name: input.clover?.name, website: website?.new },
    result: "success", syncStatus: input.clover ? "SYNCED" : null,
  });
  return json(200, {
    result: input.clover ? "synced" : "saved",
    categories: await deps.db.rpc("dash_list_categories", { p_restaurant: restaurantId }),
    clover_changed: renamed,
    website_changed: website !== null,
    message: renamed ? "Saved to Clover." : "Saved.",
  });
}

// Category order is Clover's sortOrder. The request must list every current category, so a
// category added in Clover meanwhile is detected instead of being pushed to a random place.
export async function reorderCategories(deps: Deps, session: Session, body: unknown) {
  const input = parseBody(v.object({ ids: v.array(cloverId, { min: 1, max: 500, unique: true }) }), body);
  const restaurantId = restaurantOf(session);
  const api = await open(deps, session);

  let current;
  try {
    current = (await refreshCategories(deps, api, restaurantId)).map(normalizeCategory).filter((c) => c !== null);
  } catch (error) {
    throw cloverApiError(error, { cloverChanged: false, localChanged: false });
  }
  if (!sameSet(current.map((c) => c.id), input.ids)) {
    throw conflictError("The category list");
  }

  const byId = new Map(current.map((c) => [c.id, c]));
  const failed: string[] = [];
  let changed = 0;
  let lastError: unknown = null;
  for (const [index, id] of input.ids.entries()) {
    const category = byId.get(id)!;
    const sortOrder = index + 1;
    if (category.sort_order === sortOrder) continue;
    try {
      await updateCategory(api, id, { name: category.name, sortOrder });
      changed++;
    } catch (error) {
      failed.push(id);
      lastError = error;
      // Stop at the first failure: continuing could leave an order nobody asked for.
      break;
    }
  }
  await refreshCategories(deps, api, restaurantId).catch(() => {});

  const result = failed.length === 0 ? "success" : changed === 0 ? "failed" : "partial";
  await audit(deps, session, {
    action: "CATEGORY_REORDERED", entityType: "category", newValues: { ids: input.ids },
    result, syncStatus: result === "success" ? "SYNCED" : result.toUpperCase(),
  });
  if (result === "failed") throw cloverApiError(lastError, { cloverChanged: false, localChanged: false });
  return json(200, {
    result: result === "success" ? "synced" : "partial",
    categories: await deps.db.rpc("dash_list_categories", { p_restaurant: restaurantId }),
    message: result === "success"
      ? "Category order saved to Clover."
      : "Clover saved only part of the new order. The list shows the order Clover has now.",
  });
}

export async function reorderCategoryItems(deps: Deps, session: Session, categoryId: string, body: unknown) {
  const input = parseBody(v.object({ ids: v.array(cloverId, { min: 1, max: 2000, unique: true }) }), body);
  await assertOwned(deps, session, "category", [categoryId], "category");
  await deps.db.rpc("web_reorder_category_items", {
    p_restaurant: restaurantOf(session), p_category: categoryId, p_items: input.ids,
  });
  await audit(deps, session, {
    action: "ITEMS_REORDERED", entityType: "category", entityId: categoryId,
    newValues: { count: input.ids.length }, result: "success",
  });
  return json(200, { result: "saved", message: "Item order saved." });
}

// ----------------------------------------------------------------------------------------
// Modifier groups and modifiers
// ----------------------------------------------------------------------------------------

const limit = v.nullable(v.int({ min: 0, max: 100 }));
const groupFields = {
  name: v.optional(name),
  min_required: v.optional(limit),
  max_allowed: v.optional(limit),
};
const modifierFields = {
  name: v.optional(name),
  price_cents: v.optional(v.int({ min: 0, max: 99_999_999 })),
  available: v.optional(v.bool()),
};

const listGroups = (deps: Deps, session: Session) =>
  deps.db.rpc("dash_list_modifier_groups", { p_restaurant: restaurantOf(session) });

export async function listModifierGroupsHandler(deps: Deps, session: Session): Promise<Response> {
  return json(200, { modifier_groups: await listGroups(deps, session) });
}

function assertLimits(min: number | null | undefined, max: number | null | undefined) {
  if (typeof min === "number" && typeof max === "number" && max !== 0 && min > max) {
    throw new ApiError(422, "validation_failed", "Some fields need attention.", {
      fields: { min_required: "cannot be greater than the maximum" },
    });
  }
}

export async function createModifierGroupHandler(deps: Deps, session: Session, request: Request, body: unknown) {
  const input = parseBody(v.object({ ...groupFields, name }), body);
  assertLimits(input.min_required, input.max_allowed);
  const restaurantId = restaurantOf(session);

  return idempotent(deps, session, request, "modifier_group.create", input, async (reconcileSince) => {
    const api = await open(deps, session);
    try {
      let adopt = false;
      if (reconcileSince !== null) {
        const existing = (await listModifierGroups(api)).map(normalizeModifierGroup).filter((g) => g?.name === input.name);
        const known = await deps.db.rpc<string[]>("menu_known_ids", {
          p_restaurant: restaurantId, p_kind: "modifier_group", p_ids: existing.map((g) => g!.id),
        });
        adopt = existing.some((g) => !known.includes(g!.id));
      }
      if (!adopt) {
        await createModifierGroup(api, {
          name: input.name,
          ...(input.min_required !== undefined ? { minRequired: input.min_required } : {}),
          ...(input.max_allowed !== undefined ? { maxAllowed: input.max_allowed } : {}),
        });
      }
      const groups = (await listModifierGroups(api)).map(normalizeModifierGroup).filter((g) => g !== null);
      await deps.db.rpc("menu_apply_sync", {
        p_restaurant: restaurantId,
        p_payload: { modifier_groups: groups.map((g) => ({ ...g, modifiers: g.modifiers ?? [] })) },
        p_full: false,
      });
    } catch (error) {
      const unknown = error instanceof CloverError && error.outcomeUnknown;
      await audit(deps, session, { action: "MODIFIER_GROUP_CREATED", entityType: "modifier_group", newValues: input, result: "failed", syncStatus: "FAILED" });
      throw cloverApiError(error, { cloverChanged: unknown ? "unknown" : false, localChanged: false });
    }
    await audit(deps, session, { action: "MODIFIER_GROUP_CREATED", entityType: "modifier_group", newValues: input, result: "success", syncStatus: "SYNCED" });
    return { status: 201, body: { result: "synced", modifier_groups: await listGroups(deps, session), message: "Modifier group created in Clover." } };
  });
}

export async function updateModifierGroupHandler(deps: Deps, session: Session, groupId: string, body: unknown) {
  const input = parseBody(v.object({ clover: v.object(groupFields), expected: v.object(groupFields) }), body);
  await assertOwned(deps, session, "modifier_group", [groupId], "modifier_group");
  const restaurantId = restaurantOf(session);
  const api = await open(deps, session);
  const entry = { action: "MODIFIER_GROUP_UPDATED", entityType: "modifier_group", entityId: groupId };

  let current;
  try {
    current = normalizeModifierGroup(await refreshModifierGroup(deps, api, restaurantId, groupId));
  } catch (error) {
    throw cloverApiError(error, { cloverChanged: false, localChanged: false });
  }
  if (!current) throw new ApiError(409, "removed_in_clover", "This modifier group was deleted in Clover.");

  const conflicts: Record<string, unknown> = {};
  for (const key of ["name", "min_required", "max_allowed"] as const) {
    if (input.clover[key] !== undefined && (input.expected[key] ?? null) !== (current[key] ?? null)) {
      conflicts[key] = { expected: input.expected[key] ?? null, actual: current[key] ?? null };
    }
  }
  if (Object.keys(conflicts).length > 0) {
    await audit(deps, session, { ...entry, newValues: input.clover, result: "conflict", syncStatus: "CONFLICT" });
    throw conflictError("This modifier group", { conflicts, modifier_groups: await listGroups(deps, session) });
  }
  assertLimits(input.clover.min_required ?? current.min_required, input.clover.max_allowed ?? current.max_allowed);

  try {
    await updateModifierGroup(api, groupId, {
      ...(input.clover.name !== undefined ? { name: input.clover.name } : {}),
      ...(input.clover.min_required !== undefined ? { minRequired: input.clover.min_required } : {}),
      ...(input.clover.max_allowed !== undefined ? { maxAllowed: input.clover.max_allowed } : {}),
    });
  } catch (error) {
    const unknown = error instanceof CloverError && error.outcomeUnknown;
    await refreshModifierGroup(deps, api, restaurantId, groupId).catch(() => {});
    await audit(deps, session, { ...entry, newValues: input.clover, result: "failed", syncStatus: "FAILED" });
    throw cloverApiError(error, { cloverChanged: unknown ? "unknown" : false, localChanged: false });
  }
  await refreshModifierGroup(deps, api, restaurantId, groupId);
  await audit(deps, session, { ...entry, oldValues: input.expected, newValues: input.clover, result: "success", syncStatus: "SYNCED" });
  return json(200, { result: "synced", modifier_groups: await listGroups(deps, session), message: "Saved to Clover." });
}

export async function createModifierHandler(deps: Deps, session: Session, request: Request, groupId: string, body: unknown) {
  const input = parseBody(v.object({ name, price_cents: v.int({ min: 0, max: 99_999_999 }) }), body);
  await assertOwned(deps, session, "modifier_group", [groupId], "modifier_group");
  const restaurantId = restaurantOf(session);
  const entry = { action: "MODIFIER_CREATED", entityType: "modifier", newValues: { group: groupId, ...input } };

  return idempotent(deps, session, request, `modifier.create:${groupId}`, input, async (reconcileSince) => {
    const api = await open(deps, session);
    try {
      let adopt = false;
      if (reconcileSince !== null) {
        // Read Clover WITHOUT mirroring first: a modifier of this name that the mirror has
        // never seen is the one the earlier attempt created.
        const group = normalizeModifierGroup(await getModifierGroup(api, groupId));
        const sameName = (group?.modifiers ?? []).filter((m) => m.name === input.name);
        const known = await deps.db.rpc<string[]>("menu_known_ids", {
          p_restaurant: restaurantId, p_kind: "modifier", p_ids: sameName.map((m) => m.id),
        });
        adopt = sameName.some((m) => !known.includes(m.id));
      }
      if (!adopt) await createModifier(api, groupId, { name: input.name, price: input.price_cents });
      await refreshModifierGroup(deps, api, restaurantId, groupId);
    } catch (error) {
      const unknown = error instanceof CloverError && error.outcomeUnknown;
      await audit(deps, session, { ...entry, result: "failed", syncStatus: "FAILED" });
      throw cloverApiError(error, { cloverChanged: unknown ? "unknown" : false, localChanged: false });
    }
    await audit(deps, session, { ...entry, result: "success", syncStatus: "SYNCED" });
    return { status: 201, body: { result: "synced", modifier_groups: await listGroups(deps, session), message: "Modifier created in Clover." } };
  });
}

export async function updateModifierHandler(deps: Deps, session: Session, groupId: string, modifierId: string, body: unknown) {
  const input = parseBody(v.object({ clover: v.object(modifierFields), expected: v.object(modifierFields) }), body);
  await assertOwned(deps, session, "modifier_group", [groupId], "modifier_group");
  await assertOwned(deps, session, "modifier", [modifierId], "modifier");
  const restaurantId = restaurantOf(session);
  const api = await open(deps, session);
  const entry = { action: "MODIFIER_UPDATED", entityType: "modifier", entityId: modifierId };

  let current;
  try {
    const group = normalizeModifierGroup(await refreshModifierGroup(deps, api, restaurantId, groupId));
    current = group?.modifiers?.find((m) => m.id === modifierId);
  } catch (error) {
    throw cloverApiError(error, { cloverChanged: false, localChanged: false });
  }
  if (!current) throw new ApiError(409, "removed_in_clover", "This modifier was deleted in Clover.");

  const conflicts: Record<string, unknown> = {};
  for (const key of ["name", "price_cents", "available"] as const) {
    if (input.clover[key] !== undefined && input.expected[key] !== current[key]) {
      conflicts[key] = { expected: input.expected[key], actual: current[key] };
    }
  }
  if (Object.keys(conflicts).length > 0) {
    await audit(deps, session, { ...entry, newValues: input.clover, result: "conflict", syncStatus: "CONFLICT" });
    throw conflictError("This modifier", { conflicts, modifier_groups: await listGroups(deps, session) });
  }

  try {
    await updateModifier(api, groupId, modifierId, {
      ...(input.clover.name !== undefined ? { name: input.clover.name } : {}),
      ...(input.clover.price_cents !== undefined ? { price: input.clover.price_cents } : {}),
      ...(input.clover.available !== undefined ? { available: input.clover.available } : {}),
    });
  } catch (error) {
    const unknown = error instanceof CloverError && error.outcomeUnknown;
    await refreshModifierGroup(deps, api, restaurantId, groupId).catch(() => {});
    await audit(deps, session, { ...entry, newValues: input.clover, result: "failed", syncStatus: "FAILED" });
    throw cloverApiError(error, { cloverChanged: unknown ? "unknown" : false, localChanged: false });
  }
  await refreshModifierGroup(deps, api, restaurantId, groupId);
  await audit(deps, session, { ...entry, oldValues: input.expected, newValues: input.clover, result: "success", syncStatus: "SYNCED" });
  return json(200, { result: "synced", modifier_groups: await listGroups(deps, session), message: "Saved to Clover." });
}
