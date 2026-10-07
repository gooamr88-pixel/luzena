// Item photos. Clover's item schema has no image field, so photos are website-only data,
// stored once in Supabase Storage and referenced from menu_items.web_image_path.
//
// The dashboard resizes and re-encodes the photo in the browser before upload. The server
// does not trust that: it checks size and sniffs the real type from the bytes.
import { sha256Hex } from "../crypto.ts";
import { IMAGE_TYPES, sniffImage } from "../files.ts";
import { ApiError, json, readForm } from "../http.ts";
import type { Deps, Session } from "../types.ts";
import { audit } from "./session.ts";

export const IMAGE_BUCKET = "menu-images";
const MAX_IMAGE_BYTES = 1024 * 1024;

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;

async function currentImage(deps: Deps, session: Session, itemId: string): Promise<string | null> {
  const item = await deps.db.rpc<{ image_path: string | null } | null>("dash_get_item", {
    p_restaurant: restaurantOf(session), p_item: itemId,
  });
  if (!item) throw new ApiError(404, "not_found", "This item does not exist.");
  return item.image_path;
}

export async function uploadItemImage(deps: Deps, session: Session, itemId: string, request: Request): Promise<Response> {
  const previous = await currentImage(deps, session, itemId);

  // Read under a cap on the bytes that actually arrive, not on the length the caller declares.
  let form: FormData;
  try {
    form = await readForm(request, MAX_IMAGE_BYTES + 4096,
      () => new ApiError(413, "image_too_large", "The photo is too large. The maximum is 1 MB after optimisation."));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_upload", "The upload could not be read.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(422, "validation_failed", "Choose a photo to upload.");
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    throw new ApiError(413, "image_too_large", "The photo is too large. The maximum is 1 MB after optimisation.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw new ApiError(415, "unsupported_image", "Use a JPEG, PNG or WebP photo.");

  // The path is built entirely server-side: tenant, item, and a content hash. Nothing from
  // the uploaded filename is used. A new hash also means a new URL, so CDN caches never
  // show the old photo.
  const restaurantId = restaurantOf(session);
  const hash = (await sha256Hex(bytes)).slice(0, 20);
  const path = `${restaurantId}/${itemId}/${hash}.${IMAGE_TYPES[kind].extension}`;

  await deps.files.upload(IMAGE_BUCKET, path, bytes, IMAGE_TYPES[kind].mime);
  let saved: { item: unknown } | null;
  try {
    saved = await deps.db.rpc<{ item: unknown } | null>("web_update_item", {
      p_restaurant: restaurantId, p_item: itemId, p_patch: { image_path: path },
    });
  } catch (error) {
    // Nothing points at the file that was just stored, so it must not stay. Unless it is the
    // photo the item already had, sent again: then it is still the item's photo.
    if (path !== previous) {
      await deps.files.remove(IMAGE_BUCKET, [path]).catch((cleanup) =>
        deps.log.warn("image_cleanup_failed", { path, error_message: String(cleanup) })
      );
    }
    throw error;
  }
  if (previous && previous !== path) {
    await deps.files.remove(IMAGE_BUCKET, [previous]).catch((error) =>
      deps.log.warn("image_cleanup_failed", { path: previous, error_message: String(error) })
    );
  }
  await audit(deps, session, {
    action: "ITEM_IMAGE_UPDATED", entityType: "item", entityId: itemId,
    oldValues: { image_path: previous }, newValues: { image_path: path }, result: "success",
  });
  return json(200, { result: "saved", item: saved?.item ?? null, message: "Photo saved." });
}

export async function removeItemImage(deps: Deps, session: Session, itemId: string): Promise<Response> {
  const previous = await currentImage(deps, session, itemId);
  const saved = await deps.db.rpc<{ item: unknown } | null>("web_update_item", {
    p_restaurant: restaurantOf(session), p_item: itemId, p_patch: { image_path: null },
  });
  if (previous) {
    await deps.files.remove(IMAGE_BUCKET, [previous]).catch((error) =>
      deps.log.warn("image_cleanup_failed", { path: previous, error_message: String(error) })
    );
    await audit(deps, session, {
      action: "ITEM_IMAGE_REMOVED", entityType: "item", entityId: itemId,
      oldValues: { image_path: previous }, result: "success",
    });
  }
  return json(200, { result: "saved", item: saved?.item ?? null, message: "Photo removed." });
}

// A photo for a menu category: what its tile on the home page shows. Website-only, like a
// dish's photo, and handled the same way: read under a cap, typed by its bytes, stored
// under a path made here from the restaurant, the category and a hash of the content.
//
// Without one, the website borrows the photo of one of the category's dishes, or one of the
// photos it was built with. So removing it is "go back to the automatic photo".
interface CategoryPhotoSaved {
  previous: string | null;
  categories: unknown;
}

const categoryNotFound = () => new ApiError(404, "not_found", "This category does not exist.");

const setCategoryImage = (deps: Deps, session: Session, categoryId: string, path: string | null) =>
  deps.db.rpc<CategoryPhotoSaved | null>("dash_category_set_image", {
    p_restaurant: restaurantOf(session), p_category: categoryId, p_path: path,
  });

const discard = (deps: Deps, path: string) =>
  deps.files.remove(IMAGE_BUCKET, [path]).catch((error) =>
    deps.log.warn("image_cleanup_failed", { path, error_message: String(error) })
  );

export async function uploadCategoryImage(deps: Deps, session: Session, categoryId: string, request: Request): Promise<Response> {
  const tooLarge = () => new ApiError(413, "image_too_large", "The photo is too large. The maximum is 1 MB after optimisation.");
  let form: FormData;
  try {
    form = await readForm(request, MAX_IMAGE_BYTES + 4096, tooLarge);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_upload", "The upload could not be read.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(422, "validation_failed", "Choose a photo to upload.");
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw tooLarge();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw new ApiError(415, "unsupported_image", "Use a JPEG, PNG or WebP photo.");

  // The category is looked up before anything is stored: no file is kept for a category
  // that is not this restaurant's, or that Clover no longer has.
  const restaurantId = restaurantOf(session);
  const categories = await deps.db.rpc<{ id: string; image_path: string | null; removed_from_clover: boolean }[]>(
    "dash_list_categories", { p_restaurant: restaurantId });
  const current = categories.find((category) => category.id === categoryId && !category.removed_from_clover);
  if (!current) throw categoryNotFound();

  const hash = (await sha256Hex(bytes)).slice(0, 20);
  const path = `${restaurantId}/categories/${categoryId}/${hash}.${IMAGE_TYPES[kind].extension}`;
  await deps.files.upload(IMAGE_BUCKET, path, bytes, IMAGE_TYPES[kind].mime);

  let saved: CategoryPhotoSaved | null;
  try {
    saved = await setCategoryImage(deps, session, categoryId, path);
  } catch (error) {
    // Nothing points at the file that was just stored, so it must not stay. Unless it is
    // the photo the category already had, sent again: then it is still the category's.
    if (path !== current.image_path) await discard(deps, path);
    throw error;
  }
  if (!saved) {
    // The category went between the look-up and the save.
    await discard(deps, path);
    throw categoryNotFound();
  }
  if (saved.previous && saved.previous !== path) await discard(deps, saved.previous);
  await audit(deps, session, {
    action: "CATEGORY_IMAGE_UPDATED", entityType: "category", entityId: categoryId,
    oldValues: { image_path: saved.previous }, newValues: { image_path: path }, result: "success",
  });
  return json(200, { result: "saved", categories: saved.categories, message: "Photo saved. The website shows it within a minute." });
}

export async function removeCategoryImage(deps: Deps, session: Session, categoryId: string): Promise<Response> {
  const saved = await setCategoryImage(deps, session, categoryId, null);
  if (!saved) throw categoryNotFound();
  if (saved.previous) {
    await discard(deps, saved.previous);
    await audit(deps, session, {
      action: "CATEGORY_IMAGE_REMOVED", entityType: "category", entityId: categoryId,
      oldValues: { image_path: saved.previous }, result: "success",
    });
  }
  return json(200, { result: "saved", categories: saved.categories, message: "Photo removed. The website chooses one for this category again." });
}
