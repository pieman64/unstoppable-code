import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/workspace_context.dart';
import '../chats/models.dart';
import 'models.dart';
import 'row_projection.dart';
import 'package:mobile/data/models/remote_overview_sections.dart';

/// Computer Connect's view of the phone's selected context. The raw inventory,
/// sessions and drafts remain computer-owned. This never changes host context.
final class DeviceContextScope {
  DeviceContextScope(
    WorkspaceContext context,
    List<DeviceProject> allProjects,
    List<DeviceWorktree> inventoryWorktrees,
  ) {
    // Reuse Remote Control's owner truth table, including legacy Personal and
    // unrecognized owners. Projectless chats are not in this workspace catalog.
    final scope = RemoteContextScope(context, [
      for (final project in allProjects) project.workspace,
    ]);
    final ids = scope.workspaces.map((workspace) => workspace.localId).toSet();
    projects = List.unmodifiable(allProjects.where((p) => ids.contains(p.id)));
    allWorktrees = List.unmodifiable(
      inventoryWorktrees.where((w) => ids.contains(w.projectId)),
    );
    worktrees = List.unmodifiable(allWorktrees.where((w) => !w.hidden));
    hasUnknownOwners = allProjects.any(
      (project) => project.ownerContext == null,
    );
  }

  late final List<DeviceProject> projects;
  late final List<DeviceWorktree> worktrees;

  /// Hidden worktrees can still need approval or have a pipeline to inspect.
  /// They stay out of the project browser, search and Recents.
  late final List<DeviceWorktree> allWorktrees;
  late final bool hasUnknownOwners;
  late final _coworkIds = {
    for (final project in projects)
      if (project.type == 'cowork') project.id,
  };
  late final _worktreeKeys = worktrees.map((w) => w.key).toSet();
  late final _allWorktreeKeys = allWorktrees.map((w) => w.key).toSet();

  late final AttentionSectionsData attention = _attention();

  AttentionSectionsData _attention() {
    final workspaces = projects.map((p) => p.workspace).toList();
    final indexed = indexWorktreesByWorkspace(
      workspaces: workspaces,
      worktrees: allWorktrees.map(deviceWorktreeRow).toList(),
    );
    return computeAttentionSections(
      workspaces: workspaces,
      worktreesFor: (id) => indexed[id] ?? const [],
    );
  }

  bool includesWorktree(DeviceWorktree worktree) =>
      _allWorktreeKeys.contains(worktree.key);

  /// Code chats require a visible worktree; Cowork chats inherit their project.
  /// Missing/hidden projects and worktrees cannot reappear through title search.
  bool includesChat(DeviceChatRef chat) =>
      _coworkIds.contains(chat.projectId) ||
      _worktreeKeys.contains('${chat.projectId}/${chat.worktreeId}');

  List<DeviceChatRef> chats(Iterable<DeviceChatRef> catalog) =>
      List.unmodifiable(catalog.where(includesChat));
}
