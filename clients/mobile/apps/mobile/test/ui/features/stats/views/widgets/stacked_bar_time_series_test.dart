import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/stacked_bar_time_series.dart';

const _range = TeamUsageResponseRange(
  startIso: '2026-06-28T00:00:00.000Z',
  endIso: '2026-07-01T00:00:00.000Z',
  granularity: TelemetryTimeGranularity.day,
);

/// A single-key series with [bucketCount] distinct buckets, for exercising
/// x-axis label thinning on wide ranges.
PivotedSeries _series(int bucketCount) {
  final buckets = <String>[];
  final valuesByBucket = <String, Map<String, double>>{};
  final start = DateTime.utc(2026, 6, 1);
  for (var i = 0; i < bucketCount; i++) {
    // Distinct, parseable ISO days so formatBucketTick renders representative
    // short "Jun N" ticks instead of a raw unparseable string.
    final iso = start.add(Duration(days: i)).toIso8601String();
    buckets.add(iso);
    valuesByBucket[iso] = {'a': (i + 1).toDouble()};
  }
  return PivotedSeries(
    buckets: buckets,
    keys: const ['a'],
    valuesByBucket: valuesByBucket,
  );
}

void main() {
  group('axisLabelStride', () {
    test('shows every bucket when they all fit', () {
      expect(axisLabelStride(1, 360, TelemetryTimeGranularity.day), 1);
      expect(axisLabelStride(6, 360, TelemetryTimeGranularity.day), 1);
      expect(axisLabelStride(5, 1000, TelemetryTimeGranularity.day), 1);
    });

    test('thins a wide daily range so labels do not overlap', () {
      final stride = axisLabelStride(50, 360, TelemetryTimeGranularity.day);
      expect(stride, greaterThan(1));
      // The resulting label count stays small and readable.
      expect((50 / stride).ceil(), lessThanOrEqualTo(7));
    });

    test('thins at least as much for wider hour labels', () {
      final day = axisLabelStride(20, 360, TelemetryTimeGranularity.day);
      final hour = axisLabelStride(20, 360, TelemetryTimeGranularity.hour);
      expect(hour, greaterThanOrEqualTo(day));
    });

    test('shows a single label when there is no usable width', () {
      // Zero, negative, or non-finite widths can't fit labels, so fall back to
      // a single label (stride == bucketCount) rather than an overlapping smear.
      expect(axisLabelStride(30, 0, TelemetryTimeGranularity.day), 30);
      expect(axisLabelStride(30, -10, TelemetryTimeGranularity.day), 30);
      expect(
        axisLabelStride(30, double.infinity, TelemetryTimeGranularity.day),
        30,
      );
      expect(axisLabelStride(30, double.nan, TelemetryTimeGranularity.day), 30);
    });

    test('never returns a stride below 1', () {
      expect(axisLabelStride(0, 360, TelemetryTimeGranularity.day), 1);
      expect(axisLabelStride(1, 360, TelemetryTimeGranularity.day), 1);
    });
  });

  testWidgets('renders a many-bucket chart at phone width without overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13, 390 logical
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: StackedBarTimeSeries(
            series: _series(24),
            granularity: TelemetryTimeGranularity.day,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });

  testWidgets('renders a legend key when the series has data', (tester) async {
    final series = pivotBuckets<TelemetryCostBucket>(
      const [
        TelemetryCostBucket(
          bucketStartIso: '2026-06-28T00:00:00.000Z',
          key: 'anthropic',
          totalCostUsd: 10,
        ),
      ],
      (b) => b.bucketStartIso,
      (b) => b.key,
      (b) => b.totalCostUsd.toDouble(),
      _range,
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: StackedBarTimeSeries(
            series: series,
            granularity: TelemetryTimeGranularity.day,
          ),
        ),
      ),
    );
    expect(find.text('anthropic'), findsOneWidget);
  });

  testWidgets('renders an empty placeholder when there is no data', (
    tester,
  ) async {
    const series = PivotedSeries(buckets: [], keys: [], valuesByBucket: {});
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: StackedBarTimeSeries(
            series: series,
            granularity: TelemetryTimeGranularity.day,
          ),
        ),
      ),
    );
    expect(find.text('No data for this range'), findsOneWidget);
  });
}
