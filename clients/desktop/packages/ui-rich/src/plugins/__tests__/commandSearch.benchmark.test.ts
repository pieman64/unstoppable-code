import { searchSlashCommands } from '../commandSearch';
import { SOURCE_MEMBERS } from './commandSearch.benchmark.fixtures';
import {
  buildBenchmarkInventory,
  GOLDEN_QUERIES,
  rankerQuery,
  SCENARIOS,
  type BenchmarkCommand,
  type GoldenQuery,
} from './commandSearch.benchmark.queries';

interface QueryResult {
  scenario: string;
  query: string;
  kind: string;
  expected: readonly string[];
  rank: number | null;
  top1: number;
  recall3: number;
  hit3: number;
  reciprocalRank: number;
  noise5: number;
  slots5: number;
  outside8: number;
  length: number;
  top5: string[];
  penalizedRank: number;
}

function evaluate(
  inventory: readonly BenchmarkCommand[],
  golden: GoldenQuery,
  scenario: string,
): QueryResult {
  const result = searchSlashCommands(inventory, rankerQuery(golden.query));
  const ids = result.map((command) => command.id);
  const found = golden.expected
    .map((id) => ids.indexOf(id))
    .filter((index) => index >= 0);
  const rank = found.length === 0 ? null : Math.min(...found) + 1;
  const top5 = ids.slice(0, 5);
  return {
    scenario,
    query: golden.query,
    kind: golden.kind,
    expected: golden.expected,
    rank,
    top1: golden.expected.includes(ids[0] ?? '') ? 1 : 0,
    recall3:
      golden.expected.filter((id) => ids.slice(0, 3).includes(id)).length /
      golden.expected.length,
    hit3: rank !== null && rank <= 3 ? 1 : 0,
    reciprocalRank: rank === null ? 0 : 1 / rank,
    noise5: top5.filter((id) => golden.mustNotTop5.includes(id)).length,
    slots5: top5.length,
    outside8: rank === null || rank > 8 ? 1 : 0,
    length: ids.length,
    top5,
    // A miss must make mean rank worse, rather than vanishing from the mean.
    penalizedRank: rank ?? inventory.length + 1,
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

interface Scorecard {
  queries: number;
  top1: number;
  recall3: number;
  hit3: number;
  mrr: number;
  meanRank: number;
  noise5: number;
  noiseShare: number;
  outside8: number;
  missing: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
}

function scorecard(rows: readonly QueryResult[]): Scorecard {
  const lengths = rows.map((row) => row.length);
  const slots = rows.reduce((sum, row) => sum + row.slots5, 0);
  return {
    queries: rows.length,
    top1: mean(rows.map((row) => row.top1)),
    recall3: mean(rows.map((row) => row.recall3)),
    hit3: mean(rows.map((row) => row.hit3)),
    mrr: mean(rows.map((row) => row.reciprocalRank)),
    meanRank: mean(rows.map((row) => row.penalizedRank)),
    noise5: mean(rows.map((row) => row.noise5)),
    noiseShare:
      slots === 0 ? 0 : rows.reduce((sum, row) => sum + row.noise5, 0) / slots,
    outside8: mean(rows.map((row) => row.outside8)),
    missing: rows.filter((row) => row.rank === null).length,
    p50: percentile(lengths, 0.5),
    p90: percentile(lengths, 0.9),
    p95: percentile(lengths, 0.95),
    max: Math.max(...lengths),
  };
}

function worstFirst(a: QueryResult, b: QueryResult): number {
  return b.penalizedRank - a.penalizedRank || b.noise5 - a.noise5;
}

describe('CAN-5271 slash search quality benchmark', () => {
  it('has real, unique, labelled fixtures with both enablement scenarios', () => {
    expect(SOURCE_MEMBERS.length).toBeGreaterThanOrEqual(150);
    expect(GOLDEN_QUERIES.length).toBeGreaterThanOrEqual(40);
    for (const scenario of SCENARIOS) {
      const inventory = buildBenchmarkInventory(scenario);
      const ids = inventory.map((command) => command.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(
        inventory.find((row) => row.id === 'ud-ecom-debugger:ecom-debugger')
          ?.section,
      ).toBe('available');
      for (const query of GOLDEN_QUERIES) {
        expect(query.expected.length).toBeGreaterThan(0);
        expect(query.mustNotTop5.length).toBeGreaterThan(0);
        for (const expected of query.expected) {
          expect(ids).toContain(expected);
          expect(query.relevant).toContain(expected);
          expect(query.mustNotTop5).not.toContain(expected);
        }
      }
    }
  });

  it('counts misses, alternatives, short lists and noise without hiding misses', () => {
    const inventory: BenchmarkCommand[] = [
      { id: 'a', plugin: 'test', name: 'review' },
      { id: 'b', plugin: 'test', name: 'review-more' },
    ];
    const golden: GoldenQuery = {
      query: '/review',
      kind: 'test',
      expected: ['a', 'missing'],
      relevant: ['a', 'missing'],
      mustNotTop5: ['b'],
    };
    const hit = evaluate(inventory, golden, 'test');
    expect(hit).toMatchObject({
      rank: 1,
      top1: 1,
      recall3: 0.5,
      reciprocalRank: 1,
      noise5: 1,
      length: 2,
      outside8: 0,
    });
    const miss = evaluate(inventory, { ...golden, query: 'zzz' }, 'test');
    expect(miss).toMatchObject({
      rank: null,
      top1: 0,
      recall3: 0,
      reciprocalRank: 0,
      noise5: 0,
      length: 0,
      outside8: 1,
      penalizedRank: 3,
    });
    expect(scorecard([hit, miss])).toMatchObject({
      top1: 0.5,
      recall3: 0.25,
      mrr: 0.5,
      meanRank: 2,
      missing: 1,
    });
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });

  it('prints both scenario scorecards and diagnostics', () => {
    const rows: QueryResult[] = [];
    const cards: Record<string, ReturnType<typeof scorecard>> = {};
    for (const scenario of SCENARIOS) {
      const inventory = buildBenchmarkInventory(scenario);
      const before = JSON.stringify(inventory);
      const scenarioRows = GOLDEN_QUERIES.map((query) =>
        evaluate(inventory, query, scenario.id),
      );
      expect(JSON.stringify(inventory)).toBe(before);
      expect(
        GOLDEN_QUERIES.map((query) => evaluate(inventory, query, scenario.id)),
      ).toEqual(scenarioRows);
      cards[scenario.id] = scorecard(scenarioRows);
      rows.push(...scenarioRows);
    }
    cards.combined = scorecard(rows);
    const byKind: Record<string, Scorecard> = {};
    const kinds: Set<string> = new Set(rows.map((row) => row.kind));
    kinds.forEach((kind: string): void => {
      byKind[kind] = scorecard(rows.filter((row) => row.kind === kind));
    });
    const gates: Record<string, Record<string, boolean>> = {};
    for (const scenario of SCENARIOS) {
      const card = cards[scenario.id];
      gates[scenario.id] = {
        top1AtLeast90Percent: card !== undefined && card.top1 >= 0.9,
        hit3AtLeast95Percent: card !== undefined && card.hit3 >= 0.95,
        outside8AtMost2Percent: card !== undefined && card.outside8 <= 0.02,
        noise5AtMostOne: card !== undefined && card.noise5 <= 1,
      };
    }
    const worst10 = [...rows].sort(worstFirst).slice(0, 10);
    const diagnosticQueries = rows.filter((row) =>
      [
        'ecomm-debugger',
        'ecom-debugger',
        'ud-code-review',
        'review-loop',
        'review my pr',
        'debugger',
      ].includes(row.query),
    );
    // Explicit benchmark deliverable: print results, without artifact/file IO.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          inventoryItems: SOURCE_MEMBERS.length + 11,
          goldenQueries: GOLDEN_QUERIES.length,
          scorecard: cards,
          byKind,
          worst10,
          diagnosticQueries,
          gates,
        },
        null,
        2,
      ),
    );
  });

  // Each scenario is its own test, so a failure never skips the other gate.
  it.each(SCENARIOS)('meets immutable quality gates: $id', (scenario) => {
    const inventory = buildBenchmarkInventory(scenario);
    const card = scorecard(
      GOLDEN_QUERIES.map((query) => evaluate(inventory, query, scenario.id)),
    );
    expect({
      top1AtLeast90Percent: card.top1 >= 0.9,
      hit3AtLeast95Percent: card.hit3 >= 0.95,
      outside8AtMost2Percent: card.outside8 <= 0.02,
      noise5AtMostOne: card.noise5 <= 1,
    }).toEqual({
      top1AtLeast90Percent: true,
      hit3AtLeast95Percent: true,
      outside8AtMost2Percent: true,
      noise5AtMostOne: true,
    });
  });
});
