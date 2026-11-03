/// One workspace context's slice of the paired desktop's inventory
/// (CAN-4429), the Dart mirror of the shared `snapshotWorkspaceMatchesContext`
/// rule and the shared sidebar's standalone-chat filter
/// (`packages/ui-app/src/code/shell/workspace-sections-model.ts`,
/// `SidebarSurface.tsx`).
///
/// The project list, attention queue, chat search and Recents all read
/// through this one scope, so they agree on what a context contains. The
/// engine keeps the raw snapshot; push resolution and hydration still read it.
library;

import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';

final class RemoteContextScope {
  /// Scopes [allWorkspaces] to [context]. A null context scopes nothing, for
  /// hosts that predate contexts. Catalog placeholders are never local rows.
  RemoteContextScope(this.context, List<RemoteWorkspace> allWorkspaces)
    : workspaces = List.unmodifiable([
        for (final workspace in allWorkspaces)
          if (!workspace.placeholder &&
              (context == null || workspace.ownerContext == context))
            workspace,
      ]);

  final WorkspaceContext? context;

  /// The context's workspaces, in the input order.
  final List<RemoteWorkspace> workspaces;

  late final Set<String> _workspaceIds = {
    for (final workspace in workspaces) workspace.localId,
  };

  /// Worktrees follow their workspace.
  bool includesWorktree(RemoteWorktree worktree) =>
      _workspaceIds.contains(worktree.workspaceLocalId);

  /// Standalone chats follow their project. A chat with no project belongs to
  /// Personal; one naming a project outside this scope, including one missing
  /// from the snapshot, is left out.
  bool includesStandaloneChat(RemoteStandaloneChat chat) {
    final context = this.context;
    if (context == null) return true;
    return chat.projectLocalId.isEmpty
        ? context.isPersonal
        : _workspaceIds.contains(chat.projectLocalId);
  }

  List<RemoteWorktree> worktrees(Iterable<RemoteWorktree> worktrees) =>
      List.unmodifiable(worktrees.where(includesWorktree));

  List<RemoteStandaloneChat> standaloneChats(
    Iterable<RemoteStandaloneChat> chats,
  ) => List.unmodifiable(chats.where(includesStandaloneChat));
}

/// The context that owns a chat in [workspaceLocalId], read from the raw
/// [workspaces]. An empty id is a projectless chat, which is Personal. Null
/// when the workspace is missing or its owner is unrecognized.
WorkspaceContext? remoteOwnerContext(
  List<RemoteWorkspace> workspaces,
  String workspaceLocalId,
) {
  if (workspaceLocalId.isEmpty) return const WorkspaceContext.personal();
  for (final workspace in workspaces) {
    if (workspace.localId == workspaceLocalId && !workspace.placeholder) {
      return workspace.ownerContext;
    }
  }
  return null;
}
