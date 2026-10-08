// One menu item as it appears on the public website. The dashboard's preview uses this
// same function, so "preview" is the real rendering, not an imitation.
import { h } from "./dom.js";
import { dietaryLabel, formatPrice, priceLabel } from "./format.js";
import { labelIcon } from "./label-icons.js";

// How many labels a dish shows before the rest are folded away. A dish with a long list
// stays one tidy row; the others are one press away, and reachable by keyboard.
const LABELS_SHOWN = 4;

// One label: its icon, then its name. The name is always there as text, so the icon is
// never the only way the information is given; the icon itself is hidden from screen
// readers. A description, where the restaurant wrote one, is read after the name.
const labelElement = (label) =>
  h("li", { class: "dish-label", title: label.description || null },
    labelIcon(label.icon, 15),
    h("span", { class: "min-w-0" }, label.name),
    label.description && h("span", { class: "sr-only" }, `: ${label.description}`));

// The labels the restaurant has put on a dish, in the restaurant's order. Nothing here
// decides what a dish is or contains: it shows what the restaurant said.
function labelList(labels) {
  const shown = labels.slice(0, LABELS_SHOWN);
  const folded = labels.slice(LABELS_SHOWN);
  return h("div", { class: "dish-labels" },
    h("ul", { class: "dish-label-list", "aria-label": "Dietary and menu labels" }, shown.map(labelElement)),
    folded.length > 0 && h("details", { class: "dish-labels-more" },
      h("summary", {}, `+${folded.length} more`, h("span", { class: "sr-only" }, " labels")),
      h("ul", { class: "dish-label-list", "aria-label": "More dietary and menu labels" }, folded.map(labelElement))));
}

export function menuItemElement(item, { currency, locale, showOptions = true } = {}) {
  const price = priceLabel(item, currency, locale);
  const groups = showOptions ? (item.modifier_groups ?? []).filter((group) => group.modifiers?.length) : [];
  // `labels` is how the menu has been given a dish's attributes since labels became the
  // restaurant's own. A menu from before that carries `dietary` instead, and is shown as it
  // was; a menu with both is the new one, so the old list is not shown twice.
  const labels = Array.isArray(item.labels) ? item.labels.filter((label) => label?.name) : null;
  const dietary = labels === null ? (item.dietary ?? []) : [];

  return h("li", { class: `menu-item${item.available === false ? " menu-item-unavailable" : ""}` },
    item.image_url && h("img", {
      src: item.image_url, alt: "", width: 88, height: 88, loading: "lazy", decoding: "async",
      class: "size-[5.5rem] shrink-0 rounded-lg object-cover",
    }),
    h("div", { class: "min-w-0 flex-1" },
      h("div", { class: "flex items-baseline" },
        h("h3", { class: "menu-item-name" }, item.name),
        // The dotted leader only makes sense when there is a price for it to lead to.
        price && h("span", { class: "menu-item-leader", "aria-hidden": "true" }),
        price && h("span", { class: "menu-item-price" }, price),
      ),
      // The owner's own words, set as text: markup in them is shown as the characters it is.
      // `dir="auto"` lets an Arabic description read right to left on this English page.
      item.description && h("p", { class: "mt-1.5 text-[0.95rem] whitespace-pre-line text-muted", dir: "auto" }, item.description),
      (item.available === false || dietary.length > 0) && h("ul", { class: "mt-2.5 flex flex-wrap gap-1.5" },
        item.available === false && h("li", { class: "tag tag-muted" }, "Unavailable today"),
        dietary.map((tag) => h("li", { class: "tag" }, dietaryLabel(tag))),
      ),
      labels?.length > 0 && labelList(labels),
      groups.length > 0 && h("details", { class: "mt-3 text-sm" },
        h("summary", { class: "cursor-pointer text-body underline decoration-ink/30 underline-offset-4 hover:text-brand" }, "Options"),
        h("div", { class: "mt-3 space-y-3" }, groups.map((group) =>
          h("div", {},
            h("p", { class: "text-[0.72rem] font-semibold tracking-[0.12em] text-ink uppercase" }, group.name),
            h("ul", { class: "mt-1 text-muted" }, group.modifiers.map((modifier) =>
              h("li", { class: modifier.available === false ? "line-through" : "" },
                modifier.name,
                modifier.price_cents > 0 && ` (+${formatPrice(modifier.price_cents, currency, locale)})`,
              ))),
          ))),
      ),
    ),
  );
}
