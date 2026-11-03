/// Builds [RemoteClientEngine]s for engine-level suites. Pure Dart: the
/// ports the Flutter facade backs with platform caches are in-memory here.
library;

import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/services/attachment_archive_ledger.dart';
import 'package:mobile/ui/features/remote/view_models/chat_send_coordinator.dart';
import 'package:mobile/ui/features/remote/view_models/hydration_coordinator.dart';
import 'package:mobile/ui/features/remote/view_models/overview_refresh_scheduler.dart';
import 'package:mobile/ui/features/remote/view_models/remote_client_engine.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_archive_coordinator.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_create_coordinator.dart';

/// An archive ledger that records nothing across a process restart.
final class MemoryArchiveLedger implements AttachmentArchiveLedger {
  final pending = <PendingAttachmentArchive>[];

  @override
  Future<void> trackArchiveCommand(
    String commandId,
    String workspaceId,
    String worktreeId, {
    DateTime? createdAt,
  }) async {
    pending
      ..removeWhere((archive) => archive.commandId == commandId)
      ..add((
        commandId: commandId,
        createdAt: createdAt,
        workspaceId: workspaceId,
        worktreeId: worktreeId,
      ));
  }

  @override
  Future<List<PendingAttachmentArchive>> pendingArchiveCommands() async =>
      List.of(pending);

  @override
  Future<void> finishArchiveCommand(
    String commandId, {
    required bool succeeded,
  }) async => pending.removeWhere((archive) => archive.commandId == commandId);
}

/// An engine over [repository] with transport-ordered worktrees and
/// in-memory session caches. [onChanged] observes every visible change.
RemoteClientEngine buildRemoteEngine({
  required RemoteControlRepository repository,
  void Function()? onChanged,
  void Function(String? sessionId)? restoreSessionCaches,
  Duration stateRefreshDebounce = kRemoteStateRefreshDebounce,
  Duration hydrationRetryWindow = kRemoteHydrationRetryWindow,
  Duration hydrationTimeout = kRemoteHydrationTimeout,
  Duration worktreeCreateRecoveryInterval =
      kRemoteWorktreeCreateRecoveryInterval,
  Duration worktreeCreateTimeout = kRemoteWorktreeCreateTimeout,
  Duration archiveRestoreTimeout = kRemoteArchiveRestoreTimeout,
  DateTime Function()? clock,
  RemoteChatIdFactory? chatId,
  UnsentRecordPort? unsentStore,
  RemoteTranscriptCache? transcriptCache,
}) => RemoteClientEngine(
  repository: repository,
  onChanged: onChanged ?? () {},
  orderWorktrees: List.unmodifiable,
  archiveLedger: MemoryArchiveLedger(),
  restoreSessionCaches: restoreSessionCaches ?? (_) {},
  clearSessionCaches: () {},
  stateRefreshDebounce: stateRefreshDebounce,
  hydrationRetryWindow: hydrationRetryWindow,
  hydrationTimeout: hydrationTimeout,
  worktreeCreateRecoveryInterval: worktreeCreateRecoveryInterval,
  worktreeCreateTimeout: worktreeCreateTimeout,
  archiveRestoreTimeout: archiveRestoreTimeout,
  clock: clock,
  chatId: chatId,
  unsentStore: unsentStore,
  transcriptCache: transcriptCache,
);
