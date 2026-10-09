// Labels and the allergy notice.
//
// Labels are what the restaurant says about a dish: what is in it, how it is made, that it
// is a favourite. Each has a name, an icon from the website's own set, an optional short
// description, a place in the order, and can be switched off without being lost. They are
// put on dishes in the item editor. The allergy notice is the restaurant's own wording at
// the foot of the menu.
//
// Nothing on this page, or behind it, decides what a dish contains. A label is on a dish
// only because someone here ticked it.
import { LABEL_ICON_TITLES, labelIcon } from "../../js/lib/label-icons.js";
import { menuNoticeElement } from "../../js/lib/menu-notice.js";
import { api } from "../api.js";
import { can } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, h, icon, loadingBlock, pageHeader, switchControl, toast, toastFailure } from "../ui.js";

const LANGUAGE_NAMES = { en: "English", ar: "Arabic (العربية)", es: "Spanish (Español)", fr: "French (Français)", tr: "Turkish (Türkçe)", zh: "Chinese (中文)" };
// Shown greyed in an empty box, as an idea of what a notice says. It is never saved, and
// it is not wording anyone has approved for this restaurant.
const EXAMPLE = "Example only: Please inform our staff of any food allergies or dietary requirements before ordering.";

export async function labelsView(outlet) {
  const region = h("div", {}, loadingBlock("Loading labels"));
  append(outlet, pageHeader({ title: "Labels and allergy notice" }), region);
  const writable = can("menu.write");
  const managesSite = can("site.manage");

  let labels, icons, limits;
  let notice = null;
  let languages = [];
  let noticeLimit = 600;
  // Which label is being edited ("new" for a label that does not exist yet), or null.
  let editing = null;
  // The notice as it is on screen, kept apart from what was last saved until Save is
  // pressed. It lives here, not in the notice's section, so that a change to a label, which
  // redraws the page, does not throw away what is being written.
  let draft = null;

  // ---- labels ------------------------------------------------------------------------------

  // The form for a new label or an existing one: a name, an optional description, an icon.
  function labelForm(label) {
    const id = label?.id ?? "new";
    const name = h("input", { class: "d-input", id: `label-name-${id}`, type: "text", maxlength: 40, required: true, value: label?.name ?? "", autocomplete: "off" });
    const description = h("input", { class: "d-input", id: `label-description-${id}`, type: "text", maxlength: 160, value: label?.description ?? "", autocomplete: "off", "aria-describedby": `label-description-hint-${id}` });
    const chosen = label?.icon ?? icons[0];
    const message = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
    const save = h("button", { type: "submit", class: "d-btn d-btn-primary" }, label ? "Save label" : "Add label");
    const form = h("form", { class: "space-y-4 rounded-xl border border-line-strong bg-canvas p-4", novalidate: true, dataset: { labelForm: id } },
      h("div", { class: "grid gap-4 sm:grid-cols-2" },
        h("div", {}, h("label", { class: "d-label", for: name.id }, "Name"), name),
        h("div", {}, h("label", { class: "d-label", for: description.id }, "Short description", h("span", { class: "font-normal text-muted" }, "(optional)")), description,
          h("p", { class: "d-hint", id: `label-description-hint-${id}` }, "Read out with the label by screen readers, and shown when a customer points at it."))),
      h("fieldset", {},
        h("legend", { class: "d-label" }, "Icon"),
        h("div", { class: "d-icon-choices" }, icons.map((key) =>
          h("label", { class: "d-icon-choice", title: LABEL_ICON_TITLES[key] ?? key },
            h("input", { type: "radio", name: `label-icon-${id}`, value: key, class: "sr-only", checked: key === chosen }),
            labelIcon(key, 20),
            h("span", { class: "sr-only" }, LABEL_ICON_TITLES[key] ?? key))))),
      message,
      h("div", { class: "flex flex-wrap gap-2" }, save,
        h("button", { type: "button", class: "d-btn d-btn-quiet", onClick: () => { editing = null; draw(); } }, "Cancel")));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      message.hidden = true;
      if (name.value.trim() === "") {
        message.textContent = "Give the label a name.";
        message.hidden = false;
        return name.focus();
      }
      const body = {
        name: name.value.trim(), description: description.value.trim() || null,
        icon: form.querySelector(`input[name="label-icon-${id}"]:checked`)?.value ?? chosen,
      };
      save.disabled = true;
      try {
        const result = label ? await api("PATCH", `/labels/${label.id}`, body) : await api("POST", "/labels", body);
        labels = result.labels;
        editing = null;
        toast(result.message);
        draw();
      } catch (failure) {
        // The form stays as it is, with what was typed, and says what is wrong.
        message.textContent = failure.message;
        message.hidden = false;
        save.disabled = false;
      }
    });
    return form;
  }

  async function move(index, delta) {
    const ids = labels.map((label) => label.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    try {
      labels = (await api("POST", "/labels/reorder", { ids })).labels;
    } catch (failure) {
      toastFailure(failure);
    }
    draw();
    // Keep the keyboard on the label that moved: on the same arrow, or the other one at an end.
    const arrows = [delta < 0 ? "earlier" : "later", delta < 0 ? "later" : "earlier"];
    arrows.map((arrow) => region.querySelector(`[data-move="${ids[index + delta]}:${arrow}"]`)).find((button) => button && !button.disabled)?.focus();
  }

  async function remove(label) {
    const dishes = label.item_count;
    const sure = await confirmDialog({
      title: `Delete the label "${label.name}"?`,
      body: [dishes === 0 ? "No dish carries it." : `It is taken off the ${dishes} ${dishes === 1 ? "dish that carries" : "dishes that carry"} it.`,
        "To hide a label for a while and keep it on its dishes, switch it off instead."],
      confirmLabel: "Delete label", danger: true,
    });
    if (!sure) return;
    try {
      const result = await api("DELETE", `/labels/${label.id}`);
      labels = result.labels;
      toast(result.message);
    } catch (failure) {
      toastFailure(failure);
    }
    draw();
  }

  function labelRow(label, index) {
    if (editing === label.id) return h("li", {}, labelForm(label));
    return h("li", { class: "flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-line bg-surface p-3 sm:px-4", dataset: { label: label.id } },
      h("span", { class: `flex size-10 shrink-0 items-center justify-center rounded-full border ${label.active ? "border-brand/35 text-brand" : "border-line text-muted"}`, "aria-hidden": "true" }, labelIcon(label.icon, 20)),
      h("div", { class: "min-w-0 flex-1 basis-40" },
        h("p", { class: "flex flex-wrap items-center gap-2 font-semibold" }, h("span", { class: "break-words" }, label.name), !label.active && badge("Switched off", "warn")),
        label.description && h("p", { class: "text-sm text-muted" }, label.description),
        h("p", { class: "text-[0.82rem] text-muted" }, label.item_count === 0 ? "On no dish yet" : `On ${label.item_count} ${label.item_count === 1 ? "dish" : "dishes"}`)),
      writable && h("div", { class: "flex flex-wrap items-center gap-1" },
        h("span", { class: "mr-2 flex items-center gap-2 text-sm text-muted" },
          switchControl({
            checked: label.active, label: `${label.name}: shown on the website`,
            onToggle: async (on) => {
              try {
                const result = await api("PATCH", `/labels/${label.id}`, { active: on });
                labels = result.labels;
                toast(result.message);
              } catch (failure) {
                toastFailure(failure);
              }
              draw();
            },
          })),
        h("button", { type: "button", class: "d-icon-btn", disabled: index === 0, "aria-label": `Move ${label.name} earlier`, dataset: { move: `${label.id}:earlier` }, onClick: () => move(index, -1) }, icon("up")),
        h("button", { type: "button", class: "d-icon-btn", disabled: index === labels.length - 1, "aria-label": `Move ${label.name} later`, dataset: { move: `${label.id}:later` }, onClick: () => move(index, 1) }, icon("down")),
        h("button", { type: "button", class: "d-btn d-btn-sm", onClick: () => { editing = label.id; draw(); region.querySelector(`#label-name-${label.id}`)?.focus(); } },
          "Edit", h("span", { class: "sr-only" }, ` ${label.name}`)),
        h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm", onClick: () => remove(label) }, "Delete", h("span", { class: "sr-only" }, ` ${label.name}`))));
  }

  function labelsSection() {
    const full = labels.length >= (limits?.labels ?? 40);
    return h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "labels-title" },
      h("div", { class: "flex flex-wrap items-start justify-between gap-3" },
        h("h2", { id: "labels-title", class: "d-title" }, "Menu labels"),
        writable && editing !== "new" && h("button", {
          type: "button", class: "d-btn d-btn-primary", disabled: full,
          onClick: () => { editing = "new"; draw(); region.querySelector("#label-name-new")?.focus(); },
        }, icon("plus"), "Add a label")),
      h("div", { class: "mt-1 max-w-3xl space-y-2 text-sm text-muted" },
        h("p", {}, "Labels tell customers about a dish: what is in it, how it is made, or that it is a favourite. Each appears under the dish on the menu as its icon and name, in the order below."),
        h("p", {}, h("strong", { class: "font-semibold text-text" }, "A label is shown only on the dishes you tick it for."),
          " Nothing is labelled automatically, and nothing is worked out from a dish's name. To put labels on a dish, open it in ",
          h("a", { href: "#/items", class: "font-medium text-brand hover:underline" }, "Items"), ".")),
      editing === "new" && h("div", { class: "mt-5" }, labelForm(null)),
      labels.length === 0
        ? h("div", { class: "d-alert d-alert-info mt-5" }, "There are no labels. Add one to start.")
        : h("ol", { class: "mt-5 space-y-2", "aria-label": "Labels, in the order the menu shows them" }, labels.map(labelRow)),
      full && h("p", { class: "d-hint mt-4" }, `A restaurant can have ${limits.labels} labels. Delete one to add another.`));
  }

  // ---- the allergy notice --------------------------------------------------------------------

  function noticeSection() {
    draft ??= { enabled: notice.enabled, entries: notice.entries.length > 0 ? notice.entries.map((entry) => ({ ...entry })) : [{ lang: languages[0] ?? "en", text: "" }] };
    const preview = h("div", { class: "preview-surface" });
    const list = h("div", { class: "space-y-4" });
    const message = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
    const save = h("button", { type: "button", class: "d-btn d-btn-primary" }, "Save notice");
    const addLanguage = h("button", { type: "button", class: "d-btn d-btn-sm" }, icon("plus"), "Add a language");
    const written = () => draft.entries.filter((entry) => entry.text.trim() !== "");

    function refreshPreview() {
      clear(preview);
      const element = menuNoticeElement(written(), { headingId: "notice-preview-title" });
      append(preview, element ?? h("p", { class: "py-6 text-center text-sm text-muted" }, "Nothing written yet. The menu shows no notice."));
      addLanguage.hidden = draft.entries.length >= languages.length;
    }

    function drawEntries() {
      clear(list);
      draft.entries.forEach((entry, index) => {
        const taken = new Set(draft.entries.filter((other) => other !== entry).map((other) => other.lang));
        const language = h("select", { class: "d-input sm:max-w-56", id: `notice-lang-${index}`, "aria-label": "Language of this text" },
          languages.filter((code) => !taken.has(code)).map((code) => h("option", { value: code, selected: code === entry.lang }, LANGUAGE_NAMES[code] ?? code)));
        const text = h("textarea", {
          class: "d-input", id: `notice-text-${index}`, rows: 4, maxlength: noticeLimit, dir: "auto", lang: entry.lang,
          placeholder: index === 0 ? EXAMPLE : "", "aria-describedby": `notice-count-${index}`,
        }, entry.text);
        const count = h("span", { id: `notice-count-${index}`, class: "shrink-0 whitespace-nowrap" }, `${entry.text.length} / ${noticeLimit}`);
        language.addEventListener("change", () => { entry.lang = language.value; text.lang = language.value; drawEntries(); refreshPreview(); });
        text.addEventListener("input", () => { entry.text = text.value; count.textContent = `${text.value.length} / ${noticeLimit}`; refreshPreview(); });
        append(list, h("div", { class: "rounded-xl border border-line p-4" },
          h("div", { class: "flex flex-wrap items-end justify-between gap-3" },
            h("div", {}, h("label", { class: "d-label", for: language.id }, index === 0 ? "Language" : "Another language"), language),
            draft.entries.length > 1 && h("button", {
              type: "button", class: "d-btn d-btn-quiet d-btn-sm",
              onClick: () => { draft.entries.splice(index, 1); drawEntries(); refreshPreview(); },
            }, "Remove", h("span", { class: "sr-only" }, ` the ${LANGUAGE_NAMES[entry.lang] ?? entry.lang} text`))),
          h("label", { class: "d-label mt-4", for: text.id }, "Notice text"),
          text,
          h("p", { class: "d-hint flex justify-between gap-3" }, h("span", {}, index === 0 ? "The greyed words are an example of what a notice says. They are not saved and not shown." : ""), count)));
      });
    }

    addLanguage.addEventListener("click", () => {
      const free = languages.find((code) => !draft.entries.some((entry) => entry.lang === code));
      if (!free) return;
      draft.entries.push({ lang: free, text: "" });
      drawEntries();
      refreshPreview();
      list.querySelector(`#notice-text-${draft.entries.length - 1}`)?.focus();
    });

    const toggle = h("input", { type: "checkbox", id: "notice-enabled", class: "mt-0.5 size-4 shrink-0", checked: draft.enabled });
    toggle.addEventListener("change", () => { draft.enabled = toggle.checked; });

    save.addEventListener("click", async () => {
      message.hidden = true;
      if (draft.enabled && written().length === 0) {
        message.textContent = "Write the notice before turning it on.";
        message.hidden = false;
        return list.querySelector("textarea")?.focus();
      }
      save.disabled = true;
      try {
        const result = await api("PUT", "/site/notice", { enabled: draft.enabled, entries: draft.entries.map((entry) => ({ lang: entry.lang, text: entry.text.trim() })) });
        notice = result.notice;
        draft = null;
        toast(result.message);
        draw();
      } catch (failure) {
        message.textContent = failure.message;
        message.hidden = false;
        save.disabled = false;
      }
    });

    drawEntries();
    refreshPreview();
    return h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "notice-title" },
      h("div", { class: "flex flex-wrap items-start justify-between gap-3" },
        h("h2", { id: "notice-title", class: "d-title" }, "Allergy notice"),
        notice.enabled ? badge("On the menu", "ok") : badge("Not shown")),
      h("p", { class: "mt-1 max-w-3xl text-sm text-muted" }, "A short note at the foot of the menu, after the last dish, asking customers to tell you about allergies. It is your wording, in as many languages as you serve."),
      h("div", { class: "d-alert d-alert-warn mt-4" },
        h("p", { class: "font-semibold" }, "The wording is yours to decide."),
        h("p", { class: "mt-1" }, "It must be true of how your kitchen really works, and may be covered by local rules. Have it checked before you turn it on. Nothing here is approved wording.")),
      h("div", { class: "mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]" },
        h("div", { class: "space-y-4" },
          h("label", { class: "flex items-start gap-2.5 text-sm", for: "notice-enabled" }, toggle,
            h("span", {}, h("span", { class: "font-semibold" }, "Show the notice at the foot of the menu"),
              h("span", { class: "block text-[0.82rem] text-muted" }, "Turned off, the wording is kept and customers do not see it."))),
          list,
          h("div", {}, addLanguage),
          message,
          h("div", {}, save)),
        h("div", {},
          h("h3", { class: "d-section-title mb-3" }, "Preview"),
          preview,
          h("p", { class: "d-hint" }, "This is how the notice looks on the menu. The preview includes what you have not saved yet."))));
  }

  function draw() {
    clear(region);
    append(region, h("div", { class: "space-y-5" }, labelsSection(), notice && noticeSection()));
  }

  try {
    const [labelData, noticeData] = await Promise.all([
      api("GET", "/labels"),
      managesSite ? api("GET", "/site/notice") : null,
    ]);
    ({ labels, icons, limits } = labelData);
    if (noticeData) {
      notice = noticeData.notice;
      languages = noticeData.languages;
      noticeLimit = noticeData.limits?.text ?? noticeLimit;
    }
    draw();
  } catch (failure) {
    clear(region);
    append(region, errorBlock(failure, () => { clear(outlet); labelsView(outlet); }));
  }
}
