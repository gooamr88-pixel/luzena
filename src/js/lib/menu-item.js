// One menu item as it appears on the public website. The dashboard's preview uses this
// same function, so "preview" is the real rendering, not an imitation.
import { h } from "./dom.js";
import { dietaryLabel, formatPrice, priceLabel } from "./format.js";

export function menuItemElement(item, { currency, locale, showOptions = true } = {}) {
  const price = priceLabel(item, currency, locale);
  const groups = showOptions ? (item.modifier_groups ?? []).filter((group) => group.modifiers?.length) : [];

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
      item.description && h("p", { class: "mt-1.5 text-[0.95rem] text-muted" }, item.description),
      (item.available === false || item.dietary?.length > 0) && h("ul", { class: "mt-2.5 flex flex-wrap gap-1.5" },
        item.available === false && h("li", { class: "tag tag-muted" }, "Unavailable today"),
        (item.dietary ?? []).map((tag) => h("li", { class: "tag" }, dietaryLabel(tag))),
      ),
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
