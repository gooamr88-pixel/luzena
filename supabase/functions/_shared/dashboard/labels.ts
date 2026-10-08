// Menu labels (dietary and descriptive attributes of a dish) and the allergy notice at the
// foot of the public menu. Both are the restaurant's own statements, kept per restaurant,
// and unknown to Clover.
//
// Nothing here, or anywhere else in this system, decides what a dish contains. A label is on
// a dish because someone at the restaurant put it there, and the notice says what the owner
// wrote. The code only stores, orders and shows.
import { ApiError, json } from "../http.ts";
import type { Deps, Session } from "../types.ts";
import { parseBody, uuid, v } from "../validate.ts";
import { audit } from "./session.ts";

// The icons a label can use: the keys of the website's own set (src/js/lib/label-icons.js).
// A unit test keeps the two lists the same. Adding an icon is adding its drawing there and
// its key here; nothing else in the system needs to change.
export const LABEL_ICONS = [
  "flame", "leaf", "sprout", "nut", "milk", "wheat", "egg", "fish", "shell",
  "star", "sparkle", "chef-hat", "seal", "heart", "sun", "clock", "drop", "cup",
] as const;

// The languages the notice can be written in. The code is put on the text as its language,
// so a screen reader pronounces it properly and Arabic reads right to left.
export const NOTICE_LANGUAGES = ["en", "ar", "es", "fr", "tr", "zh"] as const;

export const MAX_LABELS = 40;
export const MAX_LABELS_PER_ITEM = 12;
const MAX_NOTICE_CHARS = 600;

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;
const notFound = () => new ApiError(404, "not_found", "This label does not exist.");
const duplicate = () =>
  new ApiError(409, "duplicate", "There is already a label with this name.", { fields: { name: "is already used by another label" } });

interface LabelResult {
  labels?: unknown;
  id?: string;
  full?: boolean;
  duplicate?: boolean;
  dishes?: number;
}

const name = v.string({ min: 1, max: 40 });
const icon = v.oneOf(LABEL_ICONS);
const description = v.nullable(v.string({ max: 160 }));

export async function listLabels(deps: Deps, session: Session): Promise<Response> {
  return json(200, {
    labels: await deps.db.rpc("dash_labels_list", { p_restaurant: restaurantOf(session) }),
    icons: LABEL_ICONS,
    limits: { labels: MAX_LABELS, per_item: MAX_LABELS_PER_ITEM },
  });
}

const createBody = v.object({ name, icon, description: v.optional(description) });

export async function createLabel(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const input = parseBody(createBody, body);
  const result = await deps.db.rpc<LabelResult>("dash_label_create", {
    p_restaurant: restaurantOf(session), p_name: input.name, p_icon: input.icon,
    p_description: input.description ?? null, p_max: MAX_LABELS,
  });
  if (result.full) throw new ApiError(409, "labels_full", `A restaurant can have ${MAX_LABELS} labels. Delete one to add another.`);
  if (result.duplicate) throw duplicate();
  await audit(deps, session, {
    action: "LABEL_CREATED", entityType: "label", entityId: result.id ?? null, newValues: { name: input.name, icon: input.icon }, result: "success",
  });
  return json(201, { result: "saved", labels: result.labels, id: result.id, message: "Label added. Tick it on the dishes it applies to." });
}

const updateBody = v.object({
  name: v.optional(name), icon: v.optional(icon), description: v.optional(description), active: v.optional(v.bool()),
});

export async function updateLabel(deps: Deps, session: Session, id: string, body: unknown): Promise<Response> {
  const patch = parseBody(updateBody, body);
  if (Object.keys(patch).length === 0) throw new ApiError(422, "validation_failed", "There is nothing to save.");
  const result = await deps.db.rpc<LabelResult | null>("dash_label_update", {
    p_restaurant: restaurantOf(session), p_id: id, p_patch: patch,
  });
  if (!result) throw notFound();
  if (result.duplicate) throw duplicate();
  await audit(deps, session, { action: "LABEL_UPDATED", entityType: "label", entityId: id, newValues: patch, result: "success" });
  const message = patch.active === true ? "Label switched on. It shows on the dishes that carry it."
    : patch.active === false ? "Label switched off. It is hidden on the website and kept on its dishes."
    : "Label saved.";
  return json(200, { result: "saved", labels: result.labels, message });
}

