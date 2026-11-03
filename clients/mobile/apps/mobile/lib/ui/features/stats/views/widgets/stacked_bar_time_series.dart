import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_palette.dart';

/// Stacked vertical bar chart over time buckets, one stacked segment per series
/// key. The series should already be folded to a bounded key count (see
/// [foldTopKeys]); an empty series renders a muted placeholder.
class StackedBarTimeSeries extends StatelessWidget {
  const StackedBarTimeSeries({
    super.key,
    required this.series,
    required this.granularity,
  });

  final PivotedSeries series;
  final TelemetryTimeGranularity granularity;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (series.buckets.isEmpty || series.keys.isEmpty) {
      return _EmptyChart(theme: theme);
    }

    var maxTotal = 0.0;
    for (final bucket in series.buckets) {
      final byKey = series.valuesByBucket[bucket] ?? const {};
      final total = byKey.values.fold<double>(0, (sum, v) => sum + v);
      if (total > maxTotal) maxTotal = total;
    }
    final safeMax = maxTotal <= 0 ? 1.0 : maxTotal;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 220,
          // Thin the x-axis labels to what actually fits the available width so
          // short date ticks never overlap into an unreadable smear on wide
          // ranges. LayoutBuilder gives us the width to size the stride.
          child: LayoutBuilder(
            builder: (context, constraints) => _chart(
              theme,
              safeMax,
              axisLabelStride(
                series.buckets.length,
                constraints.maxWidth,
                granularity,
              ),
            ),
          ),
        ),
        const SizedBox(height: 12),
        _Legend(keys: series.keys),
      ],
    );
  }

  Widget _chart(ThemeData theme, double safeMax, int labelStride) {
    return BarChart(
      BarChartData(
        alignment: BarChartAlignment.spaceAround,
        maxY: safeMax,
        minY: 0,
        gridData: const FlGridData(show: true, drawVerticalLine: false),
        borderData: FlBorderData(show: false),
        barTouchData: BarTouchData(enabled: false),
        titlesData: FlTitlesData(
          leftTitles: const AxisTitles(
            sideTitles: SideTitles(showTitles: false),
          ),
          rightTitles: const AxisTitles(
            sideTitles: SideTitles(showTitles: false),
          ),
          topTitles: const AxisTitles(
            sideTitles: SideTitles(showTitles: false),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 28,
              interval: 1,
              getTitlesWidget: (value, meta) {
                final index = value.toInt();
                if (index < 0 || index >= series.buckets.length) {
                  return const SizedBox.shrink();
                }
                // Only draw every `labelStride`-th tick; skipped ticks render
                // nothing so the remaining labels stay readable and aligned.
                if (index % labelStride != 0) {
                  return const SizedBox.shrink();
                }
                return Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    formatBucketTick(series.buckets[index], granularity),
                    style: theme.textTheme.labelSmall,
                  ),
                );
              },
            ),
          ),
        ),
        barGroups: [
          for (var i = 0; i < series.buckets.length; i++)
            _stackGroup(i, series.buckets[i], theme.brightness),
        ],
      ),
    );
  }

  BarChartGroupData _stackGroup(int x, String bucket, Brightness brightness) {
    final byKey = series.valuesByBucket[bucket] ?? const {};
    final stackItems = <BarChartRodStackItem>[];
    var from = 0.0;
    for (var k = 0; k < series.keys.length; k++) {
      final value = byKey[series.keys[k]] ?? 0;
      if (value <= 0) continue;
      final to = from + value;
      stackItems.add(
        BarChartRodStackItem(from, to, statsSeriesColor(k, brightness)),
      );
      from = to;
    }
    return BarChartGroupData(
      x: x,
      barRods: [
        BarChartRodData(
          toY: from,
          width: 14,
          rodStackItems: stackItems,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(3)),
        ),
      ],
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({required this.keys});

  final List<String> keys;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Wrap(
      spacing: 12,
      runSpacing: 6,
      children: [
        for (var i = 0; i < keys.length; i++)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  color: statsSeriesColor(i, theme.brightness),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 4),
              Text(keys[i], style: theme.textTheme.labelSmall),
            ],
          ),
      ],
    );
  }
}

class _EmptyChart extends StatelessWidget {
  const _EmptyChart({required this.theme});

  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 180,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        border: Border.all(color: theme.colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        'No data for this range',
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

/// Minimum horizontal space one x-axis tick label needs, by granularity. Hour
/// ticks ("Jun 30, 3 PM") are much wider than day/week ticks ("Jun 30").
double _minTickLabelWidth(TelemetryTimeGranularity granularity) =>
    granularity == TelemetryTimeGranularity.hour ? 88.0 : 52.0;

/// How many buckets to skip between rendered x-axis labels so short date ticks
/// never overlap: fit as many evenly-spaced labels as [availableWidth] allows
/// (each needing [_minTickLabelWidth] for the [granularity]), returning 1 (show
/// every bucket) when they all fit and never less than 1.
@visibleForTesting
int axisLabelStride(
  int bucketCount,
  double availableWidth,
  TelemetryTimeGranularity granularity,
) {
  if (bucketCount <= 1) return 1;
  // Without a finite, positive width we can't tell how many labels fit, so fall
  // back to a single label (stride == bucketCount) rather than an overlapping
  // smear — or a non-finite floor()/toInt() crash on infinite/NaN widths.
  if (!availableWidth.isFinite || availableWidth <= 0) return bucketCount;
  final maxLabels = (availableWidth / _minTickLabelWidth(granularity)).floor();
  if (maxLabels >= bucketCount) return 1;
  if (maxLabels <= 1) return bucketCount;
  return (bucketCount / maxLabels).ceil();
}
