// Small UI building blocks used by every dashboard view.
import { append, clear, h } from "../js/lib/dom.js";
import { explain } from "./api.js";

export { append, clear, h };

const ICONS = {
  overview: "M4 13h6V4H4zm0 7h6v-5H4zm10 0h6v-9h-6zm0-16v5h6V4z",
  items: "M4 6h16M4 12h16M4 18h10",
  categories: "M4 5h7v6H4zm9 0h7v6h-7zM4 13h7v6H4zm9 0h7v6h-7z",
  modifiers: "M5 7h14M5 12h9M5 17h5M17 15v6M14 18h6",
  clover: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4",
  activity: "M4 12h4l3-7 4 14 3-7h2",
  menu: "M3 7h18M3 12h18M3 17h18",
  close: "M5 5l14 14M19 5L5 19",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  plus: "M12 5v14M5 12h14",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5h.01",
};

export function icon(name, size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", name === "grip" ? "2.6" : "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  append(svg, path);
  return svg;
}

export const badge = (text, tone = "") => h("span", { class: `d-badge ${tone ? `d-badge-${tone}` : ""}` }, text);
export const source = (where) => h("span", { class: "d-source", title: where === "Clover" ? "Stored in Clover. Saving writes to Clover." : "Stored by this website only. Clover is not affected." }, where);

export function toast(message, tone = "ok") {
  const node = h("div", {
    class: `pointer-events-auto max-w-md rounded-lg border px-4 py-3 text-sm shadow-lg ${
      tone === "bad" ? "border-bad/30 bg-bad-bg text-bad" : tone === "warn" ? "border-warn/30 bg-warn-bg text-warn" : "border-line bg-text text-white"}`,
    role: tone === "ok" ? "status" : "alert",
  }, message);
  document.getElementById("toasts").append(node);
  setTimeout(() => node.remove(), tone === "ok" ? 4000 : 9000);
}

export const toastFailure = (failure) => toast(explain(failure), "bad");

// Loading, empty and error states share one shape so every view handles all three.
export function stateBlock({ title, body, action, tone = "" }) {
  return h("div", { class: "d-card px-6 py-12 text-center" },
    h("h2", { class: `text-base ${tone === "bad" ? "text-bad" : ""}` }, title),
    body && h("p", { class: "mx-auto mt-2 max-w-md text-sm text-muted" }, body),
    action && h("div", { class: "mt-5 flex justify-center gap-2" }, action),
  );
}

export const loadingBlock = (label = "Loading") =>
  h("div", { class: "d-card space-y-3 p-5", role: "status", "aria-label": label },
    // Width classes, not inline styles: the site's CSP forbids style attributes.
    ["w-3/4", "w-full", "w-5/6", "w-11/12", "w-3/5"].map((width) => h("div", { class: `d-skeleton h-5 ${width}` })));

export const errorBlock = (failure, retry) =>
  stateBlock({
    tone: "bad",
    title: "This could not be loaded",
    body: explain(failure),
    action: h("button", { type: "button", class: "d-btn", onClick: retry }, "Try again"),
  });

export function pageHeader({ crumbs = [], title, actions }) {
  return h("header", { class: "mb-6" },
    crumbs.length > 0 && h("nav", { "aria-label": "Breadcrumb", class: "mb-1.5 text-[0.82rem] text-muted" },
      h("ol", { class: "flex flex-wrap items-center gap-1.5" }, crumbs.map((crumb, index) => [
        index > 0 && h("li", { "aria-hidden": "true" }, "/"),
        h("li", {}, crumb.href ? h("a", { href: crumb.href, class: "hover:text-text hover:underline" }, crumb.label) : crumb.label),
      ]))),
    h("div", { class: "flex flex-wrap items-center justify-between gap-3" },
      h("h1", { class: "text-2xl" }, title),
      actions && h("div", { class: "flex flex-wrap items-center gap-2" }, actions)),
  );
}

// A switch that never shows a state the server has not confirmed: it stays where it is,
// disabled, until onToggle resolves, and only then is redrawn by the caller.
export function switchControl({ checked, label, disabled = false, onToggle }) {
  const button = h("button", {
    type: "button", role: "switch", class: "d-switch", "aria-checked": String(checked), "aria-label": label, disabled,
  });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await onToggle(!checked);
    } finally {
      button.disabled = disabled;
    }
  });
  return button;
}

function openDialog(content, { onClose } = {}) {
  const dialog = h("dialog", { class: "d-dialog" }, content);
  document.body.append(dialog);
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  dialog.showModal();
  return dialog;
}

// Resolves true only when the owner presses the confirm button. Escape, the Cancel button
// and closing the dialog all resolve false. Focus starts on Cancel for destructive actions.
export function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const cancel = h("button", { type: "button", class: "d-btn", onClick: () => dialog.close() }, "Cancel");
    const confirm = h("button", {
      type: "button", class: `d-btn ${danger ? "d-btn-danger" : "d-btn-primary"}`,
      onClick: () => { answer = true; dialog.close(); },
    }, confirmLabel);
    const dialog = openDialog(
      h("div", { class: "p-6" },
        h("h2", { class: "text-lg" }, title),
        h("div", { class: "mt-2 space-y-2 text-sm text-muted" }, [].concat(body).map((line) => h("p", {}, line))),
        h("div", { class: "mt-6 flex justify-end gap-2" }, cancel, confirm)),
      { onClose: () => resolve(answer) },
    );
    (danger ? cancel : confirm).focus();
  });
}

// A small form in a dialog. onSubmit returns nothing on success, or throws an ApiFailure,
// which is shown inside the dialog so the owner's input is not lost.
export function formDialog({ title, intro, fields, submitLabel = "Save", onSubmit }) {
  const errorBox = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
  const submit = h("button", { type: "submit", class: "d-btn d-btn-primary" }, submitLabel);
  const inputs = fields.map((field) => {
    const input = h("input", {
      class: "d-input", id: `dialog-${field.name}`, name: field.name, type: field.type ?? "text",
      value: field.value ?? "", required: field.required ?? false, maxlength: field.maxlength,
      min: field.min, max: field.max, step: field.step, inputmode: field.inputmode, placeholder: field.placeholder,
      autocomplete: "off",
    });
    return h("div", {},
      h("label", { class: "d-label", for: input.id }, field.label, field.source && source(field.source)),
      input,
      field.hint && h("p", { class: "d-hint" }, field.hint));
  });
  const form = h("form", { class: "p-6", novalidate: false },
    h("h2", { class: "text-lg" }, title),
    intro && h("p", { class: "mt-1 text-sm text-muted" }, intro),
    h("div", { class: "mt-5 space-y-4" }, inputs, errorBox),
    h("div", { class: "mt-6 flex justify-end gap-2" },
      h("button", { type: "button", class: "d-btn", onClick: () => dialog.close() }, "Cancel"), submit));
  const dialog = openDialog(form);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "Saving...";
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
      dialog.close();
    } catch (failure) {
      errorBox.textContent = failure.details?.fields ? Object.values(failure.details.fields).join(" ") : explain(failure);
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
  return dialog;
}
