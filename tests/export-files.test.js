// The files an export of job applications produces: the Excel workbook and the CSV.
//
// These are built by the very code the dashboard runs in the owner's browser
// (src/dashboard/export), from made-up applicants, and then read back. The workbook is read
// the way Excel reads it, by opening the archive and its XML (tests/helpers/xlsx.js), not
// through the library that wrote it.
//
// What this cannot show is how Excel draws the file. No spreadsheet program is installed
// where these tests run; see TESTING.md for what was and was not checked by eye.
import { describe, expect, it } from "vitest";
import {
  buildCsv, cleanText, COLUMNS, csvBlob, csvField, csvSafe, describeScope, exportFilename, exportRow, formatStamp, summarize,
} from "../src/dashboard/export/applications.js";
import { columnLetter, excelTable, tableRange, tableXml } from "../src/dashboard/export/excel-table.js";
import { applicationsTableRange, buildWorkbook, DATE_FORMAT, HEADING_ROW, SHEET_NAME, TABLE_NAME } from "../src/dashboard/export/workbook.js";
import { LABELS, STATUSES } from "../src/js/lib/application.js";
import { cellPosition, malformed, rangesOverlap, readWorkbook, serialToStamp } from "./helpers/xlsx.js";

const ZONE = "America/Los_Angeles";
const TITLES = COLUMNS.map((column) => column.title);
const LAST = "G";

// Invisible characters, by code point, so that this file shows what it is testing.
const ZERO_WIDTH_SPACE = "\u{200B}";
const NO_BREAK_SPACE = "\u{A0}";
const BYTE_ORDER_MARK = "\u{FEFF}";
const RIGHT_TO_LEFT_OVERRIDE = "\u{202E}";
const ZERO_WIDTH_NON_JOINER = "\u{200C}";

let sequence = 0;
const applicant = (overrides = {}) => {
  sequence += 1;
  return {
    full_name: `Applicant ${sequence}`, position: "Barista", status: "new", employment_type: "part_time", experience_level: "1_2",
    has_cv: true, created_at: "2026-10-13T16:41:00.000Z", ...overrides,
  };
};
const report = (applications, more = {}) => ({
  restaurantName: "Luzena Restaurant & Cafe", generatedAt: "2026-10-13T16:41:00.000Z", timeZone: ZONE,
  scopeText: "All applications", applications, ...more,
});
const workbookOf = async (applications, more) => readWorkbook(new Uint8Array(await (await buildWorkbook(report(applications, more))).arrayBuffer()));

// A representative set: every stage, missing answers, long text, several scripts.
const people = () => [
  applicant({ full_name: "Maya Thompson", status: "new", created_at: "2026-10-13T16:41:00.000Z" }),
  applicant({ full_name: "Daniel Ortiz", position: "Line Cook", status: "reviewing", employment_type: "full_time", experience_level: "over_5", created_at: "2026-10-12T03:05:00.000Z" }),
  applicant({ full_name: "Priya Nair", position: "Waiter / Waitress", status: "reviewing", employment_type: "either", has_cv: false, created_at: "2026-10-11T19:30:00.000Z" }),
  applicant({ full_name: "Omar Haddad", position: "Head Chef", status: "shortlisted", experience_level: "3_5", created_at: "2026-10-10T08:00:00.000Z" }),
  applicant({ full_name: "عمر الحداد", position: "طاهٍ", status: "interview", created_at: "2026-10-09T08:00:00.000Z" }),
  applicant({ full_name: "José Álvarez-Núñez", position: "Sous-chef (pâtisserie)", status: "hired", created_at: "2026-10-08T08:00:00.000Z" }),
  applicant({ full_name: "山田 太郎", position: "Host / Hostess", status: "rejected", created_at: "2026-10-07T08:00:00.000Z" }),
  // The form's older applications have neither of these two answers.
  applicant({ full_name: "Chris Wallace", position: "Dishwasher / Kitchen Steward", status: "rejected", employment_type: null, experience_level: null, has_cv: false, created_at: "2026-03-08T10:30:00.000Z" }),
];

