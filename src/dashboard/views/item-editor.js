// Create and edit one item.
//
// Every field shows where it is stored (Clover or Website). Saving sends only what changed.
// For Clover fields it also sends the values the editor loaded, so the server can refuse
// the save if Clover changed in the meantime. Nothing is shown as saved until the server
// confirms it.
import { centsToInput, dietaryLabel, formatDateTime, formatPrice, parsePriceToCents } from "../../js/lib/format.js";
import { menuItemElement } from "../../js/lib/menu-item.js";
import { api, explain, newIdempotencyKey } from "../api.js";
import { optimiseImage } from "../image.js";
import { can, currency, state } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, h, loadingBlock, pageHeader, source, stateBlock, toast, toastFailure } from "../ui.js";
import { imageUrl } from "./items.js";

const CLOVER_KEYS = ["name", "price_cents", "available", "hidden", "category_ids", "modifier_group_ids"];
const WEBSITE_KEYS = ["description", "featured", "web_hidden", "dietary"];
const FIELD_LABELS = {
  name: "Name", price_cents: "Price", available: "In stock", hidden: "Hidden in Clover",
  category_ids: "Categories", modifier_group_ids: "Modifier groups",
};

const sameList = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const same = (a, b) => (Array.isArray(a) ? sameList(a, b) : a === b);

// The editable part of an item, in one flat shape.
const snapshot = (item) => ({
  name: item?.name ?? "",
  price_cents: item?.price_cents ?? null,
  available: item?.available ?? true,
  hidden: item?.hidden ?? false,
  category_ids: (item?.categories ?? []).map((c) => c.id),
  modifier_group_ids: (item?.modifier_groups ?? []).map((g) => g.id),
  description: item?.description ?? "",
  featured: item?.featured ?? false,
  web_hidden: item?.web_hidden ?? false,
  dietary: item?.dietary ?? [],
});

