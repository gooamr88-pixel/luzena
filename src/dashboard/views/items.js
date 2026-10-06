// Item list: search, filters, sorting, pagination, inline toggles and bulk actions.
import { priceLabel, timeAgo } from "../../js/lib/format.js";
import { api } from "../api.js";
import { can, currency, state } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, h, icon, loadingBlock, pageHeader, stateBlock, switchControl, toast, toastFailure } from "../ui.js";

const PAGE_SIZE = 25;
const SORTS = [
  ["name:asc", "Name (A to Z)"], ["name:desc", "Name (Z to A)"],
  ["price:asc", "Price (low to high)"], ["price:desc", "Price (high to low)"],
  ["updated:desc", "Recently updated"], ["category:asc", "Category"],
  ["custom:asc", "Menu order (choose a category)"],
];
const BULK = {
  show: { label: "Show on website", confirm: (n) => [`${n} items will become visible on the website.`] },
  hide: { label: "Hide from website", confirm: (n) => [`${n} items will be hidden from the website.`, "They stay in Clover and can still be sold at the register."] },
  available: { label: "Mark in stock", confirm: (n) => [`${n} items will be marked available in Clover.`, "This changes Clover, so the register and online ordering are affected."] },
  unavailable: { label: "Mark out of stock", confirm: (n) => [`${n} items will be marked unavailable in Clover.`, "This changes Clover, so the register and online ordering are affected."] },
  archive: { label: "Archive", danger: true, confirm: (n) => [`${n} items will be removed from the website and from this list.`, "Nothing is deleted in Clover. Archived items can be restored from the Archived filter."] },
  restore: { label: "Restore", confirm: (n) => [`${n} items will return to the active list.`] },
};

export const imageUrl = (path) => (path ? `${state.storageBase}/${path}` : null);

