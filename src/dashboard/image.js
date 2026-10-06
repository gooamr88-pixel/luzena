// Shrinks and re-encodes a photo in the browser before it is uploaded. A phone photo of
// several megabytes becomes a WebP of a few hundred kilobytes. Re-encoding through a canvas
// also drops EXIF metadata, including the location a photo was taken.
//
// The server does not rely on this: it checks size and real file type again.

const MAX_EDGE = 1600;
const MAX_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

export async function optimiseImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Use a JPEG, PNG or WebP photo.");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("This photo is too large. Choose one under 25 MB.");

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This file could not be read as a photo.");
  }

  let edge = MAX_EDGE;
  for (let attempt = 0; attempt < 4; attempt++) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    // Browsers that cannot encode WebP silently return PNG, so check the result's type.
    let blob = await toBlob(canvas, "image/webp", 0.82);
    if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", 0.84);
    if (blob && blob.size <= MAX_BYTES) {
      bitmap.close?.();
      const extension = blob.type === "image/webp" ? "webp" : "jpg";
      return new File([blob], `photo.${extension}`, { type: blob.type });
    }
    edge = Math.round(edge * 0.8);
  }
  bitmap.close?.();
  throw new Error("This photo could not be reduced enough. Try a different photo.");
}
