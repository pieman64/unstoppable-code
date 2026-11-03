/// The archive-command bookkeeping the Remote Control engine needs from the
/// attachment cache. Pure Dart, so the engine can depend on it without the
/// cache's file-system and preferences implementation.
library;

typedef PendingAttachmentArchive = ({
  String commandId,
  DateTime? createdAt,
  String workspaceId,
  String worktreeId,
});

/// Durable record of accepted archive commands whose attachment cleanup
/// waits on their terminal outcome.
abstract interface class AttachmentArchiveLedger {
  /// Persists an accepted archive command before it depends on a live
  /// session event.
  Future<void> trackArchiveCommand(
    String commandId,
    String workspaceId,
    String worktreeId, {
    DateTime? createdAt,
  });

  /// Archive commands whose terminal cleanup has not been reconciled.
  Future<List<PendingAttachmentArchive>> pendingArchiveCommands();

  /// Removes a terminal archive command, reclaiming its files only when the
  /// archive [succeeded].
  Future<void> finishArchiveCommand(
    String commandId, {
    required bool succeeded,
  });
}
