// Turns a block of cells into a real Excel table: the kind with a filter button on every
// column heading, that sorts and filters as one unit and that Excel names and tracks.
//
// write-excel-file writes the cells and their formatting but has no notion of a table. It
// does have an extension point for exactly this ("features", see its README): a feature may
// add files to the workbook and add to the ones the library writes. A table is four small
// additions, each in the form Excel itself writes:
//
//   xl/tables/table1.xml                 the table: its range, its filter, its columns
//   xl/worksheets/_rels/sheet1.xml.rels  the sheet's link to that file
//   xl/worksheets/sheet1.xml             <tableParts>, last in the sheet, naming the link
//   [Content_Types].xml                  what kind of file the table is
//
// Excel is strict about a table. The rules this file keeps, each of which Excel answers
// with "We found a problem with some content" when broken:
//   - a table has a heading row and at least one row under it (so none is made for an
//     empty export: see `excelTable` returning null);
//   - every column's name is exactly the text of its heading cell, and no two are alike;
//   - the filter belongs to the table, and the sheet has no filter of its own over it;
//   - <tableParts> comes after everything else in the sheet.

const TABLE_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml";
const TABLE_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";
const RELATIONSHIP_ID = "rId-table-1";

const escapeXml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 1 -> A, 26 -> Z, 27 -> AA.
export function columnLetter(number) {
  let letters = "";
  for (let rest = number; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

// The range a table of `rowCount` rows covers, heading row included: "A6:G31".
export const tableRange = ({ headingRow, columnCount, rowCount }) =>
  `A${headingRow}:${columnLetter(columnCount)}${headingRow + rowCount}`;

export function tableXml({ name, headingRow, columns, rowCount }) {
  const range = tableRange({ headingRow, columnCount: columns.length, rowCount });
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="${escapeXml(name)}" displayName="${escapeXml(name)}" ref="${range}" totalsRowShown="0">`,
    `<autoFilter ref="${range}"/>`,
    `<tableColumns count="${columns.length}">`,
    ...columns.map((title, index) => `<tableColumn id="${index + 1}" name="${escapeXml(title)}"/>`),
    "</tableColumns>",
    // No built-in style: the cells carry the report's own colours, and a built-in style
    // would paint Office's over them.
    '<tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/>',
    "</table>",
  ].join("");
}

// Adds `addition` just before the closing tag of a file the library wrote. If that tag is
// not where it is expected, the library has changed how it writes the file: stop, rather
// than hand the owner a workbook Excel will not open.
function beforeClosing(xml, tag, addition) {
  const closing = `</${tag}>`;
  const at = xml.lastIndexOf(closing);
  if (at === -1) throw new Error(`The workbook could not be built: <${tag}> is not in the form expected.`);
  return xml.slice(0, at) + addition + xml.slice(at);
}

// The feature to hand to write-excel-file, for a table on the first sheet whose heading
// row is `headingRow` and whose columns are named `columns`, with `rowCount` rows under
// the heading. null when there are no rows: there is then no table to make.
export function excelTable({ name, headingRow, columns, rowCount }) {
  if (rowCount < 1) return null;
  if (new Set(columns.map((title) => title.toLowerCase())).size !== columns.length) {
    throw new Error("The workbook could not be built: two columns have the same name.");
  }
  const onFirstSheet = (properties) => properties.sheetIndex === 0;
  return {
    files: {
      write: {
        files: () => ({ "xl/tables/table1.xml": tableXml({ name, headingRow, columns, rowCount }) }),
      },
      transform: {
        "[Content_Types].xml": {
          transform: (xml) => beforeClosing(xml, "Types", `<Override ContentType="${TABLE_TYPE}" PartName="/xl/tables/table1.xml"/>`),
        },
        "xl/worksheets/_rels/sheet{id}.xml.rels": {
          transform: (xml, _options, properties) => (onFirstSheet(properties)
            ? beforeClosing(xml, "Relationships", `<Relationship Id="${RELATIONSHIP_ID}" Type="${TABLE_RELATIONSHIP}" Target="../tables/table1.xml"/>`)
            : xml),
        },
        "xl/worksheets/sheet{id}.xml": {
          // The library puts this at the end of the sheet, which is where it has to be.
          insert: (_options, properties) => (onFirstSheet(properties)
            ? `<tableParts count="1"><tablePart r:id="${RELATIONSHIP_ID}"/></tableParts>`
            : undefined),
        },
      },
    },
  };
}
