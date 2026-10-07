// The website's own photos, managed from the dashboard: the home page's hero photo, the
// "our story" photo and the gallery.
//
// The dashboard shrinks and re-encodes each photo in the browser, twice: a full-size file
// and a smaller one for phones. The server does not trust that: it checks each file's size
// and reads its real type from its bytes. Paths are built here, from the restaurant, the
// slot and a hash of the content; nothing of the uploaded file's name is used.
import { sha256Hex } from "../crypto.ts";
import { IMAGE_TYPES, sniffImage } from "../files.ts";
import { ApiError, json, readForm } from "../http.ts";
import type { StoredPhotos } from "../public/site.ts";
import type { Deps, Session } from "../types.ts";
import { parseBody, uuid, ValidationError, v } from "../validate.ts";
import { IMAGE_BUCKET } from "./images.ts";
import { audit } from "./session.ts";

export const SLOTS = ["hero", "story", "gallery"] as const;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_GALLERY = 24;
const TOO_LARGE = "The photo is too large. The maximum is 1 MB after optimisation.";

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;
const notFound = () => new ApiError(404, "not_found", "This photo does not exist.");

// The dashboard is given the photos as they are stored, with their ids and their paths in
// the bucket. It builds the addresses itself, as it does for item photos.

const removeFiles = (deps: Deps, paths: string[]) =>
  (paths.length === 0 ? Promise.resolve() : deps.files.remove(IMAGE_BUCKET, paths))
    .catch((error) => deps.log.warn("site_photo_cleanup_failed", { paths, error_message: String(error) }));

// The files that nothing shows any more. A file is named by a hash of its content, so the
// same photo added to the gallery twice is one file with two rows pointing at it: taking one
// row away must leave the file for the other. `photos` is what the website shows now.
function noLongerShown(paths: string[], photos: StoredPhotos): string[] {
  const shown = new Set<string>();
  for (const photo of [photos.hero, photos.story, ...photos.gallery]) {
    if (!photo) continue;
    shown.add(photo.path);
    if (photo.small_path) shown.add(photo.small_path);
  }
  return paths.filter((path) => !shown.has(path));
}

