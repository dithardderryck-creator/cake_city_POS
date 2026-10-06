import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * A small spreadsheet writer. It produces a plain .xlsx file (the format Excel, LibreOffice and Google Sheets all open)
 * with a bold header row and the header frozen. Text is stored as text, so a customer name that starts with "=" is
 * never run as a formula.
 */

export type Cell = string | number | boolean | null | undefined;

export interface Sheet {
  name: string;
  header: string[];
  rows: Cell[][];
}

/** Excel's limits. The archive splits work well before these. */
export const XLSX_MAX_ROWS = 1_048_575;
const MAX_CELL_CHARS = 32_000;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Characters XML cannot carry at all (most control characters) are dropped; the rest are escaped. */
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const esc = (s: string) =>
  s
    .replace(BAD_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Sheet names: at most 31 characters, none of []:*?/\ , and no two the same (ignoring case). */
export function safeSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` ${n++}`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function cellXml(ref: string, v: Cell, style?: number): string {
  const s = style ? ` s="${style}"` : '';
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : '';
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="inlineStr"><is><t>${v ? 'yes' : 'no'}</t></is></c>`;
  const text = esc(String(v).slice(0, MAX_CELL_CHARS));
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  if (sheet.rows.length + 1 > XLSX_MAX_ROWS) throw new Error(`Sheet "${sheet.name}" has too many rows for a spreadsheet.`);
  const width = Math.max(sheet.header.length, ...sheet.rows.map((r) => r.length));
  const rows: string[] = [];
  rows.push(`<row r="1">${sheet.header.map((h, c) => cellXml(`${columnName(c)}1`, h, 1)).join('')}</row>`);
  sheet.rows.forEach((row, r) => {
    const cells = row.map((v, c) => cellXml(`${columnName(c)}${r + 2}`, v)).join('');
    rows.push(`<row r="${r + 2}">${cells}</row>`);
  });
  const cols = Array.from({ length: width }, (_, c) => {
    const longest = Math.max(sheet.header[c]?.length ?? 0, ...sheet.rows.slice(0, 200).map((r) => String(r[c] ?? '').length));
    return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, Math.max(8, longest + 2))}" customWidth="1"/>`;
  }).join('');
  return (
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('A spreadsheet needs at least one sheet.');
  const names = safeSheetNames(sheets.map((s) => s.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      XML_HEAD +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(
      XML_HEAD +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    ),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml({ ...s, name: names[i]! }));
  });
  return zipSync(files, { level: 6 });
}

/* ---------- Reading back (used to check a file we just wrote before anything is deleted) ---------- */

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export interface ReadSheet {
  name: string;
  /** Header row first. Empty cells are empty strings. */
  rows: string[][];
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Reads files made by buildXlsx (inline text and numbers). Throws on anything that is not a valid workbook of that shape. */
export function readXlsx(bytes: Uint8Array): ReadSheet[] {
  const files = unzipSync(bytes);
  const wb = files['xl/workbook.xml'];
  if (!wb) throw new Error('Not a spreadsheet: workbook is missing.');
  const names = [...strFromU8(wb).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unesc(m[1]!));
  return names.map((name, i) => {
    const part = files[`xl/worksheets/sheet${i + 1}.xml`];
    if (!part) throw new Error(`Sheet "${name}" is missing from the file.`);
    const xml = strFromU8(part);
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1]!.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const inner = c[2] ?? '';
        const text = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
        const num = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        cells[colIndex(c[1]!)] = unesc(text ?? num ?? '');
      }
      rows.push(Array.from(cells, (x) => x ?? ''));
    }
    return { name, rows };
  });
}