export async function deleteLabel(deps: Deps, session: Session, id: string): Promise<Response> {
  const result = await deps.db.rpc<LabelResult | null>("dash_label_delete", { p_restaurant: restaurantOf(session), p_id: id });
  if (!result) throw notFound();
  await audit(deps, session, {
    action: "LABEL_DELETED", entityType: "label", entityId: id, oldValues: { dishes: result.dishes ?? 0 }, result: "success",
  });
  const dishes = result.dishes ?? 0;
  return json(200, {
    result: "saved", labels: result.labels,
    message: dishes === 0 ? "Label deleted." : `Label deleted and taken off ${dishes} ${dishes === 1 ? "dish" : "dishes"}.`,
  });
}

const reorderBody = v.object({ ids: v.array(uuid, { max: MAX_LABELS, unique: true }) });

export async function reorderLabels(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const { ids } = parseBody(reorderBody, body);
  const result = await deps.db.rpc<LabelResult | null>("dash_labels_reorder", {
    p_restaurant: restaurantOf(session), p_ids: ids.map((id) => id.toLowerCase()),
  });
  if (!result) throw new ApiError(409, "conflict", "The labels have changed since this page was loaded. Refresh and try again.");
  return json(200, { result: "saved", labels: result.labels, message: "Order saved." });
}

// Sets exactly which labels a dish carries. Used by the item editor's save, after the
// dish's other website fields. Ids that are not this restaurant's labels are refused by the
// database, and nothing is changed.
export async function setItemLabels(deps: Deps, session: Session, itemId: string, labelIds: string[]): Promise<void> {
  const saved = await deps.db.rpc<boolean>("web_set_item_labels", {
    p_restaurant: restaurantOf(session), p_item: itemId, p_label_ids: labelIds.map((id) => id.toLowerCase()),
  });
  if (!saved) {
    throw new ApiError(422, "validation_failed", "Some fields need attention.", {
      fields: { "website.label_ids": "contains a label that does not exist" },
    });
  }
}

// ----------------------------------------------------------------------------------------
// The allergy notice
// ----------------------------------------------------------------------------------------

const noticeBody = v.object({
  enabled: v.bool(),
  entries: v.array(v.object({ lang: v.oneOf(NOTICE_LANGUAGES), text: v.string({ max: MAX_NOTICE_CHARS }) }), { max: NOTICE_LANGUAGES.length }),
});

export async function getNotice(deps: Deps, session: Session): Promise<Response> {
  return json(200, {
    notice: await deps.db.rpc("site_notice_get", { p_restaurant: restaurantOf(session) }),
    languages: NOTICE_LANGUAGES, limits: { text: MAX_NOTICE_CHARS },
  });
}

export async function setNotice(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const input = parseBody(noticeBody, body);
  // A language left empty is simply not kept, and each language appears once.
  const entries = input.entries.filter((entry) => entry.text !== "");
  if (new Set(entries.map((entry) => entry.lang)).size !== entries.length) {
    throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { entries: "has the same language twice" } });
  }
  // Turned on with nothing written would be a heading over an empty space.
  if (input.enabled && entries.length === 0) {
    throw new ApiError(422, "validation_failed", "Write the notice before turning it on.", { fields: { entries: "is empty" } });
  }
  const notice = await deps.db.rpc("site_notice_set", {
    p_restaurant: restaurantOf(session), p_enabled: input.enabled, p_entries: entries,
  });
  // The log says that it changed and in which languages, not the wording.
  await audit(deps, session, {
    action: "ALLERGY_NOTICE_UPDATED", entityType: "site_settings", entityId: "allergy_notice",
    newValues: { enabled: input.enabled, languages: entries.map((entry) => entry.lang) }, result: "success",
  });
  return json(200, {
    result: "saved", notice,
    message: input.enabled ? "Notice saved. It is at the foot of the menu within about a minute." : "Notice saved. It is switched off, so the website does not show it.",
  });
}
