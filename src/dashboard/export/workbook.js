// The export of job applications as an Excel workbook.
//
// One sheet, "Applications", read from the top:
//
//   rows 1-3  the report's head on night: the restaurant, the title, and one line saying
//             when it was generated, in which time zone, and what was asked for
//   rows 4-5  the summary on cream: how many applications in all, and at each stage
//   row 6     the table's headings
//   row 7 on  one application per row
//
// Rows 1 to 6 stay in view while the rows scroll. The applications are a real Excel table
// (excel-table.js), so each heading has a filter button; the summary sits above the table,
// outside it, and is not caught by a filter or a sort.
//
// Every value an applicant wrote is stored as text (a "string" cell), so Excel shows it and
// never works it out: a name that starts with "=" is a name, not a formula.
//
// This file is loaded only when an owner asks for an Excel export, so the library that
// writes workbooks is not part of the dashboard anyone else downloads.
import writeXlsxFile from "write-excel-file/universal";
import { label, STATUSES } from "../../js/lib/application.js";
import { COLUMNS, exportRow, formatStamp, summarize, wallClock } from "./applications.js";
import { excelTable, tableRange } from "./excel-table.js";

export const SHEET_NAME = "Applications";
export const TABLE_NAME = "JobApplications";
// The row the table's headings are on, and so the number of rows that stay in view.
export const HEADING_ROW = 6;
export const DATE_FORMAT = "yyyy-mm-dd hh:mm";

// The dashboard's own colours (src/styles/dashboard.css).
const NIGHT = "#18120F";
const INK = "#2B211E";
const MUTED = "#6E645C";
const GOLD = "#C9A063";
const BRAND = "#835F20";
const SAND = "#EFEBE3";
const CANVAS = "#F6F4F0";
const LINE = "#E6DFD3";
const WHITE = "#FFFFFF";
const ON_NIGHT = "#D9CFC2";

// A stage is written in the colour its badge has in the dashboard.
const STATUS_COLOURS = {
  new: "#1F4F8F", reviewing: "#8A5A00", shortlisted: "#6B4D18", interview: "#6B4D18", hired: "#17663A", rejected: MUTED,
};

const FONT = "Calibri";
const WIDTH = COLUMNS.length;
const ABOUT_LINE_LENGTH = 150;

// A row of the head: one cell across the whole width.
const band = (value, style) => [
  { value, type: String, columnSpan: WIDTH, backgroundColor: NIGHT, indent: 1, alignVertical: "center", ...style },
  ...Array(WIDTH - 1).fill(null),
];

// An instant as the cell Excel needs: a date whose clock reads the wall time of the zone.
function dateCell(instant, timeZone) {
  const clock = wallClock(instant, timeZone);
  return clock ? new Date(Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second)) : null;
}