export async function itemEditorView(outlet, itemId, duplicateFrom) {
  const isNew = itemId === null;
  const writable = can("menu.write");
  append(outlet, loadingBlock("Loading item"));

  let item = null;
  let categories;
  let groups;
  try {
    const [categoryData, groupData, itemData] = await Promise.all([
      api("GET", "/categories"),
      api("GET", "/modifier-groups"),
      itemId || duplicateFrom ? api("GET", `/items/${itemId ?? duplicateFrom}`) : null,
    ]);
    categories = categoryData.categories.filter((c) => !c.removed_from_clover && !c.archived);
    groups = groupData.modifier_groups;
    item = itemData?.item ?? null;
  } catch (failure) {
    clear(outlet);
    append(outlet, failure.status === 404
      ? stateBlock({ title: "This item does not exist", action: h("a", { href: "#/items", class: "d-btn" }, "Back to items") })
      : errorBlock(failure, () => { clear(outlet); itemEditorView(outlet, itemId, duplicateFrom); }));
    return;
  }

  // `initial` is what the server last confirmed. `draft` is what the form holds.
  let initial = snapshot(isNew ? null : item);
  const draft = snapshot(item);
  if (isNew && duplicateFrom && item) draft.name = `${item.name} (copy)`.slice(0, 127);
  const fixedPrice = isNew || !item || item.price_type === "FIXED";
  const removed = !isNew && item.removed_from_clover;
  const readOnly = !writable || removed;
  // One key per editor session: pressing Save again after a failed create retries the SAME
  // request, so the server can tell a retry from a second item.
  const idempotencyKey = newIdempotencyKey();

  let created = false;
  let photoError = null;

  const changed = (keys) => keys.filter((key) => !same(draft[key], initial[key]));
  const isDirty = () => changed([...CLOVER_KEYS, ...WEBSITE_KEYS]).length > 0;

  // ---- form controls ---------------------------------------------------------------------
  const status = h("div", { "aria-live": "polite", class: "space-y-3 empty:hidden" });
  const preview = h("ul", { class: "preview-surface" });
  const saveButton = h("button", { type: "submit", class: "d-btn d-btn-primary", disabled: readOnly }, isNew ? "Create item" : "Save changes");
  const dirtyNote = h("p", { class: "text-sm text-muted" });
  const errors = {};

  const errorNode = (key) => (errors[key] = h("p", { class: "d-error", id: `${key}-error`, hidden: true }));
  const setError = (key, message, input) => {
    errors[key].textContent = message;
    errors[key].hidden = !message;
    if (input) {
      if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    }
  };

  const nameInput = h("input", { class: "d-input", id: "name", type: "text", maxlength: 127, required: true, value: draft.name, disabled: readOnly, "aria-describedby": "name-error" });
  const priceInput = h("input", { class: "d-input", id: "price", type: "text", inputmode: "decimal", autocomplete: "off", value: centsToInput(draft.price_cents), disabled: readOnly || !fixedPrice, "aria-describedby": "price-error price-hint" });
  const descriptionInput = h("textarea", { class: "d-input", id: "description", rows: 3, maxlength: 600, disabled: !writable }, draft.description);
  const descriptionCount = h("span", { class: "shrink-0 whitespace-nowrap" });

  const checkbox = (id, label, checked, onChange, { disabled = false, hint } = {}) => {
    const box = h("input", { type: "checkbox", id, class: "mt-0.5 size-4 shrink-0", checked, disabled });
    box.addEventListener("change", () => { onChange(box.checked); refresh(); });
    return h("label", { class: "flex items-start gap-2.5 text-sm", for: id }, box,
      h("span", {}, label, hint && h("span", { class: "block text-[0.82rem] text-muted" }, hint)));
  };

  const checklist = (key, options, prefix, disabled) => options.length === 0
    ? h("p", { class: "text-sm text-muted" }, "None yet.")
    : h("div", { class: "grid gap-2 sm:grid-cols-2" }, options.map((option) =>
        checkbox(`${prefix}-${option.id}`, option.name, draft[key].includes(option.id), (on) => {
          draft[key] = on ? [...draft[key], option.id] : draft[key].filter((id) => id !== option.id);
        }, { disabled })));

  function refresh() {
    descriptionCount.textContent = `${draft.description.length} / 600`;
    const dirty = isDirty();
    dirtyNote.textContent = readOnly ? "" : dirty ? "You have unsaved changes." : isNew ? "" : "All changes saved.";
    state.leaveGuard = dirty && !readOnly
      ? () => confirmDialog({ title: "Discard unsaved changes?", body: "Your changes to this item have not been saved.", confirmLabel: "Discard changes", danger: true })
      : null;

    clear(preview);
    append(preview, menuItemElement({
      name: draft.name || "Item name",
      description: draft.description || null,
      price_cents: draft.price_cents,
      price_type: item?.price_type ?? "FIXED",
      unit_name: item?.unit_name ?? null,
      available: draft.available,
      dietary: draft.dietary,
      image_url: imageUrl(item && !isNew ? item.image_path : null),
      modifier_groups: groups.filter((g) => draft.modifier_group_ids.includes(g.id)),
    }, { currency: currency(), locale: state.locale }));
  }

  nameInput.addEventListener("input", () => { draft.name = nameInput.value.trim(); setError("name", "", nameInput); refresh(); });
  priceInput.addEventListener("input", () => {
    const cents = parsePriceToCents(priceInput.value);
    draft.price_cents = cents;
    setError("price", priceInput.value.trim() !== "" && cents === null ? "Enter an amount such as 12.50." : "", priceInput);
    refresh();
  });
  descriptionInput.addEventListener("input", () => { draft.description = descriptionInput.value.trim(); refresh(); });

  // ---- saving ----------------------------------------------------------------------------
  const alert = (tone, ...children) => h("div", { class: `d-alert d-alert-${tone}`, role: tone === "ok" ? "status" : "alert" }, children);

  function validate() {
    let first = null;
    if (!draft.name) { setError("name", "Enter a name.", nameInput); first = nameInput; }
    if (fixedPrice && draft.price_cents === null) { setError("price", "Enter a price, for example 12.50.", priceInput); first ??= priceInput; }
    first?.focus();
    return first === null;
  }

  function buildRequest() {
    const pick = (keys) => Object.fromEntries(keys.map((key) => [key, draft[key]]));
    const website = pick(isNew ? WEBSITE_KEYS.filter((key) => !same(draft[key], snapshot(null)[key])) : changed(WEBSITE_KEYS));
    if (isNew) {
      return { clover: pick(CLOVER_KEYS), ...(Object.keys(website).length ? { website } : {}) };
    }
    const cloverKeys = changed(CLOVER_KEYS);
    return {
      ...(cloverKeys.length ? { clover: pick(cloverKeys), expected: Object.fromEntries(cloverKeys.map((key) => [key, initial[key]])) } : {}),
      ...(Object.keys(website).length ? { website } : {}),
    };
  }

  function showConflict(failure) {
    const { conflicts, item: latest } = failure.details;
    const describe = (key, value) =>
      key === "price_cents" ? formatPrice(value, currency(), state.locale)
      : key === "category_ids" ? (value.map((id) => categories.find((c) => c.id === id)?.name ?? id).join(", ") || "none")
      : key === "modifier_group_ids" ? (value.map((id) => groups.find((g) => g.id === id)?.name ?? id).join(", ") || "none")
      : typeof value === "boolean" ? (value ? "yes" : "no") : String(value);

    const keepMine = h("button", { type: "button", class: "d-btn d-btn-sm" }, "Keep my values and save");
    const useClover = h("button", { type: "button", class: "d-btn d-btn-sm" }, "Use Clover's values");
    // Either way, "what the server last confirmed" becomes what Clover has now.
    const rebase = () => { item = latest; initial = { ...initial, ...Object.fromEntries(CLOVER_KEYS.map((key) => [key, snapshot(latest)[key]])) }; };
    keepMine.addEventListener("click", () => { rebase(); clear(status); save(); });
    useClover.addEventListener("click", () => {
      state.leaveGuard = null;
      clear(outlet);
      itemEditorView(outlet, itemId, null);
    });

    clear(status);
    append(status, alert("warn",
      h("p", { class: "font-semibold" }, "This item was changed in Clover while you were editing. Nothing was saved."),
      h("ul", { class: "mt-2 list-disc space-y-1 pl-5" }, Object.entries(conflicts).map(([key, value]) =>
        h("li", {}, `${FIELD_LABELS[key]}: Clover now has "${describe(key, value.actual)}". Your version: "${describe(key, draft[key])}".`))),
      h("div", { class: "mt-3 flex flex-wrap gap-2" }, keepMine, useClover)));
    status.scrollIntoView({ block: "nearest" });
  }

  async function save() {
    if (!validate()) return;
    const body = buildRequest();
    if (!isNew && Object.keys(body).length === 0) return;

    saveButton.disabled = true;
    const label = saveButton.textContent;
    saveButton.textContent = "Saving...";
    clear(status);
    append(status, alert("info", "Saving. Please keep this page open."));
    try {
      const result = isNew
        ? await api("POST", "/items", body, { "idempotency-key": idempotencyKey })
        : await api("PATCH", `/items/${itemId}`, body);

      if (isNew) {
        // The form is finished with: stop tracking it so leaving does not ask to discard.
        created = true;
        state.leaveGuard = null;
        toast(result.message, result.result === "partial" ? "warn" : "ok");
        location.hash = `#/items/${result.item.id}`;
        return;
      }
      item = result.item;
      initial = snapshot(item);
      clear(status);
      // After a partial save the fields Clover refused are still different from `initial`,
      // so the form stays dirty and Save sends only what is still outstanding.
      append(status, result.result === "partial"
        ? alert("warn", h("p", { class: "font-semibold" }, "Partly saved"), h("p", {}, result.message))
        : alert("ok", result.message));
      syncMeta();
    } catch (failure) {
      clear(status);
      if (failure.code === "conflict" && failure.details.conflicts) return showConflict(failure);
      if (failure.details?.fields) {
        const fields = failure.details.fields;
        if (fields["clover.name"]) setError("name", `Name ${fields["clover.name"]}.`, nameInput);
        if (fields["clover.price_cents"]) setError("price", `Price ${fields["clover.price_cents"]}.`, priceInput);
      }
      append(status, alert("bad",
        h("p", { class: "font-semibold" }, isNew ? "The item was not created" : "The changes were not saved"),
        h("p", {}, failure.details?.fields ? Object.values(failure.details.fields).join(" ") : explain(failure)),
        failure.details?.retryable && h("p", { class: "mt-1" }, "Your changes are still in the form. Press the save button to try again.")));
      status.scrollIntoView({ block: "nearest" });
    } finally {
      if (!created) {
        saveButton.disabled = readOnly;
        saveButton.textContent = label;
        refresh();
      }
    }
  }

  // ---- photo ------------------------------------------------------------------------------
  const photoRegion = h("div", {});
  function drawPhoto() {
    clear(photoRegion);
    if (isNew) {
      append(photoRegion, h("p", { class: "text-sm text-muted" }, "Create the item first, then add a photo."));
      return;
    }
    // The file input is visually hidden; the label is the button. `peer` moves the focus
    // ring onto the label so keyboard users can see where they are.
    const input = h("input", { type: "file", id: "photo", class: "peer sr-only", accept: "image/jpeg,image/png,image/webp", disabled: !writable });
    const choose = h("label", {
      for: "photo",
      class: `d-btn d-btn-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus ${writable ? "" : "pointer-events-none opacity-55"}`,
    }, item.image_path ? "Replace photo" : "Upload photo");
    const remove = item.image_path && writable && h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm" }, "Remove");

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      photoError = null;
      choose.textContent = "Optimising...";
      try {
        const form = new FormData();
        form.append("file", await optimiseImage(file));
        choose.textContent = "Uploading...";
        const result = await api("POST", `/items/${itemId}/image`, form);
        item = result.item;
        toast(result.message);
      } catch (failure) {
        photoError = failure.details ? explain(failure) : failure.message;
      }
      drawPhoto();
      refresh();
    });
    remove?.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Remove this photo?", body: "The item will be shown on the website without a photo.", confirmLabel: "Remove photo", danger: true }))) return;
      try {
        const result = await api("DELETE", `/items/${itemId}/image`);
        item = result.item;
        toast(result.message);
      } catch (failure) {
        toastFailure(failure);
      }
      drawPhoto();
      refresh();
    });

    append(photoRegion, h("div", { class: "flex flex-wrap items-center gap-4" },
      item.image_path
        ? h("img", { src: imageUrl(item.image_path), alt: "Current photo", width: 96, height: 96, class: "size-24 rounded-md object-cover" })
        : h("div", { class: "flex size-24 items-center justify-center rounded-md border border-dashed border-line-strong text-sm text-muted" }, "No photo"),
      h("div", { class: "space-y-2" },
        h("div", { class: "flex flex-wrap gap-2" }, input, choose, remove),
        h("p", { class: "d-hint" }, "JPEG, PNG or WebP. Photos are resized automatically before upload."))),
      photoError && h("p", { class: "d-error", role: "alert" }, photoError));
  }

  // ---- layout -----------------------------------------------------------------------------
  const meta = h("dl", { class: "space-y-1.5 text-sm" });
  function syncMeta() {
    clear(meta);
    if (isNew) return;
    for (const [term, value] of [["Clover ID", item.id], ["Last synced with Clover", formatDateTime(item.synced_at, state.locale)], ["Last changed", formatDateTime(item.updated_at, state.locale)]]) {
      append(meta, h("div", { class: "flex flex-wrap justify-between gap-x-4" }, h("dt", { class: "text-muted" }, term), h("dd", {}, value)));
    }
  }

  const section = (title, ...children) =>
    h("section", { class: "d-card p-5" }, h("h2", { class: "mb-4 text-base" }, title), h("div", { class: "space-y-5" }, children));
  const fieldBlock = (id, label, where, input, ...extra) =>
    h("div", {}, h("label", { class: "d-label", for: id }, label, source(where)), input, extra);

  const dietaryTags = state.me.dietary_tags ?? [];
  // On phones the save bar is fixed to the bottom of the screen, so the form needs room
  // underneath it (pb-28) for the last section to scroll clear.
  const form = h("form", { class: "grid items-start gap-5 pb-28 lg:grid-cols-[minmax(0,1fr)_22rem] lg:pb-0", novalidate: true },
    h("div", { class: "space-y-5" },
      status,
      section("Basic information",
        fieldBlock("name", "Name", "Clover", nameInput, errorNode("name")),
        fieldBlock("description", "Description", "Website", descriptionInput,
          h("p", { class: "d-hint flex justify-between gap-3" }, h("span", {}, "Shown under the item name on the website menu."), descriptionCount))),
      section("Pricing",
        fieldBlock("price", `Price (${currency()})`, "Clover", priceInput, errorNode("price"),
          h("p", { class: "d-hint", id: "price-hint" }, fixedPrice
            ? "Changing the price here changes it in Clover, at the register and for online orders."
            : "This item uses a variable or per-unit price, which is set in Clover."))),
      section("Categories", h("div", {}, h("p", { class: "d-label" }, "Shown in", source("Clover")), checklist("category_ids", categories, "cat", readOnly))),
      section("Availability and visibility",
        checkbox("available", h("span", { class: "flex flex-wrap items-center gap-2 font-semibold" }, "In stock", source("Clover")), draft.available,
          (on) => { draft.available = on; }, { disabled: readOnly, hint: "Turn off when you run out. The website shows the item as unavailable." }),
        checkbox("on-website", h("span", { class: "flex flex-wrap items-center gap-2 font-semibold" }, "Show on the website", source("Website")), !draft.web_hidden,
          (on) => { draft.web_hidden = !on; }, { disabled: !writable, hint: "Turn off to hide the item from the website only. Clover is not affected." })),
      section("Photo", h("div", {}, h("p", { class: "d-label" }, "Item photo", source("Website")), photoRegion)),
      section("Modifiers", h("div", {}, h("p", { class: "d-label" }, "Modifier groups offered with this item", source("Clover")),
        checklist("modifier_group_ids", groups, "grp", readOnly),
        h("p", { class: "d-hint" }, h("a", { href: "#/modifiers", class: "underline" }, "Manage modifier groups")))),
      section("Website presentation",
        checkbox("featured", h("span", { class: "flex flex-wrap items-center gap-2 font-semibold" }, "Feature on the home page", source("Website")), draft.featured,
          (on) => { draft.featured = on; }, { disabled: !writable, hint: "Up to six featured items are shown on the home page." }),
        h("fieldset", {}, h("legend", { class: "d-label" }, "Dietary labels", source("Website")),
          h("div", { class: "grid gap-2 sm:grid-cols-2" }, dietaryTags.map((tag) =>
            checkbox(`diet-${tag}`, dietaryLabel(tag), draft.dietary.includes(tag), (on) => {
              draft.dietary = on ? [...draft.dietary, tag] : draft.dietary.filter((entry) => entry !== tag);
            }, { disabled: !writable }))))),
      section("Advanced",
        checkbox("hidden", h("span", { class: "flex flex-wrap items-center gap-2 font-semibold" }, "Hide in Clover", source("Clover")), draft.hidden,
          (on) => { draft.hidden = on; }, { disabled: readOnly, hint: "Hides the item from the Clover register as well as from the website. Use \"Show on the website\" above to hide it from the website only." }),
        meta)),

    h("aside", { class: "space-y-4 lg:sticky lg:top-20" },
      h("div", { class: "d-card p-4" },
        h("h2", { class: "d-section-title mb-3" }, "Website preview"),
        preview,
        h("p", { class: "d-hint" }, "This is how the item appears on the public menu. The preview includes unsaved changes; customers see them only after you save.")),
      h("div", { class: "fixed inset-x-0 bottom-0 z-30 space-y-2 border-t border-line bg-surface p-3 shadow-[0_-4px_16px_rgb(0_0_0/0.08)] lg:static lg:space-y-3 lg:rounded-lg lg:border lg:p-4 lg:shadow-none" },
        dirtyNote,
        h("div", { class: "flex flex-wrap gap-2" }, saveButton, h("a", { href: "#/items", class: "d-btn" }, isNew ? "Cancel" : "Back to items")))),
  );
  form.addEventListener("submit", (event) => { event.preventDefault(); save(); });

  clear(outlet);
  append(outlet, 
    pageHeader({
      crumbs: [{ label: "Items", href: "#/items" }, { label: isNew ? "New item" : item.name }],
      title: isNew ? (duplicateFrom ? "Duplicate item" : "New item") : item.name,
      actions: !isNew && [item.archived && badge("Archived"), item.removed_from_clover && badge("Removed in Clover", "bad")],
    }),
    removed && h("div", { class: "d-alert d-alert-bad mb-5" }, "This item no longer exists in Clover. It is not shown on the website. Its website details are kept here for reference."),
    !writable && h("div", { class: "d-alert d-alert-info mb-5" }, "Your role can view items but not change them."),
    form,
  );
  syncMeta();
  drawPhoto();
  refresh();
  if (isNew) nameInput.focus();
}
