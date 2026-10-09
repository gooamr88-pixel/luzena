// The order of the items inside one category, as the website lists them. Reorder by drag or
// buttons, then save; the same way categories are put in order. This order is the
// website's own: Clover is not changed, and a sync with Clover keeps it.
import { formatPrice, priceLabel } from "../../js/lib/format.js";
import { api } from "../api.js";
import { can, currency, state } from "../state.js";
import { append, badge, clear, errorBlock, h, icon, loadingBlock, pageHeader, stateBlock, toast, toastFailure } from "../ui.js";
import { imageUrl } from "./items.js";

const PAGE = 100;

// Every active item of the category, in the website's order. The list API pages at 100.
async function itemsInOrder(categoryId) {
  const items = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await api("GET", `/items?category=${categoryId}&sort=custom&status=active&limit=${PAGE}&offset=${offset}`);
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}

export async function categoryOrderView(outlet, match) {
  const categoryId = match[1];
  const writable = can("menu.write");
  const region = h("div", {});
  const orderBar = h("div", { class: "d-alert d-alert-info mb-4 flex flex-wrap items-center justify-between gap-3", hidden: true, dataset: { orderBar: "" } });
  const heading = h("div", {});
  let items = [];
  // The order on screen. It differs from the saved order until "Save order" succeeds.
  let order = [];
  let savedOrder = [];

  const orderChanged = () => order.join() !== savedOrder.join();

  const accept = (list) => {
    items = list;
    savedOrder = items.map((item) => item.id);
    order = [...savedOrder];
    draw();
  };

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    draw();
    // Keep keyboard focus on the row that moved.
    region.querySelector(`[data-move="${order[target]}:${delta < 0 ? "up" : "down"}"]`)?.focus();
  };

  const saveOrder = async (button) => {
    button.disabled = true;
    button.textContent = "Saving...";
    try {
      const result = await api("POST", `/categories/${categoryId}/items/reorder`, { ids: order });
      // Read the order back, so what is on screen is what was stored.
      accept(await itemsInOrder(categoryId));
      toast(result.message);
    } catch (failure) {
      toastFailure(failure);
      draw();
    }
  };

  const price = (item) => priceLabel(item, currency(), state.locale)
    || (item.price_type === "VARIABLE" ? "Variable" : item.price_cents === 0 ? formatPrice(0, currency(), state.locale) : "");

  function draw() {
    clear(orderBar);
    orderBar.hidden = !orderChanged();
    if (!orderBar.hidden) {
      const save = h("button", { type: "button", class: "d-btn d-btn-primary d-btn-sm" }, "Save order");
      save.addEventListener("click", () => saveOrder(save));
      append(orderBar,
        h("p", {}, "The order has changed but is not saved yet. Saving changes the website only; Clover is not changed."),
        h("div", { class: "flex gap-2" },
          h("button", { type: "button", class: "d-btn d-btn-sm", onClick: () => { order = [...savedOrder]; draw(); } }, "Undo"), save));
    }

    clear(region);
    if (items.length === 0) {
      append(region, stateBlock({
        title: "No items in this category",
        body: "Items are put in a category in Clover, or in the item editor here.",
        action: h("a", { href: "#/categories", class: "d-btn" }, "Back to categories"),
      }));
      return;
    }

    const byId = new Map(items.map((item) => [item.id, item]));
    let dragged = null;
    const row = (id, index) => {
      const item = byId.get(id);
      const offWebsite = item.web_hidden || item.hidden;
      const node = h("li", { class: "d-card flex items-center gap-x-2 p-3 sm:gap-x-3 sm:px-4", draggable: writable ? "true" : null, dataset: { id } },
        writable && h("span", { class: "hidden cursor-grab text-line-strong sm:block", "aria-hidden": "true", title: "Drag to reorder" }, icon("grip")),
        writable && h("div", { class: "flex" },
          h("button", { type: "button", class: "d-icon-btn", disabled: index === 0, "aria-label": `Move ${item.name} up`, dataset: { move: `${id}:up` }, onClick: () => move(index, -1) }, icon("up")),
          h("button", { type: "button", class: "d-icon-btn", disabled: index === order.length - 1, "aria-label": `Move ${item.name} down`, dataset: { move: `${id}:down` }, onClick: () => move(index, 1) }, icon("down"))),
        h("span", { class: "hidden w-7 text-right text-sm tabular-nums text-muted sm:block", "aria-hidden": "true" }, String(index + 1)),
        item.image_path
          ? h("img", { src: imageUrl(item.image_path), alt: "", width: 40, height: 40, loading: "lazy", class: "hidden size-10 rounded-md object-cover sm:block" })
          : h("div", { class: "hidden size-10 items-center sm:flex justify-center rounded-md bg-sand text-line-strong" }, icon("image")),
        h("div", { class: "min-w-0 flex-1" },
          h("p", { class: "font-semibold break-words" }, item.name),
          h("p", { class: "flex flex-wrap items-center gap-2 text-sm text-muted" },
            price(item) && h("span", {}, price(item)),
            item.featured && badge("Featured", "info"),
            offWebsite && badge(item.hidden ? "Hidden in Clover" : "Hidden on website", "warn"),
            !item.available && badge("Out of stock"))),
        h("a", { href: `#/items/${item.id}`, class: "d-btn d-btn-quiet d-btn-sm" }, writable ? "Edit" : "View"));

      if (writable) {
        node.addEventListener("dragstart", (event) => {
          dragged = id;
          event.dataTransfer.effectAllowed = "move";
          node.classList.add("opacity-50");
        });
        node.addEventListener("dragend", () => node.classList.remove("opacity-50"));
        node.addEventListener("dragover", (event) => { if (dragged && dragged !== id) event.preventDefault(); });
        node.addEventListener("drop", (event) => {
          event.preventDefault();
          if (!dragged || dragged === id) return;
          order.splice(order.indexOf(dragged), 1);
          order.splice(order.indexOf(id) + (event.offsetY > node.offsetHeight / 2 ? 1 : 0), 0, dragged);
          dragged = null;
          draw();
        });
      }
      return node;
    };

    append(region, h("ol", { class: "space-y-2", "aria-label": "Items in website order" }, order.map(row)));
  }

  async function load() {
    clear(region);
    append(region, loadingBlock("Loading items"));
    try {
      const [{ categories }, list] = await Promise.all([api("GET", "/categories"), itemsInOrder(categoryId)]);
      const category = categories.find((c) => c.id === categoryId);
      if (!category) {
        clear(region);
        append(region, stateBlock({
          title: "This category does not exist",
          body: "It may have been deleted in Clover.",
          action: h("a", { href: "#/categories", class: "d-btn" }, "Back to categories"),
        }));
        return;
      }
      clear(heading);
      append(heading,
        pageHeader({ crumbs: [{ href: "#/categories", label: "Categories" }, { label: category.name }], title: `Item order: ${category.name}` }),
        h("p", { class: "-mt-3 mb-6 max-w-2xl text-sm text-muted" },
          "The website lists this category's items in this order. Drag a row, or use the arrows, then save. Only the website changes: Clover keeps its own order, and a sync with Clover does not undo this one. An item added later goes to the end."));
      accept(list);
    } catch (failure) {
      clear(region);
      append(region, errorBlock(failure, load));
    }
  }

  append(heading, pageHeader({ crumbs: [{ href: "#/categories", label: "Categories" }], title: "Item order" }));
  append(outlet, heading, orderBar, region);
  await load();
}
