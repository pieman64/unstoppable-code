import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/app_icons.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// Accent color for a pipeline-run status, following the desktop operational
/// vocabulary: success is always green, failure is always red; non-terminal
/// or unknown states the server can emit (e.g. `pending`, `neutral`) use a
/// muted color rather than error red.
Color pipelineRunStatusColor(String status, StatusColors colors) =>
    switch (status) {
      'success' => colors.success,
      'failure' => colors.failed,
      _ => colors.neutral,
    };

/// Renders a single [FeedItem] as a rich card.
///
/// The [switch] expression is exhaustive over all 11 sealed subtypes;
/// the compiler will error if a new variant is added to [FeedItem] without
/// updating this widget.
class FeedCard extends StatelessWidget {
  const FeedCard({super.key, required this.item});

  final FeedItem item;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final statusColors = StatusColors.of(context);

    final (
      IconData icon,
      Color iconColor,
      String title,
      List<Widget> chips,
    ) = switch (item) {
      AgentSessionFeedItem i => _agentSession(i, statusColors),
      PrMergedFeedItem i => _prMerged(i, statusColors),
      PrOpenedFeedItem i => _prOpened(i, statusColors),
      PipelineRunFeedItem i => _pipelineRun(i, statusColors),
      PlanApprovedFeedItem i => _planApproved(i, statusColors),
      PlanSharedFeedItem i => _planShared(i, statusColors),
      PlanUpdatedFeedItem i => _planUpdated(i, statusColors),
      WorktreeStartedFeedItem i => _worktreeStarted(i, statusColors),
      WorktreeUpdatedFeedItem i => _worktreeUpdated(i, statusColors),
      RunFailedFeedItem i => _runFailed(i, statusColors),
      RunSharedFeedItem i => _runShared(i, statusColors),
    };

