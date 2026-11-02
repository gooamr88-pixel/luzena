// Special offers: the slides of the carousel at the top of the home page. The owner adds
// them, puts them in order, switches each on or off and can give each a first and a last
// day. The website shows those that are switched on and within their dates, within about a
// minute of a change, with no deployment.
import { dayOf, dayStart, lastDayOf, nextDay, offerStatus, validThrough } from "../../js/lib/offers.js";
import { api, explain } from "../api.js";
import { optimiseSitePhoto } from "../image.js";
import { state } from "../state.js";
import {
  append, badge, clear, confirmDialog, errorBlock, h, icon, loadingBlock, openDialog, pageHeader, stateBlock, switchControl, toast, toastFailure,
} from "../ui.js";

const ACCEPT = "image/jpeg,image/png,image/webp";
// A slide's photo fills about half of a card some 34rem wide, at twice the pixels for sharp
// screens; phones are given the smaller copy.
const PHOTO_SIZE = { edge: 1600, smallEdge: 720 };
// Where a button usually leads. Anything else is typed in as "Another address".
const DESTINATIONS = [
  { value: "/menu/", label: "The menu" },
  { value: "/order/", label: "Order online" },
  { value: "/locations/", label: "Location and hours" },
  { value: "/contact/", label: "Contact" },
  { value: "other", label: "Another address" },
  { value: "", label: "No button" },
];
const LIMITS = { badge: 40, highlight: 24, title: 80, description: 240, cta_label: 30, cta_url: 500, fine_print: 80, alt: 200 };

const address = (path) => (/^(blob:|https?:|\/)/.test(path) ? path : `${state.storageBase}/${path}`);

