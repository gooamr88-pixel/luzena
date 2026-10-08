// Small UI building blocks used by every dashboard view.
import { append, clear, h } from "../js/lib/dom.js";
import { explain } from "./api.js";

export { append, clear, h };

const ICONS = {
  overview: "M4 13h6V4H4zm0 7h6v-5H4zm10 0h6v-9h-6zm0-16v5h6V4z",
  // Fork and knife, and the leaf: the same drawings as the public site uses.
  items: "M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7",
  leaf: "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10zM2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12",
  alert: "M12 9v4M12 17h.01M10.3 3.9L2.5 17.5a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  categories: "M4 5h7v6H4zm9 0h7v6h-7zM4 13h7v6H4zm9 0h7v6h-7z",
  modifiers: "M5 7h14M5 12h9M5 17h5M17 15v6M14 18h6",
  clover: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4",
  applications: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6",
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM21 7l-9 6-9-6",
  phone: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z",
  activity: "M4 12h4l3-7 4 14 3-7h2",
  menu: "M3 7h18M3 12h18M3 17h18",
  close: "M5 5l14 14M19 5L5 19",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  plus: "M12 5v14M5 12h14",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5h.01",
  tag: "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42zM7.5 7.5h.01",
  lock: "M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4",
};

export function icon(name, size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", name === "grip" ? "2.6" : "1.6");
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
      tone === "bad" ? "border-bad/30 bg-bad-bg text-bad" : tone === "warn" ? "border-warn/30 bg-warn-bg text-warn" : "border-night bg-night text-white"}`,
    role: tone === "ok" ? "status" : "alert",
  }, message);
  document.getElementById("toasts").append(node);
  setTimeout(() => node.remove(), tone === "ok" ? 4000 : 9000);
}

export const toastFailure = (failure) => toast(explain(failure), "bad");

// Loading, empty and error states share one shape so every view handles all three.
export function stateBlock({ title, body, action, tone = "" }) {
  return h("div", { class: "d-card px-6 py-12 text-center" },
    h("div", { class: `d-state-icon ${tone === "bad" ? "border-bad/35 text-bad" : ""}`, "aria-hidden": "true" }, icon(tone === "bad" ? "alert" : "leaf", 22)),
    h("h2", { class: `d-title ${tone === "bad" ? "text-bad" : ""}` }, title),
    body && h("p", { class: "mx-auto mt-2 max-w-md text-sm text-muted" }, body),
    action && h("div", { class: "mt-6 flex flex-wrap justify-center gap-2" }, action),
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
  return h("header", { class: "mb-7" },
    crumbs.length > 0 && h("nav", { "aria-label": "Breadcrumb", class: "mb-2 text-[0.82rem] text-muted" },
      h("ol", { class: "flex flex-wrap items-center gap-1.5" }, crumbs.map((crumb, index) => [
        index > 0 && h("li", { "aria-hidden": "true" }, "/"),
        h("li", {}, crumb.href ? h("a", { href: crumb.href, class: "font-medium text-brand hover:text-brand-dark hover:underline" }, crumb.label) : crumb.label),
      ]))),
    h("div", { class: "flex flex-wrap items-center justify-between gap-x-4 gap-y-3" },
      h("h1", { class: "min-w-0" }, title),
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
        h("h2", { class: "d-title text-lg" }, title),
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
    h("h2", { class: "d-title text-lg" }, title),
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
