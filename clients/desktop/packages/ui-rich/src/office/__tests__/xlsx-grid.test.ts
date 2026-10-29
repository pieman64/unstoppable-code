import type { XlsxMerge } from '../office-parse';
import { cellKey, columnLabel, coveredCells, spanByAnchor } from '../xlsx-grid';

describe('xlsx-grid helpers', () => {
  it.each([
    [0, 'A'],
    [25, 'Z'],
    [26, 'AA'],
    [701, 'ZZ'],
    [702, 'AAA'],
  ])('labels column %i as %s', (index, expected) => {
    expect(columnLabel(index)).toBe(expected);
  });

  it('marks every merged cell except its anchor and records the anchor span', () => {
    const merges: readonly XlsxMerge[] = [
      { startRow: 4, startCol: 0, endRow: 5, endCol: 1 },
    ];
    const covered = coveredCells(merges);
    expect(covered.has(cellKey(4, 0))).toBe(false);
    expect([...covered]).toEqual(['4:1', '5:0', '5:1']);
    expect(spanByAnchor(merges).get('4:0')).toEqual({ rowSpan: 2, colSpan: 2 });
    expect(spanByAnchor(merges).get('4:1')).toBeUndefined();
  });

  it('enumerates covered cells only for mounted rows', () => {
    const millionRowMerge: readonly XlsxMerge[] = [
      { startRow: 0, startCol: 0, endRow: 999_999, endCol: 1 },
    ];
    const covered = coveredCells(
      millionRowMerge,
      new Set([0, 500_000, 999_999]),
    );
    expect([...covered]).toEqual([
      '0:1',
      '500000:0',
      '500000:1',
      '999999:0',
      '999999:1',
    ]);
  });
});
