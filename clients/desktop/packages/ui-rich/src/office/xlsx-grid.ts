import type { XlsxMerge } from './office-parse';

export function columnLabel(index: number): string {
  let label = '';
  let remaining = index;
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export function coveredCells(
  merges: readonly XlsxMerge[],
  renderedRows?: ReadonlySet<number>,
): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const merge of merges) {
    if (renderedRows) {
      for (const row of renderedRows) {
        if (row < merge.startRow || row > merge.endRow) continue;
        for (let col = merge.startCol; col <= merge.endCol; col += 1) {
          if (row !== merge.startRow || col !== merge.startCol)
            covered.add(cellKey(row, col));
        }
      }
    } else {
      for (let row = merge.startRow; row <= merge.endRow; row += 1) {
        for (let col = merge.startCol; col <= merge.endCol; col += 1) {
          if (row !== merge.startRow || col !== merge.startCol)
            covered.add(cellKey(row, col));
        }
      }
    }
  }
  return covered;
}

export function spanByAnchor(
  merges: readonly XlsxMerge[],
): ReadonlyMap<string, { readonly rowSpan: number; readonly colSpan: number }> {
  const spans = new Map<
    string,
    { readonly rowSpan: number; readonly colSpan: number }
  >();
  for (const merge of merges) {
    spans.set(cellKey(merge.startRow, merge.startCol), {
      rowSpan: merge.endRow - merge.startRow + 1,
      colSpan: merge.endCol - merge.startCol + 1,
    });
  }
  return spans;
}
