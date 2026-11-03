import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/remote_progress_phases.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// One checklist row.
class CanopyProgressChecklistStep {
  const CanopyProgressChecklistStep({
    required this.label,
    required this.status,
  });

  final String label;
  final RemoteProgressStepStatus status;
}

enum CanopyProgressBadgeTone { progress, success, error }

/// Status pill rendered above the rows.
class CanopyProgressBadge {
  const CanopyProgressBadge({required this.label, required this.tone});

  final String label;
  final CanopyProgressBadgeTone tone;
}

/// Display-only progress checklist: a badge plus one icon-and-label row per
/// step. Mirrors `ProgressChecklist` in
/// `packages/ui-shared/src/components/ProgressChecklist.tsx` so desktop, web,
/// and mobile cannot drift visually.
class CanopyProgressChecklist extends StatelessWidget {
  const CanopyProgressChecklist({
    super.key,
    required this.steps,
    this.badge,
    this.error,
  });

  final List<CanopyProgressChecklistStep> steps;
  final CanopyProgressBadge? badge;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = StatusColors.of(context);
    final currentBadge = badge;
    final currentError = error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (currentBadge != null) ...[
          _Badge(badge: currentBadge, colors: colors),
          const SizedBox(height: 8),
        ],
        for (final step in steps)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 16,
                  height: 16,
                  child: Center(
                    child: _StepIcon(status: step.status, colors: colors),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    step.label,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: _labelColor(step.status, colors, theme),
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (currentError != null) ...[
          const SizedBox(height: 6),
          Text(
            currentError,
            style: theme.textTheme.bodySmall?.copyWith(color: colors.failed),
          ),
        ],
      ],
    );
  }

  Color _labelColor(
    RemoteProgressStepStatus status,
    StatusColors colors,
    ThemeData theme,
  ) => switch (status) {
    RemoteProgressStepStatus.error => colors.failed,
    RemoteProgressStepStatus.active => theme.colorScheme.onSurface,
    RemoteProgressStepStatus.pending => colors.quaternary,
    RemoteProgressStepStatus.completed => colors.neutral,
  };
}

class _StepIcon extends StatelessWidget {
  const _StepIcon({required this.status, required this.colors});

  final RemoteProgressStepStatus status;
  final StatusColors colors;

  @override
  Widget build(BuildContext context) => switch (status) {
    RemoteProgressStepStatus.error => SizedBox(
      key: const ValueKey('progress-icon-error'),
      child: CanopyIcon(
        glyph: CanopyGlyph.crossSmall,
        size: 14,
        tint: colors.failed,
      ),
    ),
    RemoteProgressStepStatus.completed => SizedBox(
      key: const ValueKey('progress-icon-completed'),
      child: CanopyIcon(
        glyph: CanopyGlyph.checkmark1,
        size: 14,
        tint: colors.success,
      ),
    ),
    RemoteProgressStepStatus.active => SizedBox(
      key: const ValueKey('progress-icon-active'),
      width: 12,
      height: 12,
      child: CircularProgressIndicator(strokeWidth: 2, color: colors.active),
    ),
    // pending — static hollow dot, deliberately not a spinner.
    RemoteProgressStepStatus.pending => Container(
      key: const ValueKey('progress-icon-pending'),
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: colors.quaternary, width: 1),
      ),
    ),
  };
}

class _Badge extends StatelessWidget {
  const _Badge({required this.badge, required this.colors});

  final CanopyProgressBadge badge;
  final StatusColors colors;

  @override
  Widget build(BuildContext context) {
    final color = switch (badge.tone) {
      CanopyProgressBadgeTone.error => colors.failed,
      CanopyProgressBadgeTone.success => colors.success,
      CanopyProgressBadgeTone.progress => colors.active,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        badge.label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}
