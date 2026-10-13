// The dialog an owner exports job applications from.
//
// It asks two things: which applications, and in which format. Before anything is
// generated it asks the server how many applications that choice comes to and says so, and
// the button carries the same number. The file is then built here, in the browser, from the
// rows the server sends for exactly that choice.
//
// What the file holds is the main information of each application, as the list shows it:
// no contact details and none of the applicant's own words. The server sends nothing else
// for an export.
import { api, explain, saveBlob } from "../api.js";
import { csvBlob, describeScope, exportFilename, localTimeZone } from "../export/applications.js";
import { state } from "../state.js";
import { append, clear, h, icon, openDialog, toast } from "../ui.js";

const FORMATS = [
  { value: "xlsx", name: "Excel workbook (.xlsx)", hint: "Laid out for reading: a summary, column filters and the headings kept in view." },
  { value: "csv", name: "CSV (.csv)", hint: "Plain rows for another program to read. Values that could be read as formulas are marked as text." },
];

const count = (number) => new Intl.NumberFormat(state.locale).format(number);
const applications = (number) => (number === 1 ? "1 application" : `${count(number)} applications`);

// `choices` is what the list can offer at this moment, each with the request the server is
// sent for it:  { value, name, hint, request: { scope, filters?, ids? }, kind }
// `kind` is how the choice is described in the head of the file.
// `filters` is the list's own filters, in the owner's words, for that description.
export function exportDialog({ choices, initial, filters }) {
  let chosen = choices.find((choice) => choice.value === initial) ?? choices[0];
  let format = "xlsx";
  // What the server last said the chosen applications come to; null while it is being asked.
  let counted = null;
  let asking = 0;
  let closed = false;
  let busy = false;

  const status = h("p", { class: "d-alert d-alert-info mt-5", role: "status", "aria-live": "polite", dataset: { exportCount: "" } }, "Counting...");
  const problem = h("div", { class: "d-alert d-alert-bad mt-4", role: "alert", hidden: true });
  const submit = h("button", { type: "submit", class: "d-btn d-btn-primary", disabled: true }, icon("export", 16), h("span", {}, "Export"));
  const submitText = submit.querySelector("span");
  const cancel = h("button", { type: "button", class: "d-btn", onClick: () => dialog.close() }, "Cancel");

  const radio = (group, option, isChosen, onChoose) => {
    const input = h("input", { type: "radio", name: group, value: option.value, checked: isChosen });
    input.addEventListener("change", () => { if (input.checked) onChoose(option); });
    return h("label", { class: "d-choice" }, input,
      h("span", { class: "min-w-0" },
        h("span", { class: "block font-semibold text-text" }, option.name),
        option.hint && h("span", { class: "mt-0.5 block text-[0.82rem] text-muted break-words" }, option.hint)));
  };

  const which = h("fieldset", { class: "mt-5" },
    h("legend", { class: "d-label" }, "Which applications"),
    h("div", { class: "space-y-2" }, choices.map((choice) => radio("export-scope", choice, choice === chosen, (next) => {
      chosen = next;
      countChosen();
    }))));
  const how = h("fieldset", { class: "mt-5" },
    h("legend", { class: "d-label" }, "File format"),
    h("div", { class: "space-y-2" }, FORMATS.map((option) => radio("export-format", option, option.value === format, (next) => {
      format = next.value;
    }))));

  const form = h("form", { class: "p-6", novalidate: true },
    h("h2", { class: "d-title text-lg" }, "Export applications"),
    h("p", { class: "mt-1 text-sm text-muted" },
      "A file with the main information of each application: applicant, position, experience, date applied, CV and status. Contact details and what applicants wrote stay in the dashboard."),
    which, how, status, problem,
    h("div", { class: "mt-6 flex flex-wrap justify-end gap-2" }, cancel, submit));

  function setBusy(isBusy) {
    busy = isBusy;
    which.disabled = isBusy;
    how.disabled = isBusy;
    drawCount();
  }

  // The line that says what will be exported, and the button that does it. Both are drawn
  // from the server's count, never from a guess.
  function drawCount() {
    clear(status);
    const exportable = counted !== null && counted.count > 0 && counted.exportable;
    submit.disabled = busy || !exportable;
    submitText.textContent = busy ? "Preparing the file..." : exportable ? `Export ${applications(counted.count)}` : "Export";
    if (counted === null) return append(status, "Counting...");
    if (counted.count === 0) return append(status, "There is nothing to export for this choice.");
    if (!counted.exportable) {
      return append(status, `${applications(counted.count)} match, and one file holds ${count(counted.limit)} at most. Narrow the filters and export in parts.`);
    }
    append(status, h("strong", {}, applications(counted.count)), " will be exported.");
    // Someone else may have deleted an application that was ticked a moment ago.
    if (counted.requested !== null && counted.count < counted.requested) {
      append(status, ` ${count(counted.requested - counted.count)} of the ${count(counted.requested)} chosen no longer exist.`);
    }
  }

  async function countChosen() {
    const mine = ++asking;
    counted = null;
    problem.hidden = true;
    drawCount();
    try {
      const answer = await api("POST", "/applications/export/preview", chosen.request);
      if (mine !== asking || closed) return;
      counted = answer;
    } catch (failure) {
      if (mine !== asking || closed) return;
      problem.textContent = explain(failure);
      problem.hidden = false;
      clear(status);
      append(status, "The applications could not be counted.");
      submit.disabled = true;
      return;
    }
    drawCount();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // One export at a time: the button is off from the first press until the file is saved.
    if (busy || submit.disabled) return;
    problem.hidden = true;
    setBusy(true);
    try {
      const data = await api("POST", "/applications/export", { ...chosen.request, format });
      const timeZone = localTimeZone();
      const report = {
        restaurantName: data.restaurant.name, generatedAt: data.generated_at, timeZone,
        scopeText: describeScope(chosen.kind, filters), applications: data.applications,
      };
      // The workbook writer is fetched only now, the first time an Excel file is asked for.
      const blob = format === "csv" ? csvBlob(report) : await (await import("../export/workbook.js")).buildWorkbook(report);
      if (closed) return;
      const filename = exportFilename({ slug: data.restaurant.slug, generatedAt: data.generated_at, timeZone, format });
      saveBlob(blob, filename);
      toast(`${applications(data.count)} exported to ${filename}.`);
      dialog.close();
    } catch (failure) {
      if (closed) return;
      problem.textContent = failure.status === undefined
        ? "The file could not be made. Nothing was saved. Try again."
        : explain(failure);
      problem.hidden = false;
      setBusy(false);
      // What matches may have changed since it was counted.
      if (failure.code === "export_too_large") countChosen();
    }
  });

  const dialog = openDialog(form, { onClose: () => { closed = true; } });
  which.querySelector("input:checked")?.focus();
  countChosen();
  return dialog;
}
