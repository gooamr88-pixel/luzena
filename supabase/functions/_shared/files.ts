// File-type detection from the bytes themselves. The browser-supplied MIME type and the
// file extension are both attacker-controlled and are used only as a cross-check.

export type DocumentKind = "pdf" | "doc" | "docx";
export type ImageKind = "webp" | "jpeg" | "png";

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

function includesAscii(bytes: Uint8Array, text: string, limit = bytes.length): boolean {
  const needle = [...text].map((char) => char.charCodeAt(0));
  const end = Math.min(bytes.length, limit) - needle.length;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function sniffDocument(bytes: Uint8Array): DocumentKind | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "doc"; // OLE2
  // A .docx is a ZIP whose entries include the Word document part.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && includesAscii(bytes, "word/")) return "docx";
  return null;
}

export const DOCUMENT_TYPES: Record<DocumentKind, { extension: string; mime: string }> = {
  pdf: { extension: "pdf", mime: "application/pdf" },
  doc: { extension: "doc", mime: "application/msword" },
  docx: { extension: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
};

// Active content that has no place in a CV. This is a cheap scan, not antivirus: content
// inside compressed PDF streams is not seen. See SECURITY.md.
export function hasActiveContent(bytes: Uint8Array, kind: DocumentKind): boolean {
  if (kind === "pdf") return includesAscii(bytes, "/JavaScript") || includesAscii(bytes, "/Launch");
  if (kind === "docx") return includesAscii(bytes, "vbaProject");
  return false;
}

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

export const IMAGE_TYPES: Record<ImageKind, { extension: string; mime: string }> = {
  webp: { extension: "webp", mime: "image/webp" },
  jpeg: { extension: "jpg", mime: "image/jpeg" },
  png: { extension: "png", mime: "image/png" },
};

// Keeps a filename usable in an email attachment header and a storage path: no path parts,
// no control characters, bounded length.
export function safeFilename(name: string, extension: string): string {
  const stem = name
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.[^.]*$/, "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${stem || "file"}.${extension}`;
}
