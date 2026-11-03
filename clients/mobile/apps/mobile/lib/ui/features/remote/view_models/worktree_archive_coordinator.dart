import 'dart:async';

import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/services/attachment_archive_ledger.dart';

import 'owned_command_registry.dart';
import 'remote_control_state.dart';

/// Upper bound for restoring an archive command whose terminal event may have
/// fallen behind the snapshot cursor. Once this elapses, Mobile releases the
/// transient "Archiving…" state so the user can retry.
const Duration kRemoteArchiveRestoreTimeout = Duration(minutes: 2);

/// Archive progress and attachment-cache reconciliation for one pairing.
final class WorktreeArchiveCoordinator {
  WorktreeArchiveCoordinator({
    required this.repository,
    required this.attachmentCache,
    required this.notify,
    required this.snapshot,
    required this.isConnected,
    required this.hasConnection,
    required this.sessionGeneration,
    required this.loadGeneration,
    required this.commands,
    required this.refresh,
    this.archiveRestoreTimeout = kRemoteArchiveRestoreTimeout,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;
  final RemoteControlRepository repository;
  final AttachmentArchiveLedger attachmentCache;
  final void Function() notify;
  final RemoteSessionSnapshot? Function() snapshot;
  final bool Function() isConnected;
  final bool Function() hasConnection;
  final int Function() sessionGeneration;
  final int Function() loadGeneration;
  final OwnedCommandRegistry commands;
  final Future<void> Function() refresh;
  final Duration archiveRestoreTimeout;
  final DateTime Function() _clock;
  final Map<RemoteWorktreeKey, String?> _pendingArchives = {};

  /// Archive commands whose terminal still reconciles the attachment cache
  /// and archiving state. Restoring commands for worktrees that are already
  /// gone drops them here, so a late terminal leaves that state alone.
  final Map<String, RemoteWorktreeKey> _archiveReconciliations = {};
  final Map<String, Timer> _archiveRestoreTimers = {};

  bool canArchiveWorktree(RemoteWorktree worktree) =>
      isConnected() &&
      repository.canArchiveWorktrees &&
      (snapshot()?.workspaces ?? const <RemoteWorkspace>[]).any(
        (workspace) =>
            workspace.localId == worktree.workspaceLocalId &&
            (workspace.type == RemoteWorkspaceType.singleRepo ||
                workspace.type == RemoteWorkspaceType.multiRepo),
      );

  bool isArchivingWorktree(RemoteWorktree worktree) =>
      _pendingArchives.containsKey(remoteWorktreeKeyOf(worktree));

  Future<void> archiveWorktree(RemoteWorktree worktree) async {
    if (!canArchiveWorktree(worktree) || isArchivingWorktree(worktree)) return;
    final key = remoteWorktreeKeyOf(worktree);
    final generation = sessionGeneration();
    _pendingArchives[key] = null;
    notify();
    try {
      final id = await repository.archiveWorktree(
        workspaceLocalId: key.workspaceLocalId,
        worktreeLocalId: key.worktreeLocalId,
      );
      final tracking = attachmentCache.trackArchiveCommand(
        id,
        key.workspaceLocalId,
        key.worktreeLocalId,
        createdAt: _clock(),
      );
      if (generation != sessionGeneration()) {
        await tracking;
        return;
      }
      _pendingArchives[key] = id;
      _archiveReconciliations[id] = key;
      _registerArchiveCommand(id);
      await tracking;
    } catch (_) {
      if (generation == sessionGeneration()) _pendingArchives.remove(key);
      rethrow;
    } finally {
      notify();
    }
  }

  void pruneCompletedArchives() {
    final rows = snapshot()?.worktrees;
    if (rows == null) return;
    _pendingArchives.removeWhere(
      (key, id) =>
          id != null &&
          commands.hasCompleted(id) &&
          !rows.any((row) => remoteWorktreeKeyOf(row) == key),
    );
  }

  Future<void> refreshArchivedWorktrees() async {
    final generation = sessionGeneration();
    try {
      await repository.requestOverviewState();
      if (generation == sessionGeneration()) await refresh();
    } catch (_) {
      // The streamed authoritative overview can still remove the archived row.
      // Keep its action pending, rather than offering a duplicate submission.
    }
  }

  Future<void> restorePendingArchiveCommands(int generation) async {
    final pending = await attachmentCache.pendingArchiveCommands();
    final currentSnapshot = snapshot();
    if (generation != loadGeneration() ||
        !hasConnection() ||
        currentSnapshot == null) {
      return;
    }
    final active = {
      for (final worktree in currentSnapshot.worktrees)
        remoteWorktreeKeyOf(worktree),
    };
    final newestRestorableByOwner =
        <RemoteWorktreeKey, PendingAttachmentArchive>{};
    for (final archive in pending) {
      final key = remoteWorktreeKey(archive.workspaceId, archive.worktreeId);
      final createdAt = archive.createdAt;
      if (!active.contains(key) || createdAt == null) continue;
      final remaining = archiveRestoreTimeout - _clock().difference(createdAt);
      if (remaining <= Duration.zero) continue;
      final currentCreatedAt = newestRestorableByOwner[key]?.createdAt;
      if (currentCreatedAt == null || !createdAt.isBefore(currentCreatedAt)) {
        newestRestorableByOwner[key] = archive;
      }
    }
    for (final archive in pending) {
      final key = remoteWorktreeKey(archive.workspaceId, archive.worktreeId);
      if (!active.contains(key)) {
        _archiveRestoreTimers.remove(archive.commandId)?.cancel();
        _archiveReconciliations.remove(archive.commandId);
        if (_pendingArchives[key] == archive.commandId) {
          _pendingArchives.remove(key);
        }
        await attachmentCache.finishArchiveCommand(
          archive.commandId,
          succeeded: true,
        );
        continue;
      }
      _archiveReconciliations[archive.commandId] = key;
      _registerArchiveCommand(archive.commandId);
      if (!_archiveReconciliations.containsKey(archive.commandId)) continue;
      final createdAt = archive.createdAt;
      if (createdAt == null) {
        _archiveRestoreTimers.remove(archive.commandId)?.cancel();
        if (_pendingArchives[key] == archive.commandId) {
          _pendingArchives.remove(key);
        }
        continue;
      }
      final remaining = archiveRestoreTimeout - _clock().difference(createdAt);
      if (remaining <= Duration.zero) {
        _archiveRestoreTimers.remove(archive.commandId)?.cancel();
        if (_pendingArchives[key] == archive.commandId) {
          _pendingArchives.remove(key);
        }
        continue;
      }
      if (newestRestorableByOwner[key]?.commandId != archive.commandId) {
        continue;
      }
      _pendingArchives[key] = archive.commandId;
      _archiveRestoreTimers.remove(archive.commandId)?.cancel();
      _archiveRestoreTimers[archive.commandId] = Timer(remaining, () {
        _archiveRestoreTimers.remove(archive.commandId);
        if (_pendingArchives[key] != archive.commandId) return;
        _pendingArchives.remove(key);
        notify();
      });
    }
    notify();
  }

  void _cancelArchiveRestoreTimers() {
    for (final timer in _archiveRestoreTimers.values) {
      timer.cancel();
    }
    _archiveRestoreTimers.clear();
  }

  void _registerArchiveCommand(String commandId) => commands.register(
    commandId,
    onCompleted: (result) => _archiveCompleted(commandId, result),
    onFailed: (_) => _archiveFailed(commandId),
  );

  void _archiveCompleted(String commandId, Map<String, dynamic>? result) {
    final key = _archiveReconciliations.remove(commandId);
    if (key == null) return;
    final succeeded = result?['success'] != false;
    _archiveRestoreTimers.remove(commandId)?.cancel();
    unawaited(
      attachmentCache.finishArchiveCommand(commandId, succeeded: succeeded),
    );
    if (succeeded) {
      unawaited(refreshArchivedWorktrees());
    } else if (_pendingArchives[key] == commandId) {
      _pendingArchives.remove(key);
    }
  }

  void _archiveFailed(String commandId) {
    if (_archiveReconciliations.remove(commandId) != null) {
      _archiveRestoreTimers.remove(commandId)?.cancel();
      unawaited(
        attachmentCache.finishArchiveCommand(commandId, succeeded: false),
      );
    }
    _pendingArchives.removeWhere((_, id) => id == commandId);
  }

  void reset() {
    _pendingArchives.clear();
    _archiveReconciliations.clear();
    _cancelArchiveRestoreTimers();
  }

  void dispose() => reset();
}
