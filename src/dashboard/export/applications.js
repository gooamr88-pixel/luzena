// The export of job applications: what goes into the file, and how each value is worded.
//
// An export is the applications list in a file: the main facts of each application and no
// more (the client's decision, 2026-10-13). Contact details and the applicant's own words
// are not in it. The server does not send them for an export, so this file could not add
// them if it tried.
//
// Everything here is plain logic with no page in it, so the same code that runs in the
// owner's browser is what the tests run. The Excel workbook is laid out in workbook.js.
import { label, STATUSES } from "../../js/lib/application.js";

// The columns, in order. `width` is in Excel's own unit, about one character.
export const COLUMNS = [
  { key: "applicant", title: "Applicant", width: 30 },
  { key: "position", title: "Position", width: 28 },
  { key: "lookingFor", title: "Looking for", width: 24 },
  { key: "experience", title: "Experience", width: 20 },
  // Wide enough for "2026-10-13 09:41" with room to spare: Excel draws a date that does
  // not fit its column as a row of # signs.
  { key: "applied", title: "Applied", width: 20 },
  { key: "cv", title: "CV", width: 9 },
  { key: "status", title: "Status", width: 15 },
];

// Characters that have no place in a cell: control characters and half surrogates (one of
// either makes an Excel file unreadable), the line and paragraph separators, the
// byte-order mark, and the characters that override the direction text is drawn in, which
// serve only to make a value look like something it is not. The joiners and direction
// marks that Arabic, Persian and other scripts are really written with are kept: a name
// comes out as it was typed. Line breaks and tabs become spaces, since every value here is
// one line.
//
// Written as code points, never as the characters themselves: several of them are
// invisible, and two would end the line of this very file.
const UNPRINTABLE = /[\p{Cc}\p{Cs}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}\u{FFFE}\u{FFFF}]/gu;

export function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\t\r\n]+/g, " ").replace(UNPRINTABLE, "").replace(/ {2,}/g, " ").trim();
}

// One application as the file shows it. Every value is text except `applied`, which stays
// an instant so that each format can write a real date.
export function exportRow(application) {
  return {
    applicant: cleanText(application.full_name) || "(no name)",
    position: cleanText(application.position),
    lookingFor: label("employment_type", application.employment_type),
    experience: label("experience_level", application.experience_level),
    applied: application.created_at,
    cv: application.has_cv ? "Yes" : "No",
    status: label("status", application.status),
    statusKey: application.status,
  };
}

// How many applications there are in all and at each stage. Counted from the very rows
// that go into the file, so the summary can never disagree with the table under it.
export function summarize(applications) {
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const application of applications) {
    if (application.status in byStatus) byStatus[application.status] += 1;
  }
  return { total: applications.length, byStatus };
}

// ---------------------------------------------------------------------------------------
// Dates. A spreadsheet has no time zones: a cell holds a wall-clock time. So every time is
// turned into the wall clock of one named zone (the owner's own, in the browser), and the
// file says which zone that is.
// ---------------------------------------------------------------------------------------

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// The wall-clock reading of an instant in a time zone, or null for something that is not a date.
export function wallClock(instant, timeZone) {
  const date = new Date(instant);
  if (instant === null || instant === undefined || Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const read = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
}

const two = (number) => String(number).padStart(2, "0");

// "2026-10-13 09:41": sorts correctly as text and is read as a date by every spreadsheet.
export function formatStamp(instant, timeZone) {
  const clock = wallClock(instant, timeZone);
  return clock ? `${clock.year}-${two(clock.month)}-${two(clock.day)} ${two(clock.hour)}:${two(clock.minute)}` : "";
}

const dayOf = (instant, timeZone) => formatStamp(instant, timeZone).slice(0, 10);

// ---------------------------------------------------------------------------------------
// What was asked for, in words, for the head of the report.
// ---------------------------------------------------------------------------------------

// `filters` is the dashboard's own: search, status, position, and the two days as the
// owner picked them (YYYY-MM-DD).
export function describeScope(scope, filters = {}) {
  if (scope === "selected") return "Selected applications";
  if (scope === "page") return "The applications on one page of the list";
  if (scope !== "filtered") return "All applications";
  const parts = [];
  if (filters.status) parts.push(`status ${label("status", filters.status)}`);
  if (filters.position) parts.push(`position ${cleanText(filters.position)}`);
  if (filters.from) parts.push(`applied from ${filters.from}`);
  if (filters.to) parts.push(`applied until ${filters.to}`);
  if (filters.search) parts.push(`matching "${cleanText(filters.search)}"`);
  return parts.length > 0 ? `Filtered: ${parts.join("; ")}` : "All applications";
}

// ---------------------------------------------------------------------------------------
// The file's name. Built from fixed words, the restaurant's own short name and the date:
// nothing an applicant wrote, and nothing that could be read as a path.
// ---------------------------------------------------------------------------------------

const EXTENSIONS = ["xlsx", "csv"];

export function exportFilename({ slug, generatedAt, timeZone, format }) {
  const safeSlug = String(slug ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "restaurant";
  const day = dayOf(generatedAt, timeZone) || "undated";
  const extension = EXTENSIONS.includes(format) ? format : "xlsx";
  return `${safeSlug}-job-applications-${day}.${extension}`;
}

// ---------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------

// A spreadsheet treats a cell that begins with = + - or @ as a formula, and a formula can
// reach outside the file (run a program, send data to an address). The names and positions
// in an export were typed by strangers into a public form, so every value is checked: one
// that would start a formula is given a leading apostrophe, which makes a spreadsheet show
// it as the text it is. "Begins with" means after any spaces, control characters or
// invisible characters, which a spreadsheet may skip and which are an obvious way to hide
// the first character. The full-width forms of the four characters (U+FF1D, U+FF0B,
// U+FF0D, U+FF20) are included, because some versions of Excel treat them as the plain
// ones. A tab or a carriage return at the start is neutralised too.
const STARTS_FORMULA = /^[\s\p{Cc}\p{Cf}\p{Z}]*[=+\-@\u{FF1D}\u{FF0B}\u{FF0D}\u{FF20}]/u;

export function csvSafe(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[\t\r]/.test(text) || STARTS_FORMULA.test(text) ? `'${text}` : text;
}

// Every field is quoted, and a quotation mark inside it is doubled: commas, quotation
// marks and line breaks in a value then cannot break out of their cell.
export const csvField = (value) => `"${csvSafe(value).replace(/"/g, '""')}"`;

// The byte-order mark, by its code point. At the head of a file it is what makes Excel
// read the file as UTF-8; without it, Arabic and accented names arrive as nonsense.
const BYTE_ORDER_MARK = String.fromCodePoint(0xFEFF);

// The export as CSV text: a header row and one row per application, nothing else, so that
// any other system can read it. Lines end with CR LF, as the CSV convention has it.
export function buildCsv({ applications, timeZone }) {
  const lines = [COLUMNS.map((column) => csvField(column.title)).join(",")];
  for (const application of applications) {
    const row = exportRow(application);
    lines.push(COLUMNS.map((column) => csvField(column.key === "applied" ? formatStamp(row.applied, timeZone) : row[column.key])).join(","));
  }
  return `${BYTE_ORDER_MARK}${lines.join("\r\n")}\r\n`;
}

export const csvBlob = (report) => new Blob([buildCsv(report)], { type: "text/csv;charset=utf-8" });
