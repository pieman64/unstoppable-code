import 'package:mobile/data/models/remote_session.dart';

/// Records a chat screen's picker copies for the worktree they were picked
/// in, so archiving that worktree reclaims them. A new task's copies read
/// before its worktree exists wait until [bind] names it.
final class PickerCopyRecorder {
  PickerCopyRecorder({required this.record});

  /// Records copies for a worktree, as `AttachmentCache.record` does.
  final Future<void> Function(
    String workspaceId,
    String worktreeId,
    Iterable<String> paths,
  )
  record;

  RemoteWorktree? _worktree;
  final List<String> _held = [];

  /// Receives the picker's copies once it has read them.
  Future<void> filesRead(Iterable<String> paths) async {
    final worktree = _worktree;
    if (worktree == null) {
      _held.addAll(paths);
      return;
    }
    await record(worktree.workspaceLocalId, worktree.localId, paths);
  }

  /// Binds the worktree the copies belong to and records those read
  /// before it existed.
  Future<void> bind(RemoteWorktree worktree) async {
    _worktree = worktree;
    if (_held.isEmpty) return;
    final held = List.of(_held);
    _held.clear();
    await record(worktree.workspaceLocalId, worktree.localId, held);
  }
}
