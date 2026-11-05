import 'package:flutter/material.dart';
import 'pending_question_indicator.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/models/remote_pr_merge_queue.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/pr_merge_queue_display.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/core/workspaces/workspace_navigation_row.dart';

/// Desktop's two-line workspace row: title and progress above activity
/// metadata, the worktree identifier, PR state, and plain diff counters.
class WorktreeRow extends StatelessWidget {
  const WorktreeRow({
    super.key,
    required this.worktree,
    this.onTap,
    this.needsAnswer = false,
    this.contextLabel,
  });

  final RemoteWorktree worktree;
  final bool needsAnswer;
  final VoidCallback? onTap;

  /// Starts the metadata line in place of the worktree id, for lists that
  /// span projects and name the workspace instead.
  final String? contextLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = StatusColors.of(context);
    final pr = _prBadge(worktree.prStatuses);
    final label = worktree.label?.trim();
    final title = label != null && label.isNotEmpty ? label : worktree.branch;
    final metadataStyle = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final signals = _rowSignals(worktree, colors);
    final leading = signals.firstOrNull;
    // The first signal is promoted to the leading icon unless the pending
    // question takes that slot, in which case every signal stays in the row.
    final leadingSignals = needsAnswer ? 0 : 1;
    final hasDiff =
        (worktree.insertions ?? 0) > 0 || (worktree.deletions ?? 0) > 0;

