// Responsive images. Every photo in the content file is resized to a few widths and
// encoded as AVIF, WebP and JPEG. Results are cached in .cache/media so only new or
// changed photos are processed again.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import sharp from "sharp";
import { ROOT, contentPaths } from "./content.js";

const WIDTHS = [480, 800, 1200, 1920];
const FORMATS = {
  avif: (image) => image.avif({ quality: 52, effort: 4 }),
  webp: (image) => image.webp({ quality: 74 }),
  jpg: (image) => image.jpeg({ quality: 78, mozjpeg: true }),
};

export const cacheDir = (profile) => resolve(ROOT, ".cache", "media", profile);
const stemOf = (name) => name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-");

export function mediaNames(site) {
  return [
    site.hero?.image, site.about?.image, site.ogImage, site.logo, site.careers?.image,
    ...(site.locations ?? []).map((location) => location.image),
    ...(site.gallery ?? []).map((entry) => entry.image),
    ...(Array.isArray(site.defaultDishPhotos) ? site.defaultDishPhotos : []),
  ].filter((name) => typeof name === "string" && name !== "");
}

// A neutral stand-in used ONLY by the sample profile when a sample photo is absent, so
// layouts can still be reviewed. Production never reaches this: a missing photo is a
// validation error there.
function placeholder(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1280">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a2622"/><stop offset="1" stop-color="#151413"/></linearGradient></defs>
    <rect width="1920" height="1280" fill="url(#g)"/>
    <text x="960" y="650" text-anchor="middle" font-family="Georgia, serif" font-size="54" fill="#8a7f6c">Sample photo: ${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg));
}

// Returns { [name]: { width, height, variants: [{ width, avif, webp, jpg }], files: [...] } }
export async function buildMedia(profile, site) {
  const { media: sourceDir } = contentPaths(profile);
  const outDir = cacheDir(profile);
  mkdirSync(outDir, { recursive: true });
  const manifest = {};

  for (const name of new Set(mediaNames(site))) {
    const source = resolve(sourceDir, name);
    const stem = stemOf(name);
    const hasSource = existsSync(source);
    if (!hasSource && profile !== "sample") continue;

    if (extname(name).toLowerCase() === ".svg") {
      const fileName = `${stem}.svg`;
      await copyFile(source, resolve(outDir, fileName));
      manifest[name] = { vector: true, url: `/media/${fileName}`, files: [fileName] };
      continue;
    }

    const input = () => (hasSource ? sharp(source).rotate() : placeholder(stem));
    const meta = await input().metadata();
    const sourceWidth = meta.width ?? 1920;
    const ratio = (meta.height ?? 1280) / sourceWidth;
    const widths = WIDTHS.filter((width) => width <= sourceWidth);
    if (widths.length === 0) widths.push(sourceWidth);
    const sourceTime = hasSource ? statSync(source).mtimeMs : 0;

    const variants = [];
    const files = [];
    for (const width of widths) {
      const variant = { width };
      for (const [extension, encode] of Object.entries(FORMATS)) {
        const fileName = `${stem}-${width}.${extension}`;
        const target = resolve(outDir, fileName);
        if (!existsSync(target) || statSync(target).mtimeMs < sourceTime) {
          await encode(input().resize({ width, withoutEnlargement: true })).toFile(target);
        }
        variant[extension] = `/media/${fileName}`;
        files.push(fileName);
      }
      variants.push(variant);
    }
    const largest = widths[widths.length - 1];
    manifest[name] = { width: largest, height: Math.round(largest * ratio), variants, files };
  }

  await buildDefaultShareImage(sourceDir, outDir, site, manifest);
  return manifest;
}

// The image shown when a page is shared, for when no photo has been chosen (`ogImage`):
// the restaurant's own logo on its own background colour, at the 1200x630 size link
// previews use. It is made from the logo file, so it is the brand, not an invented photo.
const SHARE_BACKGROUND = "#f6f4f0";

async function buildDefaultShareImage(sourceDir, outDir, site, manifest) {
  const logo = typeof site.logo === "string" ? resolve(sourceDir, site.logo) : null;
  if (!logo || !existsSync(logo)) return;
  const fileName = "og-default.png";
  const target = resolve(outDir, fileName);
  if (!existsSync(target) || statSync(target).mtimeMs < statSync(logo).mtimeMs) {
    const mark = await sharp(logo, { density: 300 }).resize({ width: 780, height: 420, fit: "inside" }).png().toBuffer();
    await sharp({ create: { width: 1200, height: 630, channels: 4, background: SHARE_BACKGROUND } })
      .composite([{ input: mark, gravity: "centre" }])
      .png({ compressionLevel: 9 })
      .toFile(target);
  }
  manifest.__og = { vector: true, url: `/media/${fileName}`, files: [fileName] };
}

const escapeAttr = (value) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// <picture> with AVIF and WebP sources and a JPEG fallback. width/height are always set so
// the page does not shift when the image loads.
export function pictureHtml(manifest, name, options = {}) {
  const entry = manifest[name];
  if (!entry) return "";
  const { alt = "", sizes = "100vw", className = "", loading = "lazy", fetchpriority } = options;
  if (entry.vector) {
    return `<img src="${entry.url}" alt="${escapeAttr(alt)}" class="${escapeAttr(className)}" loading="${loading}" decoding="async">`;
  }
  const srcset = (format) => entry.variants.map((variant) => `${variant[format]} ${variant.width}w`).join(", ");
  const fallback = entry.variants.find((variant) => variant.width >= 1200) ?? entry.variants[entry.variants.length - 1];
  return [
    "<picture>",
    `<source type="image/avif" srcset="${srcset("avif")}" sizes="${escapeAttr(sizes)}">`,
    `<source type="image/webp" srcset="${srcset("webp")}" sizes="${escapeAttr(sizes)}">`,
    `<img src="${fallback.jpg}" srcset="${srcset("jpg")}" sizes="${escapeAttr(sizes)}" alt="${escapeAttr(alt)}"`,
    ` width="${entry.width}" height="${entry.height}" class="${escapeAttr(className)}" loading="${loading}" decoding="async"`,
    fetchpriority ? ` fetchpriority="${fetchpriority}"` : "",
    ">",
    "</picture>",
  ].join("");
}

// The JPEG of a photo at the smallest built width that is at least `width`, or the largest
// one there is. For the places that need a plain address rather than a <picture>.
export function jpegNear(manifest, name, width) {
  const entry = manifest[name];
  if (!entry || entry.vector) return null;
  return (entry.variants.find((variant) => variant.width >= width) ?? entry.variants[entry.variants.length - 1]).jpg;
}

export function largestJpeg(manifest, name) {
  const entry = manifest[name];
  if (!entry || entry.vector) return null;
  return (entry.variants.find((variant) => variant.width >= 1200) ?? entry.variants[entry.variants.length - 1]).jpg;
}
