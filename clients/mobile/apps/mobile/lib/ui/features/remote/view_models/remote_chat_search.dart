/// Pure model behind the Remote Control chat search (CAN-1990 parity with
/// the web sidebar search, `packages/ui-app/.../sidebar-chat-search-model.ts`).
///
/// The workspaces list shows workspaces → worktrees and cowork chats;
/// individual worktree chat tabs are not list rows, so search flattens the
/// full chat inventory — worktree chat summaries plus standalone/cowork
/// chats — into candidates that retain their owning-workspace context.
/// Matching is deliberately title-only: search targets chat discovery, not
/// transcript content.
library;

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';

/// One chat the search can surface.
sealed class RemoteChatSearchResult {
  const RemoteChatSearchResult({
    required this.chatId,
    required this.title,
    required this.workspaceName,
  });

  final String chatId;
  final String title;

  /// Display label of the owning workspace (or the default chats bucket).
  final String workspaceName;
}

/// A chat tab belonging to a worktree in a tree-layout workspace.
final class RemoteWorktreeChatSearchResult extends RemoteChatSearchResult {
  const RemoteWorktreeChatSearchResult({
    required super.chatId,
    required super.title,
    required super.workspaceName,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.worktreeName,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;

  /// Worktree row label (`label`, falling back to the branch).
  final String worktreeName;
}

/// A standalone (cowork) chat.
final class RemoteStandaloneChatSearchResult extends RemoteChatSearchResult {
  const RemoteStandaloneChatSearchResult({
    required super.chatId,
    required super.title,
    required super.workspaceName,
    this.workspaceLocalId,
  });

  /// Absent for the legacy default bucket (no flat workspace projected).
  final String? workspaceLocalId;
}

/// Desktop chat-tab ordering: explicit `order` first (tabs carrying an order
/// sort before ones without), then `createdAt`, then `chatId` — mirroring the
/// web shell's `selectWorktreeChatSummaries` comparator.
int _compareWorktreeChats(RemoteChatSummary a, RemoteChatSummary b) {
  final aOrder = a.order;
  final bOrder = b.order;
  if (aOrder != null && bOrder != null && aOrder != bOrder) {
    return aOrder - bOrder;
  }
  if ((aOrder != null) != (bOrder != null)) {
    return aOrder != null ? -1 : 1;
  }
  final byCreated = (a.createdAt ?? '').compareTo(b.createdAt ?? '');
  return byCreated != 0 ? byCreated : a.chatId.compareTo(b.chatId);
}

/// Flattens the sidebar inventory into search candidates in sidebar order:
/// workspaces in snapshot order, worktrees in snapshot order within each
/// workspace, chats in tab-bar order within each worktree. Every workspace
/// then contributes its non-archived standalone chats, as the projects list
/// does; unparented chats fall to the first flat workspace. When no flat
/// workspace exists, the legacy default bucket takes every other active
/// standalone chat.
List<RemoteChatSearchResult> buildRemoteChatSearchCandidates({
  required List<RemoteWorkspace> workspaces,
  required List<RemoteWorktree> worktrees,
  required List<RemoteStandaloneChat> standaloneChats,
  required List<RemoteChatSummary> chatSummaries,
}) {
  final activeStandaloneChats = [
    for (final chat in standaloneChats)
      if (chat.archived != true) chat,
  ];
  String? primaryFlatWorkspaceId;
  for (final workspace in workspaces) {
    if (workspace.resolvedLayout == RemoteWorkspaceLayout.flat) {
      primaryFlatWorkspaceId = workspace.localId;
      break;
    }
  }

  final chatsByWorktree = <String, List<RemoteChatSummary>>{};
  for (final summary in chatSummaries) {
    if (summary.scope != RemoteChatScope.worktree) continue;
    final worktreeLocalId = summary.worktreeLocalId;
    if (worktreeLocalId == null || worktreeLocalId.isEmpty) continue;
    chatsByWorktree.putIfAbsent(worktreeLocalId, () => []).add(summary);
  }

  final results = <RemoteChatSearchResult>[];
  for (final workspace in workspaces) {
    // Flat workspaces list chats, not worktrees.
    final isFlat = workspace.resolvedLayout == RemoteWorkspaceLayout.flat;
    for (final worktree in isFlat ? const <RemoteWorktree>[] : worktrees) {
      if (worktree.workspaceLocalId != workspace.localId) continue;
      final chats = [...?chatsByWorktree[worktree.localId]]
        ..sort(_compareWorktreeChats);
      for (final chat in chats) {
        // A summary that names its workspace must match; the common absent
        // case inherits the owning worktree's workspace.
        final summaryWorkspace = chat.workspaceLocalId;
        if (summaryWorkspace != null &&
            summaryWorkspace.isNotEmpty &&
            summaryWorkspace != workspace.localId) {
          continue;
        }
        results.add(
          RemoteWorktreeChatSearchResult(
            chatId: chat.chatId,
            title: chat.title,
            workspaceName: workspace.name,
            workspaceLocalId: workspace.localId,
            worktreeLocalId: worktree.localId,
            worktreeName: worktree.label ?? worktree.branch,
          ),
        );
      }
    }
    for (final chat in activeStandaloneChats) {
      final owned =
          chat.projectLocalId == workspace.localId ||
          (chat.projectLocalId.isEmpty &&
              workspace.localId == primaryFlatWorkspaceId);
      if (!owned) continue;
      results.add(
        RemoteStandaloneChatSearchResult(
          chatId: chat.localId,
          title: chat.title,
          workspaceName: workspace.name,
          workspaceLocalId: workspace.localId,
        ),
      );
    }
  }

  if (primaryFlatWorkspaceId == null) {
    // Without a flat workspace, the default bucket shows every active
    // standalone chat that no workspace above took — including project-bound
    // ones whose workspace is absent from the snapshot — so search must too.
    final workspaceIds = {
      for (final workspace in workspaces) workspace.localId,
    };
    for (final chat in activeStandaloneChats) {
      if (workspaceIds.contains(chat.projectLocalId)) continue;
      results.add(
        RemoteStandaloneChatSearchResult(
          chatId: chat.localId,
          title: chat.title,
          workspaceName: 'Chats',
        ),
      );
    }
  }

  return results;
}

/// Case-insensitive title filter. A blank (or whitespace-only) query returns
/// no results — hosts treat that as "search inactive".
List<RemoteChatSearchResult> filterRemoteChatSearchResults(
  List<RemoteChatSearchResult> candidates,
  String query,
) {
  final normalized = query.trim().toLowerCase();
  if (normalized.isEmpty) return const [];
  return [
    for (final candidate in candidates)
      if (candidate.title.toLowerCase().contains(normalized)) candidate,
  ];
}
