import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/services/attachment_cache.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/overview_snapshot_fixture.dart';

final class _DeferredSnapshotRepository extends FakeRemoteControlRepository {
  Completer<RemoteSessionSnapshot>? deferredSnapshot;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    snapshotFetches += 1;
    final deferred = deferredSnapshot;
    if (deferred != null) {
      deferredSnapshot = null;
      return deferred.future;
    }
    return snapshotBuilder?.call() ??
        const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [],
        );
  }
}

final class _DeferredPendingAttachmentCache extends AttachmentCache {
  _DeferredPendingAttachmentCache({super.temporaryDirectories});

  Completer<void>? pendingReadStarted;
  Completer<List<PendingAttachmentArchive>>? deferredPending;

  @override
  Future<List<PendingAttachmentArchive>> pendingArchiveCommands() {
    final deferred = deferredPending;
    if (deferred == null) return super.pendingArchiveCommands();
    deferredPending = null;
    pendingReadStarted?.complete();
    return deferred.future;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'archive cleanup survives a session reset before command completion',
    () async {
      SharedPreferences.setMockInitialValues({});
      final root = await Directory.systemTemp.createTemp(
        'archive-reset-cleanup-test-',
      );
      addTearDown(() => root.delete(recursive: true));
      final cacheDir = await Directory(p.join(root.path, 'cache')).create();
      final picked = await File(
        p.join(cacheDir.path, 'picked.png'),
      ).writeAsString('picked attachment');
      final cache = AttachmentCache(
        temporaryDirectories: () async => [cacheDir],
      );
      await cache.record('ws-1', 'wt-1', [picked.path]);

      var snapshot = initialOverview();
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => snapshot;
      final vm = RemoteControlViewModel(
        repository: repo,
        attachmentCache: cache,
      );
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');

      await vm.archiveWorktree(snapshot.worktrees.single);
      snapshot = RemoteSessionSnapshot.fromJson({
        'workspaces': [overviewWorkspace()],
      });
      await vm.disconnect();

      final restartedCache = AttachmentCache(
        temporaryDirectories: () async => [cacheDir],
      );
      final restartedRepo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => snapshot;
      final restartedVm = RemoteControlViewModel(
        repository: restartedRepo,
        attachmentCache: restartedCache,
      );
      addTearDown(restartedVm.dispose);
      addTearDown(restartedRepo.eventsController.close);
      await restartedVm.connect('123456');
      for (var attempt = 0; attempt < 100 && await picked.exists(); attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }

      expect(await picked.exists(), isFalse);
    },
  );

  test('a legacy restored archive marker does not block retry', () async {
    SharedPreferences.setMockInitialValues({
      'chat_attachment_pending_archives.v1': [
        jsonEncode(['archive-before-restart', 'ws-1', 'wt-1']),
      ],
    });
    final snapshot = initialOverview();
    final repo = FakeRemoteControlRepository()
      ..snapshotBuilder = () => snapshot;
    final vm = RemoteControlViewModel(repository: repo);
    addTearDown(vm.dispose);
    addTearDown(repo.eventsController.close);

    await vm.connect('123456');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await vm.archiveWorktree(snapshot.worktrees.single);

    expect(repo.archiveCalls, hasLength(1));
  });

  test('a restored archive marker releases retry after its bound', () async {
    final now = DateTime(2026, 9, 22, 12);
    SharedPreferences.setMockInitialValues({
      'chat_attachment_pending_archives.v1': [
        jsonEncode([
          'archive-before-restart',
          'ws-1',
          'wt-1',
          now.millisecondsSinceEpoch,
        ]),
      ],
    });
    final snapshot = initialOverview();
    final repo = FakeRemoteControlRepository()
      ..snapshotBuilder = () => snapshot;
    final vm = RemoteControlViewModel(
      repository: repo,
      archiveRestoreTimeout: const Duration(milliseconds: 200),
      clock: () => now,
    );
    addTearDown(vm.dispose);
    addTearDown(repo.eventsController.close);

    await vm.connect('123456');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await vm.archiveWorktree(snapshot.worktrees.single);
    expect(repo.archiveCalls, isEmpty);

    await Future<void>.delayed(const Duration(milliseconds: 220));
    await vm.archiveWorktree(snapshot.worktrees.single);

    expect(repo.archiveCalls, hasLength(1));
  });

