import type { FileSearchResult } from '@/lib/fuzzySearch';

// `MatchSegment` + `splitMatchSegments` now live with the shared highlight
// component so every search surface renders matches identically. Re-exported
// here for existing importers (file-search palette, import-plan modal).
export { splitMatchSegments, type MatchSegment } from '@canopy/ui-shared';

export function getFilenameMatchedIndices(result: FileSearchResult): number[] {
  const offset = Math.max(
    0,
    result.relativePath.length - result.filename.length,
  );
  const filenameIndices: number[] = [];
  for (const index of result.matchedIndices) {
    if (index < offset) continue;
    const adjusted = index - offset;
    if (adjusted < result.filename.length) {
      filenameIndices.push(adjusted);
    }
  }
  return filenameIndices;
}
