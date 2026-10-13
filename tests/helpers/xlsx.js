// Reads an .xlsx file back, for the tests of the export.
//
// It does not use the library that wrote the file: it opens the ZIP archive and reads the
// XML inside, which is what Excel does. So a test that passes here has looked at the file
// itself, not at what the writing library believes it wrote.
import { strFromU8, unzipSync } from "fflate";

const decode = (text) => text
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export const attributes = (tag) =>
  Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]));

// Why a piece of XML is not well formed, or null when it is: every tag opened is closed in
// order, and no "<" or "&" stands on its own. One bad character here is the difference
// between a workbook that opens and "We found a problem with some content".
export function malformed(xml) {
  const body = xml.replace(/^\u{FEFF}?<\?xml[^>]*\?>/u, "");
  const stack = [];
  const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (const match of body.matchAll(tag)) {
    const between = body.slice(last, match.index);
    if (/[<>]/.test(between)) return `stray angle bracket near "${between.slice(0, 40)}"`;
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(between)) return `bare & near "${between.slice(0, 40)}"`;
    last = match.index + match[0].length;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      if (stack.pop() !== name) return `</${name}> closes nothing`;
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  const rest = body.slice(last);
  if (rest.trim() !== "") return `text after the last tag: "${rest.slice(0, 40)}"`;
  return stack.length === 0 ? null : `<${stack.at(-1)}> is never closed`;
}

// "A7" -> { column: 1, row: 7 }; "A6:G26" -> the two corners.
export function cellPosition(reference) {
  const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(reference);
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column, row: Number(digits) };
}
export function rangeCorners(range) {
  const [from, to] = range.split(":").map(cellPosition);
  return { from, to: to ?? from };
}
export const rangesOverlap = (a, b) => {
  const [x, y] = [rangeCorners(a), rangeCorners(b)];
  return x.from.row <= y.to.row && y.from.row <= x.to.row && x.from.column <= y.to.column && y.from.column <= x.to.column;
};

