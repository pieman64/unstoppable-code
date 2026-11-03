import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';

const _range = TeamUsageResponseRange(
  startIso: '2026-06-28T00:00:00.000Z',
  endIso: '2026-07-01T00:00:00.000Z',
  granularity: TelemetryTimeGranularity.day,
);

TelemetryTokenBucket _token(
  String iso,
  String key, {
  double input = 0,
  double output = 0,
  double cacheRead = 0,
  double cacheCreate = 0,
}) => TelemetryTokenBucket(
  bucketStartIso: iso,
  key: key,
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheCreate,
);

void main() {
  group('pivotBuckets', () {
    test('gap-fills the day grid and pivots per key', () {
      final series = pivotBuckets<TelemetryCostBucket>(
        const [
          TelemetryCostBucket(
            bucketStartIso: '2026-06-28T00:00:00.000Z',
            key: 'anthropic',
            totalCostUsd: 10,
          ),
          TelemetryCostBucket(
            bucketStartIso: '2026-06-30T00:00:00.000Z',
            key: 'openai',
            totalCostUsd: 4,
          ),
        ],
        (b) => b.bucketStartIso,
        (b) => b.key,
        (b) => b.totalCostUsd.toDouble(),
        _range,
      );
      // 3 daily slots across [28, 29, 30) -> [28,29,30) inclusive of the
      // partial leading bucket; end exclusive.
      expect(series.buckets, [
        '2026-06-28T00:00:00.000Z',
        '2026-06-29T00:00:00.000Z',
        '2026-06-30T00:00:00.000Z',
      ]);
      expect(series.keys, ['anthropic', 'openai']);
      expect(
        series.valuesByBucket['2026-06-28T00:00:00.000Z']!['anthropic'],
        10,
      );
      expect(
        series.valuesByBucket['2026-06-29T00:00:00.000Z']!['anthropic'],
        0,
      );
      expect(series.valuesByBucket['2026-06-30T00:00:00.000Z']!['openai'], 4);
    });

    test('returns empty buckets/keys when no rows', () {
      final series = pivotBuckets<TelemetryCostBucket>(
        const [],
        (b) => b.bucketStartIso,
        (b) => b.key,
        (b) => b.totalCostUsd.toDouble(),
        _range,
      );
      expect(series.buckets, isEmpty);
      expect(series.keys, isEmpty);
    });
  });

  group('tokenBucketTotal', () {
    test('sums the four token categories', () {
      expect(
        tokenBucketTotal(
          _token('x', 'k', input: 1, output: 2, cacheRead: 3, cacheCreate: 4),
        ),
        10,
      );
    });
  });

  group('aggregateTokenBreakdown', () {
    test('groups by key, sums, sorts by total desc', () {
      final rows = aggregateTokenBreakdown([
        _token('a', 'anthropic', input: 5, output: 5),
        _token('b', 'anthropic', input: 5, output: 0),
        _token('a', 'openai', input: 1, output: 1),
      ]);
      expect(rows.map((r) => r.key).toList(), ['anthropic', 'openai']);
      expect(rows.first.total, 15);
      expect(rows.first.inputTokens, 10);
      expect(rows.first.outputTokens, 5);
    });
  });

  group('aggregateCostBreakdown', () {
    test('groups by key, sums cost, sorts desc', () {
      final rows = aggregateCostBreakdown(const [
        TelemetryCostBucket(
          bucketStartIso: 'a',
          key: 'openai',
          totalCostUsd: 2,
        ),
        TelemetryCostBucket(
          bucketStartIso: 'b',
          key: 'anthropic',
          totalCostUsd: 3,
        ),
        TelemetryCostBucket(
          bucketStartIso: 'c',
          key: 'anthropic',
          totalCostUsd: 4,
        ),
      ]);
      expect(rows.map((r) => r.key).toList(), ['anthropic', 'openai']);
      expect(rows.first.total, 7);
    });
  });

  group('classifyPipelineType', () {
    test('derives type from id conventions', () {
      expect(
        classifyPipelineType('shared:canopy-cloud:41099f6d'),
        PipelineUsageType.shared,
      );
      expect(
        classifyPipelineType('bundled-implementation-autopilot'),
        PipelineUsageType.bundled,
      );
      expect(
        classifyPipelineType('code-review.yaml'),
        PipelineUsageType.project,
      );
      expect(
        classifyPipelineType('pipelines/code-review.yml'),
        PipelineUsageType.project,
      );
      expect(
        classifyPipelineType('a6f5db43-4ed7-4791'),
        PipelineUsageType.private,
      );
    });
  });

  group('label maps', () {
    test('use friendly labels with humanized fallback', () {
      expect(eventTypeLabel('WORKTREE_CHAT'), 'Worktree Chat');
      expect(eventTypeLabel('PIPELINE_AGENT_TURN'), 'Pipeline');
      expect(eventTypeLabel('SOME_NEW_EVENT'), 'Some New Event');
      expect(turnStatusLabel('SUCCESS'), 'Success');
      expect(turnStatusLabel('WEIRD_STATUS'), 'Weird Status');
      expect(toolCategoryLabel('file_edit'), 'File Edit');
      expect(toolCategoryLabel('CANOPY'), 'Built-in');
    });
  });

  group('foldTopKeys', () {
    test('keeps the top N keys and merges the remainder into Others', () {
      final series = pivotBuckets<TelemetryCostBucket>(
        const [
          TelemetryCostBucket(
            bucketStartIso: '2026-06-28T00:00:00.000Z',
            key: 'a',
            totalCostUsd: 7,
          ),
          TelemetryCostBucket(
            bucketStartIso: '2026-06-28T00:00:00.000Z',
            key: 'b',
            totalCostUsd: 6,
          ),
          TelemetryCostBucket(
            bucketStartIso: '2026-06-28T00:00:00.000Z',
            key: 'c',
            totalCostUsd: 5,
          ),
          TelemetryCostBucket(
            bucketStartIso: '2026-06-28T00:00:00.000Z',
            key: 'd',
            totalCostUsd: 4,
          ),
        ],
        (b) => b.bucketStartIso,
        (b) => b.key,
        (b) => b.totalCostUsd.toDouble(),
        _range,
      );
      final folded = foldTopKeys(series, maxKeys: 2);
      expect(folded.keys, ['a', 'b', 'Others']);
      expect(folded.valuesByBucket['2026-06-28T00:00:00.000Z']!['Others'], 9);
    });

    test('preserves and extends an existing Others series', () {
      const bucket = '2026-06-28T00:00:00.000Z';
      const series = PivotedSeries(
        buckets: [bucket],
        keys: ['a', 'b', 'Others', 'c', 'd'],
        valuesByBucket: {
          bucket: {'a': 10, 'b': 9, 'Others': 8, 'c': 7, 'd': 6},
        },
      );

      final folded = foldTopKeys(series, maxKeys: 2);

      expect(folded.keys, ['a', 'b', 'Others']);
      expect(folded.valuesByBucket[bucket]!['Others'], 21);
    });
  });
}
