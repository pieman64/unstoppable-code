import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/attachment_cache.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_archive_coordinator.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/overview_snapshot_fixture.dart';

final class _ArchiveCache extends AttachmentCache {
  _ArchiveCache(this.createdAt);
  final DateTime createdAt;
  final finished = <String>[];

  @override
  Future<List<PendingAttachmentArchive>> pendingArchiveCommands() async => [
    (
      commandId: 'archive-1',
      createdAt: createdAt,
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
    ),
  ];

  @override
  Future<void> finishArchiveCommand(
    String commandId, {
    required bool succeeded,
  }) async => finished.add(commandId);
}

void main() {
  for (final dispose in [false, true]) {
    test(
      '${dispose ? 'dispose' : 'reset'} cancels restored archive timers',
      () {
        fakeAsync((async) {
          final now = DateTime(2026, 9, 26);
          final repository = FakeRemoteControlRepository();
          final snapshot = initialOverview();
          var notifications = 0;
          final commands = OwnedCommandRegistry(notify: () {});
          final cache = _ArchiveCache(now);
          final coordinator = WorktreeArchiveCoordinator(
            repository: repository,
            attachmentCache: cache,
            notify: () => notifications++,
            snapshot: () => snapshot,
            isConnected: () => true,
            hasConnection: () => true,
            sessionGeneration: () => 0,
            loadGeneration: () => 0,
            commands: commands,
            refresh: () async {},
            clock: () => now,
          );
          coordinator.restorePendingArchiveCommands(0);
          async.flushMicrotasks();
          expect(
            coordinator.isArchivingWorktree(snapshot.worktrees.single),
            isTrue,
          );
          expect(async.nonPeriodicTimerCount, 1);
          final beforeReset = notifications;
          if (dispose) {
            coordinator.dispose();
          } else {
            coordinator.reset();
          }
          expect(
            coordinator.isArchivingWorktree(snapshot.worktrees.single),
            isFalse,
          );
          expect(async.nonPeriodicTimerCount, 0);
          // The restored command is still claimed, but its reconciliation was
          // dropped: a late failure leaves the attachment cache alone.
          expect(
            commands.handleFailed(
              'archive-1',
              'Rejected',
              projectionSequence: 0,
            ),
            isTrue,
          );
          expect(cache.finished, isEmpty);
          async.elapse(const Duration(minutes: 3));
          expect(notifications, beforeReset);
          repository.eventsController.close();
        });
      },
    );
  }

  test('a restored archive command reconciles its own failure', () {
    fakeAsync((async) {
      final now = DateTime(2026, 9, 26);
      final repository = FakeRemoteControlRepository();
      final snapshot = initialOverview();
      final commands = OwnedCommandRegistry(notify: () {});
      final cache = _ArchiveCache(now);
      final coordinator = WorktreeArchiveCoordinator(
        repository: repository,
        attachmentCache: cache,
        notify: () {},
        snapshot: () => snapshot,
        isConnected: () => true,
        hasConnection: () => true,
        sessionGeneration: () => 0,
        loadGeneration: () => 0,
        commands: commands,
        refresh: () async {},
        clock: () => now,
      );
      coordinator.restorePendingArchiveCommands(0);
      async.flushMicrotasks();
      final worktree = snapshot.worktrees.single;
      expect(coordinator.isArchivingWorktree(worktree), isTrue);

      commands.handleFailed('archive-1', 'Rejected', projectionSequence: 0);
      async.flushMicrotasks();

      expect(cache.finished, ['archive-1']);
      expect(coordinator.isArchivingWorktree(worktree), isFalse);
      expect(async.nonPeriodicTimerCount, 0);
      expect(commands.failureMessage, 'Rejected');
      coordinator.dispose();
      repository.eventsController.close();
    });
  });
}
