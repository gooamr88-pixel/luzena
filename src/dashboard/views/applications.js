// Job applications: the list with its search and filters, and one application in full
// with its CV, its status and its history.
//
// Everything shown here comes from the dashboard API, which answers only a signed-in owner
// or manager of this restaurant. Nothing is cached or kept in the browser: leaving the page
// leaves no applicant's details behind.
import { fileSize, label, LABELS, STATUSES } from "../../js/lib/application.js";
import { formatDateTime, timeAgo } from "../../js/lib/format.js";
import { api, downloadFile, explain, newIdempotencyKey } from "../api.js";
import { describeScope } from "../export/applications.js";
import { can, state } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, h, icon, loadingBlock, pageHeader, stateBlock, toast, toastFailure } from "../ui.js";
import { exportDialog } from "./export-dialog.js";

const PAGE_SIZE = 25;
const STATUS_TONE = { new: "info", reviewing: "warn", shortlisted: "accent", interview: "accent", hired: "ok", rejected: "" };

export const statusBadge = (status) => badge(label("status", status), STATUS_TONE[status]);

// Tells the sidebar how many applications are new, or, without a number, to ask again.
const announceChange = (newCount) => window.dispatchEvent(new CustomEvent("applications-changed", { detail: newCount }));

// The first and the last moment of a day, in this browser's time zone, as the instants the
// API filters by. "To" is the start of the following day, which the API leaves out.
const dayStart = (date) => new Date(`${date}T00:00:00`).toISOString();
function dayEnd(date) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export async function applicationsView(outlet, _match, query) {
  const filters = {
    search: query.get("search") ?? "",
    status: STATUSES.includes(query.get("status")) ? query.get("status") : "",
    position: "", from: "", to: "", offset: 0,
  };
  let data = null;
  // Exporting is the owner's: nobody else is shown the button, the tick boxes or the bar.
  // (The server refuses the export to anyone else whatever this page shows.)
  const exportable = can("applications.export");
  // The applications ticked for export. Kept while the owner pages and filters, so a
  // choice can be put together from several pages; gone when the page is left.
  const selected = new Set();

  const statusBar = h("div", { class: "d-pills mb-4", role: "group", "aria-label": "Filter by status" });
  const toolbar = h("div", { class: "d-card mb-4 p-3 sm:p-4" });
  const selectionBar = h("div", { "aria-live": "polite" });
  const listRegion = h("div", { "aria-live": "polite" });
  const positionSelect = h("select", { class: "d-input", id: "filter-position" });

  const isFiltered = () => Boolean(filters.search || filters.status || filters.position || filters.from || filters.to);
  const change = (key, value) => {
    filters[key] = value;
    filters.offset = 0;
    load();
  };

  // The filters as the API takes them: a day becomes the instants it starts and ends at,
  // in this browser's time zone. The list and the export are sent the same ones.
  function apiFilters() {
    const sent = {};
    if (filters.search) sent.search = filters.search;
    if (filters.status) sent.status = filters.status;
    if (filters.position) sent.position = filters.position;
    if (filters.from) sent.from = dayStart(filters.from);
    if (filters.to) sent.to = dayEnd(filters.to);
    return sent;
  }

  // Opens the export dialog with what can be exported at this moment. Each choice says
  // plainly what it covers, so that "this page" is never mistaken for "everything that
  // matches": the dialog then shows the server's own count for the one that is picked.
  function openExport(initial) {
    if (!data) return;
    const everything = Object.values(data.counts).reduce((sum, number) => sum + number, 0);
    const onPage = data.applications.map((application) => application.id);
    const choices = [];
    if (selected.size > 0) {
      choices.push({ value: "selected", kind: "selected", name: `The ${selected.size} I ticked`, hint: "Only the applications ticked in the list, on any page.", request: { scope: "selected", ids: [...selected] } });
    }
    if (isFiltered()) {
      choices.push({ value: "filtered", kind: "filtered", name: `Everything matching the filters (${data.total})`, hint: `${describeScope("filtered", filters).replace(/^Filtered: /, "")}. Every page, not only the one on screen.`, request: { scope: "filtered", filters: apiFilters() } });
    }
    if (data.total > onPage.length && onPage.length > 0) {
      choices.push({ value: "page", kind: "page", name: `This page only (${onPage.length})`, hint: `The ${onPage.length} applications on screen now, out of ${data.total}.`, request: { scope: "selected", ids: onPage } });
    }
    choices.push({ value: "all", kind: "all", name: `All applications (${everything})`, hint: isFiltered() ? "Every application, ignoring the filters." : "Every application.", request: { scope: "all" } });
    exportDialog({ choices, initial: initial ?? (selected.size > 0 ? "selected" : isFiltered() ? "filtered" : "all"), filters });
  }

  function drawSelection() {
    clear(selectionBar);
    if (!exportable || selected.size === 0) return;
    const clearButton = h("button", { type: "button", class: "d-btn d-btn-sm d-btn-quiet" }, "Clear");
    clearButton.addEventListener("click", () => {
      selected.clear();
      drawSelection();
      if (data) draw();
    });
    append(selectionBar, h("div", { class: "d-card mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3" },
      h("p", { class: "text-sm font-semibold" }, selected.size === 1 ? "1 application ticked" : `${selected.size} applications ticked`),
      h("div", { class: "flex flex-wrap gap-2" },
        clearButton,
        h("button", { type: "button", class: "d-btn d-btn-sm d-btn-primary", onClick: () => openExport("selected") }, icon("export", 16), "Export ticked"))));
  }

  // A tick box for one application. Ticking redraws only the bar and the "all" box, so the
  // keyboard stays on the box that was pressed.
  function tick(application, onChange) {
    const input = h("input", { type: "checkbox", checked: selected.has(application.id), dataset: { tick: application.id } });
    input.addEventListener("change", () => {
      if (input.checked) selected.add(application.id);
      else selected.delete(application.id);
      // The same application is drawn twice (a table row and a card): keep both in step.
      for (const twin of listRegion.querySelectorAll(`[data-tick="${application.id}"]`)) twin.checked = input.checked;
      drawSelection();
      onChange?.();
    });
    return h("label", { class: "d-tick" }, input, h("span", { class: "sr-only" }, `Tick ${application.full_name}'s application for export`));
  }
  positionSelect.addEventListener("change", () => change("position", positionSelect.value));

  function drawToolbar() {
    const search = h("input", {
      class: "d-input", id: "filter-search", type: "search", placeholder: "Name, email, phone or position",
      value: filters.search, maxlength: 100,
    });
    let timer;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => change("search", search.value), 300);
    });
    const date = (key, text) => {
      const input = h("input", { class: "d-input", id: `filter-${key}`, type: "date", value: filters[key] });
      input.addEventListener("change", () => change(key, input.value));
      return h("div", {}, h("label", { class: "d-label", for: input.id }, text), input);
    };
    const reset = h("button", { type: "button", class: "d-btn d-btn-quiet w-full lg:w-auto" }, "Clear filters");
    reset.addEventListener("click", () => {
      Object.assign(filters, { search: "", status: "", position: "", from: "", to: "", offset: 0 });
      drawToolbar();
      load();
    });

    clear(toolbar);
    append(toolbar, h("div", { class: "grid grid-cols-2 items-end gap-x-2 gap-y-3 lg:grid-cols-[2fr_1.5fr_1fr_1fr_auto]" },
      h("div", { class: "col-span-2 lg:col-span-1" }, h("label", { class: "d-label", for: "filter-search" }, "Search"), search),
      h("div", { class: "col-span-2 lg:col-span-1" }, h("label", { class: "d-label", for: "filter-position" }, "Position"), positionSelect),
      date("from", "Applied from"),
      date("to", "Applied until"),
      h("div", { class: "col-span-2 lg:col-span-1" }, reset)));
  }

  // The positions people have applied for, so the filter only offers ones that match something.
  function drawPositions() {
    clear(positionSelect);
    append(positionSelect,
      h("option", { value: "", selected: filters.position === "" }, "All positions"),
      data.positions.map((position) => h("option", { value: position, selected: filters.position === position }, position)));
  }

  function drawStatusBar() {
    const total = Object.values(data.counts).reduce((sum, count) => sum + count, 0);
    const pill = (value, text, count) => {
      const button = h("button", { type: "button", class: "d-pill", "aria-pressed": String(filters.status === value) },
        text, h("span", { class: "d-pill-count" }, String(count)));
      button.addEventListener("click", () => change("status", value));
      return button;
    };
    clear(statusBar);
    append(statusBar, pill("", "All", total), STATUSES.map((status) => pill(status, LABELS.status[status], data.counts[status] ?? 0)));
  }

  function draw() {
    drawStatusBar();
    drawPositions();
    clear(listRegion);

    if (data.applications.length === 0) {
      append(listRegion, isFiltered()
        ? stateBlock({ title: "No applications match these filters", body: "Change or clear the filters to see more applications." })
        : stateBlock({
            title: "No applications yet",
            body: "Applications sent from the Join Our Team page of the website appear here as soon as they arrive.",
            action: h("a", { href: "/careers/", target: "_blank", rel: "noopener", class: "d-btn" }, "Open the Join Our Team page"),
          }));
      return;
    }

    const open = (application) => `#/applications/${application.id}`;
    const applied = (application) => formatDateTime(application.created_at, state.locale);
    const cvMark = (application) => (application.has_cv
      ? h("span", { class: "inline-flex items-center gap-1.5 text-brand" }, icon("file", 16), "CV")
      : h("span", { class: "text-muted" }, "No CV"));

    // The box in the table's heading ticks or unticks every application on this page. It
    // shows a dash when only some are ticked.
    const allBox = exportable ? h("input", { type: "checkbox" }) : null;
    const syncAll = () => {
      if (!allBox) return;
      const ticked = data.applications.filter((application) => selected.has(application.id)).length;
      allBox.checked = ticked === data.applications.length;
      allBox.indeterminate = ticked > 0 && ticked < data.applications.length;
    };
    allBox?.addEventListener("change", () => {
      for (const application of data.applications) {
        if (allBox.checked) selected.add(application.id);
        else selected.delete(application.id);
      }
      for (const input of listRegion.querySelectorAll("[data-tick]")) input.checked = allBox.checked;
      drawSelection();
      syncAll();
    });
    syncAll();

    const table = h("div", { class: "d-card hidden overflow-x-auto xl:block" },
      h("table", { class: "d-table" },
        h("caption", { class: "sr-only" }, "Job applications, newest first"),
        h("thead", {}, h("tr", {},
          allBox && h("th", { scope: "col", class: "w-12" }, h("label", { class: "d-tick" }, allBox, h("span", { class: "sr-only" }, "Tick every application on this page for export"))),
          ["Applicant", "Position", "Experience", "Applied", "CV", "Status"].map((title) => h("th", { scope: "col" }, title)),
          h("th", { scope: "col", class: "text-right" }, h("span", { class: "sr-only" }, "Open")))),
        h("tbody", {}, data.applications.map((application) => h("tr", {},
          exportable && h("td", { class: "w-12" }, tick(application, syncAll)),
          h("th", { scope: "row", class: "text-left font-semibold" },
            h("a", { href: open(application), class: "hover:text-brand hover:underline" }, application.full_name),
            h("div", { class: "mt-0.5 text-[0.82rem] font-normal text-muted" }, label("employment_type", application.employment_type))),
          h("td", {}, application.position),
          h("td", { class: "text-muted" }, label("experience_level", application.experience_level)),
          h("td", { class: "whitespace-nowrap" }, applied(application),
            h("div", { class: "text-[0.82rem] text-muted" }, timeAgo(application.created_at))),
          h("td", { class: "whitespace-nowrap" }, cvMark(application)),
          h("td", {}, statusBadge(application.status)),
          h("td", { class: "text-right" }, h("a", { href: open(application), class: "d-btn d-btn-sm" }, "Open",
            h("span", { class: "sr-only" }, ` ${application.full_name}'s application`))))))));

    // Smaller screens get cards, as the item list does.
    const cards = h("ul", { class: "grid gap-3 md:grid-cols-2 xl:hidden" }, data.applications.map((application) =>
      h("li", { class: "d-card flex flex-col p-4" },
        h("div", { class: "flex flex-1 items-start justify-between gap-3" },
          h("div", { class: "flex min-w-0 items-start gap-1" },
            exportable && h("div", { class: "-mt-2 -ml-2 shrink-0" }, tick(application, syncAll)),
            h("div", { class: "min-w-0" },
              h("a", { href: open(application), class: "font-semibold hover:text-brand hover:underline" }, application.full_name),
              h("p", { class: "text-sm text-muted" }, application.position))),
          statusBadge(application.status)),
        h("dl", { class: "mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-3 text-sm" },
          h("div", {}, h("dt", { class: "text-[0.78rem] text-muted" }, "Applied"), h("dd", {}, timeAgo(application.created_at))),
          h("div", {}, h("dt", { class: "text-[0.78rem] text-muted" }, "Experience"), h("dd", {}, label("experience_level", application.experience_level)))),
        h("div", { class: "mt-3 flex items-center justify-between gap-3 text-sm" },
          cvMark(application),
          h("a", { href: open(application), class: "d-btn d-btn-sm" }, "Open",
            h("span", { class: "sr-only" }, ` ${application.full_name}'s application`))))));

    const from = data.offset + 1;
    const to = data.offset + data.applications.length;
    const pager = h("nav", { class: "mt-4 flex flex-wrap items-center justify-between gap-3 text-sm", "aria-label": "Pages" },
      h("p", { class: "text-muted" }, `${from} to ${to} of ${data.total}`),
      h("div", { class: "flex gap-2" },
        h("button", { type: "button", class: "d-btn d-btn-sm", disabled: data.offset === 0, onClick: () => { filters.offset = Math.max(0, data.offset - PAGE_SIZE); load(); } }, "Previous"),
        h("button", { type: "button", class: "d-btn d-btn-sm", disabled: to >= data.total, onClick: () => { filters.offset = data.offset + PAGE_SIZE; load(); } }, "Next")));

    append(listRegion, table, cards, pager);
  }

  async function load() {
    clear(listRegion);
    append(listRegion, loadingBlock("Loading applications"));
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(filters.offset), ...apiFilters() });
    exportButton.disabled = true;
    try {
      data = await api("GET", `/applications?${params}`);
      draw();
      exportButton.disabled = false;
      announceChange(data.counts.new ?? 0);
    } catch (failure) {
      data = null;
      clear(listRegion);
      append(listRegion, errorBlock(failure, load));
    }
  }

  const refresh = h("button", { type: "button", class: "d-btn" }, icon("clover", 16), "Refresh");
  refresh.addEventListener("click", load);
  // Off until the list has loaded: the dialog is built from what the list holds.
  const exportButton = h("button", { type: "button", class: "d-btn d-btn-primary", disabled: true }, icon("export", 16), "Export");
  exportButton.addEventListener("click", () => openExport());

  append(outlet,
    pageHeader({ title: "Job applications", actions: [exportable && exportButton, refresh] }),
    h("p", { class: "-mt-3 mb-6 max-w-2xl text-sm text-muted" },
      "Everyone who has applied through the Join Our Team page, newest first. Open an application to read it in full, download the CV and set where it stands."),
    statusBar, toolbar, selectionBar, listRegion);
  drawToolbar();
  await load();
}

