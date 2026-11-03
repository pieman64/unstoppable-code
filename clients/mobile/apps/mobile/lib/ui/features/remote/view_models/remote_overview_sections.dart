import 'dart:ui' show PlatformDispatcher;
import 'package:icu_kit/icu_kit.dart';
import 'package:mobile/data/models/remote_session.dart';

/// One attention row: a worktree needing the user's attention plus the
/// display name of its owning workspace (worktree ids are workspace-scoped
/// and meaningless to render alone).
class AttentionEntry {
  const AttentionEntry({required this.worktree, required this.workspaceName});

  final RemoteWorktree worktree;
  final String workspaceName;
}

/// The five attention sections computed from the synced overview shell — the
/// Dart mirror of the shared web/desktop selectors in
/// `packages/app-state/src/overview/create-overview-store.ts`.
class AttentionSectionsData {
  const AttentionSectionsData({
    required this.awaitingApproval,
    required this.unreadChats,
    required this.inProgress,
    required this.pipelinesRunning,
    required this.pipelinesFinished,
  });

  final List<AttentionEntry> awaitingApproval;
  final List<AttentionEntry> unreadChats;
  final List<AttentionEntry> inProgress;
  final List<AttentionEntry> pipelinesRunning;
  final List<AttentionEntry> pipelinesFinished;

  bool get isEmpty =>
      awaitingApproval.isEmpty &&
      unreadChats.isEmpty &&
      inProgress.isEmpty &&
      pipelinesRunning.isEmpty &&
      pipelinesFinished.isEmpty;

  /// The phone-sized queue, ordered by urgency and deduplicated by
  /// workspace-scoped worktree identity. A worktree can still carry several
  /// signals; its single row renders them together instead of repeating the
  /// task.
  ///
  /// Rows that genuinely need the user: an approval to give, an unread
  /// result to read, or a finished/paused pipeline to look at. Streaming
  /// agents and running pipelines are deliberately excluded — they need
  /// nothing from the user (CAN-2808) — and are no longer pinned in a group
  /// of their own either. [inProgress] and [pipelinesRunning] remain as the
  /// mirror of the shared web/desktop selectors.
  List<AttentionEntry> get attentionEntries {
    final seen = <String>{};
    return List.unmodifiable([
      for (final entry in [
        ...awaitingApproval,
        ...unreadChats,
        ...pipelinesFinished,
      ])
        if (seen.add(_entryKey(entry))) entry,
    ]);
  }

  static String _entryKey(AttentionEntry entry) =>
      '${entry.worktree.workspaceLocalId}:${entry.worktree.localId}';
}

/// Per-worktree pipeline badge values treated as recently finished. `paused`
/// is terminal in the shared Overview semantics, not "in progress".
const Set<RemoteWorktreePipelineStatus> _finishedPipelineStatuses = {
  RemoteWorktreePipelineStatus.unseen,
  RemoteWorktreePipelineStatus.unseenFailure,
  RemoteWorktreePipelineStatus.paused,
};

/// Sidebar-visible workspaces, mirroring the shared `partitionWorkspaces` /
/// `orderedWorkspaces` rule (`packages/ui-app/src/code/shell`): a workspace
/// is hidden when the user's explicit `hidden` toggle is set, or when it is
/// `alwaysShow: false` (temporary / adhoc-combine) and no longer holds any
/// visible worktree — an empty temporary workspace must not render as a
/// ghost header. Worktree presence counts only non-hidden worktrees, and
/// chats do not rescue an empty `alwaysShow: false` workspace.
List<RemoteWorkspace> visibleRemoteWorkspaces({
  required List<RemoteWorkspace> workspaces,
  required List<RemoteWorktree> Function(String workspaceLocalId) worktreesFor,
}) => List.unmodifiable([
  for (final workspace in workspaces)
    if (!workspace.hidden &&
        (workspace.alwaysShow ||
            worktreesFor(
              workspace.localId,
            ).any((worktree) => worktree.hidden != true)))
      workspace,
]);

/// Sidebar-visible worktrees (drops `hidden` rows), mirroring the shared
/// `partitionWorktrees`. The attention sections deliberately do NOT use this
/// — see [computeAttentionSections]'s hidden policy.
List<RemoteWorktree> visibleRemoteWorktrees(List<RemoteWorktree> worktrees) =>
    List.unmodifiable([
      for (final worktree in worktrees)
        if (worktree.hidden != true) worktree,
    ]);