export async function itemsView(outlet, _match, query) {
  const writable = can("menu.write");
  const filters = {
    search: "", category: query.get("category") ?? "", availability: query.get("availability") ?? "",
    visibility: query.get("visibility") ?? "", status: query.get("status") ?? "active",
    featured: query.get("featured") ?? "", sort: "name:asc", offset: 0,
  };
  const selected = new Set();
  let data = null;
  let categories = [];

  const listRegion = h("div", { "aria-live": "polite" });
  const bulkBar = h("div", { class: "d-card mb-3 flex flex-wrap items-center gap-2 border-gold bg-[#fbf5ea] p-3", hidden: true });
  const toolbar = h("div", { class: "d-card mb-4 p-3" });

  append(outlet, 
    pageHeader({
      title: "Items",
      actions: writable && h("a", { href: "#/items/new", class: "d-btn d-btn-primary" }, icon("plus", 16), "Add item"),
    }),
    toolbar, bulkBar, listRegion,
  );

  const options = (key, choices) => choices.map(([value, text]) => h("option", { value, selected: filters[key] === value }, text));
  const select = (label, key, choices) => {
    const node = h("select", { class: "d-input", "aria-label": label }, options(key, choices));
    node.addEventListener("change", () => {
      filters[key] = node.value;
      filters.offset = 0;
      load();
    });
    return node;
  };

  const categoryChoices = () => [["", "All categories"], ["none", "No category"],
    ...categories.filter((c) => !c.removed_from_clover).map((c) => [c.id, c.name])];
  const categorySelect = select("Category", "category", categoryChoices());

  function drawToolbar() {
    const search = h("input", { class: "d-input col-span-2 lg:col-span-1", type: "search", placeholder: "Search items or categories", "aria-label": "Search items", value: filters.search, maxlength: 100 });
    let timer;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        filters.search = search.value;
        filters.offset = 0;
        load();
      }, 300);
    });
    clear(toolbar);
    const sortSelect = select("Sort", "sort", SORTS);
    sortSelect.classList.add("col-span-2", "lg:col-span-1");
    // Search and sort take a full row on phones and tablets, with the four filters two to a
    // row between them; three to a row on a laptop; all six in one row on a wide screen.
    append(toolbar, h("div", { class: "grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-[1.8fr_repeat(5,1fr)]" },
      search,
      categorySelect,
      select("Availability", "availability", [["", "Any stock"], ["available", "In stock"], ["unavailable", "Out of stock"]]),
      select("Visibility", "visibility", [["", "Any visibility"], ["visible", "On website"], ["hidden", "Hidden"]]),
      select("Status", "status", [["active", "Active"], ["archived", "Archived"], ["removed", "Removed in Clover"]]),
      sortSelect));
  }

  function drawBulkBar() {
    clear(bulkBar);
    bulkBar.hidden = selected.size === 0 || !writable;
    if (bulkBar.hidden) return;
    const actions = filters.status === "archived" ? ["restore"] : ["show", "hide", "available", "unavailable", "archive"];
    append(bulkBar, 
      h("p", { class: "mr-2 text-sm font-semibold" }, `${selected.size} selected`),
      actions.map((action) => h("button", { type: "button", class: "d-btn d-btn-sm", onClick: () => runBulk(action) }, BULK[action].label)),
      h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm ml-auto", onClick: () => { selected.clear(); draw(); } }, "Clear selection"));
  }

  async function runBulk(action) {
    const ids = [...selected];
    const confirmed = await confirmDialog({
      title: `${BULK[action].label}: ${ids.length} ${ids.length === 1 ? "item" : "items"}`,
      body: BULK[action].confirm(ids.length),
      confirmLabel: BULK[action].label,
      danger: BULK[action].danger,
    });
    if (!confirmed) return;
    try {
      const result = await api("POST", "/items/bulk", { ids, action });
      toast(result.message, result.result === "partial" ? "warn" : result.result === "failed" ? "bad" : "ok");
      // Keep the failed ones selected so they can be retried in one press.
      selected.clear();
      for (const failure of result.failed ?? []) selected.add(failure.id);
    } catch (failure) {
      toastFailure(failure);
    }
    await load();
  }

  // Sends one change and redraws the row from the server's answer. The row is never
  // changed before the server confirms.
  async function patch(item, body) {
    try {
      const result = await api("PATCH", `/items/${item.id}`, body);
      replaceItem(result.item);
      toast(result.message, result.result === "partial" ? "warn" : "ok");
    } catch (failure) {
      if (failure.code === "conflict" && failure.details.item) replaceItem(failure.details.item);
      toastFailure(failure);
      if (failure.code === "removed_in_clover") await load();
    }
  }

  function replaceItem(item) {
    data.items = data.items.map((existing) => (existing.id === item.id ? item : existing));
    draw();
  }

  const controls = (item) => ({
    available: () => switchControl({
      checked: item.available, label: `${item.name}: in stock`, disabled: !writable || item.removed_from_clover,
      onToggle: (next) => patch(item, { clover: { available: next }, expected: { available: item.available } }),
    }),
    visible: () => switchControl({
      checked: !item.web_hidden, label: `${item.name}: shown on website`, disabled: !writable,
      onToggle: (next) => patch(item, { website: { web_hidden: !next } }),
    }),
    actions: () => h("div", { class: "flex flex-wrap justify-end gap-1" },
      h("a", { href: `#/items/${item.id}`, class: "d-btn d-btn-sm" }, writable ? "Edit" : "View"),
      writable && !item.removed_from_clover && h("a", { href: `#/items/new?from=${item.id}`, class: "d-btn d-btn-quiet d-btn-sm" }, "Duplicate"),
      writable && h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm", onClick: () => archive(item) }, item.archived ? "Restore" : "Archive")),
    select: () => {
      const box = h("input", { type: "checkbox", class: "size-4", "aria-label": `Select ${item.name}`, checked: selected.has(item.id) });
      box.addEventListener("change", () => {
        if (box.checked) selected.add(item.id); else selected.delete(item.id);
        draw();
      });
      return box;
    },
    thumb: () => item.image_path
      ? h("img", { src: imageUrl(item.image_path), alt: "", width: 40, height: 40, loading: "lazy", class: "size-10 rounded-md object-cover" })
      : h("div", { class: "flex size-10 items-center justify-center rounded-md bg-sand text-line-strong" }, icon("image")),
    labels: () => [
      item.featured && badge("Featured", "info"),
      item.hidden && badge("Hidden in Clover", "warn"),
      item.archived && badge("Archived"),
      item.removed_from_clover && badge("Removed in Clover", "bad"),
    ],
    categories: () => item.categories.map((c) => c.name).join(", ") || "None",
    price: () => priceLabel(item, currency(), state.locale) || (item.price_type === "VARIABLE" ? "Variable" : ""),
  });

  async function archive(item) {
    if (!item.archived) {
      const confirmed = await confirmDialog({
        title: `Archive "${item.name}"?`,
        body: ["It will be removed from the website and from this list.", "It is not deleted in Clover and can still be sold at the register. You can restore it from the Archived filter."],
        confirmLabel: "Archive", danger: true,
      });
      if (!confirmed) return;
    }
    try {
      await api("PATCH", `/items/${item.id}`, { website: { archived: !item.archived } });
      toast(item.archived ? "Item restored." : "Item archived.");
    } catch (failure) {
      toastFailure(failure);
    }
    await load();
  }

  function draw() {
    drawBulkBar();
    clear(listRegion);
    if (data.items.length === 0) {
      const filtered = filters.search || filters.category || filters.availability || filters.visibility || filters.featured || filters.status !== "active";
      append(listRegion, filtered
        ? stateBlock({ title: "No items match these filters", body: "Change or clear the filters to see more items." })
        : stateBlock({
            title: "No items yet",
            body: "Items appear here once Clover is connected and synced, or when you add one.",
            action: [h("a", { href: "#/clover", class: "d-btn" }, "Clover connection"), writable && h("a", { href: "#/items/new", class: "d-btn d-btn-primary" }, "Add item")],
          }));
      return;
    }

    const pageIds = data.items.map((item) => item.id);
    const allSelected = pageIds.every((id) => selected.has(id));
    const selectAll = h("input", { type: "checkbox", class: "size-4", "aria-label": "Select all items on this page", checked: allSelected });
    selectAll.addEventListener("change", () => {
      for (const id of pageIds) { if (selectAll.checked) selected.add(id); else selected.delete(id); }
      draw();
    });

    const table = h("div", { class: "d-card hidden overflow-x-auto xl:block" },
      h("table", { class: "d-table" },
        h("caption", { class: "sr-only" }, "Menu items"),
        h("thead", {}, h("tr", {},
          writable && h("th", { scope: "col", class: "w-10" }, selectAll),
          h("th", { scope: "col", class: "w-14" }, h("span", { class: "sr-only" }, "Photo")),
          ["Item", "Category", "Price", "In stock", "On website"].map((title) => h("th", { scope: "col" }, title)),
          // The first column to go when the table runs out of room.
          h("th", { scope: "col", class: "hidden 2xl:table-cell" }, "Updated"),
          h("th", { scope: "col", class: "text-right" }, "Actions"))),
        h("tbody", {}, data.items.map((item) => {
          const c = controls(item);
          return h("tr", {},
            writable && h("td", {}, c.select()),
            h("td", {}, c.thumb()),
            h("th", { scope: "row", class: "text-left font-semibold" },
              h("a", { href: `#/items/${item.id}`, class: "hover:text-brand hover:underline" }, item.name),
              h("div", { class: "mt-1 flex flex-wrap gap-1 empty:hidden" }, c.labels())),
            h("td", { class: "text-muted" }, c.categories()),
            h("td", { class: "whitespace-nowrap tabular-nums" }, c.price()),
            h("td", {}, c.available()),
            h("td", {}, c.visible()),
            h("td", { class: "hidden whitespace-nowrap text-muted 2xl:table-cell" }, timeAgo(item.updated_at)),
            h("td", {}, c.actions()));
        }))));

    // Phones, tablets and small laptops get cards, not a squeezed table: every control keeps
    // a full-size touch target and no name or action wraps. Two to a row from 768px.
    const cards = h("ul", { class: "grid gap-3 md:grid-cols-2 xl:hidden" }, data.items.map((item) => {
      const c = controls(item);
      // The top of the card grows, so the switches and buttons line up across a row of cards.
      return h("li", { class: "d-card flex flex-col p-4" },
        h("div", { class: "flex flex-1 items-start gap-3" },
          writable && h("div", { class: "pt-1" }, c.select()),
          c.thumb(),
          h("div", { class: "min-w-0 flex-1" },
            h("a", { href: `#/items/${item.id}`, class: "font-semibold hover:text-brand hover:underline" }, item.name),
            h("p", { class: "text-sm text-muted" }, `${c.categories()}${c.price() ? `, ${c.price()}` : ""}`),
            h("div", { class: "mt-1.5 flex flex-wrap gap-1 empty:hidden" }, c.labels()))),
        h("div", { class: "mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm" },
          h("div", { class: "flex items-center justify-between gap-2" }, h("span", {}, "In stock"), c.available()),
          h("div", { class: "flex items-center justify-between gap-2" }, h("span", {}, "On website"), c.visible())),
        h("div", { class: "mt-3" }, c.actions()));
    }));

    const from = data.offset + 1;
    const to = data.offset + data.items.length;
    const pager = h("nav", { class: "mt-4 flex flex-wrap items-center justify-between gap-3 text-sm", "aria-label": "Pages" },
      h("p", { class: "text-muted" }, `${from} to ${to} of ${data.total}`),
      h("div", { class: "flex gap-2" },
        h("button", { type: "button", class: "d-btn d-btn-sm", disabled: data.offset === 0, onClick: () => { filters.offset = Math.max(0, data.offset - PAGE_SIZE); load(); } }, "Previous"),
        h("button", { type: "button", class: "d-btn d-btn-sm", disabled: to >= data.total, onClick: () => { filters.offset = data.offset + PAGE_SIZE; load(); } }, "Next")));

    append(listRegion, table, cards, pager);
  }

  async function load() {
    clear(listRegion);
    append(listRegion, loadingBlock("Loading items"));
    const [sort, dir] = filters.sort.split(":");
    const params = new URLSearchParams({ sort, dir, limit: String(PAGE_SIZE), offset: String(filters.offset), status: filters.status });
    for (const key of ["search", "category", "availability", "visibility", "featured"]) {
      if (filters[key]) params.set(key, filters[key]);
    }
    try {
      data = await api("GET", `/items?${params}`);
      // If the last item on a page was archived, step back instead of showing an empty page.
      if (data.items.length === 0 && data.total > 0 && filters.offset > 0) {
        filters.offset = Math.max(0, filters.offset - PAGE_SIZE);
        return load();
      }
      draw();
    } catch (failure) {
      clear(listRegion);
      append(listRegion, errorBlock(failure, load));
    }
  }

  drawToolbar();
  // Only the category list is filled in when it arrives. Redrawing the whole toolbar here
  // threw away a search the owner had already started typing.
  api("GET", "/categories").then((result) => {
    categories = result.categories;
    clear(categorySelect);
    append(categorySelect, options("category", categoryChoices()));
  }).catch(() => {});
  await load();
}