    return WorkspaceNavigationRow(
      onTap: onTap,
      title: title,
      centerLeading: needsAnswer,
      leading: needsAnswer
          ? const PendingQuestionIndicator()
          : leading?.widget(size: 18),
      titleSignals: _TitleSignals(worktree: worktree, needsAnswer: needsAnswer),
      metadata: DefaultTextStyle(
        style: metadataStyle ?? const TextStyle(),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        child: LayoutBuilder(
          builder: (context, constraints) => Row(
            children: [
              Expanded(
                child: Row(
                  children: [
                    if (signals.length > leadingSignals) ...[
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth: constraints.maxWidth * 0.3,
                        ),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: Alignment.centerLeft,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              for (final signal in signals.skip(leadingSignals))
                                Padding(
                                  padding: const EdgeInsets.only(right: 4),
                                  child: signal.widget(size: 12),
                                ),
                            ],
                          ),
                        ),
                      ),
                    ],
                    Expanded(
                      child: Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(text: contextLabel ?? worktree.localId),
                            if (worktree.mergeProgressLabel != null ||
                                pr != null) ...[
                              const TextSpan(text: ' · '),
                              TextSpan(
                                text: worktree.mergeProgressLabel ?? pr!.label,
                                style: metadataStyle?.copyWith(
                                  color: worktree.mergingPr
                                      ? colors.active
                                      : pr!.color(colors),
                                  fontWeight: AppTypography.emphasisWeight,
                                  fontVariations:
                                      AppTypography.emphasisVariations,
                                ),
                              ),
                              if (!worktree.mergingPr)
                                if (pr?.checkStatus case final check?)
                                  WidgetSpan(
                                    alignment: PlaceholderAlignment.middle,
                                    child: _PrCheck(status: check),
                                  )
                                else if (pr?.mergeQueue case final queue?)
                                  WidgetSpan(
                                    alignment: PlaceholderAlignment.middle,
                                    child: _PrMergeQueue(queue: queue),
                                  ),
                            ],
                          ],
                        ),
                        key: const ValueKey('worktree-metadata'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ),
              if (hasDiff) ...[
                const SizedBox(width: 8),
                ConstrainedBox(
                  // Leave room for the identifier even with large diffs.
                  constraints: BoxConstraints(
                    maxWidth: constraints.maxWidth * 0.6,
                  ),
                  child: _DiffCounters(
                    insertions: worktree.insertions ?? 0,
                    deletions: worktree.deletions ?? 0,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _RowSignal {
  const _RowSignal(
    this.icon,
    this.color,
    this.tooltip, {
    this.inProgress = false,
  });
  final bool inProgress;
  final IconData icon;
  final Color color;
  final String tooltip;

  Widget widget({required double size}) => Tooltip(
    message: tooltip,
    child: inProgress
        ? ThinkingSpinner(size: size, color: color)
        : Icon(icon, size: size, color: color),
  );
}

// Follow the desktop priority for subjects available in the mobile snapshot.
// Promote only the winner; overlapping activities remain on the second line.
List<_RowSignal> _rowSignals(RemoteWorktree worktree, StatusColors colors) => [
  if (worktree.mergeProgressLabel case final label?)
    _RowSignal(Icons.merge, colors.active, label, inProgress: true),
  if (worktree.pipelineStatus case final pipeline?)
    _RowSignal(
      _pipelineIcon(pipeline),
      _pipelineColor(pipeline, colors),
      _pipelineTooltip(pipeline),
    ),
  if (worktree.awaitingApproval == true)
    _RowSignal(Icons.fact_check_outlined, colors.warning, 'Awaiting approval'),
  if (worktree.scriptStatus == 'running')
    _RowSignal(Icons.rocket_launch_outlined, colors.active, 'Scripts running'),
  if (worktree.hookStatus == 'running')
    _RowSignal(Icons.link, colors.active, 'Hook running'),
  if (worktree.terminalStatus case final terminal?)
    _RowSignal(
      Icons.terminal,
      switch (terminal) {
        'unseen-failure' => colors.failed,
        'running' => colors.active,
        _ => colors.unread,
      },
      switch (terminal) {
        'running' => 'Terminal running',
        'unseen-failure' => 'Terminal finished with errors',
        _ => 'Terminal finished',
      },
    ),
  if (!worktree.mergingPr &&
      worktree.prStatuses.any((pr) => pr.state == 'merged'))
    _RowSignal(Icons.check, colors.merged, 'Done'),
];

class _TitleSignals extends StatelessWidget {
  const _TitleSignals({required this.worktree, required this.needsAnswer});
  final RemoteWorktree worktree;
  final bool needsAnswer;

  @override
  Widget build(BuildContext context) {
    final colors = StatusColors.of(context);
    final setup = switch (worktree.setupPhase) {
      RemoteWorktreeSetupPhase.gitPending => 'Setting up worktree',
      RemoteWorktreeSetupPhase.runningSetup => 'Running setup',
      RemoteWorktreeSetupPhase.runningTeardown => 'Deleting worktree',
      _ => null,
    };
    final attention = switch (worktree.pipelineStatus) {
      _ when needsAnswer => (PendingQuestionIndicator.message, colors.warning),
      RemoteWorktreePipelineStatus.unseenFailure => (
        'Pipeline failed',
        colors.failed,
      ),
      _ when worktree.hasUnread == true && worktree.hidden != true => (
        'Unread',
        colors.unread,
      ),
      RemoteWorktreePipelineStatus.unseen => (
        'Pipeline finished',
        colors.unread,
      ),
      _ => null,
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (setup != null || worktree.isWorking)
          SizedBox(
            width: 24,
            child: Center(
              child: Tooltip(
                key: const ValueKey('worktree-working'),
                message: setup ?? 'Agent working',
                child: ThinkingSpinner(size: 14, color: colors.accent),
              ),
            ),
          ),
        if (setup == null && attention != null)
          SizedBox(
            width: 24,
            child: Center(
              child: Tooltip(
                key: const ValueKey('worktree-attention'),
                message: attention.$1,
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: attention.$2,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _PrCheck extends StatelessWidget {
  const _PrCheck({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final colors = StatusColors.of(context);
    final signal = switch (status) {
      'passing' => _RowSignal(Icons.check, colors.success, 'Checks passing'),
      'failing' => _RowSignal(Icons.close, colors.failed, 'Checks failing'),
      'pending' => _RowSignal(Icons.schedule, colors.warning, 'Checks pending'),
      _ => null,
    };
    return signal == null
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(left: 4),
            child: signal.widget(size: 12),
          );
  }
}

/// The merge queue glyph replaces the CI check glyph of a queued PR. A
/// tooltip is not a semantics label, so the glyph names its state itself.
class _PrMergeQueue extends StatelessWidget {
  const _PrMergeQueue({required this.queue});
  final RemotePrMergeQueue queue;

  @override
  Widget build(BuildContext context) {
    final label = mergeQueueSemanticsLabel(queue);
    return Padding(
      key: const ValueKey('worktree-pr-merge-queue'),
      padding: const EdgeInsets.only(left: 4),
      child: Tooltip(
        message: label,
        excludeFromSemantics: true,
        child: Semantics(
          label: label,
          // Desktop and web draw `GitMergeQueueIcon`; mobile keeps the merge
          // glyph here for now.
          child: CanopyIcon(
            glyph: CanopyGlyph.mergedSimple,
            size: 12,
            tint: StatusColors.of(context).warning,
          ),
        ),
      ),
    );
  }
}

/// Compact PR badge derivation: merged wins, then the first open/draft PR by
/// number, then closed. Colors follow the desktop PR-state vocabulary
/// (`PullRequestStateBadge`): open is green, merged is purple, closed is red,
/// draft stays neutral, and a PR in GitHub's merge queue is amber.
class _PrBadge {
  const _PrBadge(this.label, this._kind, {this.checkStatus, this.mergeQueue});

  final String label;
  final String _kind;
  final String? checkStatus;
  final RemotePrMergeQueue? mergeQueue;

  Color color(StatusColors status) => switch (_kind) {
    'merged' => status.merged,
    'open' => status.success,
    'queued' => status.warning,
    'closed' => status.destructive,
    _ => status.neutral,
  };
}

_PrBadge? _prBadge(List<RemoteWorktreePr> statuses) {
  if (statuses.isEmpty) return null;
  if (statuses.any((s) => s.state == 'merged')) {
    return const _PrBadge('PR merged', 'merged');
  }
  final queue = worktreeRowMergeQueue(statuses);
  for (final status in statuses) {
    if (status.state == 'open' || status.state == 'draft') {
      final number = status.prNumber;
      final draft = status.state == 'draft';
      // A numbered draft keeps its draft marker — color alone (neutral, the
      // same tone as the subtitle) does not distinguish it from open.
      final label = number == null
          ? (draft ? 'PR draft' : 'PR open')
          : (draft ? 'PR #$number · draft' : 'PR #$number');
      return queue == null
          ? _PrBadge(
              label,
              draft ? 'draft' : 'open',
              checkStatus: status.checkStatus,
            )
          : _PrBadge(
              '$label · ${mergeQueueBadgeLabel(queue)}',
              'queued',
              mergeQueue: queue,
            );
    }
  }
  // `state` is an open wire set: only an EXPLICIT closed state may render
  // the red closed badge — a fallthrough would paint any future state red.
  if (statuses.any((s) => s.state == 'closed')) {
    return const _PrBadge('PR closed', 'closed');
  }
  return null;
}

/// Plain counters inherit the subtitle's typography and have no pill surface.
class _DiffCounters extends StatelessWidget {
  const _DiffCounters({required this.insertions, required this.deletions});
  final int insertions;
  final int deletions;

  @override
  Widget build(BuildContext context) {
    final style = DefaultTextStyle.of(context).style;
    final colors = StatusColors.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        if (insertions > 0)
          Flexible(
            child: Text(
              '+$insertions',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style.copyWith(color: colors.success),
            ),
          ),
        if (insertions > 0 && deletions > 0) const SizedBox(width: 4),
        if (deletions > 0)
          Flexible(
            child: Text(
              '-$deletions',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style.copyWith(color: colors.failed),
            ),
          ),
      ],
    );
  }
}

IconData _pipelineIcon(RemoteWorktreePipelineStatus status) => switch (status) {
  RemoteWorktreePipelineStatus.running => Icons.sync,
  // `unseen` means the pipeline finished with an unseen result — use a
  // completed-check glyph, not a play glyph that reads as "not yet started".
  RemoteWorktreePipelineStatus.unseen => Icons.check_circle_outline,
  RemoteWorktreePipelineStatus.unseenFailure => Icons.error_outline,
  RemoteWorktreePipelineStatus.paused => Icons.pause_circle_outline,
};

// Desktop pipeline glyph vocabulary: running is a STATIC gray glyph (only
// the agent ever gets a spinner, so a row never shows two progress
// animations — CAN-2808), unseen success is green, unseen failure is red,
// paused is orange (needs input).
Color _pipelineColor(
  RemoteWorktreePipelineStatus status,
  StatusColors colors,
) => switch (status) {
  RemoteWorktreePipelineStatus.running => colors.neutral,
  RemoteWorktreePipelineStatus.unseen => colors.success,
  RemoteWorktreePipelineStatus.unseenFailure => colors.failed,
  RemoteWorktreePipelineStatus.paused => colors.warning,
};

String _pipelineTooltip(RemoteWorktreePipelineStatus status) =>
    switch (status) {
      RemoteWorktreePipelineStatus.running => 'Pipeline running',
      RemoteWorktreePipelineStatus.unseen => 'Pipeline finished',
      RemoteWorktreePipelineStatus.unseenFailure => 'Pipeline failed',
      RemoteWorktreePipelineStatus.paused => 'Pipeline paused',
    };