const EVENT_TITLES = {
  submitted: () => "Application received",
  email_sent: () => "Notification email sent",
  email_failed: () => "Notification email could not be sent",
  status_changed: (event) => `Status changed from ${label("status", event.from_status)} to ${label("status", event.to_status)}`,
  note: () => "Note added",
  cv_downloaded: () => "CV downloaded",
  message_sent: () => "Message sent to the applicant",
  message_failed: () => "A message to the applicant could not be sent",
};

// What a message to an applicant can start from. Each is a beginning, in the restaurant's
// name, for the person writing to finish: nothing is sent that they have not read.
const firstName = (application) => application.full_name.trim().split(/\s+/)[0];
const MESSAGE_TEMPLATES = [
  { kind: "reply", name: "A message of my own", subject: (a, r) => `Your application to ${r}`, body: (a, r) => `Dear ${firstName(a)},\n\n\n\nKind regards,\n${r}` },
  {
    kind: "acknowledgment", name: "We have received your application", subject: () => "We have received your application",
    body: (a, r) => `Dear ${firstName(a)},\n\nThank you for applying for the ${a.position} position at ${r}. We have received your application and will read it carefully.\n\nWe will write to you again if we would like to take it further.\n\nKind regards,\n${r}`,
  },
  {
    kind: "interview", name: "An invitation to an interview", subject: (a) => `Interview for the ${a.position} position`,
    body: (a, r) => `Dear ${firstName(a)},\n\nThank you for your application for the ${a.position} position. We would like to invite you to an interview.\n\nDate and time: \nPlace: \n\nPlease reply to this email to confirm, or to suggest another time.\n\nKind regards,\n${r}`,
  },
  {
    kind: "more_information", name: "A request for more information", subject: (a) => `Your application for the ${a.position} position`,
    body: (a, r) => `Dear ${firstName(a)},\n\nThank you for your application for the ${a.position} position. Before we take it further, could you tell us a little more about:\n\n\n\nYou can simply reply to this email.\n\nKind regards,\n${r}`,
  },
  {
    kind: "status_update", name: "An update on the application", subject: (a) => `An update on your application for the ${a.position} position`,
    body: (a, r) => `Dear ${firstName(a)},\n\nThank you for your interest in the ${a.position} position at ${r}, and for the time you put into your application.\n\n\n\nKind regards,\n${r}`,
  },
];
const MESSAGE_STATUS = {
  sending: ["Sending", "warn"], sent: ["Sent", "info"], delivered: ["Delivered", "ok"],
  failed: ["Not sent", "bad"], bounced: ["Not delivered", "bad"], blocked: ["Not delivered", "bad"],
};

