import 'package:flutter/material.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/breakdown_table.dart';
import 'package:mobile/ui/features/stats/views/widgets/stacked_bar_time_series.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_section.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';

enum _TokenDim { provider, model }

/// Tokens over time with a Provider|Model toggle: a folded stacked chart of
/// total tokens per bucket plus a `[key | input | output | total]` breakdown
/// table sorted by total desc.
class TokensTab extends StatefulWidget {
  const TokensTab({super.key, required this.usage});

  final TeamUsageResponse usage;

  @override
  State<TokensTab> createState() => _TokensTabState();
}

class _TokensTabState extends State<TokensTab> {
  _TokenDim _dim = _TokenDim.provider;

  @override
  Widget build(BuildContext context) {
    final usage = widget.usage;
    final buckets = _dim == _TokenDim.provider
        ? usage.tokensByProvider
        : usage.tokensByModel;

    final series = foldTopKeys(
      pivotBuckets<TelemetryTokenBucket>(
        buckets,
        (b) => b.bucketStartIso,
        (b) => b.key,
        tokenBucketTotal,
        usage.range,
      ),
    );
    final breakdown = aggregateTokenBreakdown(buckets);
    final dimLabel = _dim == _TokenDim.provider ? 'provider' : 'model';

    return StatsTabList(
      children: [
        // Title and toggle are stacked (not a single Row) so the title and the
        // Provider/Model control never contend for width and overflow on a
        // phone.
        const SectionTitle('Tokens over time'),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: SegmentedButton<_TokenDim>(
            segments: const [
              ButtonSegment(value: _TokenDim.provider, label: Text('Provider')),
              ButtonSegment(value: _TokenDim.model, label: Text('Model')),
            ],
            selected: {_dim},
            onSelectionChanged: (selection) =>
                setState(() => _dim = selection.first),
          ),
        ),
        const SizedBox(height: 12),
        StackedBarTimeSeries(
          series: series,
          granularity: usage.range.granularity,
        ),
        const SizedBox(height: 24),
        SectionTitle('Tokens by $dimLabel'),
        const SizedBox(height: 8),
        if (breakdown.isEmpty)
          Text(
            'No token usage for this range.',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          )
        else
          BreakdownTable(
            keyHeader: dimLabel,
            rowKeys: [for (final row in breakdown) row.key],
            columns: [
              BreakdownColumn(
                header: 'Input',
                valueForRow: (i) => formatCompact(breakdown[i].inputTokens),
              ),
              BreakdownColumn(
                header: 'Output',
                valueForRow: (i) => formatCompact(breakdown[i].outputTokens),
              ),
              BreakdownColumn(
                header: 'Total',
                valueForRow: (i) => formatCompact(breakdown[i].total),
              ),
            ],
          ),
      ],
    );
  }
}