describe("the Excel workbook", () => {
  it("is a valid archive of well-formed XML, with every part declared and every link pointing at a part", async () => {
    const book = await workbookOf(people());
    expect(book.names).toEqual(expect.arrayContaining([
      "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml",
      "xl/sharedStrings.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/_rels/sheet1.xml.rels", "xl/tables/table1.xml",
    ]));
    for (const name of book.names) expect(malformed(book.text(name)), name).toBeNull();

    // Every part is given a type, by name or by its extension.
    const declared = new Set(book.overrides.map((override) => override.PartName));
    for (const name of book.names.filter((entry) => entry !== "[Content_Types].xml")) {
      const extension = name.split(".").pop();
      expect(declared.has(`/${name}`) || book.defaults.includes(extension), name).toBe(true);
    }
    expect(book.overrides).toContainEqual({
      ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml", PartName: "/xl/tables/table1.xml",
    });
    // The sheet's one link is to the table, and the sheet names that link.
    expect(book.sheetRelationships).toEqual([{
      Id: "rId-table-1", Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table", Target: "../tables/table1.xml",
    }]);
    expect(book.tableParts).toEqual(["rId-table-1"]);
  });

  it("has one sheet, Applications, headed by the restaurant, the title and a labelled time of generation", async () => {
    const book = await workbookOf(people(), { scopeText: "Filtered: status Reviewing; position Barista" });
    expect(book.sheetCount).toBe(1);
    expect(book.sheetName).toBe(SHEET_NAME);
    expect(book.cell("A1").value).toBe("LUZENA RESTAURANT & CAFE");
    expect(book.cell("A2").value).toBe("Job Applications");
    // 16:41 UTC is 09:41 in Los Angeles in October: the file says which clock it is using.
    expect(book.cell("A3").value).toBe("Generated: 2026-10-13 09:41 (America/Los_Angeles)   |   Filtered: status Reviewing; position Barista   |   Main information only");
    // Each line of the head is one cell across the whole width.
    expect(book.merges).toEqual([`A1:${LAST}1`, `A2:${LAST}2`, `A3:${LAST}3`]);
  });

  it("carries the dashboard's colours: night and gold in the head, cream in the summary, ink headings", async () => {
    const book = await workbookOf(people());
    expect(book.cell("A1").format).toMatchObject({ fill: "FF18120F", font: { color: "FFC9A063", bold: true } });
    expect(book.cell("A2").format).toMatchObject({ fill: "FF18120F", font: { color: "FFFFFFFF", name: "Georgia", size: 20 } });
    expect(book.cell("A3").format).toMatchObject({ fill: "FF18120F" });
    // The whole width of each band is filled, not only the cell with the words in it.
    for (const column of ["B", "D", LAST]) for (const row of [1, 2, 3]) expect(book.cell(`${column}${row}`).format.fill, `${column}${row}`).toBe("FF18120F");
    for (const column of ["A", "D", LAST]) {
      expect(book.cell(`${column}4`).format, `${column}4`).toMatchObject({ fill: "FFEFEBE3", font: { color: "FF835F20", bold: true } });
      expect(book.cell(`${column}5`).format, `${column}5`).toMatchObject({ fill: "FFEFEBE3", border: { bottom: { style: "medium", color: "FFC9A063" } } });
      expect(book.cell(`${column}${HEADING_ROW}`).format, `${column}6`).toMatchObject({ fill: "FF2B211E", font: { color: "FFFFFFFF", bold: true } });
    }
    expect(book.view.showGridLines).toBe("false");
  });

  it("sums up the applications above the table, and the figures are those of the rows below", async () => {
    const applications = people();
    const book = await workbookOf(applications);
    const labels = ["A", "B", "C", "D", "E", "F", "G"].map((column) => book.cell(`${column}4`).value);
    const figures = ["A", "B", "C", "D", "E", "F", "G"].map((column) => book.cell(`${column}5`));
    expect(labels).toEqual(["TOTAL", "NEW", "REVIEWING", "SHORTLISTED", "INTERVIEW", "HIRED", "REJECTED"]);
    expect(figures.map((cell) => cell.kind)).toEqual(Array(7).fill("number"));
    expect(figures.map((cell) => cell.value)).toEqual([8, 1, 2, 1, 1, 1, 2]);

    // Counted again from the Status column of the table itself.
    const statusColumn = String.fromCharCode(65 + TITLES.indexOf("Status"));
    const shown = applications.map((_, index) => book.cell(`${statusColumn}${HEADING_ROW + 1 + index}`).value);
    for (const [index, status] of STATUSES.entries()) {
      expect(shown.filter((value) => value === LABELS.status[status]).length, status).toBe(figures[index + 1].value);
    }
    expect(shown).toHaveLength(figures[0].value);
    // The summary is above the table and outside it: a filter or a sort cannot reach it.
    expect(rangesOverlap(`A4:${LAST}5`, book.table.ref)).toBe(false);
  });

  it("lists one application per row under the headings, newest first as given, with nothing below or beside", async () => {
    const applications = people();
    const book = await workbookOf(applications);
    expect(["A", "B", "C", "D", "E", "F", "G"].map((column) => book.cell(`${column}${HEADING_ROW}`).value)).toEqual(TITLES);
    expect(TITLES).toEqual(["Applicant", "Position", "Looking for", "Experience", "Applied", "CV", "Status"]);

    const row = (number) => ["A", "B", "C", "D", "E", "F", "G"].map((column) => book.cell(`${column}${number}`));
    expect(row(7).map((cell) => cell.value)).toEqual(["Maya Thompson", "Barista", "Part-time", "1 to 2 years", expect.any(Number), "Yes", "New"]);
    expect(row(8).map((cell) => cell.value)).toEqual(["Daniel Ortiz", "Line Cook", "Full-time", "More than 5 years", expect.any(Number), "Yes", "Reviewing"]);
    expect(row(9).map((cell) => cell.value)).toEqual(["Priya Nair", "Waiter / Waitress", "Full-time or part-time", "1 to 2 years", expect.any(Number), "No", "Reviewing"]);

    // Exactly as many rows as applications, and exactly as many columns as headings: no
    // blank row between the head and the table, none after it, no stray column.
    expect(book.lastRow).toBe(HEADING_ROW + applications.length);
    expect(book.lastColumn).toBe(TITLES.length);
    expect(book.rows.map((entry) => Number(entry.r))).toEqual(Array.from({ length: HEADING_ROW + applications.length }, (_, index) => index + 1));
    for (let number = 1; number <= book.lastRow; number++) {
      expect(row(number).some((cell) => cell.kind !== "empty" && cell.kind !== "missing"), `row ${number} is blank`).toBe(true);
    }
  });

  it("leaves out everything but the main facts: no contact details, no free text, no storage path or id", async () => {
    // Even when the data handed to it has them, the workbook has no column to put them in.
    const book = await workbookOf([applicant({
      full_name: "Maya Thompson", email: "maya@example.test", phone: "+1 619 555 0101", message: "I live nearby.",
      experience: "Two years behind an espresso machine.", cv_path: "alpha/secret.pdf", ip_hash: "abc123", id: "00000000-0000-4000-8000-000000000001",
      availability: ["weekday_days"], start_when: "immediately", work_authorized: true,
    })]);
    const everything = book.names.map((name) => book.text(name)).join("\n");
    expect(everything).not.toMatch(/maya@example\.test|619 555|I live nearby|espresso|secret\.pdf|abc123|00000000-0000-4000|Weekday days|Immediately/);
    expect(TITLES.join(" ")).not.toMatch(/email|phone|contact|availability|introduction|message/i);
  });

  it("makes the applications a real Excel table whose range, filter and column names agree with the cells", async () => {
    const applications = people();
    const book = await workbookOf(applications);
    const range = `A${HEADING_ROW}:${LAST}${HEADING_ROW + applications.length}`;
    expect(book.table).toMatchObject({ id: "1", name: TABLE_NAME, displayName: TABLE_NAME, ref: range, filter: range, totalsRowShown: "0" });
    expect(applicationsTableRange(applications.length)).toBe(range);
    // A column's name must be the text of its heading cell, exactly, or Excel repairs the file.
    expect(book.table.columnCount).toBe(TITLES.length);
    expect(book.table.columns).toEqual(TITLES.map((_, index) => book.cell(`${String.fromCharCode(65 + index)}${HEADING_ROW}`).value));
    expect(new Set(book.table.columns.map((name) => name.toLowerCase())).size).toBe(book.table.columns.length);
    for (const index of TITLES.keys()) expect(book.cell(`${String.fromCharCode(65 + index)}${HEADING_ROW}`).kind).toBe("text");
    // The filter is the table's own; the sheet has none of its own over it.
    expect(book.sheetFilter).toBe(false);
    // The merged cells of the head do not touch the table, and the table is the last thing in the sheet.
    for (const merge of book.merges) expect(rangesOverlap(merge, range), merge).toBe(false);
    expect(book.elementOrder.at(-1)).toBe("tableParts");
    expect(book.elementOrder).toEqual(["sheetViews", "cols", "sheetData", "mergeCells", "conditionalFormatting", "pageMargins", "pageSetup", "tableParts"]);
    // No built-in table style paints over the report's own colours.
    expect(book.table.style).toEqual({ showFirstColumn: "0", showLastColumn: "0", showRowStripes: "0", showColumnStripes: "0" });
  });

  it("keeps the head and the headings in view while the applications scroll", async () => {
    const book = await workbookOf(people());
    expect(book.pane).toMatchObject({ ySplit: String(HEADING_ROW), topLeftCell: `A${HEADING_ROW + 1}`, state: "frozen" });
    expect(Number(book.pane.xSplit ?? 0)).toBe(0);
  });

  it("sets a width for every column, wraps text that is too long for it, and gives the head its heights", async () => {
    const book = await workbookOf([applicant({ full_name: "A name that is deliberately very long to see how the applicant column copes with wrapping" }), ...people()]);
    expect(book.columns).toEqual(COLUMNS.map((column, index) => ({ min: String(index + 1), max: String(index + 1), width: String(column.width), customWidth: "1" })));
    expect(COLUMNS.every((column) => column.width >= 8 && column.width <= 40)).toBe(true);
    for (const column of ["A", "B", "C", "D", "F", "G"]) {
      expect(book.cell(`${column}7`).format.alignment, column).toMatchObject({ wrapText: "1", vertical: "center" });
    }
    // The six rows that stay in view have a set height; the rows of data are left to fit their text.
    expect(book.rows.slice(0, HEADING_ROW).every((row) => row.customHeight === "1" && Number(row.ht) >= 20)).toBe(true);
    expect(book.rows.slice(HEADING_ROW).some((row) => "ht" in row)).toBe(false);
    // The widest thing in the date column is a date, and it has room: a date that does not
    // fit is drawn by Excel as a row of # signs.
    expect(COLUMNS.find((column) => column.key === "applied").width).toBeGreaterThanOrEqual("2026-10-13 09:41".length + 3);
  });

  it("gives the line under the title the height its words need, however long the filters make it", async () => {
    const short = await workbookOf(people());
    expect(short.rows[2]).toMatchObject({ r: "3", ht: "24", customHeight: "1" });
    expect(short.cell("A3").format.alignment).toMatchObject({ wrapText: "1" });

    const scopeText = `Filtered: status Reviewing; position ${"Dishwasher / Kitchen Steward ".repeat(3).trim()}; applied from 2026-10-01; applied until 2026-10-13; matching "${"a long search ".repeat(7).trim()}"`;
    const long = await workbookOf(people(), { scopeText });
    expect(long.cell("A3").value).toContain(scopeText);
    expect(long.cell("A3").value.length).toBeGreaterThan(300);
    // Three lines' worth of words, three lines of height; and never more than four.
    expect(long.rows[2].ht).toBe("48");
    const huge = await workbookOf(people(), { scopeText: "x".repeat(2000) });
    expect(huge.rows[2].ht).toBe("60");
    // The table is still where it was.
    expect(long.table.ref).toBe(`A${HEADING_ROW}:${LAST}${HEADING_ROW + 8}`);
  });

  it("writes the date applied as a real date, in one format, on the clock of the named time zone", async () => {
    const applications = people();
    const book = await workbookOf(applications);
    const column = String.fromCharCode(65 + TITLES.indexOf("Applied"));
    const cells = applications.map((_, index) => book.cell(`${column}${HEADING_ROW + 1 + index}`));
    expect(cells.every((cell) => cell.kind === "number")).toBe(true);
    expect(new Set(cells.map((cell) => cell.format.numberFormat))).toEqual(new Set([DATE_FORMAT]));
    expect(DATE_FORMAT).toBe("yyyy-mm-dd hh:mm");
    // UTC 16:41 on the 13th is 09:41 that morning in Los Angeles; 03:05 UTC on the 12th is the evening of the 11th.
    expect(serialToStamp(cells[0].value)).toBe("2026-10-13 09:41");
    expect(serialToStamp(cells[1].value)).toBe("2026-10-11 20:05");
    // Winter time: 10:30 UTC on 8 March 2026 is 02:30 Pacific Standard Time... which that
    // night does not exist; the clocks go from 02:00 to 03:00. It is shown as 03:30.
    expect(serialToStamp(cells[7].value)).toBe("2026-03-08 03:30");
    expect(cells.map((cell) => serialToStamp(cell.value))).toEqual(applications.map((entry) => formatStamp(entry.created_at, ZONE)));

    const elsewhere = await workbookOf([applications[0]], { timeZone: "Asia/Dubai" });
    expect(serialToStamp(elsewhere.cell(`${column}7`).value)).toBe("2026-10-13 20:41");
    expect(elsewhere.cell("A3").value).toContain("Generated: 2026-10-13 20:41 (Asia/Dubai)");
  });

  it("words every stage the same way and colours it as the dashboard's badge", async () => {
    const book = await workbookOf(STATUSES.map((status) => applicant({ status })));
    const column = String.fromCharCode(65 + TITLES.indexOf("Status"));
    const cells = STATUSES.map((_, index) => book.cell(`${column}${HEADING_ROW + 1 + index}`));
    expect(cells.map((cell) => cell.value)).toEqual(["New", "Reviewing", "Shortlisted", "Interview", "Hired", "Rejected"]);
    expect(cells.map((cell) => cell.format.font.color)).toEqual(["FF1F4F8F", "FF8A5A00", "FF6B4D18", "FF6B4D18", "FF17663A", "FF6E645C"]);
    expect(cells.every((cell) => cell.format.font.bold)).toBe(true);
  });

  it("shades every other row by a rule that follows a sort or a filter, not by painting rows", async () => {
    const applications = people();
    const book = await workbookOf(applications);
    expect(book.shading).toMatchObject({
      range: `A${HEADING_ROW + 1}:${LAST}${HEADING_ROW + applications.length}`, type: "expression",
      // Counts the rows that are showing down to this one: hidden rows do not break the pattern.
      formula: `MOD(SUBTOTAL(103,$A$${HEADING_ROW + 1}:$A${HEADING_ROW + 1}),2)=0`, fill: "FFF6F4F0",
    });
    // The rows carry no fill of their own for the rule to fight with.
    for (const index of applications.keys()) expect(book.cell(`A${HEADING_ROW + 1 + index}`).format.fill).toBeNull();
  });

  it("stores what an applicant typed as text and never as a formula, whatever it starts with", async () => {
    const hostile = [
      '=HYPERLINK("http://evil.example","Click")', "+1+1", "-2+3", "@SUM(1+1)", "=cmd|' /C calc'!A0",
      "=1+1", `${ZERO_WIDTH_SPACE}=2+2`, "<script>alert(1)</script>", 'O\'Brien & "Mac" <b>', "]]>&amp;&#x41;", "123456", "TRUE", "2026-01-01",
    ];
    const book = await workbookOf(hostile.map((full_name) => applicant({ full_name, position: full_name })));
    const sheet = book.text("xl/worksheets/sheet1.xml");
    // The only formula in the whole sheet is the shading rule's.
    expect(sheet.match(/<f[ >]/g)).toBeNull();
    expect(sheet.match(/<formula>/g)).toHaveLength(1);
    for (const [index, value] of hostile.entries()) {
      for (const column of ["A", "B"]) {
        const cell = book.cell(`${column}${HEADING_ROW + 1 + index}`);
        // Text, character for character; a value that looks like a number or a date is still text.
        expect(cell.kind, value).toBe("text");
        expect(cell.hasFormula, value).toBe(false);
        expect(cell.value, value).toBe(value);
      }
    }
    for (const name of book.names) expect(malformed(book.text(name)), name).toBeNull();
  });

  it("keeps Arabic and other scripts exactly as typed, and drops only what would break the file or mislead", async () => {
    const names = ["عمر الحداد", "ليلى منصور", "José Álvarez-Núñez", "Zoë Brontë", "山田 太郎", "Nguyễn Thị Minh Khai", "Ольга Смирнова", "Ελένη", "שרה כהן", "Sam 👩‍🍳 Lee", `می${ZERO_WIDTH_NON_JOINER}خواهم`];
    const book = await workbookOf(names.map((full_name) => applicant({ full_name, position: full_name })));
    for (const [index, name] of names.entries()) {
      expect(book.cell(`A${HEADING_ROW + 1 + index}`).value).toBe(name);
      expect(book.cell(`B${HEADING_ROW + 1 + index}`).value).toBe(name);
    }
    // The archive holds them as UTF-8.
    expect(book.text("xl/sharedStrings.xml")).toContain("عمر الحداد");

    // Control characters, a half surrogate, a byte-order mark and a direction override are
    // removed; line breaks and tabs become one space. The joiner Persian is written with stays.
    const dirty = await workbookOf([applicant({
      full_name: `Ana\u{0}\u{1}\u{8} Re\u{B}yes\u{7F}\u{FFFE}${String.fromCharCode(0xD800)}`, position: `Line\r\n\tCook ${RIGHT_TO_LEFT_OVERRIDE}${BYTE_ORDER_MARK} `,
    })]);
    expect(dirty.cell(`A${HEADING_ROW + 1}`).value).toBe("Ana Reyes");
    expect(dirty.cell(`B${HEADING_ROW + 1}`).value).toBe("Line Cook");
    expect(dirty.text("xl/sharedStrings.xml")).not.toMatch(/[\p{Cc}\p{Cs}]/u);
  });

  it("copes with answers that are missing, a date that is not one, and a name that is empty", async () => {
    const book = await workbookOf([
      applicant({ full_name: "", position: "", employment_type: null, experience_level: null, status: "new", has_cv: false, created_at: null }),
      applicant({ full_name: "   ", employment_type: undefined, experience_level: "decades", status: "archived", created_at: "not a date" }),
    ]);
    const row = (number) => ["A", "B", "C", "D", "E", "F", "G"].map((column) => book.cell(`${column}${number}`).value);
    expect(row(7)).toEqual(["(no name)", null, null, null, null, "No", "New"]);
    // An answer this code has no wording for is shown as it is stored, not dropped.
    expect(row(8)).toEqual(["(no name)", "Barista", null, "decades", null, "Yes", "archived"]);
    // The first column is never empty: the shading rule counts it.
    expect(book.cell("A7").kind).toBe("text");
    // A stage that is not one of the six is in the total and in no stage's figure.
    expect(["A", "B", "C", "D", "E", "F", "G"].map((column) => book.cell(`${column}5`).value)).toEqual([2, 1, 0, 0, 0, 0, 0]);
    expect(book.table.ref).toBe(`A${HEADING_ROW}:${LAST}${HEADING_ROW + 2}`);
    for (const name of book.names) expect(malformed(book.text(name)), name).toBeNull();
  });

  it("is still a valid, complete report when there is nothing to export", async () => {
    const book = await workbookOf([], { scopeText: "Filtered: status Hired" });
    for (const name of book.names) expect(malformed(book.text(name)), name).toBeNull();
    expect(book.cell("A2").value).toBe("Job Applications");
    expect(book.cell("A3").value).toContain("Filtered: status Hired");
    expect(["A", "B", "C", "D", "E", "F", "G"].map((column) => book.cell(`${column}5`).value)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(["A", "B", "C", "D", "E", "F", "G"].map((column) => book.cell(`${column}${HEADING_ROW}`).value)).toEqual(TITLES);
    expect(book.cell(`A${HEADING_ROW + 1}`).value).toBe("No applications match this export.");
    expect(book.lastRow).toBe(HEADING_ROW + 1);
    // Excel refuses a table with no rows, so none is made: no table file, link, type or rule.
    expect(book.table).toBeNull();
    expect(book.names).not.toContain("xl/tables/table1.xml");
    expect(book.tableParts).toEqual([]);
    expect(book.sheetRelationships).toEqual([]);
    expect(book.overrides.some((override) => override.PartName.includes("table"))).toBe(false);
    expect(book.shading).toBeNull();
    expect(applicationsTableRange(0)).toBeNull();
    expect(book.pane).toMatchObject({ ySplit: String(HEADING_ROW), state: "frozen" });
  });

  it("holds a single application, and several thousand, with the table reaching exactly the last one", async () => {
    const one = await workbookOf([applicant()]);
    expect(one.table.ref).toBe(`A${HEADING_ROW}:${LAST}${HEADING_ROW + 1}`);
    expect(one.shading.range).toBe(`A${HEADING_ROW + 1}:${LAST}${HEADING_ROW + 1}`);

    const many = Array.from({ length: 5000 }, (_, index) => applicant({ status: STATUSES[index % STATUSES.length] }));
    const book = await workbookOf(many);
    expect(book.table.ref).toBe(`A${HEADING_ROW}:${LAST}${HEADING_ROW + 5000}`);
    expect(book.lastRow).toBe(HEADING_ROW + 5000);
    expect(book.cell("A5").value).toBe(5000);
    expect(book.cell(`A${HEADING_ROW + 5000}`).value).toBe(many.at(-1).full_name);
  });

  it("is given the type of an Excel file", async () => {
    const blob = await buildWorkbook(report(people()));
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // A ZIP archive starts with "PK".
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 2)]).toEqual([0x50, 0x4B]);
  });
});