export async function applicationDetailView(outlet, match) {
  const id = match[1];
  const manage = can("applications.manage");
  append(outlet, loadingBlock("Loading application"));

  async function load() {
    let application;
    try {
      ({ application } = await api("GET", `/applications/${id}`));
    } catch (failure) {
      clear(outlet);
      append(outlet,
        // The page keeps its heading and its way back, whatever went wrong.
        pageHeader({ crumbs: [{ label: "Job applications", href: "#/applications" }, { label: "Application" }], title: "Job application" }),
        failure.status === 404
          ? stateBlock({
              title: "This application does not exist",
              body: "It may have been deleted at the end of the period applications are kept for.",
              action: h("a", { href: "#/applications", class: "d-btn" }, "Back to applications"),
            })
          : errorBlock(failure, () => { clear(outlet); append(outlet, loadingBlock("Loading application")); load(); }));
      return;
    }
    draw(application);
  }

  function draw(application) {
    const section = (title, ...children) =>
      h("section", { class: "d-card p-5 sm:p-6" }, h("h2", { class: "d-title mb-4" }, title), children);
    const fact = (term, value) => h("div", {}, h("dt", {}, term), h("dd", {}, value));
    // What the applicant wrote, as they wrote it: line breaks kept, nothing treated as markup.
    const prose = (text, missing) => (text
      ? h("p", { class: "text-[0.95rem] leading-relaxed break-words whitespace-pre-line" }, text)
      : h("p", { class: "text-sm text-muted" }, missing));

    // ---- CV --------------------------------------------------------------------------------
    let cvBlock = h("p", { class: "text-sm text-muted" }, "No CV was uploaded with this application.");
    if (application.cv) {
      const download = h("button", { type: "button", class: "d-btn d-btn-primary" }, icon("download", 16), "Download CV");
      download.addEventListener("click", async () => {
        download.disabled = true;
        try {
          await downloadFile(`/applications/${id}/cv`, application.cv.name || "cv");
          toast("The CV has been downloaded.");
          await load();
        } catch (failure) {
          toastFailure(failure);
          download.disabled = false;
        }
      });
      cvBlock = h("div", { class: "flex flex-wrap items-center justify-between gap-4" },
        h("div", { class: "flex min-w-0 items-center gap-3" },
          h("span", { class: "flex size-11 shrink-0 items-center justify-center rounded-md bg-sand text-brand", "aria-hidden": "true" }, icon("file", 22)),
          h("div", { class: "min-w-0" },
            h("p", { class: "truncate font-medium" }, application.cv.name || "CV"),
            h("p", { class: "text-sm text-muted" }, fileSize(application.cv.size)))),
        // Taking the file is a permission of its own; the server checks it on every download.
        can("applications.cv") ? download : h("p", { class: "text-sm text-muted" }, "Your role does not include downloading CVs."));
    }

    // ---- status ----------------------------------------------------------------------------
    let statusBlock = h("div", {}, statusBadge(application.status));
    if (manage) {
      const select = h("select", { class: "d-input", id: "application-status" },
        STATUSES.map((status) => h("option", { value: status, selected: application.status === status }, LABELS.status[status])));
      const note = h("textarea", { class: "d-input", id: "application-note", rows: 3, maxlength: 500, "aria-describedby": "application-note-hint" });
      const save = h("button", { type: "submit", class: "d-btn d-btn-primary w-full", disabled: true }, "Update status");

      // Telling the applicant about the new status. Offered for every status that has an
      // email (all but New), to someone who may write to applicants, and ticked to begin
      // with. The email is the server's own text for that status, shown here exactly as it
      // will be sent; the note above is never part of it.
      const emailsFor = can("applications.message") ? application.status_emails ?? {} : {};
      const notify = h("input", { type: "checkbox", id: "application-notify", class: "mt-0.5 size-4 shrink-0", checked: true, "aria-describedby": "application-notify-hint" });
      const previewSubject = h("p", { class: "font-semibold" });
      const previewBody = h("p", { class: "mt-2 whitespace-pre-line" });
      const notifyBlock = h("div", { class: "rounded-md border border-line px-3 py-3", hidden: true, dataset: { notify: "" } },
        h("label", { class: "flex items-start gap-2.5 text-sm font-medium", for: "application-notify" }, notify,
          h("span", {}, `Email ${application.full_name} about the new status`)),
        h("p", { class: "d-hint", id: "application-notify-hint" }, `Sent to ${application.email} in the name of ${state.me.restaurant.name}.`),
        h("details", { class: "mt-2 text-sm" },
          h("summary", { class: "cursor-pointer font-medium text-brand" }, "See the email"),
          h("div", { class: "mt-2 rounded-md bg-canvas px-3 py-2 break-words" }, previewSubject, previewBody)));

      const sync = () => {
        const changed = select.value !== application.status;
        save.disabled = !changed && note.value.trim() === "";
        save.textContent = changed || note.value.trim() === "" ? "Update status" : "Add note";
        const email = changed ? emailsFor[select.value] : null;
        notifyBlock.hidden = !email;
        if (email) {
          previewSubject.textContent = `Subject: ${email.subject}`;
          previewBody.textContent = email.body;
        }
      };
      select.addEventListener("change", sync);
      note.addEventListener("input", sync);
      statusBlock = h("form", { class: "space-y-4", novalidate: true },
        h("div", {}, h("label", { class: "d-label", for: "application-status" }, "Status"), select),
        notifyBlock,
        h("div", {}, h("label", { class: "d-label", for: "application-note" }, "Note", h("span", { class: "font-normal text-muted" }, "(optional)")), note,
          h("p", { class: "d-hint", id: "application-note-hint" }, "Kept in the history below. The applicant never sees it.")),
        save);
      statusBlock.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        save.textContent = "Saving...";
        try {
          const request = { status: select.value, note: note.value.trim() || null };
          if (!notifyBlock.hidden && notify.checked) request.notify_applicant = true;
          const result = await api("PATCH", `/applications/${id}`, request);
          toast(result.message, result.email?.result === "failed" ? "warn" : "ok");
          announceChange();
          draw(result.application);
        } catch (failure) {
          toastFailure(failure);
          sync();
        }
      });
    }

    // ---- deleting, for an applicant who asks for their details to be removed ------------------
    let deleteBlock = null;
    if (manage) {
      const remove = h("button", { type: "button", class: "d-btn d-btn-sm" }, "Delete application");
      remove.addEventListener("click", async () => {
        const confirmed = await confirmDialog({
          title: `Delete ${application.full_name}'s application?`,
          body: [
            "The application, the CV and the history are deleted for good. This cannot be undone.",
            "Use this when an applicant asks for their details to be removed. Otherwise applications are deleted by themselves at the end of the period they are kept for.",
          ],
          confirmLabel: "Delete for good", danger: true,
        });
        if (!confirmed) return;
        remove.disabled = true;
        try {
          const result = await api("DELETE", `/applications/${id}`);
          toast(result.message);
          announceChange();
          location.hash = "#/applications";
        } catch (failure) {
          toastFailure(failure);
          remove.disabled = false;
        }
      });
      deleteBlock = h("section", { class: "d-card p-5 sm:p-6" },
        h("h2", { class: "d-title mb-2" }, "Remove this applicant's details"),
        h("p", { class: "mb-4 text-sm text-muted" }, "If the applicant asks you to delete what you hold about them, do it here. It deletes the application, the CV and the history."),
        remove);
    }

    // ---- messages to the applicant -------------------------------------------------------------
    // What has been written to them from here, newest first, each with what became of it.
    // "Delivered" is shown only when the email provider itself reports it.
    const messages = application.messages ?? [];
    const restaurant = state.me.restaurant.name;
    const writes = can("applications.message");
    const messageList = h("ul", { class: "divide-y divide-line", dataset: { messages: "" } }, [...messages].reverse().map((message) => {
      const [text, tone] = MESSAGE_STATUS[message.status] ?? [message.status, ""];
      const retry = writes && message.status === "failed" && h("button", { type: "button", class: "d-btn d-btn-sm" }, "Try again");
      if (retry) {
        retry.addEventListener("click", async () => {
          retry.disabled = true;
          try {
            const result = await api("POST", `/applications/${id}/messages/${message.id}/retry`);
            toast(result.notice, result.result === "sent" ? "ok" : "bad");
            await load();
          } catch (failure) {
            toastFailure(failure);
            retry.disabled = false;
          }
        });
      }
      return h("li", { class: "py-4 first:pt-0 last:pb-0" },
        h("div", { class: "flex flex-wrap items-start justify-between gap-x-3 gap-y-2" },
          h("p", { class: "min-w-0 font-semibold break-words" }, message.subject),
          h("div", { class: "flex items-center gap-2" }, badge(text, tone), retry)),
        h("p", { class: "mt-0.5 text-[0.82rem] text-muted" },
          `To ${message.to_email}`, message.sent_by_email ? `, by ${message.sent_by_email}` : "", `, ${formatDateTime(message.created_at, state.locale)}`,
          message.delivered_at ? `. Delivered ${formatDateTime(message.delivered_at, state.locale)}.` : "."),
        message.status_detail && h("p", { class: "mt-1 text-[0.82rem] font-medium text-bad" }, message.status_detail),
        h("details", { class: "mt-2 text-sm" },
          h("summary", { class: "cursor-pointer font-medium text-brand" }, "Read the message"),
          h("p", { class: "mt-2 rounded-md bg-canvas px-3 py-2 break-words whitespace-pre-line" }, message.body)));
    }));

    let composer = null;
    if (writes) {
      const template = h("select", { class: "d-input", id: "message-template" },
        MESSAGE_TEMPLATES.map((entry) => h("option", { value: entry.kind }, entry.name)));
      const subject = h("input", { class: "d-input", id: "message-subject", type: "text", maxlength: 150, required: true });
      const body = h("textarea", { class: "d-input", id: "message-body", rows: 9, maxlength: 5000, required: true, "aria-describedby": "message-hint" });
      const send = h("button", { type: "submit", class: "d-btn d-btn-primary" }, icon("mail", 16), "Send message");
      const problem = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
      // The beginning in use and what it put in the boxes, to tell typing from it apart.
      let chosen = template.value;
      let filled = { subject: "", body: "" };
      // One key per message: pressing Send twice, or trying again after a lost answer,
      // sends one email. A new key is made only once a message has gone.
      let key = newIdempotencyKey();
      const fill = () => {
        const entry = MESSAGE_TEMPLATES.find((candidate) => candidate.kind === template.value);
        chosen = entry.kind;
        filled = { subject: entry.subject(application, restaurant), body: entry.body(application, restaurant) };
        subject.value = filled.subject;
        body.value = filled.body;
      };
      template.addEventListener("change", async () => {
        const typed = subject.value !== filled.subject || body.value !== filled.body;
        if (typed && !(await confirmDialog({ title: "Replace what you have written?", body: "Choosing another beginning replaces the subject and the message in the boxes.", confirmLabel: "Replace" }))) {
          template.value = chosen;
          return;
        }
        fill();
      });
      fill();
      composer = h("form", { class: "space-y-4", novalidate: true },
        h("div", {}, h("label", { class: "d-label", for: "message-template" }, "Start from"), template),
        h("div", {}, h("label", { class: "d-label", for: "message-subject" }, "Subject"), subject),
        h("div", {}, h("label", { class: "d-label", for: "message-body" }, "Message"), body,
          h("p", { class: "d-hint", id: "message-hint" },
            `Sent to ${application.email} in the name of ${restaurant}. Their answer comes to the restaurant's recruitment inbox.`)),
        problem,
        h("div", {}, send));
      composer.addEventListener("submit", async (event) => {
        event.preventDefault();
        problem.hidden = true;
        if (subject.value.trim() === "" || body.value.trim() === "") {
          problem.textContent = "Write a subject and a message first.";
          problem.hidden = false;
          return (subject.value.trim() === "" ? subject : body).focus();
        }
        const confirmed = await confirmDialog({
          title: `Send this message to ${application.full_name}?`,
          body: [`It will be emailed to ${application.email} from ${restaurant}, and kept on this application.`, `Subject: ${subject.value.trim()}`],
          confirmLabel: "Send message",
        });
        if (!confirmed) return;
        send.disabled = true;
        try {
          const result = await api("POST", `/applications/${id}/messages`, { kind: chosen, subject: subject.value.trim(), body: body.value.trim() }, { "idempotency-key": key });
          key = newIdempotencyKey();
          toast(result.notice, result.result === "sent" ? "ok" : "bad");
          await load();
        } catch (failure) {
          problem.textContent = failure.details?.fields ? Object.entries(failure.details.fields).map(([name, text]) => `The ${name} ${text}.`).join(" ") : explain(failure);
          problem.hidden = false;
          send.disabled = false;
        }
      });
    }
    const messagesSection = (writes || messages.length > 0) && h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "messages-title" },
      h("h2", { id: "messages-title", class: "d-title mb-4" }, "Messages to the applicant"),
      composer,
      messages.length > 0
        ? h("div", { class: composer ? "mt-6 border-t border-line pt-5" : "" },
            h("h3", { class: "d-section-title mb-3" }, messages.length === 1 ? "1 message sent from here" : `${messages.length} messages sent from here`), messageList)
        : !composer && h("p", { class: "text-sm text-muted" }, "Nothing has been written to this applicant from the dashboard."));

    // ---- history, newest first ---------------------------------------------------------------
    const history = h("ol", { class: "d-timeline" }, [...application.events].reverse().map((event) =>
      h("li", {},
        h("p", { class: "font-medium" }, (EVENT_TITLES[event.kind] ?? (() => event.kind))(event)),
        event.note && h("p", { class: "mt-1 rounded-md bg-canvas px-3 py-2 text-sm break-words whitespace-pre-line" }, event.note),
        h("p", { class: "mt-0.5 text-[0.82rem] text-muted" },
          formatDateTime(event.created_at, state.locale), event.actor_email ? `, by ${event.actor_email}` : ""))));

    clear(outlet);
    append(outlet,
      pageHeader({
        crumbs: [{ label: "Job applications", href: "#/applications" }, { label: application.full_name }],
        title: application.full_name,
        actions: statusBadge(application.status),
      }),
      application.email_status === "failed" && h("div", { class: "d-alert d-alert-warn mb-5" },
        "The notification email for this application could not be sent. The application itself is saved in full, here."),
      application.other_applications > 0 && h("div", { class: "d-alert d-alert-info mb-5 flex flex-wrap items-center justify-between gap-3" },
        h("p", {}, application.other_applications === 1
          ? "This person has sent one other application."
          : `This person has sent ${application.other_applications} other applications.`),
        h("a", { href: `#/applications?search=${encodeURIComponent(application.email)}`, class: "d-btn d-btn-sm" }, "Show them all")),

      h("div", { class: "grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]" },
        h("div", { class: "space-y-5" },
          section("Application",
            h("dl", { class: "d-facts text-sm" },
              fact("Position", application.position),
              fact("Applied", `${formatDateTime(application.created_at, state.locale)} (${timeAgo(application.created_at)})`),
              fact("Looking for", label("employment_type", application.employment_type) || "Not answered"),
              fact("Available", application.availability.map((slot) => label("availability", slot)).join(", ") || "Not answered"),
              fact("Can start", label("start_when", application.start_when) || "Not answered"),
              fact("Experience", label("experience_level", application.experience_level) || "Not answered"),
              fact("Authorized to work in the US", application.work_authorized === null ? "Not answered" : application.work_authorized ? "Yes" : "No"))),
          section("Relevant experience", prose(application.experience, "The applicant did not describe their experience.")),
          section("Introduction", prose(application.message, "The applicant did not write an introduction.")),
          section("Resume / CV", cvBlock),
          messagesSection),

        h("aside", { class: "space-y-5 lg:sticky lg:top-24" },
          section("Contact",
            h("ul", { class: "space-y-3 text-sm" },
              h("li", { class: "flex items-center gap-3" }, h("span", { class: "text-brand", "aria-hidden": "true" }, icon("mail")),
                h("a", { href: `mailto:${application.email}`, class: "font-medium break-all hover:text-brand hover:underline" }, application.email)),
              h("li", { class: "flex items-center gap-3" }, h("span", { class: "text-brand", "aria-hidden": "true" }, icon("phone")),
                h("a", { href: `tel:${application.phone.replace(/[^\d+]/g, "")}`, class: "font-medium hover:text-brand hover:underline" }, application.phone)))),
          section("Status", statusBlock),
          section("History", history),
          deleteBlock)));
  }

  await load();
}