export async function offersView(outlet) {
  const region = h("div", {}, loadingBlock("Loading offers"));
  const addButton = h("button", { type: "button", class: "d-btn d-btn-primary", onClick: () => editor(null) }, icon("plus"), "Add offer");
  append(outlet,
    pageHeader({ title: "Special offers", actions: addButton }),
    h("p", { class: "-mt-3 mb-6 max-w-2xl text-sm text-muted" },
      "The offers carousel at the top of the home page. Visitors see the offers that are switched on and within their dates, in this order. A change is on the website within about a minute. With no offer to show, the carousel is not on the page."),
    region);

  let offers = [];
  let timezone = "America/Los_Angeles";
  let limits = { offers: 12 };

  const formatDay = (day) => new Intl.DateTimeFormat(state.locale, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${day}T00:00:00Z`));

  // In words, when an offer is on the website: "From Mon, Nov 3 to Sun, Nov 9".
  function scheduleText(offer) {
    const first = offer.starts_at ? formatDay(dayOf(offer.starts_at, timezone)) : null;
    const last = offer.ends_at ? formatDay(lastDayOf(offer.ends_at, timezone)) : null;
    if (first && last) return `From ${first} to ${last}`;
    if (first) return `From ${first}, until switched off`;
    if (last) return `Until ${last}`;
    return "No dates: shown while switched on";
  }

  function statusBadge(offer) {
    const status = offerStatus(offer);
    if (status === "live") return badge("On the website", "ok");
    if (status === "scheduled") return badge(`Starts ${formatDay(dayOf(offer.starts_at, timezone))}`, "info");
    if (status === "ended") return badge("Ended", "warn");
    return badge("Switched off");
  }

  async function save(change) {
    try {
      const result = await change();
      offers = result.offers;
      toast(result.message);
    } catch (failure) {
      toastFailure(failure);
    }
    draw();
  }

  async function move(index, delta) {
    const ids = offers.map((offer) => offer.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    await save(() => api("POST", "/site/offers/reorder", { ids }));
    // Keep the keyboard on the offer that moved.
    const arrows = [delta < 0 ? "earlier" : "later", delta < 0 ? "later" : "earlier"];
    const moved = arrows.map((arrow) => region.querySelector(`[data-move="${ids[index + delta]}:${arrow}"]`));
    moved.find((button) => button && !button.disabled)?.focus();
  }

  async function remove(offer) {
    if (!(await confirmDialog({
      title: `Remove "${offer.title}"?`,
      body: ["The offer is taken off the website and deleted, with its photo.", "To keep it for another time, switch it off instead."],
      confirmLabel: "Remove offer", danger: true,
    }))) return;
    await save(() => api("DELETE", `/site/offers/${offer.id}`));
  }

  function row(offer, index) {
    const status = offerStatus(offer);
    const live = status === "live";
    return h("li", { class: `d-card d-offer-row ${live ? "" : "d-offer-row-quiet"}`, dataset: { offer: offer.id } },
      h("div", { class: "d-offer-thumb" },
        offer.image
          ? h("img", { src: address(offer.image.small_path ?? offer.image.path), alt: "", loading: "lazy", decoding: "async" })
          : h("span", { class: "d-leaf size-10 opacity-40", "aria-hidden": "true" }),
        h("span", { class: "d-offer-number" }, String(index + 1), h("span", { class: "sr-only" }, " in the carousel"))),
      h("div", { class: "min-w-0 flex-1" },
        h("div", { class: "flex flex-wrap items-center gap-2" }, statusBadge(offer), offer.badge && h("span", { class: "text-xs font-semibold tracking-[0.14em] text-muted uppercase" }, offer.badge)),
        h("h2", { class: "mt-1.5 text-[1.05rem] leading-snug font-semibold" },
          offer.highlight && h("span", { class: "text-brand" }, `${offer.highlight} `), offer.title),
        offer.description && h("p", { class: "mt-1 line-clamp-2 text-sm text-muted" }, offer.description),
        h("p", { class: "mt-2 flex items-center gap-1.5 text-[0.8rem] text-muted" }, icon("calendar", 14), scheduleText(offer))),
      h("div", { class: "d-offer-actions" },
        h("label", { class: "flex items-center gap-2 text-sm font-medium" },
          switchControl({
            checked: offer.active, label: `Show "${offer.title}" on the website`,
            // The list is drawn again; the keyboard stays on this offer's switch.
            onToggle: async (active) => {
              await save(() => api("PATCH", `/site/offers/${offer.id}`, { active }));
              region.querySelector(`[data-offer="${offer.id}"] [role="switch"]`)?.focus();
            },
          }),
          h("span", { "aria-hidden": "true" }, offer.active ? "On" : "Off")),
        h("div", { class: "flex items-center gap-1" },
          h("button", { type: "button", class: "d-icon-btn", disabled: index === 0, "aria-label": `Move "${offer.title}" earlier`, dataset: { move: `${offer.id}:earlier` }, onClick: () => move(index, -1) }, icon("up")),
          h("button", { type: "button", class: "d-icon-btn", disabled: index === offers.length - 1, "aria-label": `Move "${offer.title}" later`, dataset: { move: `${offer.id}:later` }, onClick: () => move(index, 1) }, icon("down")),
          h("button", { type: "button", class: "d-btn d-btn-sm", onClick: () => editor(offer) }, "Edit", h("span", { class: "sr-only" }, ` "${offer.title}"`)),
          h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm", onClick: () => remove(offer) }, "Remove", h("span", { class: "sr-only" }, ` "${offer.title}"`)))));
  }

  function draw() {
    clear(region);
    const full = offers.length >= limits.offers;
    addButton.disabled = full;
    addButton.title = full ? `The website holds ${limits.offers} offers. Remove one to add another.` : "";
    if (offers.length === 0) {
      append(region, stateBlock({
        title: "No offers yet",
        body: "Add an offer and it appears in a carousel at the top of the home page, beside the headline: a photo, a few words and a button.",
        action: h("button", { type: "button", class: "d-btn d-btn-primary", onClick: () => editor(null) }, icon("plus"), "Add your first offer"),
      }));
      return;
    }
    const showing = offers.filter((offer) => offerStatus(offer) === "live").length;
    append(region,
      h("p", { class: "mb-3 text-sm text-muted" },
        `${showing === 0 ? "None" : showing} of ${offers.length} on the website now. ${offers.length} of ${limits.offers} places used.`),
      showing === 0 && h("div", { class: "d-alert d-alert-info mb-4" }, "No offer is on the website right now, so the home page shows no carousel."),
      h("ol", { class: "space-y-3", "aria-label": "Offers, in carousel order" }, offers.map(row)));
  }

  // The form for one offer, new or existing, beside a preview of the slide as it will look.
  function editor(offer) {
    let id = offer?.id ?? null;
    let pendingFile = null;
    let pendingUrl = null;
    let dropPhoto = false;
    const existing = offer?.image ?? null;

    const field = (name, label, { value = "", placeholder = "", hint = "", required = false } = {}) => {
      const input = h("input", { class: "d-input", id: `offer-${name}`, name, type: "text", value, placeholder, maxlength: LIMITS[name], required, autocomplete: "off" });
      return [input, h("div", {},
        h("label", { class: "d-label", for: input.id }, label, required && h("span", { class: "text-bad" }, " *")),
        input,
        hint && h("p", { class: "d-hint" }, hint))];
    };

    const [badgeInput, badgeField] = field("badge", "Badge", { value: offer?.badge ?? "This week at Luzena", placeholder: "This week at Luzena", hint: "A few words in the small red label at the top." });
    const [highlightInput, highlightField] = field("highlight", "Highlight", { value: offer?.highlight ?? "", placeholder: "15% OFF", hint: "The discount or the big news, shown above the title in gold." });
    const [titleInput, titleField] = field("title", "Title", { value: offer?.title ?? "", placeholder: "Family Platters", required: true });
    const descriptionInput = h("textarea", { class: "d-input", id: "offer-description", name: "description", rows: 3, maxlength: LIMITS.description, placeholder: "Gather around great food. Enjoy 15% off our family platters, perfect for sharing." }, offer?.description ?? "");
    const [labelInput, labelField] = field("cta_label", "Button words", { value: offer?.cta_label ?? "View Offer", placeholder: "View Offer" });
    const knownDestination = DESTINATIONS.some((option) => option.value === (offer?.cta_url ?? "/menu/") && option.value !== "other");
    const destination = h("select", { class: "d-input", id: "offer-destination" },
      DESTINATIONS.map((option) => h("option", {
        value: option.value,
        selected: knownDestination ? option.value === (offer?.cta_url ?? "/menu/") : option.value === "other",
      }, option.label)));
    const otherUrl = h("input", {
      class: "d-input mt-2", id: "offer-cta-url", type: "text", maxlength: LIMITS.cta_url, autocomplete: "off",
      value: knownDestination ? "" : offer?.cta_url ?? "", placeholder: "https://... or /a-page/", "aria-label": "Button address",
    });
    const [finePrintInput, finePrintField] = field("fine_print", "Fine print", {
      value: offer?.fine_print ?? "", placeholder: "Dine-in only. Not combined with other offers.",
      hint: "Shown at the foot of the slide. Left empty, the slide shows the last day by itself (\"Valid through Sunday\").",
    });
    const firstDay = h("input", { class: "d-input", id: "offer-first-day", type: "date", value: offer?.starts_at ? dayOf(offer.starts_at, timezone) : "" });
    const lastDay = h("input", { class: "d-input", id: "offer-last-day", type: "date", value: offer?.ends_at ? lastDayOf(offer.ends_at, timezone) : "" });
    const activeInput = h("input", { type: "checkbox", id: "offer-active", checked: offer ? offer.active : true });
    const altInput = h("input", { class: "d-input", id: "offer-alt", type: "text", maxlength: LIMITS.alt, value: existing?.alt ?? "", placeholder: "What the photo shows", autocomplete: "off" });

    // The photo: the one the offer has, one just chosen, or none.
    const photoFrame = h("div", { class: "d-photo-frame aspect-[16/10]" });
    const fileInput = h("input", { type: "file", id: "offer-photo", class: "peer sr-only", accept: ACCEPT });
    const chooseLabel = h("label", {
      for: "offer-photo",
      class: "d-btn d-btn-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
    });
    const removePhoto = h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm" }, "Remove photo");
    const currentPhoto = () => (pendingUrl ?? (existing && !dropPhoto ? address(existing.small_path ?? existing.path) : null));
    function drawPhoto() {
      clear(photoFrame);
      const src = currentPhoto();
      append(photoFrame, src
        ? h("img", { src, alt: "" })
        : h("p", { class: "flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted" },
            icon("image", 26), "No photo: the slide shows the restaurant's green panel"));
      chooseLabel.textContent = src ? "Replace photo" : "Choose a photo";
      removePhoto.hidden = !src;
      altInput.closest("div").hidden = !src;
      preview();
    }
    fileInput.addEventListener("change", () => {
      const [file] = fileInput.files ?? [];
      if (!file) return;
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      pendingFile = file;
      pendingUrl = URL.createObjectURL(file);
      dropPhoto = false;
      drawPhoto();
    });
    removePhoto.addEventListener("click", () => {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      pendingFile = null;
      pendingUrl = null;
      fileInput.value = "";
      dropPhoto = true;
      drawPhoto();
      fileInput.focus();
    });

    // The preview: the slide as the home page draws it, from what is in the form now.
    const previewBox = h("div", { class: "d-offer-preview", "aria-hidden": "true" });
    function preview() {
      clear(previewBox);
      const url = ctaUrl();
      const lastDayValue = lastDay.value;
      const fine = finePrintInput.value.trim()
        || (lastDayValue ? validThrough(dayStart(nextDay(lastDayValue), timezone), { locale: state.locale, timeZone: timezone }) : "");
      const src = currentPhoto();
      append(previewBox,
        src && h("img", { class: "d-offer-preview-photo", src, alt: "" }),
        h("div", { class: "d-offer-preview-body" },
          badgeInput.value.trim() && h("span", { class: "d-offer-preview-badge" }, badgeInput.value.trim()),
          h("p", { class: "d-offer-preview-title" },
            highlightInput.value.trim() && h("span", { class: "block" }, highlightInput.value.trim()),
            h("span", { class: "block" }, titleInput.value.trim() || "Title")),
          descriptionInput.value.trim() && h("p", { class: "d-offer-preview-text" }, descriptionInput.value.trim()),
          url && h("span", { class: "d-offer-preview-cta" }, labelInput.value.trim() || "View Offer", " →"),
          fine && h("span", { class: "d-offer-preview-fine" }, icon("calendar", 12), fine)));
    }

    const ctaUrl = () => (destination.value === "other" ? otherUrl.value.trim() : destination.value);
    const syncDestination = () => {
      otherUrl.hidden = destination.value !== "other";
      labelInput.disabled = destination.value === "";
    };
    destination.addEventListener("change", () => {
      syncDestination();
      if (destination.value === "other") otherUrl.focus();
      preview();
    });
    syncDestination();

    const errorBox = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "d-btn d-btn-primary" }, offer ? "Save offer" : "Add offer");

    const form = h("form", { class: "flex max-h-[min(90dvh,60rem)] flex-col" },
      h("div", { class: "border-b border-line px-6 py-4" },
        h("h2", { class: "d-title text-lg" }, offer ? "Edit offer" : "Add an offer"),
        h("p", { class: "mt-0.5 text-sm text-muted" }, "A slide in the carousel at the top of the home page.")),
      h("div", { class: "grid min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-5 lg:grid-cols-[minmax(0,1fr)_22rem]" },
        h("div", { class: "space-y-4" },
          h("fieldset", { class: "space-y-3" },
            h("legend", { class: "d-label" }, "Photo"),
            photoFrame,
            h("div", { class: "flex flex-wrap gap-2" }, fileInput, chooseLabel, removePhoto),
            h("div", {}, h("label", { class: "d-label", for: altInput.id }, "Photo description"), altInput,
              h("p", { class: "d-hint" }, "For people who cannot see the photo.")),
            h("p", { class: "d-hint" }, "JPEG, PNG or WebP. A food photo on a dark background looks best; it fills the right half of the slide.")),
          badgeField, highlightField, titleField,
          h("div", {}, h("label", { class: "d-label", for: descriptionInput.id }, "Description"), descriptionInput,
            h("p", { class: "d-hint" }, "One or two short sentences.")),
          h("div", { class: "grid gap-4 sm:grid-cols-2" },
            h("div", {}, h("label", { class: "d-label", for: destination.id }, "Button leads to"), destination, otherUrl),
            labelField),
          h("fieldset", { class: "space-y-2" },
            h("legend", { class: "d-label" }, "When it is shown"),
            h("div", { class: "grid gap-4 sm:grid-cols-2" },
              h("div", {}, h("label", { class: "d-label", for: firstDay.id }, "First day"), firstDay),
              h("div", {}, h("label", { class: "d-label", for: lastDay.id }, "Last day"), lastDay)),
            h("p", { class: "d-hint" }, `Days at the restaurant (${timezone.replace(/_/g, " ")}). Leave the first day empty to start now, and the last day empty to keep it until you switch it off.`)),
          finePrintField,
          h("label", { class: "d-choice", for: activeInput.id }, activeInput,
            h("span", {}, h("span", { class: "block font-medium" }, "Show on the website"),
              h("span", { class: "block text-sm text-muted" }, "Switched off, the offer is kept here for another time."))),
          errorBox),
        h("div", { class: "lg:sticky lg:top-0 lg:self-start" },
          h("p", { class: "d-label" }, "Preview"),
          previewBox,
          h("p", { class: "d-hint mt-2" }, "As it appears on the home page. Phones show the same slide, narrower."))),
      h("div", { class: "flex justify-end gap-2 border-t border-line px-6 py-4" },
        h("button", { type: "button", class: "d-btn", onClick: () => dialog.close() }, "Cancel"), submit));

    for (const input of [badgeInput, highlightInput, titleInput, descriptionInput, labelInput, otherUrl, finePrintInput, lastDay]) {
      input.addEventListener("input", preview);
    }

    const dialog = openDialog(form, {
      label: offer ? "Edit offer" : "Add an offer",
      onClose: () => { if (pendingUrl) URL.revokeObjectURL(pendingUrl); },
    });
    dialog.classList.add("d-dialog-wide");
    drawPhoto();
    titleInput.focus();

    // What the form says now, in the shape the server takes.
    function values() {
      const url = ctaUrl();
      if (firstDay.value && lastDay.value && lastDay.value < firstDay.value) {
        throw new Error("The last day must be on or after the first day.");
      }
      if (destination.value === "other" && url === "") throw new Error("Write the address the button leads to, or choose \"No button\".");
      return {
        active: activeInput.checked,
        badge: badgeInput.value.trim(),
        highlight: highlightInput.value.trim(),
        title: titleInput.value.trim(),
        description: descriptionInput.value.trim(),
        cta_label: url ? labelInput.value.trim() : "",
        cta_url: url,
        fine_print: finePrintInput.value.trim(),
        starts_at: firstDay.value ? dayStart(firstDay.value, timezone) : null,
        ends_at: lastDay.value ? dayStart(nextDay(lastDay.value), timezone) : null,
      };
    }

    async function sendPhoto() {
      const made = await optimiseSitePhoto(pendingFile, PHOTO_SIZE);
      const upload = new FormData();
      upload.append("alt", altInput.value.trim());
      upload.append("width", String(made.width));
      upload.append("height", String(made.height));
      upload.append("file", made.file);
      if (made.small) {
        upload.append("small_width", String(made.smallWidth));
        upload.append("file_small", made.small);
      }
      return api("POST", `/site/offers/${id}/image`, upload);
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = "Saving...";
      try {
        const wanted = values();
        let result;
        if (!id) {
          result = await api("POST", "/site/offers", wanted);
          // From here on the offer exists: trying again only sends what is left.
          id = result.id;
          offers = result.offers;
        } else {
          const before = offers.find((entry) => entry.id === id) ?? {};
          // Dates are compared as moments: the server writes them its own way.
          const same = (key, value) => (key.endsWith("_at")
            ? (before[key] ? Date.parse(before[key]) : null) === (value ? Date.parse(value) : null)
            : (before[key] ?? null) === value);
          const changed = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => !same(key, value)));
          if (!pendingFile && existing && !dropPhoto && altInput.value.trim() !== (existing.alt ?? "")) changed.alt = altInput.value.trim();
          if (Object.keys(changed).length > 0) result = await api("PATCH", `/site/offers/${id}`, changed);
        }
        if (result) offers = result.offers;
        if (pendingFile) {
          submit.textContent = "Uploading photo...";
          offers = (await sendPhoto()).offers;
          pendingFile = null;
        } else if (dropPhoto && existing) {
          offers = (await api("DELETE", `/site/offers/${id}/image`)).offers;
        }
        toast(offer ? "Offer saved. The website shows it within a minute." : "Offer added. The website shows it within a minute.");
        dialog.close();
        draw();
        region.querySelector(`[data-offer="${id}"] .d-btn`)?.focus();
      } catch (failure) {
        errorBox.textContent = failure.details?.fields ? Object.values(failure.details.fields).join(" ") : failure.status ? explain(failure) : failure.message;
        errorBox.hidden = false;
        errorBox.scrollIntoView({ block: "nearest" });
        // An offer added before its photo failed is on the list already.
        draw();
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    });
  }

  try {
    const answer = await api("GET", "/site/offers");
    offers = answer.offers;
    timezone = answer.timezone || timezone;
    limits = answer.limits ?? limits;
    draw();
  } catch (failure) {
    clear(region);
    append(region, errorBlock(failure, () => { clear(outlet); offersView(outlet); }));
  }
}
