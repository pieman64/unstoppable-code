import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_mini_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/run_presentation.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_run_display.dart';
import 'background_tray_header.dart';
import 'pipeline_run_dot_track.dart';

/// What the host lets a run row do. Without it, rows are view-only.
final class BackgroundTrayRunControls {
  const BackgroundTrayRunControls({
    required this.canStop,
    required this.onAction,
    required this.onOpen,
    this.isPending,
  });

  final bool canStop;
  final void Function(BackgroundTrayRun run, BackgroundTrayRunAction action)
  onAction;
  final ValueChanged<BackgroundTrayRun> onOpen;

  /// A command already sent for the run disables its action until it settles.
  final bool Function(BackgroundTrayRun run)? isPending;
}

/// A run's row (desktop `RunRow`): glyph, name and job dots, its elapsed time
/// or state, and one action; the inspector lists the jobs, the pending
/// question, the running jobs and Open run.
class BackgroundTrayRunRow extends StatelessWidget {
  const BackgroundTrayRunRow({
    super.key,
    required this.run,
    required this.now,
    required this.open,
    required this.onToggle,
    this.controls,
  });

  final BackgroundTrayRun run;
  final int now;
  final bool open;
  final VoidCallback onToggle;
  final BackgroundTrayRunControls? controls;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final statusColors = StatusColors.of(context);
    final controls = this.controls;
    final action = controls == null
        ? null
        : backgroundTrayRunAction(run, canStop: controls.canStop);
    final pending = controls?.isPending?.call(run) ?? false;
    final tiers = buildPipelineRunDotTiers(run.pipelineRun?.jobs ?? const []);
    final attention = run.status == BackgroundTrayRunStatus.needsInput;
    final trailing = backgroundTrayRunTrailing(run, now);
    final status = backgroundTrayRunStatusLabel(run.status);
    final trailingColor = switch (run.status) {
      BackgroundTrayRunStatus.succeeded => statusColors.success,
      BackgroundTrayRunStatus.failed => statusColors.failed,
      _ => colors.foregroundMuted,
    };
    final kind = switch (run.kind) {
      BackgroundTrayRunKind.pipeline => BackgroundTrayKind.pipeline,
      BackgroundTrayRunKind.github => BackgroundTrayKind.github,
      BackgroundTrayRunKind.githubPr => BackgroundTrayKind.githubPr,
    };
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ColoredBox(
          key: ValueKey('background-tray-run-${run.id}'),
          color: attention ? colors['bg-attention-muted'] : colors['bg-depth'],
          child: Row(
            children: [
              Expanded(
                child: Semantics(
                  button: true,
                  expanded: open,
                  child: InkWell(
                    onTap: onToggle,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 44),
                      child: Padding(
                        padding: EdgeInsets.fromLTRB(
                          8,
                          8,
                          action == null ? 8 : 4,
                          8,
                        ),
                        child: Row(
                          children: [
                            CanopyIcon(
                              glyph: open
                                  ? CanopyGlyph.chevronDownSmall
                                  : CanopyGlyph.chevronRightSmall,
                              size: 14,
                              tint: colors.foregroundMuted,
                            ),
                            const SizedBox(width: 4),
                            CanopyIcon(
                              glyph: backgroundTrayGlyph(kind),
                              size: 14,
                              tint: colors.foregroundSecondary,
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    run.title,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: AppTypography.bodySmall.copyWith(
                                      color: colors.foregroundSecondary,
                                    ),
                                  ),
                                  if (tiers.isNotEmpty)
                                    Padding(
                                      padding: const EdgeInsets.only(top: 4),
                                      child: PipelineRunDotStrip(
                                        executionId: run.id,
                                        tiers: tiers,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            Semantics(
                              // Elapsed time alone does not say the run is
                              // still going.
                              label: trailing == status
                                  ? trailing
                                  : '$trailing, $status',
                              excludeSemantics: true,
                              child: Text(
                                trailing,
                                style: AppTypography.bodySmall.copyWith(
                                  fontFeatures: const [
                                    ...AppTypography.features,
                                    FontFeature.tabularFigures(),
                                  ],
                                  color: trailingColor,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (action != null && controls != null)
                Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: CanopyMiniButton(
                    key: ValueKey(
                      'background-tray-run-${run.id}-${action.name}',
                    ),
                    label: action.label,
                    semanticsLabel: action.semanticsLabel,
                    onPressed: pending
                        ? null
                        : () => controls.onAction(run, action),
                  ),
                ),
            ],
          ),
        ),
        if (open)
          Padding(
            key: ValueKey('background-tray-inspector-${run.id}'),
            padding: const EdgeInsets.fromLTRB(30, 0, 8, 12),
            child: _RunInspector(
              run: run,
              tiers: tiers,
              onOpen: controls?.onOpen,
            ),
          ),
      ],
    );
  }
}

class _RunInspector extends StatelessWidget {
  const _RunInspector({required this.run, required this.tiers, this.onOpen});

  final BackgroundTrayRun run;
  final List<List<PipelineRunDot>> tiers;
  final ValueChanged<BackgroundTrayRun>? onOpen;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final style = AppTypography.bodySmall.copyWith(
      color: colors.foregroundMuted,
    );
    final running = backgroundTrayRunRunningJobs(run);
    final question = run.status == BackgroundTrayRunStatus.needsInput
        ? run.question
        : null;
    final jobs = {
      for (final job in run.pipelineRun?.jobs ?? const <RemotePipelineRunJob>[])
        job.jobId: job,
    };
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: 8,
      children: [
        // One line per job in tier order: the row's strip already draws the
        // dots, so the inspector names them instead of repeating them.
        if (tiers.isNotEmpty)
          Column(
            key: ValueKey('background-tray-run-jobs-${run.id}'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: 6,
            children: [
              for (final tier in tiers)
                for (final dot in tier)
                  if (jobs[dot.jobId] case final job?) _JobLine(job: job),
            ],
          ),
        if (question != null)
          Text(
            question,
            key: const ValueKey('background-tray-run-question'),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: style.copyWith(color: StatusColors.of(context).warning),
          ),
        if (running != null)
          Text(
            '$running · running',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          ),
        if (onOpen case final open? when run.pipelineRun != null)
          CanopyMiniButton(label: 'Open run', onPressed: () => open(run)),
      ],
    );
  }
}

class _JobLine extends StatelessWidget {
  const _JobLine({required this.job});

  final RemotePipelineRunJob job;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final status = pipelineRunStatusLabel(job.status);
    return MergeSemantics(
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: pipelineRunStatusColor(
                job.status,
                StatusColors.of(context),
              ),
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              job.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.bodySmall.copyWith(
                color: colors.foregroundSecondary,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            status,
            style: AppTypography.bodySmall.copyWith(
              color: colors.foregroundMuted,
            ),
          ),
        ],
      ),
    );
  }
}