// The sheet as rows of cells. Kept apart from writing the file so that what is in each
// cell can be read without opening one.
export function sheetData({ restaurantName, generatedAt, timeZone, scopeText, applications }) {
  const { total, byStatus } = summarize(applications);
  const figures = [["Total", total], ...STATUSES.map((status) => [label("status", status), byStatus[status]])];
  // The summary has one figure per column. If a stage is ever added, the row would run
  // past the table: say so here rather than produce a lopsided report.
  if (figures.length > WIDTH) throw new Error("The workbook could not be built: more stages than columns.");
  const rest = Array(WIDTH - figures.length).fill({ backgroundColor: SAND });

  // The line under the title. Its length depends on the filters, and Excel does not make a
  // row taller for text in a merged cell, so the height is worked out here: one line of
  // this size holds about 150 characters across the sheet's width.
  const about = `Generated: ${formatStamp(generatedAt, timeZone)} (${timeZone})   |   ${scopeText}   |   Main information only`;
  const aboutLines = Math.min(4, Math.ceil(about.length / ABOUT_LINE_LENGTH));

  const head = [
    band(restaurantName.toUpperCase(), { textColor: GOLD, fontWeight: "bold", fontSize: 9, height: 24 }),
    band("Job Applications", { textColor: WHITE, fontFamily: "Georgia", fontSize: 20, height: 36 }),
    band(about, { textColor: ON_NIGHT, fontSize: 9, height: 12 + 12 * aboutLines, wrap: true }),
    [...figures.map(([name]) => ({
      value: name.toUpperCase(), type: String, backgroundColor: SAND, textColor: BRAND, fontWeight: "bold", fontSize: 8,
      height: 22, indent: 1, alignVertical: "bottom",
    })), ...rest],
    [...figures.map(([, count]) => ({
      value: count, type: Number, backgroundColor: SAND, textColor: INK, fontWeight: "bold", fontSize: 16,
      height: 30, indent: 1, align: "left", alignVertical: "center", bottomBorderStyle: "medium", bottomBorderColor: GOLD,
    })), ...rest.map((cell) => ({ ...cell, bottomBorderStyle: "medium", bottomBorderColor: GOLD }))],
    COLUMNS.map((column) => ({
      value: column.title, type: String, backgroundColor: INK, textColor: WHITE, fontWeight: "bold", fontSize: 10,
      height: 26, indent: 1, alignVertical: "center",
    })),
  ];

  if (applications.length === 0) {
    return [...head, [
      { value: "No applications match this export.", type: String, columnSpan: WIDTH, textColor: MUTED, fontStyle: "italic", fontSize: 10, height: 28, indent: 1, alignVertical: "center" },
      ...Array(WIDTH - 1).fill(null),
    ]];
  }

  const text = { fontSize: 10, textColor: INK, indent: 1, alignVertical: "center", wrap: true, bottomBorderStyle: "thin", bottomBorderColor: LINE };
  const rows = applications.map((application) => {
    const row = exportRow(application);
    const applied = dateCell(row.applied, timeZone);
    return COLUMNS.map((column) => {
      if (column.key === "applied") {
        return applied
          ? { ...text, value: applied, type: Date, format: DATE_FORMAT, align: "left", wrap: false }
          : { ...text, value: "", type: String };
      }
      if (column.key === "status") {
        return { ...text, value: row.status, type: String, fontWeight: "bold", textColor: STATUS_COLOURS[row.statusKey] ?? INK };
      }
      return { ...text, value: row[column.key], type: String };
    });
  });
  return [...head, ...rows];
}

// The options that go with the sheet: widths, the rows held in view, and the shading of
// every other row. The shading is a rule, not a colour painted on rows: it counts the rows
// that are showing, so it stays every other row after the table is sorted or filtered.
export function sheetOptions(rowCount) {
  const first = HEADING_ROW + 1;
  return {
    sheet: SHEET_NAME,
    columns: COLUMNS.map((column) => ({ width: column.width })),
    stickyRowsCount: HEADING_ROW,
    showGridLines: false,
    orientation: "landscape",
    conditionalFormatting: rowCount < 1 ? undefined : [{
      cellRange: { from: { row: first, column: 1 }, to: { row: HEADING_ROW + rowCount, column: WIDTH } },
      condition: { formula: `MOD(SUBTOTAL(103,$A$${first}:$A${first}),2)=0` },
      style: { backgroundColor: CANVAS },
    }],
  };
}

// The range the table covers in a workbook of `rowCount` applications, or null for none.
export const applicationsTableRange = (rowCount) =>
  (rowCount < 1 ? null : tableRange({ headingRow: HEADING_ROW, columnCount: WIDTH, rowCount }));

// The workbook itself, as the bytes of an .xlsx file.
export async function buildWorkbook(report) {
  const rowCount = report.applications.length;
  const table = excelTable({ name: TABLE_NAME, headingRow: HEADING_ROW, columns: COLUMNS.map((column) => column.title), rowCount });
  return writeXlsxFile(sheetData(report), sheetOptions(rowCount), {
    fontFamily: FONT, fontSize: 10, features: table ? [table] : [],
  }).toBlob();
}
