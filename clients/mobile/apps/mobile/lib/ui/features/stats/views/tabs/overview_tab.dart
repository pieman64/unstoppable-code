import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_section.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';
import 'package:mobile/ui/features/stats/views/widgets/status_badge.dart';

/// Fixed height of a headline tile, grown with the user's text
/// scale so the label/value/trend stack cannot overflow at accessibility sizes.
double _headlineCardHeight(BuildContext context) {
  final textScale = MediaQuery.textScalerOf(
    context,
  ).scale(1).clamp(1.0, double.infinity).toDouble();
  return 120 * textScale;
}

/// The organization Overview: server-driven headline card grid plus the Most
/// Expensive Runs list. Output matches the pre-tabs screen exactly.
class OverviewTab extends StatelessWidget {
  const OverviewTab({super.key, required this.usage});

  final TeamUsageResponse usage;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final runs = usage.mostExpensiveRuns;

    return StatsTabList(
      children: [
        Text(
          rangeLabel(usage.range),
          style: theme.textTheme.labelMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) => GridView(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            // Phones retain the established two-up layout, including narrow
            // 320px viewports. Tablets can add columns while keeping cards
            // compact. A width-derived `childAspectRatio` made each card as
            // tall as it was wide (~325px on an iPad).
            gridDelegate: constraints.maxWidth < 600
                ? SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    mainAxisSpacing: 12,
                    crossAxisSpacing: 12,
                    mainAxisExtent: _headlineCardHeight(context),
                  )
                : SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 280,
                    mainAxisSpacing: 12,
                    crossAxisSpacing: 12,
                    mainAxisExtent: _headlineCardHeight(context),
                  ),
            children: [
              for (final card in usage.headline) _HeadlineCard(card: card),
            ],
          ),
        ),
        if (runs.isNotEmpty) ...[
          const SizedBox(height: 24),
          const SectionTitle('Most expensive runs'),
          const SizedBox(height: 4),
          for (final run in runs.take(10)) _ExpensiveRunRow(run: run),
        ],
      ],
    );
  }
}

class _HeadlineCard extends StatelessWidget {
  const _HeadlineCard({required this.card});

  final TelemetryHeadlineCard card;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final trend = formatTrend(card.value, card.previousValue);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              card.label,
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            Text(
              formatHeadlineValue(card.value, card.unit),
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            Text(
              trend ?? '—',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }
}

class _ExpensiveRunRow extends StatelessWidget {
  const _ExpensiveRunRow({required this.run});

  final TelemetryExpensiveRun run;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.labelSmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );

    final meta = [
      run.authorName ?? 'Unknown',
      eventTypeLabel(run.eventType),
      run.branchName,
    ].join(' · ');

    final detail = [
      run.provider,
      if (run.model != null) run.model!,
      '${formatCompact(run.inputTokens + run.outputTokens)} tokens',
      if (run.durationMs != null) formatDuration(run.durationMs!),
      formatRelativeTime(run.startedAtIso),
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              StatusBadge(status: run.status),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  run.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: AppTypography.emphasisWeight,
                    fontVariations: AppTypography.emphasisVariations,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                formatCurrency(run.totalCostUsd),
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: AppTypography.emphasisWeight,
                  fontVariations: AppTypography.emphasisVariations,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            meta,
            style: muted,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          Text(
            detail,
            style: muted,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}
