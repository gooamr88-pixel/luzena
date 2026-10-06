// Item photos. Clover's item schema has no image field, so photos are website-only data,
// stored once in Supabase Storage and referenced from menu_items.web_image_path.
//
// The dashboard resizes and re-encodes the photo in the browser before upload. The server
// does not trust that: it checks size and sniffs the real type from the bytes.
import { sha256Hex } from "../crypto.ts";
import { IMAGE_TYPES, sniffImage } from "../files.ts";
import { ApiError, json } from "../http.ts";
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

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES + 4096) {
    throw new ApiError(413, "image_too_large", "The photo is too large. The maximum is 1 MB after optimisation.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
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
  const saved = await deps.db.rpc<{ item: unknown } | null>("web_update_item", {
    p_restaurant: restaurantId, p_item: itemId, p_patch: { image_path: path },
  });
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
