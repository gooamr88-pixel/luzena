// Special offers: the slides of the offers carousel on the home page, managed from the
// dashboard. Each has words, a button, an optional photo, a place in the order, a switch and
// optional first and last days. The website shows those switched on and within their dates.
//
// An offer's words and its photo are saved separately: the words as JSON, the photo as an
// upload of its own, shrunk in the browser as the site's other photos are and checked again
// here. Paths are built here, from the restaurant and a hash of the content.
import { sha256Hex } from "../crypto.ts";
import { IMAGE_TYPES, sniffImage } from "../files.ts";
import { ApiError, json, readForm } from "../http.ts";
import type { Deps, Session } from "../types.ts";
import { parseBody, uuid, ValidationError, v } from "../validate.ts";
import { IMAGE_BUCKET } from "./images.ts";
import { audit } from "./session.ts";

export const MAX_OFFERS = 12;
const MAX_IMAGE_BYTES = 1024 * 1024;
const TOO_LARGE = "The photo is too large. The maximum is 1 MB after optimisation.";

export interface StoredOfferImage {
  path: string;
  small_path: string | null;
  width: number | null;
  height: number | null;
  small_width: number | null;
  alt: string;
}

export interface StoredOffer {
  id?: string;
  active?: boolean;
  badge: string;
  highlight: string;
  title: string;
  description: string;
  cta_label: string;
  cta_url: string;
  fine_print: string;
  starts_at: string | null;
  ends_at: string | null;
  image: StoredOfferImage | null;
}

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;
const notFound = () => new ApiError(404, "not_found", "This offer does not exist.");
const scheduleRefused = () => new ApiError(422, "validation_failed", "The last day must come after the first day.", {
  fields: { ends_at: "must come after the first day" },
});

