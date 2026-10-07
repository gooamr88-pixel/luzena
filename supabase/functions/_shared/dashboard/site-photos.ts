// The website's own photos, managed from the dashboard: the home page's hero photo, the
// "our story" photo and the gallery.
//
// The dashboard shrinks and re-encodes each photo in the browser, twice: a full-size file
// and a smaller one for phones. The server does not trust that: it checks each file's size
// and reads its real type from its bytes. Paths are built here, from the restaurant, the
// slot and a hash of the content; nothing of the uploaded file's name is used.
import { sha256Hex } from "../crypto.ts";
import { IMAGE_TYPES, sniffImage } from "../files.ts";
import { ApiError, json } from "../http.ts";
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
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 2 * MAX_IMAGE_BYTES + 8192) throw new ApiError(413, "image_too_large", TOO_LARGE);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
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
    await removeFiles(deps, [imagePath, ...(smallPath ? [smallPath] : [])]);
    throw error;
  }
  if (saved.full || !saved.photos) {
    await removeFiles(deps, [imagePath, ...(smallPath ? [smallPath] : [])]);
    throw new ApiError(409, "gallery_full", `The gallery holds ${MAX_GALLERY} photos. Remove one to add another.`);
  }
  // A replaced photo's files, unless the new photo is the very same file again.
  await removeFiles(deps, (saved.unused ?? []).filter((path) => path !== imagePath && path !== smallPath));
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
  await removeFiles(deps, removed.unused);
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
