// Job applications: the list with its search and filters, and one application in full
// with its CV, its status and its history.
//
// Everything shown here comes from the dashboard API, which answers only a signed-in owner
// or manager of this restaurant. Nothing is cached or kept in the browser: leaving the page
// leaves no applicant's details behind.
import { fileSize, label, LABELS, STATUSES } from "../../js/lib/application.js";
import { formatDateTime, timeAgo } from "../../js/lib/format.js";
import { api, downloadFile } from "../api.js";
import { can, state } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, h, icon, loadingBlock, pageHeader, stateBlock, toast, toastFailure } from "../ui.js";

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

  const statusBar = h("div", { class: "d-pills mb-4", role: "group", "aria-label": "Filter by status" });
  const toolbar = h("div", { class: "d-card mb-4 p-3 sm:p-4" });
  const listRegion = h("div", { "aria-live": "polite" });
  const positionSelect = h("select", { class: "d-input", id: "filter-position" });

  const isFiltered = () => Boolean(filters.search || filters.status || filters.position || filters.from || filters.to);
  const change = (key, value) => {
    filters[key] = value;
    filters.offset = 0;
    load();
  };
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

    const table = h("div", { class: "d-card hidden overflow-x-auto xl:block" },
      h("table", { class: "d-table" },
        h("caption", { class: "sr-only" }, "Job applications, newest first"),
        h("thead", {}, h("tr", {},
          ["Applicant", "Position", "Experience", "Applied", "CV", "Status"].map((title) => h("th", { scope: "col" }, title)),
          h("th", { scope: "col", class: "text-right" }, h("span", { class: "sr-only" }, "Open")))),
        h("tbody", {}, data.applications.map((application) => h("tr", {},
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
          h("div", { class: "min-w-0" },
            h("a", { href: open(application), class: "font-semibold hover:text-brand hover:underline" }, application.full_name),
            h("p", { class: "text-sm text-muted" }, application.position)),
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
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(filters.offset) });
    if (filters.search) params.set("search", filters.search);
    if (filters.status) params.set("status", filters.status);
    if (filters.position) params.set("position", filters.position);
    if (filters.from) params.set("from", dayStart(filters.from));
    if (filters.to) params.set("to", dayEnd(filters.to));
    try {
      data = await api("GET", `/applications?${params}`);
      draw();
      announceChange(data.counts.new ?? 0);
    } catch (failure) {
      clear(listRegion);
      append(listRegion, errorBlock(failure, load));
    }
  }

  const refresh = h("button", { type: "button", class: "d-btn" }, icon("clover", 16), "Refresh");
  refresh.addEventListener("click", load);

  append(outlet,
    pageHeader({ title: "Job applications", actions: refresh }),
    h("p", { class: "-mt-3 mb-6 max-w-2xl text-sm text-muted" },
      "Everyone who has applied through the Join Our Team page, newest first. Open an application to read it in full, download the CV and set where it stands."),
    statusBar, toolbar, listRegion);
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
        download);
    }

    // ---- status ----------------------------------------------------------------------------
    let statusBlock = h("div", {}, statusBadge(application.status));
    if (manage) {
      const select = h("select", { class: "d-input", id: "application-status" },
        STATUSES.map((status) => h("option", { value: status, selected: application.status === status }, LABELS.status[status])));
      const note = h("textarea", { class: "d-input", id: "application-note", rows: 3, maxlength: 500, "aria-describedby": "application-note-hint" });
      const save = h("button", { type: "submit", class: "d-btn d-btn-primary w-full", disabled: true }, "Update status");
      const sync = () => {
        const changed = select.value !== application.status;
        save.disabled = !changed && note.value.trim() === "";
        save.textContent = changed || note.value.trim() === "" ? "Update status" : "Add note";
      };
      select.addEventListener("change", sync);
      note.addEventListener("input", sync);
      statusBlock = h("form", { class: "space-y-4", novalidate: true },
        h("div", {}, h("label", { class: "d-label", for: "application-status" }, "Status"), select),
        h("div", {}, h("label", { class: "d-label", for: "application-note" }, "Note", h("span", { class: "font-normal text-muted" }, "(optional)")), note,
          h("p", { class: "d-hint", id: "application-note-hint" }, "Kept in the history below. The applicant never sees it.")),
        save);
      statusBlock.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        save.textContent = "Saving...";
        try {
          const result = await api("PATCH", `/applications/${id}`, { status: select.value, note: note.value.trim() || null });
          toast(result.message);
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
          section("Resume / CV", cvBlock)),

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
