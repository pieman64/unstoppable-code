import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_empty_state.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_section.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';

/// One event type's status rows, grouped for display.
class _ActivityGroup {
  _ActivityGroup(this.eventType);

  final String eventType;
  final List<TelemetryEventStatusCount> rows = [];
  double total = 0;
}

/// Turns grouped by event type: one card per event type with a chip row of
/// status -> count. Event types are ordered by total count descending.
class ActivityTab extends StatelessWidget {
  const ActivityTab({super.key, required this.usage});

  final TeamUsageResponse usage;

  @override
  Widget build(BuildContext context) {
    if (usage.eventTypeStatusCounts.isEmpty) {
      return const StatsEmptyState(
        message: 'No agent activity for this range.',
      );
    }

    final byType = <String, _ActivityGroup>{};
    final order = <String>[];
    for (final row in usage.eventTypeStatusCounts) {
      final group = byType.putIfAbsent(row.eventType, () {
        order.add(row.eventType);
        return _ActivityGroup(row.eventType);
      });
      group.rows.add(row);
      group.total += row.count;
    }
    final groups = order.map((type) => byType[type]!).toList()
      ..sort((a, b) => b.total.compareTo(a.total));

    return StatsTabList(
      children: [
        const SectionTitle('Turns by event type & status'),
        const SizedBox(height: 12),
        for (final group in groups) _ActivityCard(group: group),
      ],
    );
  }
}

class _ActivityCard extends StatelessWidget {
  const _ActivityCard({required this.group});

  final _ActivityGroup group;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              eventTypeLabel(group.eventType),
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final row in group.rows)
                  Chip(
                    label: Text(
                      '${turnStatusLabel(row.status)} · ${formatCount(row.count)}',
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
