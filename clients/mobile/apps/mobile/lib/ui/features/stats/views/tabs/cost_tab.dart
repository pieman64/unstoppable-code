import 'package:flutter/material.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/breakdown_table.dart';
import 'package:mobile/ui/features/stats/views/widgets/stacked_bar_time_series.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_section.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';

enum _CostDim { provider, model }

const String _costDisclaimer =
    "Standard list price for these AI interactions. What you're actually "
    'billed may differ on subscription plans.';

/// Observed cost over time with a Provider|Model toggle: a folded stacked
/// chart of `totalCostUsd` per bucket, the list-price disclaimer, and a
/// `[key | observed cost]` breakdown table sorted by total desc.
class CostTab extends StatefulWidget {
  const CostTab({super.key, required this.usage});

  final TeamUsageResponse usage;

  @override
  State<CostTab> createState() => _CostTabState();
}

class _CostTabState extends State<CostTab> {
  _CostDim _dim = _CostDim.provider;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final usage = widget.usage;
    final buckets = _dim == _CostDim.provider
        ? usage.costByProvider
        : usage.costByModel;

    final series = foldTopKeys(
      pivotBuckets<TelemetryCostBucket>(
        buckets,
        (b) => b.bucketStartIso,
        (b) => b.key,
        (b) => b.totalCostUsd.toDouble(),
        usage.range,
      ),
    );
    final breakdown = aggregateCostBreakdown(buckets);
    final dimLabel = _dim == _CostDim.provider ? 'provider' : 'model';

    return StatsTabList(
      children: [
        // Title and toggle are stacked (not a single Row) so the long title and
        // the Provider/Model control never contend for width and overflow on a
        // phone.
        const SectionTitle('Observed cost over time'),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: SegmentedButton<_CostDim>(
            segments: const [
              ButtonSegment(value: _CostDim.provider, label: Text('Provider')),
              ButtonSegment(value: _CostDim.model, label: Text('Model')),
            ],
            selected: {_dim},
            onSelectionChanged: (selection) =>
                setState(() => _dim = selection.first),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          _costDisclaimer,
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        StackedBarTimeSeries(
          series: series,
          granularity: usage.range.granularity,
        ),
        const SizedBox(height: 24),
        SectionTitle('Observed cost by $dimLabel'),
        const SizedBox(height: 8),
        if (breakdown.isEmpty)
          Text(
            'No observed cost recorded for this range.',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          )
        else
          BreakdownTable(
            keyHeader: dimLabel,
            rowKeys: [for (final row in breakdown) row.key],
            columns: [
              BreakdownColumn(
                header: 'Observed cost',
                valueForRow: (i) => formatCurrency(breakdown[i].total),
              ),
            ],
          ),
      ],
    );
  }
}