String? _worktreeCollationLocale;
IcuCollator? _worktreeCollator;

int _compareWorktreeText(String left, String right, String locale) {
  if (_worktreeCollationLocale != locale || _worktreeCollator == null) {
    // Match localeCompare's default sort semantics: distinguish accents and
    // case, retain punctuation, and use the system locale's case ordering.
    // Reuse the native collator across comparisons, rebuilding on locale changes.
    _worktreeCollator = IcuCollator(
      locale: locale,
      strength: IcuCollatorStrength.tertiary,
      alternateHandling: IcuCollatorAlternateHandling.nonIgnorable,
      caseLevel: IcuCollatorCaseLevel.off,
    );
    _worktreeCollationLocale = locale;
  }
  return _worktreeCollator!.compare(left, right);
}

/// Sidebar order shared by the overview and worktree selectors: saved order
/// (missing means zero), locale-collated trimmed label or branch, then local identity.
/// Uses the system locale unless an explicit collation locale is supplied.
int compareRemoteWorktrees(
  RemoteWorktree left,
  RemoteWorktree right, {
  String? locale,
}) {
  final byOrder = (left.order ?? 0).compareTo(right.order ?? 0);
  if (byOrder != 0) return byOrder;
  String title(RemoteWorktree worktree) {
    final label = worktree.label?.trim();
    return label != null && label.isNotEmpty ? label : worktree.branch;
  }

  final collationLocale =
      locale ?? PlatformDispatcher.instance.locale.toLanguageTag();
  final byTitle = _compareWorktreeText(
    title(left),
    title(right),
    collationLocale,
  );
  return byTitle != 0
      ? byTitle
      : _compareWorktreeText(left.localId, right.localId, collationLocale);
}

/// Returns a sorted copy without mutating the transport snapshot.
List<RemoteWorktree> orderedRemoteWorktrees(
  Iterable<RemoteWorktree> worktrees,
) => List.unmodifiable(worktrees.toList()..sort(compareRemoteWorktrees));

/// Indexes the snapshot's worktrees in one pass so build-time consumers can
/// share the same workspace-scoped lists instead of repeatedly filtering the
/// full snapshot.
Map<String, List<RemoteWorktree>> indexWorktreesByWorkspace({
  required List<RemoteWorkspace> workspaces,
  required List<RemoteWorktree> worktrees,
}) {
  final indexed = <String, List<RemoteWorktree>>{
    for (final workspace in workspaces) workspace.localId: [],
  };
  for (final worktree in worktrees) {
    indexed[worktree.workspaceLocalId]?.add(worktree);
  }
  return {
    for (final entry in indexed.entries)
      entry.key: orderedRemoteWorktrees(entry.value),
  };
}

/// Computes attention sections in the caller's workspace and worktree order.
///
/// Hidden policy (intentional asymmetry copied from the shared store): only
/// the unread section excludes hidden worktrees — an unread badge is a
/// "needs you" signal the user muted by hiding. Every other section includes
/// hidden worktrees because a hidden worktree can still be actively working.
AttentionSectionsData computeAttentionSections({
  required List<RemoteWorkspace> workspaces,
  required List<RemoteWorktree> Function(String workspaceLocalId) worktreesFor,
}) {
  final entries = <AttentionEntry>[
    for (final workspace in workspaces)
      for (final worktree in worktreesFor(workspace.localId))
        AttentionEntry(worktree: worktree, workspaceName: workspace.name),
  ];

  List<AttentionEntry> filterEntries(bool Function(RemoteWorktree) test) => [
    for (final entry in entries)
      if (test(entry.worktree)) entry,
  ];

  return AttentionSectionsData(
    awaitingApproval: filterEntries((w) => w.awaitingApproval == true),
    unreadChats: filterEntries((w) => w.hasUnread == true && w.hidden != true),
    // The legacy `busy` flag is intentionally not consulted, matching the
    // shared selector (`isStreaming === true`).
    inProgress: filterEntries((w) => w.isStreaming == true),
    pipelinesRunning: filterEntries(
      (w) => w.pipelineStatus == RemoteWorktreePipelineStatus.running,
    ),
    pipelinesFinished: filterEntries(
      (w) => _finishedPipelineStatuses.contains(w.pipelineStatus),
    ),
  );
}