describe("the table added to the workbook", () => {
  it("names columns past Z and ranges of any size", () => {
    expect([1, 2, 26, 27, 52, 53, 702, 703].map(columnLetter)).toEqual(["A", "B", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
    expect(tableRange({ headingRow: 6, columnCount: 7, rowCount: 20 })).toBe("A6:G26");
    expect(cellPosition("AA10")).toEqual({ column: 27, row: 10 });
  });

  it("escapes a name that has markup in it, and refuses two columns with one name", () => {
    const xml = tableXml({ name: "T", headingRow: 1, columns: ['A & "B" <c>', "D"], rowCount: 1 });
    expect(malformed(xml)).toBeNull();
    expect(xml).toContain('name="A &amp; &quot;B&quot; &lt;c&gt;"');
    expect(() => excelTable({ name: "T", headingRow: 1, columns: ["Status", "status"], rowCount: 1 })).toThrow(/same name/);
    expect(excelTable({ name: "T", headingRow: 1, columns: ["A"], rowCount: 0 })).toBeNull();
  });

  it("stops, rather than write a broken workbook, if the library ever writes its files differently", () => {
    const feature = excelTable({ name: "T", headingRow: 1, columns: ["A"], rowCount: 1 });
    const transform = feature.files.transform;
    expect(() => transform["[Content_Types].xml"].transform("<Types/>")).toThrow(/could not be built/);
    expect(() => transform["xl/worksheets/_rels/sheet{id}.xml.rels"].transform("<Relationships/>", {}, { sheetIndex: 0 })).toThrow(/could not be built/);
    // Only the first sheet is given the table.
    expect(transform["xl/worksheets/_rels/sheet{id}.xml.rels"].transform("<Relationships/>", {}, { sheetIndex: 1 })).toBe("<Relationships/>");
    expect(transform["xl/worksheets/sheet{id}.xml"].insert({}, { sheetIndex: 1 })).toBeUndefined();
  });
});

// A reader of CSV as the standard describes it (RFC 4180): quoted fields, doubled quotes,
// commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = [[]];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { rows.at(-1).push(field); field = ""; }
    else if (char === "\r" && text[index + 1] === "\n") { rows.at(-1).push(field); field = ""; rows.push([]); index += 1; }
    else field += char;
  }
  if (field !== "" || rows.at(-1).length > 0) rows.at(-1).push(field);
  return rows.filter((row) => row.length > 0);
}

