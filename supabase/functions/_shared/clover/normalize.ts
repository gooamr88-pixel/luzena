// Turns raw Clover inventory JSON into the payload public.menu_apply_sync expects.
// Clover's data is treated as untrusted input: anything malformed is skipped and counted,
// never passed through.

const CLOVER_ID = /^[A-Z0-9]{13}$/;
const PRICE_TYPES = ["FIXED", "VARIABLE", "PER_UNIT"];

export interface MirrorItem {
  id: string;
  name: string;
  price_cents: number | null;
  price_type: string;
  unit_name: string | null;
  hidden: boolean;
  available: boolean;
  modified_time: number | null;
  category_ids?: string[];
  modifier_group_ids?: string[];
}

export interface MirrorCategory {
  id: string;
  name: string;
  sort_order: number;
  item_ids?: string[];
}

export interface MirrorModifier {
  id: string;
  name: string;
  price_cents: number;
  available: boolean;
}

export interface MirrorModifierGroup {
  id: string;
  name: string;
  min_required: number | null;
  max_allowed: number | null;
  show_by_default: boolean;
  sort_order: number;
  modifiers?: MirrorModifier[];
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Clover wraps lists as { "elements": [...] }, both at the top level and for expanded fields.
export function elementsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.elements)) return value.elements;
  return [];
}

const idOf = (value: unknown): string | null =>
  isRecord(value) && typeof value.id === "string" && CLOVER_ID.test(value.id) ? value.id : null;

const idsOf = (value: unknown): string[] =>
  elementsOf(value).map(idOf).filter((id): id is string => id !== null);

const nameOf = (value: Raw): string | null => {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  return name === "" ? null : name.slice(0, 200);
};

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

// `expanded` names the associations the request asked Clover to expand. For those, a
// missing field means "none". For anything else it means "unknown", and the links in the
// mirror are left alone.
export function normalizeItem(raw: unknown, expanded: { categories: boolean; modifierGroups: boolean }): MirrorItem | null {
  if (!isRecord(raw) || raw.deleted === true) return null;
  const id = idOf(raw);
  const name = nameOf(raw);
  if (!id || !name) return null;

  const price = intOrNull(raw.price);
  const item: MirrorItem = {
    id,
    name,
    price_cents: price !== null && price >= 0 ? price : null,
    price_type: typeof raw.priceType === "string" && PRICE_TYPES.includes(raw.priceType) ? raw.priceType : "FIXED",
    unit_name: typeof raw.unitName === "string" && raw.unitName.trim() !== "" ? raw.unitName.trim().slice(0, 40) : null,
    hidden: raw.hidden === true,
    available: raw.available !== false,
    modified_time: intOrNull(raw.modifiedTime),
  };
  if (expanded.categories || raw.categories !== undefined) item.category_ids = idsOf(raw.categories);
  if (expanded.modifierGroups || raw.modifierGroups !== undefined) item.modifier_group_ids = idsOf(raw.modifierGroups);
  return item;
}

export function normalizeCategory(raw: unknown): MirrorCategory | null {
  if (!isRecord(raw) || raw.deleted === true) return null;
  const id = idOf(raw);
  const name = nameOf(raw);
  if (!id || !name) return null;
  const category: MirrorCategory = { id, name, sort_order: intOrNull(raw.sortOrder) ?? 0 };
  if (raw.items !== undefined) category.item_ids = idsOf(raw.items);
  return category;
}

export function normalizeModifier(raw: unknown): MirrorModifier | null {
  if (!isRecord(raw)) return null;
  const id = idOf(raw);
  const name = nameOf(raw);
  if (!id || !name) return null;
  const price = intOrNull(raw.price);
  return { id, name, price_cents: price !== null && price >= 0 ? price : 0, available: raw.available !== false };
}

export function normalizeModifierGroup(raw: unknown): MirrorModifierGroup | null {
  if (!isRecord(raw)) return null;
  const id = idOf(raw);
  const name = nameOf(raw);
  if (!id || !name) return null;
  const group: MirrorModifierGroup = {
    id,
    name,
    min_required: intOrNull(raw.minRequired),
    max_allowed: intOrNull(raw.maxAllowed),
    show_by_default: raw.showByDefault !== false,
    sort_order: intOrNull(raw.sortOrder) ?? 0,
  };
  if (raw.modifiers !== undefined) {
    group.modifiers = elementsOf(raw.modifiers)
      .map(normalizeModifier)
      .filter((modifier): modifier is MirrorModifier => modifier !== null);
  }
  return group;
}

export interface RawInventory {
  categories: unknown[];
  items: unknown[];
  modifierGroups: unknown[];
}

export function buildSyncPayload(raw: RawInventory) {
  const keep = <T>(list: (T | null)[]) => list.filter((entry): entry is T => entry !== null);
  const categories = keep(raw.categories.map(normalizeCategory));
  const items = keep(raw.items.map((item) => normalizeItem(item, { categories: true, modifierGroups: true })));
  const modifierGroups = keep(raw.modifierGroups.map(normalizeModifierGroup)).map((group) => ({
    ...group,
    modifiers: group.modifiers ?? [],
  }));

  // Objects Clover marks deleted are expected to be absent; only count the malformed ones.
  const malformed = (list: unknown[], kept: number) =>
    list.filter((entry) => !(isRecord(entry) && entry.deleted === true)).length - kept;

  return {
    payload: { categories, items, modifier_groups: modifierGroups },
    skipped:
      malformed(raw.categories, categories.length) +
      malformed(raw.items, items.length) +
      malformed(raw.modifierGroups, modifierGroups.length),
  };
}