  test('a late archive completion still reclaims attachments', () async {
    SharedPreferences.setMockInitialValues({});
    final root = await Directory.systemTemp.createTemp(
      'archive-late-completion-test-',
    );
    addTearDown(() => root.delete(recursive: true));
    final cacheDir = await Directory(p.join(root.path, 'cache')).create();
    final picked = await File(
      p.join(cacheDir.path, 'picked.png'),
    ).writeAsString('picked attachment');
    final cache = AttachmentCache(temporaryDirectories: () async => [cacheDir]);
    await cache.record('ws-1', 'wt-1', [picked.path]);
    final now = DateTime(2026, 9, 22, 12);
    await cache.trackArchiveCommand(
      'archive-before-restart',
      'ws-1',
      'wt-1',
      createdAt: now,
    );
    final snapshot = initialOverview();
    final repo = FakeRemoteControlRepository()
      ..snapshotBuilder = () => snapshot;
    final vm = RemoteControlViewModel(
      repository: repo,
      attachmentCache: cache,
      archiveRestoreTimeout: const Duration(milliseconds: 50),
      clock: () => now,
    );
    addTearDown(vm.dispose);
    addTearDown(repo.eventsController.close);

    await vm.connect('123456');
    await Future<void>.delayed(const Duration(milliseconds: 80));

    expect(vm.isArchivingWorktree(snapshot.worktrees.single), isFalse);
    expect(await cache.pendingArchiveCommands(), hasLength(1));

    repo.eventsController.add(
      RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.command.completed',
            'payload': {
              'commandId': 'archive-before-restart',
              'result': {'success': true},
            },
          },
        ],
        'nextCursor': 1,
      }),
    );
    for (var attempt = 0; attempt < 100 && await picked.exists(); attempt++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }

    expect(await picked.exists(), isFalse);
    expect(await cache.pendingArchiveCommands(), isEmpty);
  });

  test(
    'an original archive success still cleans up after a retry is restored',
    () async {
      final now = DateTime(2026, 9, 22, 12);
      SharedPreferences.setMockInitialValues({
        'chat_attachment_pending_archives.v1': [
          jsonEncode([
            'archive-original',
            'ws-1',
            'wt-1',
            now.subtract(const Duration(seconds: 1)).millisecondsSinceEpoch,
          ]),
          jsonEncode([
            'archive-retry',
            'ws-1',
            'wt-1',
            now.millisecondsSinceEpoch,
          ]),
        ],
      });
      final root = await Directory.systemTemp.createTemp(
        'archive-overlap-cleanup-test-',
      );
      addTearDown(() => root.delete(recursive: true));
      final cacheDir = await Directory(p.join(root.path, 'cache')).create();
      final picked = await File(
        p.join(cacheDir.path, 'picked.png'),
      ).writeAsString('picked attachment');
      final cache = AttachmentCache(
        temporaryDirectories: () async => [cacheDir],
      );
      await cache.record('ws-1', 'wt-1', [picked.path]);
      final snapshot = initialOverview();
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => snapshot;
      final vm = RemoteControlViewModel(
        repository: repo,
        attachmentCache: cache,
        clock: () => now,
      );
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);

      await vm.connect('123456');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      repo.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.command.completed',
              'payload': {
                'commandId': 'archive-original',
                'result': {'success': true},
              },
            },
            {
              'type': 'portal.command.failed',
              'payload': {
                'commandId': 'archive-retry',
                'message': 'retry failed',
              },
            },
          ],
          'nextCursor': 1,
        }),
      );
      for (var attempt = 0; attempt < 100 && await picked.exists(); attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }

      expect(await picked.exists(), isFalse);
      expect(await cache.pendingArchiveCommands(), isEmpty);
    },
  );

  test(
    'dispose cancels archive restoration without discarding its marker',
    () async {
      SharedPreferences.setMockInitialValues({});
      final now = DateTime(2026, 9, 22, 12);
      final cache = AttachmentCache();
      await cache.trackArchiveCommand(
        'archive-before-dispose',
        'ws-1',
        'wt-1',
        createdAt: now,
      );
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = initialOverview;
      final vm = RemoteControlViewModel(
        repository: repo,
        attachmentCache: cache,
        archiveRestoreTimeout: const Duration(milliseconds: 50),
        clock: () => now,
      );
      addTearDown(repo.eventsController.close);

      await vm.connect('123456');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(
        vm.isArchivingWorktree(initialOverview().worktrees.single),
        isTrue,
      );
      vm.dispose();
      await Future<void>.delayed(const Duration(milliseconds: 80));

      expect(await cache.pendingArchiveCommands(), hasLength(1));
    },
  );

  test(
    'archive cleanup uses the snapshot preserved from a raced event',
    () async {
      SharedPreferences.setMockInitialValues({});
      final root = await Directory.systemTemp.createTemp(
        'archive-raced-snapshot-test-',
      );
      addTearDown(() => root.delete(recursive: true));
      final cacheDir = await Directory(p.join(root.path, 'cache')).create();
      final picked = await File(
        p.join(cacheDir.path, 'picked.png'),
      ).writeAsString('picked attachment');
      final cache = AttachmentCache(
        temporaryDirectories: () async => [cacheDir],
      );
      await cache.record('ws-1', 'wt-1', [picked.path]);
      await cache.trackArchiveCommand('archive-during-refresh', 'ws-1', 'wt-1');
      final repo = _DeferredSnapshotRepository()
        ..snapshotBuilder = initialOverview;
      final vm = RemoteControlViewModel(
        repository: repo,
        attachmentCache: cache,
      );
      addTearDown(() async {
        await vm.disconnect();
        vm.dispose();
      });
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');

      final staleSnapshot = Completer<RemoteSessionSnapshot>();
      repo.deferredSnapshot = staleSnapshot;
      final refresh = vm.refresh();
      await Future<void>.delayed(Duration.zero);
      repo.eventsController.add(
        overviewBatch(
          eventId: 'overview-without-worktree',
          entities: [
            {
              'entityType': 'workspace',
              'localId': 'ws-1',
              'payload': overviewWorkspace(includeLocalId: false),
            },
          ],
        ),
      );
      await Future<void>.delayed(Duration.zero);
      staleSnapshot.complete(initialOverview());
      await refresh;
      for (var attempt = 0; attempt < 100 && await picked.exists(); attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }

      expect(vm.allWorktrees, isEmpty);
      expect(await picked.exists(), isFalse);
      expect(await cache.pendingArchiveCommands(), isEmpty);
    },
  );

  test(
    'archive cleanup re-reads overview after loading pending commands',
    () async {
      SharedPreferences.setMockInitialValues({});
      final root = await Directory.systemTemp.createTemp(
        'archive-pending-read-race-test-',
      );
      addTearDown(() => root.delete(recursive: true));
      final cacheDir = await Directory(p.join(root.path, 'cache')).create();
      final picked = await File(
        p.join(cacheDir.path, 'picked.png'),
      ).writeAsString('picked attachment');
      final cache = _DeferredPendingAttachmentCache(
        temporaryDirectories: () async => [cacheDir],
      );
      await cache.record('ws-1', 'wt-1', [picked.path]);
      await cache.trackArchiveCommand(
        'archive-during-pending-read',
        'ws-1',
        'wt-1',
      );
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = initialOverview;
      final vm = RemoteControlViewModel(
        repository: repo,
        attachmentCache: cache,
      );
      addTearDown(() async {
        await vm.disconnect();
        vm.dispose();
      });
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      final pending = await cache.pendingArchiveCommands();
      final pendingReadStarted = Completer<void>();
      final deferredPending = Completer<List<PendingAttachmentArchive>>();
      cache
        ..pendingReadStarted = pendingReadStarted
        ..deferredPending = deferredPending;

      await vm.refresh();
      await pendingReadStarted.future;
      repo.eventsController.add(
        overviewBatch(
          eventId: 'overview-during-pending-read',
          entities: [
            {
              'entityType': 'workspace',
              'localId': 'ws-1',
              'payload': overviewWorkspace(includeLocalId: false),
            },
          ],
        ),
      );
      await Future<void>.delayed(Duration.zero);
      deferredPending.complete(pending);
      for (var attempt = 0; attempt < 100 && await picked.exists(); attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }

      expect(vm.allWorktrees, isEmpty);
      expect(await picked.exists(), isFalse);
      expect(await cache.pendingArchiveCommands(), isEmpty);
    },
  );
}
