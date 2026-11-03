import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/remote/view_models/background_process_hydration.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../remote_background_tray_test.dart' show traySnapshot;

void main() {
  final worktree = remoteWorktreeKey('ws', 'wt');

  test('a scoped read is single-flight and replays live removals', () async {
    final gate = Completer<void>();
    final repo = FakeRemoteControlRepository()
      ..worktreeStateSlices = {'wt': traySnapshot().raw}
      ..worktreeStateSlicesGate = gate;
    var notifications = 0;
    final hydration = BackgroundProcessHydration(
      repository: repo,
      notify: () => notifications++,
    );
    hydration.ensure(worktree);
    hydration.ensure(worktree);
    expect(repo.fetchWorktreeStateSlicesCalls, 1);
    hydration.applySlicePatch(
      worktree,
      (slices) => {...slices, 'backgroundProcesses': const []},
    );
    gate.complete();
    await Future<void>.delayed(Duration.zero);
    expect(hydration.processesFor(worktree), isEmpty);
    expect(notifications, 1);
  });

  test('a discarded session cannot populate the new session', () async {
    final gate = Completer<void>();
    final repo = FakeRemoteControlRepository()
      ..worktreeStateSlices = {'wt': traySnapshot().raw}
      ..worktreeStateSlicesGate = gate;
    final hydration = BackgroundProcessHydration(
      repository: repo,
      notify: () {},
    );
    hydration.ensure(worktree);
    hydration.reset();
    gate.complete();
    await Future<void>.delayed(Duration.zero);
    expect(hydration.processesFor(worktree), isNull);
    repo.worktreeStateSlicesGate = null;
    hydration.ensure(worktree);
    await Future<void>.delayed(Duration.zero);
    expect(hydration.processesFor(worktree), hasLength(1));
    expect(hydration.processesFor(remoteWorktreeKey('other', 'wt')), isNull);
  });

  test(
    'newer full activity read wins and omitted slices preserve fallback',
    () {
      final hydration = BackgroundProcessHydration(
        repository: FakeRemoteControlRepository(),
        notify: () {},
      );
      final old = hydration.beginRead(worktree);
      final current = hydration.beginRead(worktree);
      expect(
        hydration.settleRead(worktree, current, traySnapshot(tasks: 0).raw),
        isTrue,
      );
      expect(hydration.settleRead(worktree, old, traySnapshot().raw), isFalse);
      expect(hydration.processesFor(worktree), isEmpty);
      hydration.reset();
      final missing = hydration.beginRead(worktree);
      expect(hydration.settleRead(worktree, missing, const {}), isFalse);
      hydration.finishRead(worktree, missing);
      expect(hydration.processesFor(worktree), isNull);
    },
  );

  test(
    'failed or refreshing reads preserve fallback and allow another binding',
    () async {
      final repo = FakeRemoteControlRepository()
        ..worktreeStateSlicesFailures = 1;
      final hydration = BackgroundProcessHydration(
        repository: repo,
        notify: () {},
      );
      hydration.ensure(worktree);
      await Future<void>.delayed(Duration.zero);
      expect(hydration.processesFor(worktree), isNull);
      repo
        ..worktreeStateSlices = {'wt': traySnapshot().raw}
        ..worktreeStateSlicesRefreshing = true;
      hydration.ensure(worktree);
      await Future<void>.delayed(Duration.zero);
      expect(hydration.processesFor(worktree), isNull);
      repo.worktreeStateSlicesRefreshing = false;
      hydration.ensure(worktree);
      await Future<void>.delayed(Duration.zero);
      expect(hydration.processesFor(worktree), hasLength(1));
    },
  );
}
