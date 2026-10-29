import type { AgentAuditEntry, AgentProviderType } from '../../types';
import { bucketEntries } from '../auditTimeBucket';

type BucketEntry = Pick<AgentAuditEntry, 'provider' | 'startedAt' | 'tokens'>;

function localIso(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): string {
  return new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  ).toISOString();
}

function localHourStartIso(timestamp: string): string {
  const date = new Date(timestamp);
  return new Date(
    date.getTime() -
      date.getMinutes() * 60 * 1000 -
      date.getSeconds() * 1000 -
      date.getMilliseconds(),
  ).toISOString();
}

function makeEntry(
  provider: AgentProviderType,
  startedAt: string,
  input: number,
  output: number,
): BucketEntry {
  return {
    provider,
    startedAt,
    tokens: {
      input,
      output,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

describe('bucketEntries', () => {
  const range = {
    startDate: localIso(2026, 4, 19),
    endDate: localIso(2026, 4, 22),
  };

  it('buckets entries by local hour', () => {
    const buckets = bucketEntries(
      [
        makeEntry('claude', localIso(2026, 4, 20, 10, 1), 10, 5),
        makeEntry('claude', localIso(2026, 4, 20, 10, 59, 59, 999), 2, 3),
        makeEntry('codex', localIso(2026, 4, 20, 11), 7, 11),
      ],
      'hour',
      range,
    );

    expect(buckets).toEqual([
      {
        bucketStart: localIso(2026, 4, 20, 10),
        providers: {
          claude: { in: 12, out: 8 },
          codex: { in: 0, out: 0 },
          ollama: { in: 0, out: 0 },
          cursor: { in: 0, out: 0 },
          copilot: { in: 0, out: 0 },
          opencode: { in: 0, out: 0 },
        },
      },
      {
        bucketStart: localIso(2026, 4, 20, 11),
        providers: {
          claude: { in: 0, out: 0 },
          codex: { in: 7, out: 11 },
          ollama: { in: 0, out: 0 },
          cursor: { in: 0, out: 0 },
          copilot: { in: 0, out: 0 },
          opencode: { in: 0, out: 0 },
        },
      },
    ]);
  });

  it('buckets entries by local day and keeps boundary entries separate', () => {
    const buckets = bucketEntries(
      [
        makeEntry('claude', localIso(2026, 4, 20, 23, 59, 59, 999), 1, 2),
        makeEntry('claude', localIso(2026, 4, 21), 3, 4),
      ],
      'day',
      range,
    );

    expect(buckets.map((bucket) => bucket.bucketStart)).toEqual([
      localIso(2026, 4, 20),
      localIso(2026, 4, 21),
    ]);
    expect(buckets[0]?.providers.claude).toEqual({ in: 1, out: 2 });
    expect(buckets[1]?.providers.claude).toEqual({ in: 3, out: 4 });
  });

  it('buckets entries by local ISO week start', () => {
    const buckets = bucketEntries(
      [
        makeEntry('claude', localIso(2026, 4, 19, 12), 5, 6),
        makeEntry('codex', localIso(2026, 4, 20), 7, 8),
      ],
      'week',
      range,
    );

    expect(buckets.map((bucket) => bucket.bucketStart)).toEqual([
      localIso(2026, 4, 13),
      localIso(2026, 4, 20),
    ]);
    expect(buckets[0]?.providers.claude).toEqual({ in: 5, out: 6 });
    expect(buckets[1]?.providers.codex).toEqual({ in: 7, out: 8 });
  });

  it('uses the device local timezone for day boundaries', () => {
    const buckets = bucketEntries(
      [
        makeEntry('claude', localIso(2026, 5, 24, 23, 30), 1, 2),
        makeEntry('claude', localIso(2026, 5, 25, 0, 30), 3, 4),
      ],
      'day',
      {
        startDate: localIso(2026, 5, 24),
        endDate: localIso(2026, 5, 26),
      },
    );

    expect(buckets.map((bucket) => bucket.bucketStart)).toEqual([
      localIso(2026, 5, 24),
      localIso(2026, 5, 25),
    ]);
    expect(buckets[0]?.providers.claude).toEqual({ in: 1, out: 2 });
    expect(buckets[1]?.providers.claude).toEqual({ in: 3, out: 4 });
  });

  it('uses the device local timezone for week boundaries', () => {
    const buckets = bucketEntries(
      [
        makeEntry('claude', localIso(2026, 5, 24, 23, 30), 1, 2),
        makeEntry('claude', localIso(2026, 5, 25, 0, 30), 3, 4),
      ],
      'week',
      {
        startDate: localIso(2026, 5, 18),
        endDate: localIso(2026, 6, 1),
      },
    );

    expect(buckets.map((bucket) => bucket.bucketStart)).toEqual([
      localIso(2026, 5, 18),
      localIso(2026, 5, 25),
    ]);
    expect(buckets[0]?.providers.claude).toEqual({ in: 1, out: 2 });
    expect(buckets[1]?.providers.claude).toEqual({ in: 3, out: 4 });
  });

  it('sums each provider independently in the same bucket', () => {
    const buckets = bucketEntries(
      [
        makeEntry('claude', localIso(2026, 4, 20, 12), 1, 2),
        makeEntry('codex', localIso(2026, 4, 20, 12, 5), 3, 4),
        makeEntry('ollama', localIso(2026, 4, 20, 12, 10), 5, 6),
        makeEntry('cursor', localIso(2026, 4, 20, 12, 10), 9, 10),
        makeEntry('codex', localIso(2026, 4, 20, 12, 15), 7, 8),
        makeEntry('copilot', localIso(2026, 4, 20, 12, 20), 11, 12),
        makeEntry('copilot', localIso(2026, 4, 20, 12, 25), 13, 14),
        makeEntry('opencode', localIso(2026, 4, 20, 12, 30), 15, 16),
        makeEntry('opencode', localIso(2026, 4, 20, 12, 35), 17, 18),
      ],
      'hour',
      range,
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.providers).toEqual({
      claude: { in: 1, out: 2 },
      codex: { in: 10, out: 12 },
      ollama: { in: 5, out: 6 },
      cursor: { in: 9, out: 10 },
      copilot: { in: 24, out: 26 },
      opencode: { in: 32, out: 34 },
    });
  });

  it('keeps repeated fallback hours in separate local buckets', () => {
    const buckets = bucketEntries(
      [
        makeEntry('claude', '2026-11-01T01:30:00-04:00', 1, 1),
        makeEntry('claude', '2026-11-01T01:30:00-05:00', 2, 2),
      ],
      'hour',
      {
        startDate: '2026-11-01T00:00:00.000Z',
        endDate: '2026-11-02T00:00:00.000Z',
      },
    );

    expect(buckets.map((bucket) => bucket.bucketStart)).toEqual([
      localHourStartIso('2026-11-01T01:30:00-04:00'),
      localHourStartIso('2026-11-01T01:30:00-05:00'),
    ]);
    expect(buckets[0]?.providers.claude).toEqual({ in: 1, out: 1 });
    expect(buckets[1]?.providers.claude).toEqual({ in: 2, out: 2 });
  });

  it('returns an empty list when there are no entries in range', () => {
    const buckets = bucketEntries(
      [
        makeEntry(
          'claude',
          new Date(new Date(range.startDate).getTime() - 1).toISOString(),
          1,
          1,
        ),
      ],
      'day',
      range,
    );

    expect(buckets).toEqual([]);
  });
});