    final actorName = item.actor.displayName ?? 'Unknown';
    final relativeTime = formatRelativeTime(item.occurredAt);

    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Header row: icon · actor · time ────────────────────────────
            Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: iconColor.withAlpha(30),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(icon, size: 18, color: iconColor),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    actorName,
                    style: textTheme.labelMedium?.copyWith(
                      fontWeight: AppTypography.emphasisWeight,
                      fontVariations: AppTypography.emphasisVariations,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                Text(
                  relativeTime,
                  style: textTheme.labelSmall?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            // ── Title ──────────────────────────────────────────────────────
            Text(
              title,
              style: textTheme.bodyMedium?.copyWith(
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            // ── Metadata chips ─────────────────────────────────────────────
            if (chips.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 6, runSpacing: 4, children: chips),
            ],
          ],
        ),
      ),
    );
  }

  // ── Variant helpers ─────────────────────────────────────────────────────────

  static (IconData, Color, String, List<Widget>) _agentSession(
    AgentSessionFeedItem item,
    StatusColors colors,
  ) {
    final chips = <Widget>[
      _chip('${item.turnCount} turns'),
      if (item.totalCostUsd != null)
        _chip('\$${item.totalCostUsd!.toStringAsFixed(3)}'),
      if (item.latestModel != null) _chip(item.latestModel!),
    ];
    return (
      Icons.smart_toy_outlined,
      colors.accent,
      'Agent session · ${item.latestStatus}',
      chips,
    );
  }

  static (IconData, Color, String, List<Widget>) _prMerged(
    PrMergedFeedItem item,
    StatusColors colors,
  ) {
    final chips = <Widget>[
      _chip('${item.repoName} #${item.prNumber.toInt()}'),
      if (item.additions != null && item.deletions != null)
        _chip('+${item.additions!.toInt()} / -${item.deletions!.toInt()}'),
    ];
    // Merged is always purple in the shared status vocabulary.
    return (Icons.merge_type, colors.merged, item.title, chips);
  }

  static (IconData, Color, String, List<Widget>) _prOpened(
    PrOpenedFeedItem item,
    StatusColors colors,
  ) {
    final chips = <Widget>[
      _chip('${item.repoName} #${item.prNumber.toInt()}'),
      _chip(item.checkStatus),
      if (item.hasConflicts) _chip('conflicts'),
    ];
    // Open PRs read green, matching the desktop PR-state badge.
    return (Icons.call_split, colors.success, item.title, chips);
  }

  static (IconData, Color, String, List<Widget>) _pipelineRun(
    PipelineRunFeedItem item,
    StatusColors colors,
  ) {
    final durationLabel = item.runDurationMs != null
        ? formatDuration(item.runDurationMs!)
        : null;
    final chips = <Widget>[
      if (item.stepCount != null) _chip('${item.stepCount!.toInt()} steps'),
      if (durationLabel != null) _chip(durationLabel),
      _chip(item.status),
    ];
    return (
      Icons.account_tree_outlined,
      pipelineRunStatusColor(item.status, colors),
      item.pipelineName,
      chips,
    );
  }

  static (IconData, Color, String, List<Widget>) _planApproved(
    PlanApprovedFeedItem item,
    StatusColors colors,
  ) {
    final chips = <Widget>[
      if (item.planVersion != null) _chip('v${item.planVersion!.toInt()}'),
      if (item.reviewStatus != null) _chip(item.reviewStatus!),
    ];
    return (Icons.description_outlined, colors.success, item.title, chips);
  }

  static (IconData, Color, String, List<Widget>) _planShared(
    PlanSharedFeedItem item,
    StatusColors colors,
  ) {
    return (
      AppIcons.share,
      colors.special,
      item.title,
      [_chip(item.shareScope)],
    );
  }

  static (IconData, Color, String, List<Widget>) _planUpdated(
    PlanUpdatedFeedItem item,
    StatusColors colors,
  ) {
    final chips = <Widget>[
      if (item.remoteRevisionNumber != null)
        _chip('rev ${item.remoteRevisionNumber!.toInt()}'),
      _chip(item.shareScope),
    ];
    return (Icons.edit_note, colors.neutral, item.title, chips);
  }

  static (IconData, Color, String, List<Widget>) _worktreeStarted(
    WorktreeStartedFeedItem item,
    StatusColors colors,
  ) {
    final chips = <Widget>[
      _chip(item.branchName),
      if (item.workspaceName != null) _chip(item.workspaceName!),
    ];
    return (Icons.commit, colors.accent, 'Worktree started', chips);
  }

  static (IconData, Color, String, List<Widget>) _worktreeUpdated(
    WorktreeUpdatedFeedItem item,
    StatusColors colors,
  ) {
    return (
      Icons.commit,
      colors.neutral,
      'Worktree updated · ${item.branchName}',
      [],
    );
  }

  static (IconData, Color, String, List<Widget>) _runFailed(
    RunFailedFeedItem item,
    StatusColors colors,
  ) {
    final chips = <Widget>[
      _chip(item.status),
      if (item.model != null) _chip(item.model!),
    ];
    return (Icons.error_outline, colors.failed, item.label, chips);
  }

  static (IconData, Color, String, List<Widget>) _runShared(
    RunSharedFeedItem item,
    StatusColors colors,
  ) {
    final chips = <Widget>[
      _chip('${item.turnCount} turns'),
      _chip('${item.toolUseCount} tools'),
      if (item.totalCostUsd != null)
        _chip('\$${item.totalCostUsd!.toStringAsFixed(3)}'),
      if (item.model != null) _chip(item.model!),
      _chip(item.status),
    ];
    return (AppIcons.share, colors.accent, item.title, chips);
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  static Widget _chip(String label) => Chip(
    // A long value (branch/workspace/repo name) ellipsizes instead of
    // wrapping to multiple lines and inflating the chip.
    label: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
    labelStyle: AppTypography.compactLabel,
  );
}
