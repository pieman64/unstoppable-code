import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/watcher_patch.dart';
import 'package:mobile/ui/features/remote/view_models/watcher_slice_store.dart';

import '../../../../support/fake_remote_control_repository.dart';

void main() {
  final first = remoteWorktreeKey('ws-1', 'wt-shared');
  final second = remoteWorktreeKey('ws-2', 'wt-shared');

  Map<String, dynamic> slices(
    RemoteWorktreeKey key, {
    String status = 'active',
  }) => {
    'watchers': [
      watcherJson(
        id: key.workspaceLocalId,
        projectId: key.workspaceLocalId,
        worktreeId: key.worktreeLocalId,
        status: status,
      ),
    ],
  };

  Map<String, dynamic> failedPatch(
    Map<String, dynamic> held,
    RemoteWorktreeKey key,
  ) => withWatcherDelta(
    held,
    key,
    RemoteShellDelta.fromPayload({
      'entities': [
        watcherEntityJson(
          watcherJson(
            id: key.workspaceLocalId,
            projectId: key.workspaceLocalId,
            worktreeId: key.worktreeLocalId,
            status: 'delivery_failed',
          ),
        ),
      ],
    }),
  );

  test(
    'overlapping first reads settle independently and replay live patches',
    () {
      final store = WatcherSliceStore();
      final firstRead = store.beginRead(first);
      final secondRead = store.beginRead(second);
      expect(
        store.applySlicePatch(first, (held) => failedPatch(held, first)),
        isFalse,
      );
      expect(store.settleRead(second, secondRead, slices(second)), isTrue);
      expect(store.settleRead(first, firstRead, slices(first)), isTrue);
      expect(store.watchersFor(first).single.status, 'delivery_failed');
      expect(store.watchersFor(second).single.status, 'active');
    },
  );

  test('a stale read cannot replace the newest read of the same identity', () {
    final store = WatcherSliceStore();
    final oldRead = store.beginRead(first);
    final newRead = store.beginRead(first);
    store.settleRead(first, newRead, slices(first, status: 'delivery_failed'));
    expect(store.settleRead(first, oldRead, slices(first)), isFalse);
    store.finishRead(first, oldRead);
    expect(store.watchersFor(first).single.status, 'delivery_failed');
  });

  test('a failed or refreshing read preserves held live updates', () {
    final store = WatcherSliceStore();
    store.settleRead(first, store.beginRead(first), slices(first));
    final read = store.beginRead(first);
    expect(
      store.applySlicePatch(first, (held) => failedPatch(held, first)),
      isTrue,
    );
    store.finishRead(first, read);
    expect(store.watchersFor(first).single.status, 'delivery_failed');
    expect(store.settleRead(first, read, slices(first)), isFalse);
    store.settleRead(first, store.beginRead(first), const {});
    expect(store.watchersFor(first), isEmpty);
  });

  test('session reset drops held rows and rejects late reads', () {
    final store = WatcherSliceStore();
    store.settleRead(first, store.beginRead(first), slices(first));
    final oldRead = store.beginRead(second);
    store.reset();
    final newRead = store.beginRead(second);
    store.finishRead(second, oldRead);
    expect(store.settleRead(second, oldRead, slices(second)), isFalse);
    expect(store.watchersFor(first), isEmpty);
    expect(store.settleRead(second, newRead, slices(second)), isTrue);
    expect(store.watchersFor(second).single.id, 'ws-2');
  });

  test('non-watcher patches leave watcher state unchanged', () {
    final store = WatcherSliceStore();
    store.settleRead(first, store.beginRead(first), slices(first));
    expect(
      store.applySlicePatch(first, (held) => {...held, 'plans': []}),
      isFalse,
    );
    expect(store.watchersFor(first).single.id, 'ws-1');
  });
}
