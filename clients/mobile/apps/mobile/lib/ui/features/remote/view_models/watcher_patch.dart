import 'package:mobile/data/models/remote_shell_delta.dart';
import 'package:mobile/data/models/remote_watcher.dart';

import 'remote_identity.dart';

/// Applies removals before upserts, matching the Portal cache. The caller
/// supplies the workspace that owns these held slices.
Map<String, dynamic> withWatcherDelta(
  Map<String, dynamic> slices,
  RemoteWorktreeKey worktree,
  RemoteShellDelta delta,
) {
  final held = [
    if (slices['watchers'] case final List<Object?> rows)
      for (final row in rows) ?RemoteWatcher.fromJson(row),
  ];
  bool removed(RemoteWatcher row) => delta.watcherRemovals.any(
    (removal) =>
        row.id == removal.localId &&
        (removal.parentLocalId == null ||
            removal.parentLocalId == row.worktreeId ||
            removal.parentLocalId == '${row.projectId}:${row.worktreeId}'),
  );
  final upserts = [
    for (final row in delta.watchers)
      if (row.projectId == worktree.workspaceLocalId &&
          row.worktreeId == worktree.worktreeLocalId)
        row,
  ];
  if (!held.any(removed) && upserts.isEmpty) return slices;
  final next = {
    for (final row in held)
      if (!removed(row)) (row.projectId, row.worktreeId, row.id): row,
    for (final row in upserts) (row.projectId, row.worktreeId, row.id): row,
  }.values.toList()..sort((a, b) => a.id.compareTo(b.id));
  return {
    ...slices,
    'watchers': [for (final row in next) row.toJson()],
  };
}

/// Parentless and legacy removals also visit known worktrees. Canonical
/// parents can identify a worktree even while its first read is in flight.
Set<RemoteWorktreeKey> watcherWorktrees(
  RemoteShellDelta delta,
  Iterable<RemoteWorktreeKey> knownWorktrees,
) => {
  for (final row in delta.watchers)
    remoteWorktreeKey(row.projectId, row.worktreeId),
  for (final removal in delta.watcherRemovals)
    if (removal.parentLocalId case final parent?)
      if (remoteWorktreeKeyFromEvent(parent) case final worktree?)
        worktree
      else
        ...knownWorktrees.where((key) => key.worktreeLocalId == parent)
    else
      ...knownWorktrees,
};

/// Desktop watcher lists keep creation order. Use the projection index for
/// ties so equal or absent dates do not reshuffle after hydration.
List<RemoteWatcher> watchersForChat(
  List<RemoteWatcher> rows, {
  required String projectId,
  required String worktreeId,
  required String chatId,
}) {
  final selected =
      [
        for (final entry in rows.indexed)
          if (entry.$2.projectId == projectId &&
              entry.$2.worktreeId == worktreeId &&
              entry.$2.chatId == chatId &&
              entry.$2.isVisible)
            entry,
      ]..sort((a, b) {
        final order = (a.$2.createdAt ?? '').compareTo(b.$2.createdAt ?? '');
        return order == 0 ? a.$1.compareTo(b.$1) : order;
      });
  return [for (final entry in selected) entry.$2];
}