// An Excel date number as the wall-clock time it shows: "2026-10-13 09:41".
export function serialToStamp(serial) {
  const date = new Date(Math.round((serial - 25569) * 86_400_000));
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function readWorkbook(bytes) {
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const text = (name) => (files[name] ? strFromU8(files[name]) : null);

  const strings = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>(.*?)<\/si>/gs)]
    .map(([, item]) => [...item.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(([, part]) => decode(part)).join(""));

  // ---- styles: what each cell format (the "s" on a cell) means ------------------------------
  const styleXml = text("xl/styles.xml") ?? "";
  const section = (name) => styleXml.match(new RegExp(`<${name}[ >].*?</${name}>`, "s"))?.[0] ?? "";
  const fonts = [...section("fonts").matchAll(/<font>(.*?)<\/font>/gs)].map(([, font]) => ({
    name: font.match(/<name val="([^"]*)"/)?.[1] ?? null, size: Number(font.match(/<sz val="([^"]*)"/)?.[1]),
    bold: /<b\/>/.test(font), italic: /<i\/>/.test(font), color: font.match(/<color rgb="([^"]*)"/)?.[1] ?? null,
  }));
  const fills = [...section("fills").matchAll(/<fill>(.*?)<\/fill>/gs)].map(([, fill]) => fill.match(/<fgColor rgb="([^"]*)"/)?.[1] ?? null);
  const borders = [...section("borders").matchAll(/<border>(.*?)<\/border>/gs)].map(([, border]) => {
    const bottom = border.match(/<bottom style="([^"]*)"><color rgb="([^"]*)"/);
    return { bottom: bottom ? { style: bottom[1], color: bottom[2] } : null };
  });
  const numberFormats = Object.fromEntries([...section("numFmts").matchAll(/<numFmt ([^>]*?)\/>/g)].map(([, raw]) => {
    const found = attributes(raw);
    return [found.numFmtId, found.formatCode];
  }));
  const formats = [...section("cellXfs").matchAll(/<xf ([^>]*?)(?:\/>|>(.*?)<\/xf>)/gs)].map(([, raw, inner]) => {
    const found = attributes(raw);
    const alignment = inner?.match(/<alignment ([^>]*?)\/>/);
    return {
      font: fonts[Number(found.fontId ?? 0)], fill: fills[Number(found.fillId ?? 0)] ?? null,
      border: borders[Number(found.borderId ?? 0)] ?? { bottom: null },
      numberFormat: numberFormats[found.numFmtId] ?? null, alignment: alignment ? attributes(alignment[1]) : {},
    };
  });
  const differentialFills = [...section("dxfs").matchAll(/<dxf>(.*?)<\/dxf>/gs)].map(([, dxf]) => dxf.match(/<bgColor rgb="([^"]*)"/)?.[1] ?? null);

  // ---- the sheet -----------------------------------------------------------------------------
  const sheet = text("xl/worksheets/sheet1.xml") ?? "";
  const cells = new Map();
  for (const [, raw, inner] of sheet.matchAll(/<c ([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
    const found = attributes(raw);
    const stored = inner?.match(/<v>(.*?)<\/v>/s)?.[1];
    const kind = stored === undefined ? "empty" : found.t === "s" ? "text" : found.t === "b" ? "boolean" : "number";
    cells.set(found.r, {
      kind, value: kind === "text" ? strings[Number(stored)] : kind === "number" ? Number(stored) : kind === "boolean" ? stored === "1" : null,
      format: formats[Number(found.s ?? 0)], hasFormula: /<f[ >/]/.test(inner ?? ""),
    });
  }
  const rows = [...sheet.matchAll(/<row ([^>]*?)>/g)].map(([, raw]) => attributes(raw));
  const pane = sheet.match(/<pane ([^>]*?)\/>/);
  const view = sheet.match(/<sheetView ([^>]*?)\/?>/);
  const rule = sheet.match(/<conditionalFormatting sqref="([^"]*)"><cfRule ([^>]*?)><formula>(.*?)<\/formula><\/cfRule><\/conditionalFormatting>/s);
  const elementOrder = [];
  let depth = 0;
  for (const [, closing, name, selfClosing] of sheet.slice(sheet.indexOf(">", sheet.indexOf("<worksheet")) + 1).matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (closing) depth -= 1;
    else {
      if (depth === 0) elementOrder.push(name);
      if (!selfClosing) depth += 1;
    }
  }

  // ---- the table -----------------------------------------------------------------------------
  const tableXml = text("xl/tables/table1.xml");
  const table = tableXml && {
    ...attributes(tableXml.match(/<table ([^>]*?)>/)[1]),
    filter: tableXml.match(/<autoFilter ref="([^"]*)"\/>/)?.[1] ?? null,
    columns: [...tableXml.matchAll(/<tableColumn ([^>]*?)\/>/g)].map(([, raw]) => attributes(raw).name),
    columnCount: Number(tableXml.match(/<tableColumns count="(\d+)"/)?.[1]),
    style: attributes(tableXml.match(/<tableStyleInfo ([^>]*?)\/>/)?.[1] ?? ""),
  };

  const relationships = (name) => [...(text(name) ?? "").matchAll(/<Relationship ([^>]*?)\/>/g)].map(([, raw]) => attributes(raw));
  const contentTypes = text("[Content_Types].xml") ?? "";

  return {
    names, text, strings, cells, rows, formats, table, elementOrder,
    sheetName: attributes((text("xl/workbook.xml") ?? "").match(/<sheet ([^>]*?)\/>/)?.[1] ?? "").name ?? null,
    sheetCount: [...(text("xl/workbook.xml") ?? "").matchAll(/<sheet /g)].length,
    columns: [...sheet.matchAll(/<col ([^>]*?)\/>/g)].map(([, raw]) => attributes(raw)),
    merges: [...sheet.matchAll(/<mergeCell ref="([^"]*)"\/>/g)].map(([, reference]) => reference),
    pane: pane ? attributes(pane[1]) : null,
    view: view ? attributes(view[1]) : {},
    sheetFilter: /<autoFilter /.test(sheet),
    shading: rule && { range: rule[1], ...attributes(rule[2]), formula: decode(rule[3]), fill: differentialFills[Number(attributes(rule[2]).dxfId)] ?? null },
    tableParts: [...sheet.matchAll(/<tablePart r:id="([^"]*)"\/>/g)].map(([, id]) => id),
    sheetRelationships: relationships("xl/worksheets/_rels/sheet1.xml.rels"),
    overrides: [...contentTypes.matchAll(/<Override ([^>]*?)\/>/g)].map(([, raw]) => attributes(raw)),
    defaults: [...contentTypes.matchAll(/<Default ([^>]*?)\/>/g)].map(([, raw]) => attributes(raw).Extension),
    cell: (reference) => cells.get(reference) ?? { kind: "missing", value: undefined, format: formats[0], hasFormula: false },
    lastRow: Math.max(0, ...[...cells.keys()].map((reference) => cellPosition(reference).row)),
    lastColumn: Math.max(0, ...[...cells.keys()].map((reference) => cellPosition(reference).column)),
  };
}
