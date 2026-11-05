import type { MemoryEntry } from './memory-model';

/**
 * Plain memories the panel's loading skeletons measure: a title, one short
 * line, and a meta line each, so the bars sit where the rows will.
 */

const SAMPLE_MODIFIED_AT = '2026-01-01T12:00:00.000Z';

function sampleEntry(id: string, title: string, excerpt: string): MemoryEntry {
  return {
    id,
    scopeIndex: 0,
    title,
    file: {
      fileKey: id,
      kind: 'topic',
      modifiedAt: SAMPLE_MODIFIED_AT,
      sizeBytes: 0,
      excerpt,
    },
  };
}

export const SAMPLE_MEMORY_ENTRIES: readonly MemoryEntry[] = [
  sampleEntry(
    'memory-skeleton-1',
    'Prefers short replies',
    'Keep answers brief and skip code details unless asked',
  ),
  sampleEntry(
    'memory-skeleton-2',
    'Runs tests before committing',
    'Runs the affected test suite before every commit',
  ),
  sampleEntry(
    'memory-skeleton-3',
    'Uses the staging database',
    'Local work points at the staging database on port 5433',
  ),
];

/** A memory body's paragraphs, as its Markdown renders them. */
export const SAMPLE_MEMORY_PARAGRAPHS: readonly string[] = [
  'Keep answers brief and in plain language.',
  'Skip code details unless they are asked for, and lead with the outcome.',
];
