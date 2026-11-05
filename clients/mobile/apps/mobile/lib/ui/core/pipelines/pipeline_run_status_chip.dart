import 'package:flutter/material.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/activity/pipeline_run_display.dart';

/// A run's status as a tinted pill: the run screen's header and the chat's
/// Agent activity cards share it, so a status reads the same on both.
class PipelineRunStatusChip extends StatelessWidget {
  const PipelineRunStatusChip({super.key, required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = pipelineRunStatusColor(status, StatusColors.of(context));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(999),
        color: color.withValues(alpha: 0.12),
      ),
      child: Text(
        pipelineRunStatusLabel(status),
        style: theme.textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}