describe("the CSV file", () => {
  it("is a header row and one row per application, in the workbook's columns and wording", () => {
    const applications = people();
    const rows = parseCsv(buildCsv({ applications, timeZone: ZONE }).slice(1));
    expect(rows).toHaveLength(applications.length + 1);
    expect(rows[0]).toEqual(TITLES);
    expect(rows[1]).toEqual(["Maya Thompson", "Barista", "Part-time", "1 to 2 years", "2026-10-13 09:41", "Yes", "New"]);
    expect(rows[3]).toEqual(["Priya Nair", "Waiter / Waitress", "Full-time or part-time", "1 to 2 years", "2026-10-11 12:30", "No", "Reviewing"]);
    expect(rows[8]).toEqual(["Chris Wallace", "Dishwasher / Kitchen Steward", "", "", "2026-03-08 03:30", "No", "Rejected"]);
    expect(rows.every((row) => row.length === TITLES.length)).toBe(true);
  });

  it("starts with the mark that makes Excel read it as UTF-8, and ends every line with CR LF", async () => {
    const text = buildCsv({ applications: people(), timeZone: ZONE });
    expect(text.codePointAt(0)).toBe(0xFEFF);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.slice(1).split("\r\n").slice(0, -1).every((line) => !/[\r\n]/.test(line))).toBe(true);
    // As bytes: EF BB BF, then the text in UTF-8.
    const blob = csvBlob({ applications: people(), timeZone: ZONE });
    expect(blob.type).toBe("text/csv;charset=utf-8");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xEF, 0xBB, 0xBF]);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toContain("عمر الحداد");
  });

  it("keeps Arabic and other scripts intact through a reader", () => {
    const names = ["عمر الحداد", "José Álvarez-Núñez", "山田 太郎", "Sam 👩‍🍳 Lee", `می${ZERO_WIDTH_NON_JOINER}خواهم`];
    const rows = parseCsv(buildCsv({ applications: names.map((full_name) => applicant({ full_name })), timeZone: ZONE }).slice(1));
    expect(rows.slice(1).map((row) => row[0])).toEqual(names);
  });

  it("quotes every field, so commas, quotation marks and line breaks stay inside their cell", () => {
    expect(csvField("plain")).toBe('"plain"');
    expect(csvField('O\'Brien, "Mac"')).toBe('"O\'Brien, ""Mac"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("")).toBe('""');
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
    expect(csvField(0)).toBe('"0"');
    // Read back, each comes out as it went in.
    const awkward = ['a,b', 'say "hi"', "", "trailing,", '","', '""', "x\r\ny"];
    const line = awkward.map(csvField).join(",");
    expect(parseCsv(`${line}\r\n`)[0]).toEqual(awkward);

    const applications = [applicant({ full_name: 'Lee, "Sam" Jr.', position: "Chef; Baker, Barista" })];
    const rows = parseCsv(buildCsv({ applications, timeZone: ZONE }).slice(1));
    expect(rows[1].slice(0, 2)).toEqual(['Lee, "Sam" Jr.', "Chef; Baker, Barista"]);
    expect(rows).toHaveLength(2);
  });

  it("disarms a value that a spreadsheet would run as a formula, however its first character is hidden", () => {
    const dangerous = [
      "=1+1", "+1+1", "-1+1", "@SUM(A1)", '=HYPERLINK("http://evil.example","x")', "=cmd|' /C calc'!A0", "+cmd|' /C calc'!A0",
      "=", "-", "@", "+",
      // After spaces, tabs, line breaks and other things a spreadsheet may skip.
      " =1+1", "   +1", "\t=1+1", "\r=1+1", "\n=1+1", "\r\n=1+1", " \t \r\n =1+1",
      `${NO_BREAK_SPACE}=1+1`, `${ZERO_WIDTH_SPACE}=1+1`, `${BYTE_ORDER_MARK}=1+1`, `${RIGHT_TO_LEFT_OVERRIDE}=1+1`, `\u{0}=1+1`, `\u{1F}@x`, `\u{7F}-1`,
      `\u{2028}=1+1`, `\u{3000}=1+1`, `\u{AD}=1+1`, `\u{200E}\u{200F}+1`,
      // The full-width forms of the four characters.
      "\u{FF1D}1+1", "\u{FF0B}1", "\u{FF0D}1", "\u{FF20}x",
      // A tab or a carriage return first, whatever follows.
      "\tplain", "\rplain",
    ];
    for (const value of dangerous) {
      expect(csvSafe(value), JSON.stringify(value)).toBe(`'${value}`);
      expect(csvField(value).startsWith(`"'`), JSON.stringify(value)).toBe(true);
    }
  });

  it("leaves an ordinary value exactly as it is", () => {
    const ordinary = [
      "Maya Thompson", "Barista", "Jean-Luc", "a-b", "3-5 years", "name@example.test", "a=b", "1+1", "C++", "#hashtag", "100%",
      "O'Brien", "'already quoted", "(619) 555-0101", "عمر الحداد", "", " ", "   spaced", "5", "0", "Yes", "2026-10-13 09:41",
    ];
    for (const value of ordinary) expect(csvSafe(value), JSON.stringify(value)).toBe(value);
    expect(csvSafe(null)).toBe("");
    expect(csvSafe(undefined)).toBe("");
    expect(csvSafe(-5)).toBe("'-5");
  });

  it("disarms hostile names and positions in a whole file, and they still read back as typed", () => {
    const hostile = ['=HYPERLINK("http://evil.example","Click")', "+1+1", "-2+3", "@SUM(1+1)", "  =cmd|' /C calc'!A0", "\t=1+1", `${ZERO_WIDTH_SPACE}=2+2`];
    const text = buildCsv({ applications: hostile.map((full_name) => applicant({ full_name, position: full_name })), timeZone: ZONE });
    const rows = parseCsv(text.slice(1)).slice(1);
    for (const row of rows) {
      for (const value of row.slice(0, 2)) expect(value.startsWith("'"), value).toBe(true);
      // Nothing in the file starts a cell with one of the four characters.
      for (const value of row) expect(/^[=+\-@]/.test(value), value).toBe(false);
    }
    // No raw line of the file starts a field with them either (after its opening quote).
    expect(text.slice(1)).not.toMatch(/(^|,|\n)"[\s]*[=+\-@]/);
    expect(rows.map((row) => row[0])).toEqual([
      '\'=HYPERLINK("http://evil.example","Click")', "'+1+1", "'-2+3", "'@SUM(1+1)", "'=cmd|' /C calc'!A0", "'=1+1", `'${ZERO_WIDTH_SPACE}=2+2`,
    ]);
  });

  it("is only the header row when there is nothing to export", () => {
    const text = buildCsv({ applications: [], timeZone: ZONE });
    expect(parseCsv(text.slice(1))).toEqual([TITLES]);
    expect(text).toBe(`${BYTE_ORDER_MARK}"Applicant","Position","Looking for","Experience","Applied","CV","Status"\r\n`);
  });
});

