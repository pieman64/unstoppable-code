import 'package:flutter/material.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_indicator.dart';
import 'package:mobile/data/models/remote_pr_merge_queue.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/activity/pr_merge_queue_display.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/core/workspaces/workspace_navigation_row.dart';

/// Desktop's classic two-line sidebar row (`WorktreeRow.tsx`, see
/// docs/sidebar-worktree-status.md): one leading status glyph, the working
/// spinner and one attention dot after the title, then the worktree id with
/// the done label or PR badge, and diff counters.
class WorktreeRow extends StatelessWidget {
  const WorktreeRow({
    super.key,
    required this.worktree,
    this.onTap,
    this.needsAnswer = false,
    this.codeGraphBuilding = false,
    this.contextLabel,
  });

  final RemoteWorktree worktree;
  final bool needsAnswer;

  /// A code-graph build is in flight. Only hosts that observe build pushes
  /// can say so.
  final bool codeGraphBuilding;
  final VoidCallback? onTap;

  /// Starts the metadata line in place of the worktree id, for lists that
  /// span projects and name the workspace instead.
  final String? contextLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = StatusColors.of(context);
    final done = isWorktreeDone(worktree);
    final pr = _prBadge(worktree.prStatuses);
    final label = worktree.label?.trim();
    final title = label != null && label.isNotEmpty ? label : worktree.branch;
    final metadataStyle = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final leading = _leadingSignal(worktree, colors, needsAnswer: needsAnswer);
    final fallbacks = _fallbackSignals(
      worktree,
      colors,
      codeGraphBuilding: codeGraphBuilding,
    );
    // Promotion fallbacks claim the leading slot only when nothing above
    // them does; the promoted subject leaves the subtitle.
    final promoted = leading == null ? fallbacks.firstOrNull : null;
    final badges = promoted == null ? fallbacks : fallbacks.skip(1).toList();
    final doneGlyph = done && leading == null && promoted == null
        ? _doneSignal(worktree, colors)
        : null;
    final hasDiff =
        !done &&
        ((worktree.insertions ?? 0) > 0 || (worktree.deletions ?? 0) > 0);

