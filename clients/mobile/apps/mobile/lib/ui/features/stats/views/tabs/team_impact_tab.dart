import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/stacked_bar_time_series.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_empty_state.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_section.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';

/// Team impact over time (stacked per person) plus an expandable leaderboard,
/// one card per person sorted by impact score desc.
class TeamImpactTab extends StatelessWidget {
  const TeamImpactTab({super.key, required this.usage});

  final TeamUsageResponse usage;

  @override
  Widget build(BuildContext context) {
    if (usage.byUser.isEmpty) {
      return const StatsEmptyState(
        message: 'No attributed usage for this range.',
      );
    }

    final series = foldTopKeys(
      pivotBuckets<TelemetryImpactBucket>(
        usage.impactByUser,
        (b) => b.bucketStartIso,
        (b) => b.key,
        (b) => b.impactScore.toDouble(),
        usage.range,
      ),
    );
    final rows = [...usage.byUser]
      ..sort((a, b) => b.impactScore.compareTo(a.impactScore));

    return StatsTabList(
      children: [
        const SectionTitle('Team impact over time'),
        const SizedBox(height: 12),
        StackedBarTimeSeries(
          series: series,
          granularity: usage.range.granularity,
        ),
        const SizedBox(height: 24),
        const SectionTitle('Impact leaderboard'),
        const SizedBox(height: 8),
        for (final row in rows) _LeaderboardCard(row: row),
      ],
    );
  }
}

class _LeaderboardCard extends StatelessWidget {
  const _LeaderboardCard({required this.row});

  final TelemetryUserLeaderboardRow row;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = row.userName ?? 'Unknown';
    final subtitle = [
      'Impact ${formatCompact(row.impactScore)}',
      '${formatCount(row.prsMerged)} merged',
      formatPercent(row.prsMerged, row.prsCreated),
      formatCurrency(row.totalCostUsd),
    ].join(' · ');

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: ExpansionTile(
        title: Text(
          name,
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        subtitle: Text(subtitle, style: theme.textTheme.labelSmall),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _DetailRow(label: 'PRs opened', value: formatCount(row.prsCreated)),
          _DetailRow(label: 'PRs merged', value: formatCount(row.prsMerged)),
          _DetailRow(
            label: 'Worktrees created',
            value: formatCount(row.worktreesCreated),
          ),
          _DetailRow(
            label: 'Plans implemented',
            value: formatCount(row.plansImplemented),
          ),
          _DetailRow(
            label: 'Lines changed',
            value: formatCount(row.linesChanged),
          ),
          _DetailRow(label: 'Turns', value: formatCount(row.turnCount)),
          _DetailRow(
            label: 'Avg cycle time',
            value: row.avgCycleTimeMs > 0
                ? formatDuration(row.avgCycleTimeMs)
                : '—',
          ),
          _DetailRow(
            label: 'Check pass rate',
            value: formatPercent(row.checksPassing, row.checksDecided),
          ),
          _DetailRow(
            label: 'Avg PR size',
            value: row.avgPrSize > 0 ? formatCount(row.avgPrSize) : '—',
          ),
          _DetailRow(
            label: 'Tokens',
            value: formatCompact(row.inputTokens + row.outputTokens),
          ),
          _DetailRow(
            label: 'Ticket-linked',
            value: formatPercent(row.prsWithTicket, row.prsCreated),
          ),
          _DetailRow(
            label: 'Cost per PR',
            value: row.prsMerged > 0
                ? formatCurrency(row.totalCostUsd / row.prsMerged)
                : '—',
          ),
        ],
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          Text(
            value,
            style: theme.textTheme.bodySmall?.copyWith(
              fontWeight: AppTypography.emphasisWeight,
              fontVariations: AppTypography.emphasisVariations,
            ),
          ),
        ],
      ),
    );
  }
}
