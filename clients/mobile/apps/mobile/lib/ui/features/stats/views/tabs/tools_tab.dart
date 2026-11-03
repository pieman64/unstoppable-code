import 'package:flutter/material.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/horizontal_bar_chart.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_empty_state.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_section.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';

/// Tool usage by category as a horizontal bar chart, sorted by count desc.
class ToolsTab extends StatelessWidget {
  const ToolsTab({super.key, required this.usage});

  final TeamUsageResponse usage;

  @override
  Widget build(BuildContext context) {
    final sorted = [...usage.toolCategoryTotals]
      ..sort((a, b) => b.total.compareTo(a.total));

    if (sorted.isEmpty) {
      return const StatsEmptyState(message: 'No tool usage for this range.');
    }

    final data = [
      for (final total in sorted)
        HorizontalBarDatum(
          label: toolCategoryLabel(total.toolCategory),
          value: total.total.toDouble(),
        ),
    ];

    return StatsTabList(
      children: [
        const SectionTitle('Tool usage by category'),
        const SizedBox(height: 12),
        HorizontalBarChart(data: data, valueFormatter: formatCount),
      ],
    );
  }
}
