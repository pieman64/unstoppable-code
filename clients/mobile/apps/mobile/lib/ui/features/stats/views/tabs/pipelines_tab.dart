import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/features/stats/stats_aggregation.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_empty_state.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_section.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';

/// Pipeline usage rows, default sorted by run count desc. Each row shows the
/// resolved pipeline name (or raw id) with a colored type badge, and a
/// runs/agent-time/cost/tokens summary line.
class PipelinesTab extends StatelessWidget {
  const PipelinesTab({super.key, required this.usage});

  final TeamUsageResponse usage;

  @override
  Widget build(BuildContext context) {
    if (usage.pipelines.isEmpty) {
      return const StatsEmptyState(message: 'No pipeline runs for this range.');
    }
    final sorted = [...usage.pipelines]
      ..sort((a, b) => b.runCount.compareTo(a.runCount));

    return StatsTabList(
      children: [
        const SectionTitle('Pipeline usage'),
        const SizedBox(height: 4),
        for (final pipeline in sorted) _PipelineRow(pipeline: pipeline),
      ],
    );
  }
}

class _PipelineRow extends StatelessWidget {
  const _PipelineRow({required this.pipeline});

  final TelemetryPipelineUsage pipeline;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.labelSmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final summary = [
      '${formatCount(pipeline.runCount)} runs',
      formatDuration(pipeline.agentTimeMs),
      formatCurrency(pipeline.totalCostUsd),
      '${formatCompact(pipeline.inputTokens + pipeline.outputTokens)} tokens',
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  pipeline.pipelineName ?? pipeline.clientPipelineId,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: AppTypography.emphasisWeight,
                    fontVariations: AppTypography.emphasisVariations,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _PipelineTypeBadge(
                type: classifyPipelineType(pipeline.clientPipelineId),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            summary,
            style: muted,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

class _PipelineTypeBadge extends StatelessWidget {
  const _PipelineTypeBadge({required this.type});

  final PipelineUsageType type;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final statusColors = StatusColors.of(context);
    final (label, color) = switch (type) {
      PipelineUsageType.bundled => ('Bundled', scheme.primary),
      PipelineUsageType.shared => ('Shared', statusColors.special),
      // Distinct from Private: neutral and onSurfaceVariant resolve to the
      // same grey, so Project takes the cyan active role instead.
      PipelineUsageType.project => ('Project', statusColors.active),
      PipelineUsageType.private => ('Private', scheme.onSurfaceVariant),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha(30),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: AppTypography.emphasisWeight,
          fontVariations: AppTypography.emphasisVariations,
        ),
      ),
    );
  }
}
