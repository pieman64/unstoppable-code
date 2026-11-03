import 'dart:async';

import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'remote_identity.dart';

typedef BackgroundProcessSlicePatch =
    Map<String, dynamic> Function(Map<String, dynamic> slices);

/// Hydrates processes without settling Files or replacing pipeline history.
/// Live patches are replayed over reads that began before their delivery.
final class BackgroundProcessHydration {
  BackgroundProcessHydration({required this.repository, required this.notify});

  final RemoteControlRepository repository;
  final void Function() notify;
  final _slices = <RemoteWorktreeKey, Map<String, dynamic>>{};
  final _reads =
      <
        RemoteWorktreeKey,
        ({Object token, List<BackgroundProcessSlicePatch> patches})
      >{};

  List<RemoteBackgroundProcess>? processesFor(RemoteWorktreeKey worktree) {
    final slices = _slices[worktree];
    if (slices == null) return null;
    return RemoteWorktreeActivity.fromState(
      worktreeLocalId: worktree.worktreeLocalId,
      state: slices,
    ).backgroundProcesses;
  }

  void ensure(RemoteWorktreeKey worktree) {
    if (_slices.containsKey(worktree) || _reads.containsKey(worktree)) return;
    final token = beginRead(worktree);
    unawaited(() async {
      try {
        final result = await repository.fetchWorktreeStateSlices(
          workspaceLocalId: worktree.workspaceLocalId,
          worktreeLocalId: worktree.worktreeLocalId,
        );
        if (!result.refreshing && settleRead(worktree, token, result.slices)) {
          notify();
        }
      } on Object {
        // A failed read leaves the current projection available.
      } finally {
        finishRead(worktree, token);
      }
    }());
  }

  Object beginRead(RemoteWorktreeKey worktree) {
    final token = Object();
    _reads[worktree] = (token: token, patches: []);
    return token;
  }

  bool settleRead(
    RemoteWorktreeKey worktree,
    Object token,
    Map<String, dynamic> slices,
  ) {
    final read = _reads[worktree];
    if (read == null || !identical(read.token, token)) return false;
    if (!slices.containsKey('backgroundProcesses')) return false;
    var next = <String, dynamic>{
      'backgroundProcesses': slices['backgroundProcesses'] ?? const [],
    };
    for (final patch in read.patches) {
      next = patch(next);
    }
    _slices[worktree] = {'backgroundProcesses': next['backgroundProcesses']};
    _reads.remove(worktree);
    return true;
  }

  void finishRead(RemoteWorktreeKey worktree, Object token) {
    if (identical(_reads[worktree]?.token, token)) _reads.remove(worktree);
  }

  bool applySlicePatch(
    RemoteWorktreeKey worktree,
    BackgroundProcessSlicePatch patch,
  ) {
    _reads[worktree]?.patches.add(patch);
    final held = _slices[worktree];
    if (held == null) return false;
    final next = patch(held);
    if (identical(next['backgroundProcesses'], held['backgroundProcesses'])) {
      return false;
    }
    _slices[worktree] = {'backgroundProcesses': next['backgroundProcesses']};
    return true;
  }

  void reset() {
    _slices.clear();
    _reads.clear();
  }
}
