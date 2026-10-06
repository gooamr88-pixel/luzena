// Categories: create, rename, reorder (drag or buttons), hide on the website, archive.
import { api, newIdempotencyKey } from "../api.js";
import { can } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, formDialog, h, icon, loadingBlock, pageHeader, stateBlock, switchControl, toast, toastFailure } from "../ui.js";

export async function categoriesView(outlet) {
  const writable = can("menu.write");
  const region = h("div", {});
  const orderBar = h("div", { class: "d-alert d-alert-info mb-4 flex flex-wrap items-center justify-between gap-3", hidden: true });
  let categories = [];
  // The order on screen. It differs from the saved order until "Save order" succeeds.
  let order = [];
  let savedOrder = [];

  const active = () => categories.filter((c) => !c.removed_from_clover);
  const orderChanged = () => order.join() !== savedOrder.join();

  const accept = (list) => {
    categories = list;
    savedOrder = active().map((c) => c.id);
    order = [...savedOrder];
    draw();
  };

  const add = () => {
    const key = newIdempotencyKey();
    formDialog({
      title: "Add category",
      intro: "The category is created in Clover and appears on the website once it has items.",
      fields: [{ name: "name", label: "Name", source: "Clover", required: true, maxlength: 127 }],
      submitLabel: "Create category",
      onSubmit: async (values) => {
        const result = await api("POST", "/categories", { name: values.name.trim() }, { "idempotency-key": key });
        accept(result.categories);
        toast(result.message);
      },
    });
  };

  const rename = (category) => formDialog({
    title: "Rename category",
    intro: "The name changes in Clover and on the website.",
    fields: [{ name: "name", label: "Name", source: "Clover", required: true, maxlength: 127, value: category.name }],
    onSubmit: async (values) => {
      const name = values.name.trim();
      if (name === category.name) return;
      try {
        const result = await api("PATCH", `/categories/${category.id}`, { clover: { name }, expected: { name: category.name } });
        accept(result.categories);
        toast(result.message);
      } catch (failure) {
        // After a conflict the list on screen is out of date; reload it behind the dialog.
        if (failure.code === "conflict") load();
        throw failure;
      }
    },
  });

  const setWebsite = async (category, patch, message) => {
    try {
      const result = await api("PATCH", `/categories/${category.id}`, { website: patch });
      accept(result.categories);
      toast(message);
    } catch (failure) {
      toastFailure(failure);
    }
  };

  const archive = async (category) => {
    if (!category.archived) {
      const confirmed = await confirmDialog({
        title: `Archive "${category.name}"?`,
        body: [
          `The category and its ${category.item_count} ${category.item_count === 1 ? "item" : "items"} will no longer appear under it on the website.`,
          "Nothing is deleted in Clover, and the items themselves are not archived. You can restore the category at any time.",
        ],
        confirmLabel: "Archive", danger: true,
      });
      if (!confirmed) return;
    }
    await setWebsite(category, { archived: !category.archived }, category.archived ? "Category restored." : "Category archived.");
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
      const result = await api("POST", "/categories/reorder", { ids: order });
      accept(result.categories);
      toast(result.message, result.result === "partial" ? "warn" : "ok");
    } catch (failure) {
      toastFailure(failure);
      if (failure.code === "conflict") await load();
      else draw();
    }
  };

  function draw() {
    clear(orderBar);
    orderBar.hidden = !orderChanged();
    if (!orderBar.hidden) {
      const save = h("button", { type: "button", class: "d-btn d-btn-primary d-btn-sm" }, "Save order");
      save.addEventListener("click", () => saveOrder(save));
      append(orderBar, 
        h("p", {}, "The order has changed but is not saved yet. Saving writes the new order to Clover."),
        h("div", { class: "flex gap-2" },
          h("button", { type: "button", class: "d-btn d-btn-sm", onClick: () => { order = [...savedOrder]; draw(); } }, "Undo"), save));
    }

    clear(region);
    if (categories.length === 0) {
      append(region, stateBlock({
        title: "No categories yet",
        body: "Categories are imported from Clover. Connect and sync Clover, or add a category here.",
        action: [h("a", { href: "#/clover", class: "d-btn" }, "Clover connection"), writable && h("button", { type: "button", class: "d-btn d-btn-primary", onClick: add }, "Add category")],
      }));
      return;
    }

    const byId = new Map(categories.map((c) => [c.id, c]));
    let dragged = null;
    const row = (id, index) => {
      const category = byId.get(id);
      const node = h("li", { class: "d-card flex flex-wrap items-center gap-x-3 gap-y-2 p-3", draggable: writable ? "true" : null, dataset: { id } },
        writable && h("span", { class: "hidden cursor-grab text-line-strong sm:block", "aria-hidden": "true", title: "Drag to reorder" }, icon("grip")),
        writable && h("div", { class: "flex" },
          h("button", { type: "button", class: "d-icon-btn", disabled: index === 0, "aria-label": `Move ${category.name} up`, dataset: { move: `${id}:up` }, onClick: () => move(index, -1) }, icon("up")),
          h("button", { type: "button", class: "d-icon-btn", disabled: index === order.length - 1, "aria-label": `Move ${category.name} down`, dataset: { move: `${id}:down` }, onClick: () => move(index, 1) }, icon("down"))),
        h("div", { class: "min-w-0 flex-1" },
          h("p", { class: "truncate font-semibold" }, category.name),
          h("p", { class: "flex flex-wrap items-center gap-2 text-sm text-muted" },
            h("a", { href: `#/items?category=${id}`, class: "hover:underline" }, `${category.item_count} ${category.item_count === 1 ? "item" : "items"}`),
            category.archived && badge("Archived"),
            category.web_hidden && !category.archived && badge("Hidden on website", "warn"))),
        h("label", { class: "flex items-center gap-2 text-sm" }, h("span", { class: "text-muted" }, "On website"),
          switchControl({
            checked: !category.web_hidden && !category.archived, label: `${category.name}: shown on website`,
            disabled: !writable || category.archived,
            onToggle: (next) => setWebsite(category, { web_hidden: !next }, next ? "Category is shown on the website." : "Category is hidden from the website."),
          })),
        writable && h("div", { class: "flex gap-1" },
          h("button", { type: "button", class: "d-btn d-btn-sm", onClick: () => rename(category) }, "Rename"),
          h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm", onClick: () => archive(category) }, category.archived ? "Restore" : "Archive")));

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

    const removed = categories.filter((c) => c.removed_from_clover);
    append(region, 
      h("ol", { class: "space-y-2", "aria-label": "Categories in menu order" }, order.map(row)),
      removed.length > 0 && h("details", { class: "mt-6 text-sm" },
        h("summary", { class: "cursor-pointer text-muted" }, `Removed in Clover (${removed.length})`),
        h("ul", { class: "mt-2 list-disc space-y-1 pl-5 text-muted" }, removed.map((c) => h("li", {}, c.name)))));
  }

  async function load() {
    clear(region);
    append(region, loadingBlock("Loading categories"));
    try {
      accept((await api("GET", "/categories")).categories);
    } catch (failure) {
      clear(region);
      append(region, errorBlock(failure, load));
    }
  }

  append(outlet, 
    pageHeader({
      title: "Categories",
      actions: writable && h("button", { type: "button", class: "d-btn d-btn-primary", onClick: add }, icon("plus", 16), "Add category"),
    }),
    h("p", { class: "mb-4 max-w-2xl text-sm text-muted" }, "Categories and their order come from Clover. The website lists them in this order. Drag a row, or use the arrows, then save."),
    orderBar, region,
  );
  await load();
}
