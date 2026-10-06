// Every Clover REST call this system makes. Endpoints and fields are the ones recorded in
// CLOVER_CAPABILITY_MATRIX.md; nothing here is guessed.
import type { CloverApi } from "./auth.ts";
import { MAX_PAGES, PAGE_LIMIT } from "./config.ts";
import { CloverError } from "./errors.ts";
import { elementsOf, type RawInventory } from "./normalize.ts";

const base = (api: CloverApi) => `/v3/merchants/${api.merchantId}`;

async function listAll(api: CloverApi, path: string, query: Record<string, string | string[]>): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await api.request({
      method: "GET",
      path,
      query: { ...query, limit: String(PAGE_LIMIT), offset: String(page * PAGE_LIMIT) },
      retry: "read",
    });
    if (body === null || typeof body !== "object") {
      throw new CloverError("invalid_response", "Clover list response is not an object");
    }
    const elements = elementsOf(body);
    all.push(...elements);
    if (elements.length < PAGE_LIMIT) return all;
  }
  throw new CloverError("invalid_response", "Clover inventory exceeds the supported size");
}

// Three paged list calls, issued one after another to stay well inside the per-token
// concurrency limit.
export async function fetchInventory(api: CloverApi): Promise<RawInventory> {
  const categories = await listAll(api, `${base(api)}/categories`, { expand: "items" });
  const modifierGroups = await listAll(api, `${base(api)}/modifier_groups`, { expand: "modifiers" });
  const items = await listAll(api, `${base(api)}/items`, { expand: "categories,modifierGroups" });
  return { categories, items, modifierGroups };
}

export const getItem = (api: CloverApi, itemId: string) =>
  api.request({
    method: "GET",
    path: `${base(api)}/items/${itemId}`,
    query: { expand: "categories,modifierGroups" },
    retry: "read",
  });

export const listCategories = (api: CloverApi) => listAll(api, `${base(api)}/categories`, {});

export const getModifierGroup = (api: CloverApi, groupId: string) =>
  api.request({
    method: "GET",
    path: `${base(api)}/modifier_groups/${groupId}`,
    query: { expand: "modifiers" },
    retry: "read",
  });

export const listModifierGroups = (api: CloverApi) =>
  listAll(api, `${base(api)}/modifier_groups`, { expand: "modifiers" });

export interface ItemFields {
  name?: string;
  price?: number;
  priceType?: string;
  available?: boolean;
  hidden?: boolean;
}

export const createItem = (api: CloverApi, fields: ItemFields & { name: string; price: number }) =>
  api.request({ method: "POST", path: `${base(api)}/items`, body: fields, retry: "create" });

export const updateItem = (api: CloverApi, itemId: string, fields: ItemFields) =>
  api.request({ method: "POST", path: `${base(api)}/items/${itemId}`, body: fields, retry: "idempotent" });

// Items created at or after `sinceMs` with exactly this name. Used to find out whether a
// create whose response was lost did in fact happen.
export const findItemsByName = (api: CloverApi, name: string, sinceMs: number) =>
  listAll(api, `${base(api)}/items`, { filter: [`name=${name}`, `modifiedTime>=${sinceMs}`] });

export const createCategory = (api: CloverApi, name: string) =>
  api.request({ method: "POST", path: `${base(api)}/categories`, body: { name }, retry: "create" });

// Clover's reference marks `name` as required on a category update, so it is always sent.
export const updateCategory = (api: CloverApi, categoryId: string, fields: { name: string; sortOrder?: number }) =>
  api.request({ method: "POST", path: `${base(api)}/categories/${categoryId}`, body: fields, retry: "idempotent" });

type Association = "category_items" | "item_modifier_groups";

function associationBody(kind: Association, itemId: string, otherIds: string[]) {
  return {
    elements: otherIds.map((otherId) =>
      kind === "category_items"
        ? { category: { id: otherId }, item: { id: itemId } }
        : { modifierGroup: { id: otherId }, item: { id: itemId } }
    ),
  };
}

// Adds and removes associations so the item ends up linked to exactly `wanted`.
export async function setItemAssociations(
  api: CloverApi,
  kind: Association,
  itemId: string,
  current: string[],
  wanted: string[],
): Promise<void> {
  const add = wanted.filter((id) => !current.includes(id));
  const remove = current.filter((id) => !wanted.includes(id));
  if (add.length > 0) {
    await api.request({
      method: "POST",
      path: `${base(api)}/${kind}`,
      body: associationBody(kind, itemId, add),
      retry: "idempotent",
    });
  }
  if (remove.length > 0) {
    await api.request({
      method: "POST",
      path: `${base(api)}/${kind}`,
      query: { delete: "true" },
      body: associationBody(kind, itemId, remove),
      retry: "idempotent",
    });
  }
}

export interface ModifierGroupFields {
  name?: string;
  minRequired?: number | null;
  maxAllowed?: number | null;
}

export const createModifierGroup = (api: CloverApi, fields: ModifierGroupFields & { name: string }) =>
  api.request({ method: "POST", path: `${base(api)}/modifier_groups`, body: fields, retry: "create" });

export const updateModifierGroup = (api: CloverApi, groupId: string, fields: ModifierGroupFields) =>
  api.request({ method: "POST", path: `${base(api)}/modifier_groups/${groupId}`, body: fields, retry: "idempotent" });

export const createModifier = (api: CloverApi, groupId: string, fields: { name: string; price: number }) =>
  api.request({
    method: "POST",
    path: `${base(api)}/modifier_groups/${groupId}/modifiers`,
    body: fields,
    retry: "create",
  });

export const updateModifier = (
  api: CloverApi,
  groupId: string,
  modifierId: string,
  fields: { name?: string; price?: number; available?: boolean },
) =>
  api.request({
    method: "POST",
    path: `${base(api)}/modifier_groups/${groupId}/modifiers/${modifierId}`,
    body: fields,
    retry: "idempotent",
  });

// Needs the "Read merchant" permission. Used only to show the merchant's name; callers
// treat a failure as "name unknown".
export const getMerchant = (api: CloverApi) =>
  api.request({ method: "GET", path: base(api), retry: "read" });