export async function listSitePhotos(deps: Deps, session: Session): Promise<Response> {
  const photos = await deps.db.rpc<StoredPhotos>("site_photos_for", { p_restaurant: restaurantOf(session), p_with_id: true });
  return json(200, { photos: photos, limits: { gallery: MAX_GALLERY } });
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

export async function uploadSitePhoto(deps: Deps, session: Session, request: Request): Promise<Response> {
  // Two files at most, read under a cap on the bytes that actually arrive.
  let form: FormData;
  try {
    form = await readForm(request, 2 * MAX_IMAGE_BYTES + 8192, () => new ApiError(413, "image_too_large", TOO_LARGE));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_upload", "The upload could not be read.");
  }
  const slot = String(form.get("slot") ?? "");
  if (!(SLOTS as readonly string[]).includes(slot)) {
    throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { slot: "is not valid" } });
  }
  let alt: string;
  try {
    alt = v.string({ max: 200 })(String(form.get("alt") ?? ""), "alt");
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { alt: error.message } });
  }
  const image = await readImage(form.get("file"), true);
  const small = await readImage(form.get("file_small"), false);
  if (!image) throw new ApiError(422, "validation_failed", "Choose a photo to upload.");

  const restaurantId = restaurantOf(session);
  const pathOf = async (bytes: Uint8Array, extension: string, suffix: string) =>
    `${restaurantId}/site/${slot}/${(await sha256Hex(bytes)).slice(0, 20)}${suffix}.${extension}`;
  const imagePath = await pathOf(image.bytes, image.extension, "");
  const smallPath = small ? await pathOf(small.bytes, small.extension, "-small") : null;

  await deps.files.upload(IMAGE_BUCKET, imagePath, image.bytes, image.mime);
  if (small && smallPath) await deps.files.upload(IMAGE_BUCKET, smallPath, small.bytes, small.mime);

  let saved: { photos?: StoredPhotos; unused?: string[]; full?: boolean };
  try {
    saved = await deps.db.rpc("dash_site_photo_add", {
      p_restaurant: restaurantId, p_slot: slot, p_image_path: imagePath, p_small_path: smallPath,
      p_width: dimension(form, "width"), p_height: dimension(form, "height"),
      p_small_width: small ? dimension(form, "small_width") : null, p_alt: alt,
    });
  } catch (error) {
    // The photo was not saved, so its files go: but only once it is known that no photo
    // already on the website uses them. If that cannot be found out either, they stay. A
    // file nobody uses costs a little storage; a photo with its file gone is a broken page.
    const current = await deps.db.rpc<StoredPhotos>("site_photos_for", { p_restaurant: restaurantId, p_with_id: true }).catch(() => null);
    if (current) await removeFiles(deps, noLongerShown([imagePath, ...(smallPath ? [smallPath] : [])], current));
    throw error;
  }
  if (saved.full || !saved.photos) {
    // The gallery is full, so this photo was not added. Its files go, unless they are also
    // the files of a photo that is in the gallery already.
    const current = await deps.db.rpc<StoredPhotos>("site_photos_for", { p_restaurant: restaurantId, p_with_id: true });
    await removeFiles(deps, noLongerShown([imagePath, ...(smallPath ? [smallPath] : [])], current));
    throw new ApiError(409, "gallery_full", `The gallery holds ${MAX_GALLERY} photos. Remove one to add another.`);
  }
  // A replaced photo's files, unless something still shows them (the new photo is the very
  // same file again).
  await removeFiles(deps, noLongerShown(saved.unused ?? [], saved.photos));
  await audit(deps, session, {
    action: "SITE_PHOTO_SET", entityType: "site_photo", entityId: slot, newValues: { slot, image_path: imagePath }, result: "success",
  });
  return json(200, {
    result: "saved", photos: saved.photos,
    message: slot === "gallery" ? "Photo added to the gallery." : "Photo saved. The website shows it within a minute.",
  });
}

const describeBody = v.object({ alt: v.string({ max: 200 }) });

export async function describeSitePhoto(deps: Deps, session: Session, id: string, body: unknown): Promise<Response> {
  const { alt } = parseBody(describeBody, body);
  const photos = await deps.db.rpc<StoredPhotos | null>("dash_site_photo_describe", {
    p_restaurant: restaurantOf(session), p_id: id, p_alt: alt,
  });
  if (!photos) throw notFound();
  return json(200, { result: "saved", photos: photos, message: "Description saved." });
}

export async function removeSitePhoto(deps: Deps, session: Session, id: string): Promise<Response> {
  const removed = await deps.db.rpc<{ photos: StoredPhotos; unused: string[]; slot: string } | null>("dash_site_photo_remove", {
    p_restaurant: restaurantOf(session), p_id: id,
  });
  if (!removed) throw notFound();
  await removeFiles(deps, noLongerShown(removed.unused, removed.photos));
  // Recorded by where the photo was, as setting one is; the photo's own id means nothing now.
  await audit(deps, session, { action: "SITE_PHOTO_REMOVED", entityType: "site_photo", entityId: removed.slot, result: "success" });
  return json(200, { result: "saved", photos: removed.photos, message: "Photo removed." });
}

const reorderBody = v.object({ ids: v.array(uuid, { max: MAX_GALLERY, unique: true }) });

export async function reorderGallery(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const { ids } = parseBody(reorderBody, body);
  const photos = await deps.db.rpc<StoredPhotos | null>("dash_site_gallery_reorder", {
    p_restaurant: restaurantOf(session), p_ids: ids.map((id) => id.toLowerCase()),
  });
  if (!photos) {
    throw new ApiError(409, "conflict", "The gallery has changed since this page was loaded. Refresh and try again.");
  }
  return json(200, { result: "saved", photos: photos, message: "Gallery order saved." });
}