// Where a button may lead: a page of this website, a full https address, or a phone number.
// Nothing else: no other scheme, and no "//host" that a browser would read as another site.
const CTA_URL = /^(\/(?!\/)[^\s<>"']*|https:\/\/[^\s<>"']+|tel:\+?[0-9 ().-]{3,30})$/;
const ctaUrl: (value: unknown, path: string) => string = (value, path) => {
  const text = v.string({ max: 500 })(value, path);
  if (text !== "" && !CTA_URL.test(text)) {
    throw new ValidationError(path, "must be a page of the website (starting with /), an https address or a tel: number");
  }
  return text;
};
const stamp = v.nullable((value: unknown, path: string) => {
  const text = v.string({ max: 40 })(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new ValidationError(path, "is not a valid date and time");
  }
  return new Date(text).toISOString();
});

const fields = {
  active: v.optional(v.bool()),
  badge: v.optional(v.string({ max: 40 })),
  highlight: v.optional(v.string({ max: 24 })),
  title: v.optional(v.string({ min: 1, max: 80 })),
  description: v.optional(v.string({ max: 240 })),
  cta_label: v.optional(v.string({ max: 30 })),
  cta_url: v.optional(ctaUrl),
  fine_print: v.optional(v.string({ max: 80 })),
  alt: v.optional(v.string({ max: 200 })),
  starts_at: v.optional(stamp),
  ends_at: v.optional(stamp),
};
const updateBody = v.object(fields);
const createBody = v.object({ ...fields, title: v.string({ min: 1, max: 80 }) });

const removeFiles = (deps: Deps, paths: string[]) =>
  (paths.length === 0 ? Promise.resolve() : deps.files.remove(IMAGE_BUCKET, paths))
    .catch((error) => deps.log.warn("site_offer_cleanup_failed", { paths, error_message: String(error) }));

// The files that no offer shows any more. A file is named by a hash of its content, so two
// offers given the same photo share one file: taking it from one must leave it for the other.
function noLongerShown(paths: string[], offers: StoredOffer[]): string[] {
  const shown = new Set<string>();
  for (const offer of offers) {
    if (!offer.image) continue;
    shown.add(offer.image.path);
    if (offer.image.small_path) shown.add(offer.image.small_path);
  }
  return paths.filter((path) => !shown.has(path));
}

const allOffers = (deps: Deps, restaurant: string) => deps.db.rpc<StoredOffer[]>("site_offers_for", { p_restaurant: restaurant, p_all: true });

export async function listOffers(deps: Deps, session: Session): Promise<Response> {
  const answer = await deps.db.rpc<{ offers: StoredOffer[]; timezone: string }>("dash_site_offers", { p_restaurant: restaurantOf(session) });
  return json(200, { offers: answer.offers, timezone: answer.timezone, limits: { offers: MAX_OFFERS } });
}

export async function createOffer(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const values = parseBody(createBody, body);
  const saved = await deps.db.rpc<{ id?: string; offers?: StoredOffer[]; full?: boolean; refused?: string }>("dash_site_offer_create", {
    p_restaurant: restaurantOf(session), p_fields: values, p_max: MAX_OFFERS,
  });
  if (saved.full) throw new ApiError(409, "offers_full", `The website holds ${MAX_OFFERS} offers. Remove one to add another.`);
  if (saved.refused === "schedule") throw scheduleRefused();
  await audit(deps, session, {
    action: "SITE_OFFER_CREATED", entityType: "site_offer", entityId: saved.id ?? null, newValues: { title: values.title }, result: "success",
  });
  return json(200, { result: "saved", id: saved.id, offers: saved.offers, message: "Offer added." });
}

export async function updateOffer(deps: Deps, session: Session, id: string, body: unknown): Promise<Response> {
  const values = parseBody(updateBody, body);
  if (Object.keys(values).length === 0) throw new ApiError(422, "validation_failed", "Nothing to change.");
  const saved = await deps.db.rpc<{ offers?: StoredOffer[]; refused?: string } | null>("dash_site_offer_update", {
    p_restaurant: restaurantOf(session), p_id: id, p_fields: values,
  });
  if (!saved) throw notFound();
  if (saved.refused === "schedule") throw scheduleRefused();
  await audit(deps, session, { action: "SITE_OFFER_UPDATED", entityType: "site_offer", entityId: id, newValues: values, result: "success" });
  const onlySwitch = Object.keys(values).length === 1 && "active" in values;
  return json(200, {
    result: "saved", offers: saved.offers,
    message: onlySwitch ? (values.active ? "Offer switched on." : "Offer switched off.") : "Offer saved. The website shows it within a minute.",
  });
}

export async function removeOffer(deps: Deps, session: Session, id: string): Promise<Response> {
  const removed = await deps.db.rpc<{ offers: StoredOffer[]; unused: string[]; title: string } | null>("dash_site_offer_remove", {
    p_restaurant: restaurantOf(session), p_id: id,
  });
  if (!removed) throw notFound();
  await removeFiles(deps, noLongerShown(removed.unused, removed.offers));
  await audit(deps, session, {
    action: "SITE_OFFER_REMOVED", entityType: "site_offer", entityId: id, oldValues: { title: removed.title }, result: "success",
  });
  return json(200, { result: "saved", offers: removed.offers, message: "Offer removed." });
}

const reorderBody = v.object({ ids: v.array(uuid, { max: MAX_OFFERS, unique: true }) });

export async function reorderOffers(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const { ids } = parseBody(reorderBody, body);
  const offers = await deps.db.rpc<StoredOffer[] | null>("dash_site_offer_reorder", {
    p_restaurant: restaurantOf(session), p_ids: ids.map((id) => id.toLowerCase()),
  });
  if (!offers) throw new ApiError(409, "conflict", "The offers have changed since this page was loaded. Refresh and try again.");
  return json(200, { result: "saved", offers, message: "Order saved." });
}

async function readImage(file: FormDataEntryValue | null, required: boolean) {
  if (!(file instanceof File)) {
    if (required) throw new ApiError(422, "validation_failed", "Choose a photo to upload.");
    return null;
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new ApiError(413, "image_too_large", TOO_LARGE);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw new ApiError(415, "unsupported_image", "Use a JPEG, PNG or WebP photo.");
  return { bytes, ...IMAGE_TYPES[kind] };
}

const dimension = (form: FormData, name: string): number | null => {
  const value = Number(form.get(name));
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : null;
};

export async function uploadOfferImage(deps: Deps, session: Session, id: string, request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await readForm(request, 2 * MAX_IMAGE_BYTES + 8192, () => new ApiError(413, "image_too_large", TOO_LARGE));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_upload", "The upload could not be read.");
  }
  let alt: string | null = null;
  if (form.has("alt")) {
    try {
      alt = v.string({ max: 200 })(String(form.get("alt") ?? ""), "alt");
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { alt: error.message } });
    }
  }
  const image = await readImage(form.get("file"), true);
  const small = await readImage(form.get("file_small"), false);
  if (!image) throw new ApiError(422, "validation_failed", "Choose a photo to upload.");

  const restaurantId = restaurantOf(session);
  const pathOf = async (bytes: Uint8Array, extension: string, suffix: string) =>
    `${restaurantId}/offers/${(await sha256Hex(bytes)).slice(0, 20)}${suffix}.${extension}`;
  const imagePath = await pathOf(image.bytes, image.extension, "");
  const smallPath = small ? await pathOf(small.bytes, small.extension, "-small") : null;
  const uploaded = [imagePath, ...(smallPath ? [smallPath] : [])];

  await deps.files.upload(IMAGE_BUCKET, imagePath, image.bytes, image.mime);
  if (small && smallPath) await deps.files.upload(IMAGE_BUCKET, smallPath, small.bytes, small.mime);

  let saved: { offers: StoredOffer[]; unused: string[] } | null;
  try {
    saved = await deps.db.rpc("dash_site_offer_set_image", {
      p_restaurant: restaurantId, p_id: id, p_image_path: imagePath, p_small_path: smallPath,
      p_width: dimension(form, "width"), p_height: dimension(form, "height"),
      p_small_width: small ? dimension(form, "small_width") : null, p_alt: alt,
    });
  } catch (error) {
    // Not saved, so its files go, once it is known that no offer already uses them.
    const current = await allOffers(deps, restaurantId).catch(() => null);
    if (current) await removeFiles(deps, noLongerShown(uploaded, current));
    throw error;
  }
  if (!saved) {
    await removeFiles(deps, noLongerShown(uploaded, await allOffers(deps, restaurantId)));
    throw notFound();
  }
  await removeFiles(deps, noLongerShown(saved.unused ?? [], saved.offers));
  await audit(deps, session, {
    action: "SITE_OFFER_PHOTO_SET", entityType: "site_offer", entityId: id, newValues: { image_path: imagePath }, result: "success",
  });
  return json(200, { result: "saved", offers: saved.offers, message: "Photo saved. The website shows it within a minute." });
}

export async function removeOfferImage(deps: Deps, session: Session, id: string): Promise<Response> {
  const removed = await deps.db.rpc<{ offers: StoredOffer[]; unused: string[] } | null>("dash_site_offer_remove_image", {
    p_restaurant: restaurantOf(session), p_id: id,
  });
  if (!removed) throw notFound();
  await removeFiles(deps, noLongerShown(removed.unused, removed.offers));
  await audit(deps, session, { action: "SITE_OFFER_PHOTO_REMOVED", entityType: "site_offer", entityId: id, result: "success" });
  return json(200, { result: "saved", offers: removed.offers, message: "Photo removed." });
}
