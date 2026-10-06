import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName, readXlsx, safeSheetNames } from './xlsx';

describe('spreadsheet writer', () => {
  it('names columns like a spreadsheet does', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('keeps sheet names legal and different', () => {
    expect(safeSheetNames(['Orders', 'orders', 'a/b:c', '', 'x'.repeat(40)])).toEqual(['Orders', 'orders 2', 'a b c', 'Sheet4', 'x'.repeat(31)]);
  });

  it('round-trips text, numbers, blanks, awkward characters and formula-looking text', () => {
    const bytes = buildXlsx([
      {
        name: 'Orders',
        header: ['Number', 'Customer', 'Total', 'Note'],
        rows: [
          ['S-0001', 'Amina & "Sons" <ltd>', 1250.5, null],
          ['S-0002', '=HYPERLINK("http://evil")', 0, 'line one\nline two'],
          ['S-0003', 'tab\there\u0001gone', -3, true],
        ],
      },
      { name: 'Empty', header: ['A'], rows: [] },
    ]);
    const sheets = readXlsx(bytes);
    expect(sheets.map((s) => s.name)).toEqual(['Orders', 'Empty']);
    expect(sheets[0]!.rows).toEqual([
      ['Number', 'Customer', 'Total', 'Note'],
      ['S-0001', 'Amina & "Sons" <ltd>', '1250.5'],
      ['S-0002', '=HYPERLINK("http://evil")', '0', 'line one\nline two'],
      ['S-0003', 'tab\theregone', '-3', 'yes'],
    ]);
    expect(sheets[1]!.rows).toEqual([['A']]);
  });

  it('never stores text as a formula', () => {
    const files = Buffer.from(buildXlsx([{ name: 'S', header: ['h'], rows: [['=1+1']] }])).toString('latin1');
    expect(files.length).toBeGreaterThan(100);
    const sheet = readXlsx(buildXlsx([{ name: 'S', header: ['h'], rows: [['=1+1']] }]))[0]!;
    expect(sheet.rows[1]).toEqual(['=1+1']);
  });

  it('refuses a sheet too big for a spreadsheet, and a file with no sheets', () => {
    expect(() => buildXlsx([])).toThrow(/at least one sheet/);
    expect(() => buildXlsx([{ name: 'Big', header: ['x'], rows: { length: 1_048_575, map: () => [] } as never }])).toThrow(/too many rows/);
  });

  it('refuses something that is not a workbook', () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
