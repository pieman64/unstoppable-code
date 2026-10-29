import { assertOfficeArchiveExpansion } from './office-expansion';
import type { OfficeArchiveData } from './office-archive';

export const XLSX_MAX_STRUCTURE_MARKERS = 200_000;

/**
 * Bound source structure before SheetJS creates objects, including cells outside
 * the visible grid. Every XML cell, row, merge, style and shared string requires
 * a literal '<' byte (also in UTF-16). Counting all such bytes conservatively
 * bounds their combined count without trusting paths, namespaces, dimensions,
 * or the vendor's permissive XML grammar. Binary parts count too.
 *
 * Stream and discard expanded data. Checking actual sizes prevents a dishonest
 * deflate stream from bypassing the ZIP metadata's per-entry and total limits.
 */
export function assertXlsxStructure(
  entries: readonly OfficeArchiveData[],
): void {
  let markers = 0;
  assertOfficeArchiveExpansion(entries, (chunk) => {
    for (const byte of chunk) {
      if (byte === 0x3c && ++markers > XLSX_MAX_STRUCTURE_MARKERS)
        throw new Error('Workbook exceeds the source structure budget.');
    }
  });
}
