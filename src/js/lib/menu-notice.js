// The allergy notice at the foot of the menu, as the restaurant wrote it in the dashboard.
// The dashboard's preview uses this same function, so the preview is the real thing.
//
// The wording is the restaurant's own and is set as text, never as markup. Each language is
// marked as what it is, so a screen reader pronounces it properly, and `dir="auto"` lets
// Arabic read right to left on this left-to-right page.
import { h } from "./dom.js";

export function menuNoticeElement(entries, { headingId = "menu-notice-title" } = {}) {
  const written = (entries ?? []).filter((entry) => entry?.text);
  if (written.length === 0) return null;
  return h("aside", { class: "menu-notice", "aria-labelledby": headingId },
    h("span", { class: "menu-notice-rule", "aria-hidden": "true" }),
    h("h2", { id: headingId, class: "menu-notice-title" }, "Allergies & dietary requirements"),
    written.map((entry) => h("p", { class: "menu-notice-text", lang: entry.lang, dir: "auto" }, entry.text)));
}
