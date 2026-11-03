import 'package:mobile/data/models/remote_watcher.dart';

import 'remote_identity.dart';

typedef WatcherSlicePatch =
    Map<String, dynamic> Function(Map<String, dynamic> slices);

/// Watcher projections and reads belong to the full workspace/worktree key.
/// A read replays the patches it raced, independently of other workspaces
/// that happen to reuse the same worktree id.
final class WatcherSliceStore {
  final _slices = <RemoteWorktreeKey, Map<String, dynamic>>{};
  final _reads =
      <RemoteWorktreeKey, ({Object token, List<WatcherSlicePatch> patches})>{};

  Set<RemoteWorktreeKey> get worktrees => {..._slices.keys, ..._reads.keys};

  List<RemoteWatcher> watchersFor(RemoteWorktreeKey worktree) => [
    if (_slices[worktree]?['watchers'] case final List<Object?> rows)
      for (final row in rows) ?RemoteWatcher.fromJson(row),
  ];

  Object beginRead(RemoteWorktreeKey worktree) {
    final token = Object();
    _reads[worktree] = (token: token, patches: []);
    return token;
  }

  /// Only the newest read of this exact worktree can replace its projection.
  bool settleRead(
    RemoteWorktreeKey worktree,
    Object token,
    Map<String, dynamic> slices,
  ) {
    final read = _reads[worktree];
    if (read == null || !identical(read.token, token)) return false;
    var next = <String, dynamic>{
      'watchers': [
        if (slices['watchers'] case final List<Object?> rows)
          for (final row in rows)
            if (RemoteWatcher.fromJson(row) case final watcher?)
              if (watcher.projectId == worktree.workspaceLocalId &&
                  watcher.worktreeId == worktree.worktreeLocalId)
                watcher.toJson(),
      ],
    };
    for (final patch in read.patches) {
      next = patch(next);
    }
    _slices[worktree] = {'watchers': next['watchers']};
    _reads.remove(worktree);
    return true;
  }

  /// A refreshing or failed read keeps the previously held projection.
  void finishRead(RemoteWorktreeKey worktree, Object token) {
    if (identical(_reads[worktree]?.token, token)) _reads.remove(worktree);
  }

  /// Composes with HydrationCoordinator.applySlicePatch. Other activity
  /// patches do not replace watcher state or report a watcher change.
  bool applySlicePatch(RemoteWorktreeKey worktree, WatcherSlicePatch patch) {
    _reads[worktree]?.patches.add(patch);
    final held = _slices[worktree];
    if (held == null) return false;
    final next = patch(held);
    if (identical(next['watchers'], held['watchers'])) return false;
    _slices[worktree] = {'watchers': next['watchers']};
    return true;
  }

  void reset() {
    _slices.clear();
    _reads.clear();
  }
}