describe("what goes into an export", () => {
  it("words each answer as the dashboard does", () => {
    expect(exportRow({ full_name: " Ana  Reyes ", position: "Barista", status: "interview", employment_type: "either", experience_level: "under_1", has_cv: true, created_at: "2026-10-13T16:41:00.000Z" }))
      .toEqual({ applicant: "Ana Reyes", position: "Barista", lookingFor: "Full-time or part-time", experience: "Less than 1 year", applied: "2026-10-13T16:41:00.000Z", cv: "Yes", status: "Interview", statusKey: "interview" });
    expect(cleanText(null)).toBe("");
    expect(cleanText(42)).toBe("42");
    expect(cleanText("a\tb\r\nc   d")).toBe("a b c d");
  });

  it("counts the applications at each stage", () => {
    expect(summarize([])).toEqual({ total: 0, byStatus: { new: 0, reviewing: 0, shortlisted: 0, interview: 0, hired: 0, rejected: 0 } });
    expect(summarize([{ status: "new" }, { status: "new" }, { status: "hired" }, { status: "nonsense" }, {}]))
      .toEqual({ total: 5, byStatus: { new: 2, reviewing: 0, shortlisted: 0, interview: 0, hired: 1, rejected: 0 } });
    // A stage named like something every object has is not counted as a stage.
    expect(summarize([{ status: "constructor" }, { status: "toString" }]).byStatus.new).toBe(0);
  });

  it("says in words what was asked for", () => {
    expect(describeScope("all")).toBe("All applications");
    expect(describeScope("selected")).toBe("Selected applications");
    expect(describeScope("page")).toBe("The applications on one page of the list");
    expect(describeScope("filtered", {})).toBe("All applications");
    expect(describeScope("filtered", { status: "reviewing", position: "Barista", from: "2026-10-01", to: "2026-10-13", search: " maya " }))
      .toBe('Filtered: status Reviewing; position Barista; applied from 2026-10-01; applied until 2026-10-13; matching "maya"');
  });

  it("names the file from fixed words, the restaurant's short name and the day: never a path", () => {
    const name = (slug, format = "xlsx") => exportFilename({ slug, generatedAt: "2026-10-13T16:41:00.000Z", timeZone: ZONE, format });
    expect(name("luzena")).toBe("luzena-job-applications-2026-10-13.xlsx");
    expect(name("luzena", "csv")).toBe("luzena-job-applications-2026-10-13.csv");
    // The day is the owner's day: 03:00 UTC on the 14th is still the 13th in Los Angeles.
    expect(exportFilename({ slug: "luzena", generatedAt: "2026-10-14T03:00:00.000Z", timeZone: ZONE, format: "xlsx" })).toBe("luzena-job-applications-2026-10-13.xlsx");
    for (const [slug, expected] of [
      ["../../etc/passwd", "etc-passwd"], ["..\\..\\windows\\system32", "windows-system32"], ["a/b\\c:d*e?f\"g<h>i|j", "a-b-c-d-e-f-g-h-i-j"],
      ["Luzena Restaurant & Cafe", "luzena-restaurant-cafe"], ["", "restaurant"], [null, "restaurant"], [undefined, "restaurant"], ["...", "restaurant"],
      ["CON", "con"], ["a".repeat(200), "a".repeat(60)], ["file.exe", "file-exe"], ["%2e%2e%2f", "2e-2e-2f"],
    ]) {
      const file = name(slug);
      expect(file, String(slug)).toBe(`${expected}-job-applications-2026-10-13.xlsx`);
      expect(file, String(slug)).toMatch(/^[a-z0-9-]+\.xlsx$/);
    }
    // An unknown format is not taken as an extension.
    expect(name("luzena", "exe")).toBe("luzena-job-applications-2026-10-13.xlsx");
    expect(name("luzena", "../../x")).toBe("luzena-job-applications-2026-10-13.xlsx");
    expect(exportFilename({ slug: "luzena", generatedAt: "nonsense", timeZone: ZONE, format: "csv" })).toBe("luzena-job-applications-undated.csv");
  });

  it("uses the same stages and wording as the backend", () => {
    expect(STATUSES).toEqual(["new", "reviewing", "shortlisted", "interview", "hired", "rejected"]);
    // One figure per column in the summary: a seventh stage would need a column of its own.
    expect(STATUSES.length + 1).toBeLessThanOrEqual(COLUMNS.length);
  });
});
