import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/activity/pipeline_run_display.dart';
import 'package:mobile/ui/core/activity/pipeline_run_dot_track.dart';
import 'pipeline_run_status_chip.dart';

/// "Agent activity · N items" under one turn: a disclosure header and, while
/// expanded, a card per run. Expansion is the controller's screen-session
/// state, so it survives the feed recycling this row.
class PipelineRunAgentActivityPanel extends StatelessWidget {
  const PipelineRunAgentActivityPanel({
    super.key,
    required this.expanded,
    required this.onToggle,
    required this.pendingAction,
    required this.actionError,
    required this.onCancel,
    required this.turnKey,
    required this.runs,
    required this.onOpenRun,
  });

  final bool expanded;
  final VoidCallback onToggle;
  final RemotePipelineRunAction? Function(String) pendingAction;
  final String? Function(String) actionError;
  final ValueChanged<String>? onCancel;
  final String turnKey;
  final List<RemotePipelineRun> runs;
  final ValueChanged<RemotePipelineRun> onOpenRun;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final muted = colors.foregroundSecondary;
    final count = runs.length == 1 ? '1 item' : '${runs.length} items';
    final labelStyle = theme.textTheme.labelMedium?.copyWith(color: muted);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: expanded,
            excludeSemantics: true,
            label: 'Agent activity, $count',
            onTap: onToggle,
            child: InkWell(
              key: ValueKey('agent-activity-toggle:$turnKey'),
              onTap: onToggle,
              borderRadius: BorderRadius.circular(AppRadii.md),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Row(
                    children: [
                      Flexible(
                        child: Wrap(
                          spacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text('Agent activity', style: labelStyle),
                            Text('·', style: labelStyle),
                            Text(count, style: labelStyle),
                          ],
                        ),
                      ),
                      const SizedBox(width: 4),
                      CanopyIcon(
                        glyph: expanded
                            ? CanopyGlyph.chevronDownSmall
                            : CanopyGlyph.chevronRightSmall,
                        size: 16,
                        tint: muted,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (expanded)
            for (final run in runs)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: _RunCard(
                  key: ValueKey('agent-activity-run:${run.localId}'),
                  run: run,
                  pendingAction: pendingAction(run.localId),
                  actionError: actionError(run.localId),
                  onOpen: () => onOpenRun(run),
                  onCancel: onCancel == null
                      ? null
                      : () => onCancel!(run.localId),
                ),
              ),
        ],
      ),
    );
  }
}

/// One run: status, start time, name and job dots open the run screen;
/// Cancel sits beside them as its own target, so a tap on it (even while
/// disabled) never opens the run.
class _RunCard extends StatelessWidget {
  const _RunCard({
    super.key,
    required this.run,
    required this.pendingAction,
    required this.actionError,
    required this.onOpen,
    required this.onCancel,
  });

  final RemotePipelineRun run;
  final RemotePipelineRunAction? pendingAction;
  final String? actionError;
  final VoidCallback onOpen;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final started = DateTime.tryParse(run.startedAt ?? '');
    final startedText = started == null ? null : formatRelativeDate(started);
    final tiers = buildPipelineRunDotTiers(run.jobs ?? const []);
    final status = pipelineRunStatusLabel(run.status);
    final cancellable = run.isRoot && canCancelPipelineRun(run);
    final error = actionError;
    final body = Semantics(
      button: true,
      excludeSemantics: true,
      label: [
        run.pipelineName,
        status,
        if (startedText != null) 'started $startedText',
      ].join(', '),
      onTap: onOpen,
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    PipelineRunStatusChip(status: run.status),
                    if (startedText != null)
                      Text(
                        startedText,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: colors.foregroundSecondary,
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  run.pipelineName,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colors.foreground,
                  ),
                ),
                if (tiers.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  // Start-aligned like the desktop card; the track centers
                  // itself in a wider box.
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: PipelineRunDotTrack(
                      key: ValueKey('agent-activity-dots:${run.localId}'),
                      executionId: run.localId,
                      tiers: tiers,
                      muted: !isPipelineRunActive(run.status),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.lg),
        side: BorderSide(color: colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: body),
              if (cancellable)
                Padding(
                  padding: const EdgeInsets.only(top: 4, right: 4),
                  child: _CancelButton(
                    key: ValueKey('agent-activity-cancel:${run.localId}'),
                    pendingAction: pendingAction,
                    onCancel: onCancel,
                  ),
                ),
            ],
          ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: Text(
                error,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: StatusColors.of(context).failed,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Cancel, or a disabled "Cancelling…" until the desktop answers. Any other
/// control in flight for the run also disables it, as on the run screen.
class _CancelButton extends StatelessWidget {
  const _CancelButton({
    super.key,
    required this.pendingAction,
    required this.onCancel,
  });

  final RemotePipelineRunAction? pendingAction;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final destructive = StatusColors.of(context).destructive;
    final muted = AppColors.of(context).foregroundSecondary;
    final cancelling = pendingAction == RemotePipelineRunAction.cancel;
    return TextButton(
      onPressed: pendingAction == null ? onCancel : null,
      style: TextButton.styleFrom(
        foregroundColor: destructive,
        disabledForegroundColor: muted,
        minimumSize: const Size(44, 44),
        padding: const EdgeInsets.symmetric(horizontal: 10),
      ),
      child: Text(cancelling ? 'Cancelling…' : 'Cancel'),
    );
  }
}