    return WorkspaceNavigationRow(
      onTap: onTap,
      title: title,
      leading: (leading ?? promoted ?? doneGlyph)?.widget(size: 18),
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
                    if (badges.isNotEmpty) ...[
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
                              for (final signal in badges)
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
                            ..._statusSpans(
                              worktree,
                              pr,
                              done: done,
                              style: metadataStyle,
                              colors: colors,
                            ),
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

/// Desktop `isWorktreeDone`: the saved done status, or for rows without a
/// status, every known PR merged.
bool isWorktreeDone(RemoteWorktree worktree) {
  if (worktree.status == 'done') return true;
  if (worktree.status != null) return false;
  return worktree.prStatuses.isNotEmpty &&
      worktree.prStatuses.every((pr) => pr.state == 'merged');
}

bool _allMerged(List<RemoteWorktreePr> statuses) =>
    statuses.isNotEmpty && statuses.every((pr) => pr.state == 'merged');

List<InlineSpan> _statusSpans(
  RemoteWorktree worktree,
  _PrBadge? pr, {
  required bool done,
  required TextStyle? style,
  required StatusColors colors,
}) {
  // Desktop keeps the subtitle's weight and changes only the ink.
  TextStyle? ink(Color color) => style?.copyWith(color: color);
  const separator = TextSpan(text: ' · ');
  if (worktree.mergeProgressLabel case final progress?) {
    return [
      separator,
      TextSpan(text: progress, style: ink(colors.active)),
      WidgetSpan(
        alignment: PlaceholderAlignment.middle,
        child: Padding(
          padding: const EdgeInsets.only(left: 4),
          child: ThinkingSpinner(size: 12, color: colors.active),
        ),
      ),
    ];
  }
  if (done) {
    final merged = _allMerged(worktree.prStatuses);
    return [
      separator,
      TextSpan(
        text: merged ? 'PR merged' : 'Done',
        style: ink(merged ? colors.merged : colors.success),
      ),
    ];
  }
  if (pr == null) return const [];
  return [
    separator,
    TextSpan(text: pr.label, style: ink(pr.color(colors))),
    if (pr.mergeQueue case final queue?)
      WidgetSpan(
        alignment: PlaceholderAlignment.middle,
        child: _PrMergeQueue(queue: queue),
      )
    else if (pr.approval case final approval?)
      WidgetSpan(
        alignment: PlaceholderAlignment.middle,
        child: _PrApproval(approval: approval),
      ),
  ];
}

class _RowSignal {
  const _RowSignal(this.tooltip, {this.glyph, this.tint, this.child});
  final String tooltip;
  final CanopyGlyph? glyph;
  final Color? tint;
  final Widget? child;

  Widget widget({required double size}) => Tooltip(
    message: tooltip,
    child: child ?? CanopyIcon(glyph: glyph!, size: size, tint: tint),
  );
}

// Desktop leading chain above the promotion fallbacks: pipeline paused,
// unseen result or running, then a waiting question. A tool approval is
// dot-only by design.
_RowSignal? _leadingSignal(
  RemoteWorktree worktree,
  StatusColors colors, {
  required bool needsAnswer,
}) {
  if (worktree.pipelineStatus case final pipeline?) {
    return _RowSignal(
      _pipelineTooltip(pipeline),
      glyph: CanopyGlyph.agent,
      tint: _pipelineColor(pipeline, colors),
    );
  }
  if (needsAnswer) {
    return const _RowSignal(
      PendingQuestionIndicator.message,
      child: PendingQuestionIndicator(),
    );
  }
  return null;
}

// Desktop promotion fallbacks for subjects a snapshot carries, in priority
// order. Running scripts and hooks use the info ink, shared with unread.
List<_RowSignal> _fallbackSignals(
  RemoteWorktree worktree,
  StatusColors colors, {
  required bool codeGraphBuilding,
}) => [
  if (worktree.scriptStatus == 'running')
    _RowSignal(
      'Scripts running',
      glyph: CanopyGlyph.rocket,
      tint: colors.unread,
    ),
  if (worktree.hookStatus == 'running')
    _RowSignal(
      'Hook running',
      glyph: CanopyGlyph.webhooks,
      tint: colors.unread,
    ),
  if (worktree.terminalStatus case final terminal?)
    _RowSignal(
      switch (terminal) {
        'running' => 'Terminal running',
        'unseen-failure' => 'Terminal finished with errors',
        _ => 'Terminal finished',
      },
      glyph: CanopyGlyph.consoleSimple,
      tint: switch (terminal) {
        'running' => colors.neutral,
        'unseen-failure' => colors.failed,
        _ => colors.unread,
      },
    ),
  if (codeGraphBuilding)
    _RowSignal(
      'Building code graph',
      glyph: CanopyGlyph.agents,
      tint: colors.neutral,
    ),
];

// The quiet-state fallback: a green check, or the purple merge glyph when
// every known PR merged.
_RowSignal _doneSignal(RemoteWorktree worktree, StatusColors colors) =>
    _allMerged(worktree.prStatuses)
    ? _RowSignal('Merged', glyph: CanopyGlyph.mergedSimple, tint: colors.merged)
    : _RowSignal('Done', glyph: CanopyGlyph.circleCheck, tint: colors.success);

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
    final background = worktree.backgroundTasks ?? 0;
    final spinner = setup != null
        ? (setup, colors.accent)
        : worktree.isWorking
        ? ('Agent working', colors.accent)
        : background > 0
        ? (
            background == 1
                ? '1 background task running'
                : '$background background tasks running',
            colors.neutral,
          )
        : null;
    // One severity dot: question, tool approval, unseen pipeline failure,
    // unread, unseen pipeline result.
    final attention = switch (worktree.pipelineStatus) {
      _ when needsAnswer => (PendingQuestionIndicator.message, colors.warning),
      _ when worktree.awaitingApproval == true => (
        'Approval needed',
        colors.warning,
      ),
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
        if (spinner != null)
          SizedBox(
            width: 24,
            child: Center(
              child: Tooltip(
                key: const ValueKey('worktree-working'),
                message: spinner.$1,
                child: ThinkingSpinner(size: 14, color: spinner.$2),
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

/// Desktop's approval check after the PR label: neutral until mergeable,
/// then warning with unresolved comments, otherwise success.
class _PrApproval extends StatelessWidget {
  const _PrApproval({required this.approval});
  final ({bool mergeReady, bool unresolved}) approval;

  @override
  Widget build(BuildContext context) {
    final colors = StatusColors.of(context);
    final label = !approval.mergeReady
        ? 'Has PR approval but is not ready to merge'
        : approval.unresolved
        ? 'Approved and ready to merge, with unresolved comments'
        : 'Approved and ready to merge';
    return Padding(
      key: const ValueKey('worktree-pr-approved'),
      padding: const EdgeInsets.only(left: 4),
      child: Tooltip(
        message: label,
        excludeFromSemantics: true,
        child: Semantics(
          label: label,
          child: CanopyIcon(
            glyph: CanopyGlyph.circleCheck,
            size: 12,
            tint: !approval.mergeReady
                ? colors.neutral
                : approval.unresolved
                ? colors.warning
                : colors.success,
          ),
        ),
      ),
    );
  }
}

/// The merge queue glyph replaces the approval check of a queued PR. A
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
          child: CanopyIcon(
            glyph: CanopyGlyph.mergeQueue,
            size: 12,
            tint: StatusColors.of(context).warning,
          ),
        ),
      ),
    );
  }
}

/// Desktop `derivePrBadgeStatus` for rows that are not done: the open PR
/// (`PR #N`, or `N PRs` across repositories) tinted by its checks, else the
/// terminal PR in the secondary ink. A queued PR reads as pending.
class _PrBadge {
  const _PrBadge(this.label, this._kind, {this.mergeQueue, this.approval});

  final String label;
  final String _kind;
  final RemotePrMergeQueue? mergeQueue;
  final ({bool mergeReady, bool unresolved})? approval;

  Color color(StatusColors status) => switch (_kind) {
    'queued' => status.warning,
    'passing' => status.success,
    'failing' => status.destructive,
    _ => status.neutral,
  };
}

_PrBadge? _prBadge(List<RemoteWorktreePr> statuses) {
  if (statuses.isEmpty) return null;
  String number(RemoteWorktreePr pr) =>
      pr.prNumber == null ? 'Pull request' : 'PR #${pr.prNumber}';
  final open = statuses
      .where((pr) => pr.state == 'open' || pr.state == 'draft')
      .toList();
  if (open.isEmpty) {
    // `state` is an open wire set: only explicit terminal states get a badge.
    final terminal = statuses
        .where((pr) => pr.state == 'merged' || pr.state == 'closed')
        .toList();
    if (terminal.isEmpty) return null;
    return _PrBadge(
      statuses.length > 1
          ? '${terminal.length} ${terminal.length == 1 ? 'PR' : 'PRs'}'
          : number(terminal.first),
      'terminal',
    );
  }
  final first = open.first;
  // A draft keeps its marker: the secondary ink alone does not distinguish
  // it from an open PR without checks.
  final label = statuses.length > 1
      ? '${open.length} ${open.length == 1 ? 'PR' : 'PRs'}'
      : first.state == 'draft'
      ? '${number(first)} · draft'
      : number(first);
  final queue = worktreeRowMergeQueue(statuses);
  if (queue != null) {
    return _PrBadge(
      '$label · ${mergeQueueBadgeLabel(queue)}',
      'queued',
      mergeQueue: queue,
    );
  }
  final checks = open.map((pr) => pr.checkStatus).toSet();
  final approved = open.every((pr) => pr.reviewStatus == 'approved');
  return _PrBadge(
    label,
    checks.contains('failing')
        ? 'failing'
        : checks.contains('passing')
        ? 'passing'
        : 'none',
    approval: approved
        ? (
            // Desktop `isMergeReady`: open, approved, passing checks and no
            // conflicts (queued PRs are handled above).
            mergeReady: open.every(
              (pr) =>
                  pr.state == 'open' &&
                  pr.hasConflicts != true &&
                  pr.checkStatus == 'passing',
            ),
            unresolved: open.any(
              (pr) => (pr.unresolvedReviewThreadCount ?? 0) > 0,
            ),
          )
        : null,
  );
}

/// Desktop's condensed sidebar count: `1234` -> `1k`, `1234567` -> `1M`.
String condensedDiffCount(int value) => value >= 1000000
    ? '${value ~/ 1000000}M'
    : value >= 1000
    ? '${value ~/ 1000}k'
    : '$value';

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
              '+${condensedDiffCount(insertions)}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style.copyWith(color: colors.success),
            ),
          ),
        if (insertions > 0 && deletions > 0) const SizedBox(width: 4),
        if (deletions > 0)
          Flexible(
            child: Text(
              '-${condensedDiffCount(deletions)}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style.copyWith(color: colors.destructive),
            ),
          ),
      ],
    );
  }
}

String _pipelineTooltip(RemoteWorktreePipelineStatus status) =>
    switch (status) {
      RemoteWorktreePipelineStatus.running => 'Pipeline running',
      RemoteWorktreePipelineStatus.unseen => 'Pipeline finished',
      RemoteWorktreePipelineStatus.unseenFailure => 'Pipeline failed',
      RemoteWorktreePipelineStatus.paused => 'Pipeline paused',
    };

// Desktop pipeline glyph vocabulary: one glyph, tinted by state. Running is
// a static secondary glyph (only the agent gets a spinner, CAN-2808).
Color _pipelineColor(
  RemoteWorktreePipelineStatus status,
  StatusColors colors,
) => switch (status) {
  RemoteWorktreePipelineStatus.running => colors.neutral,
  RemoteWorktreePipelineStatus.unseen => colors.success,
  RemoteWorktreePipelineStatus.unseenFailure => colors.destructive,
  RemoteWorktreePipelineStatus.paused => colors.warning,
};
