import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { searchSlashCommands } from '../commandSearch';
import { groupContiguousRuns, limitSlashResults } from '../commandPresentation';
import type { SlashCommandOption } from '../../types';

// Shared with the Dart port in apps/mobile; expectations are hand-reviewed
// against the contract and must never be regenerated from either ranker.
const VECTORS_PATH = resolve(
  __dirname,
  '../../../../../apps/mobile/test/fixtures/slash-search-vectors.json',
);

interface SearchVector {
  case: string;
  query: string;
  rows: (SlashCommandOption & { id: string })[];
  expected: string[];
}

interface LimitRow {
  id: string;
  group: string;
}

interface LimitVector {
  case: string;
  expanded?: boolean;
  limits?: { total?: number; perGroup?: number };
  rows: LimitRow[];
  expected: { visible: string[]; hiddenCount: number };
  runs?: { key: string; occurrence: number; rows: string[] }[];
}

interface Vectors {
  version: number;
  search: SearchVector[];
  limit: LimitVector[];
}

function isVectors(value: unknown): value is Vectors {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'number' &&
    'search' in value &&
    Array.isArray(value.search) &&
    'limit' in value &&
    Array.isArray(value.limit)
  );
}

const parsed: unknown = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
if (!isVectors(parsed)) throw new Error('Malformed slash search vectors');
const vectors = parsed;

describe('slash search conformance vectors', () => {
  it('uses a known vector version', () => {
    expect(vectors.version).toBe(2);
    expect(vectors.search.length).toBeGreaterThan(20);
    expect(vectors.limit.length).toBeGreaterThan(5);
  });

  it.each(vectors.search.map((vector) => [vector.case, vector] as const))(
    'search: %s',
    (_label, vector) => {
      const before = JSON.stringify(vector.rows);
      const ranked = searchSlashCommands(vector.rows, vector.query);
      expect(ranked.map((row) => row.id)).toEqual(vector.expected);
      expect(JSON.stringify(vector.rows)).toBe(before);
    },
  );

  it.each(vectors.limit.map((vector) => [vector.case, vector] as const))(
    'limit: %s',
    (_label, vector) => {
      const group = (row: LimitRow): string => row.group;
      const before = JSON.stringify(vector.rows);
      const { visible, hiddenCount } = vector.expanded
        ? { visible: [...vector.rows], hiddenCount: 0 }
        : limitSlashResults(vector.rows, group, vector.limits);
      expect(JSON.stringify(vector.rows)).toBe(before);
      expect({
        visible: visible.map((row) => row.id),
        hiddenCount,
      }).toEqual(vector.expected);
      // Visible rows keep their identity and ranked order.
      expect(visible.every((row) => vector.rows.includes(row))).toBe(true);
      if (vector.runs) {
        expect(
          groupContiguousRuns(visible, group).map((run) => ({
            key: run.key,
            occurrence: run.occurrence,
            rows: run.rows.map((row) => row.id),
          })),
        ).toEqual(vector.runs);
      }
    },
  );
});
