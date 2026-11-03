// CAN-5253: `background_process` deltas reduce onto the held worktree
// activity slices the way the server cache applies them.
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';
import 'package:mobile/ui/features/remote/view_models/background_process_patch.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/remote_shell_reducer.dart';

import '../../../../support/fake_remote_control_repository.dart';

void main() {
  RemoteBackgroundProcess process(
    String localId, {
    String workspaceLocalId = 'ws-1',
    String worktreeLocalId = 'wt-1',
    String status = 'running',
  }) => RemoteBackgroundProcess.fromJson(
    backgroundProcessJson(
      localId: localId,
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      status: status,
    ),
  )!;

  RemoteShellRemoval removal(String localId, [String? parentLocalId]) =>
      RemoteShellRemoval(
        type: RemoteShellEntityType.backgroundProcess,
        localId: localId,
        parentLocalId: parentLocalId,
      );

  List<String> ids(List<RemoteBackgroundProcess> rows) => [
    for (final row in rows) row.localId,
  ];

  group('reduceBackgroundProcesses', () {
    test('an upsert replaces its row in place', () {
      final rows = [process('bg-a'), process('bg-b'), process('bg-c')];

      final next = reduceBackgroundProcesses(
        rows,
        upserts: [process('bg-b', status: 'completed')],
      );

      expect(ids(next), ['bg-a', 'bg-b', 'bg-c']);
      expect(next[1].status, RemoteBackgroundProcessStatus.completed);
    });

    test('a new row goes in local id order', () {
      final next = reduceBackgroundProcesses(
        [process('bg-a'), process('bg-c')],
        upserts: [process('bg-b'), process('bg-d')],
      );

      expect(ids(next), ['bg-a', 'bg-b', 'bg-c', 'bg-d']);
    });

    test('rows of another worktree with the same id stay apart', () {
      final next = reduceBackgroundProcesses(
        [process('bg-a')],
        upserts: [process('bg-a', workspaceLocalId: 'ws-2')],
      );

      expect([for (final row in next) row.workspaceLocalId], ['ws-1', 'ws-2']);
    });

    test('a removal matches its id and worktree parent only', () {
      final rows = [
        process('bg-a'),
        process('bg-a', worktreeLocalId: 'wt-2'),
        process('bg-b'),
      ];

      final next = reduceBackgroundProcesses(
        rows,
        removals: [removal('bg-a', 'ws-1:wt-1')],
      );

      expect(
        [for (final row in next) (row.localId, row.worktreeLocalId)],
        [('bg-a', 'wt-2'), ('bg-b', 'wt-1')],
      );
    });

    test('a removal without a parent matches every worktree', () {
      final next = reduceBackgroundProcesses(
        [process('bg-a'), process('bg-a', worktreeLocalId: 'wt-2')],
        removals: [removal('bg-a')],
      );

      expect(next, isEmpty);
    });

    test('removals apply before upserts', () {
      final next = reduceBackgroundProcesses(
        [process('bg-a')],
        removals: [removal('bg-a', 'ws-1:wt-1')],
        upserts: [process('bg-a', status: 'stopped')],
      );

      expect(next.single.status, RemoteBackgroundProcessStatus.stopped);
    });

    test('a step that changes nothing keeps the list identity', () {
      final rows = [process('bg-a')];

      expect(
        reduceBackgroundProcesses(rows, removals: [removal('bg-z')]),
        same(rows),
      );
      expect(reduceBackgroundProcesses(rows), same(rows));
    });
  });

  test('backgroundProcessWorktrees names the rows and removal parents', () {
    final worktrees = backgroundProcessWorktrees(
      RemoteShellDelta(
        backgroundProcesses: [
          process('bg-a'),
          process('bg-b', worktreeLocalId: 'wt-2'),
        ],
        backgroundProcessRemovals: [
          removal('bg-c', 'ws-3:wt-3'),
          removal('bg-d'),
          removal('bg-e', 'wt-legacy'),
        ],
      ),
    );

    expect(worktrees, {
      remoteWorktreeKey('ws-1', 'wt-1'),
      remoteWorktreeKey('ws-1', 'wt-2'),
      remoteWorktreeKey('ws-3', 'wt-3'),
    });
  });

  group('withBackgroundProcessDelta', () {
    final worktree = remoteWorktreeKey('ws-1', 'wt-1');

    List<RemoteBackgroundProcess> activityRows(Map<String, dynamic> slices) =>
        RemoteWorktreeActivity.fromState(
          worktreeLocalId: 'wt-1',
          state: slices,
        ).backgroundProcesses;

    test('applies the worktree rows and leaves other slices alone', () {
      final slices = <String, dynamic>{
        'plans': const [
          {'worktreeLocalId': 'wt-1', 'title': 'Plan'},
        ],
        'backgroundProcesses': [
          backgroundProcessJson(localId: 'bg-a'),
          backgroundProcessJson(localId: 'bg-b'),
        ],
      };

      final next = withBackgroundProcessDelta(
        slices,
        worktree,
        RemoteShellDelta(
          backgroundProcessRemovals: [removal('bg-a', 'ws-1:wt-1')],
          backgroundProcesses: [
            process('bg-b', status: 'failed'),
            process('bg-c'),
            // Another worktree's row in the same delta stays out.
            process('bg-d', worktreeLocalId: 'wt-2'),
          ],
        ),
      );

      expect(ids(activityRows(next)), ['bg-b', 'bg-c']);
      expect(
        activityRows(next).first.status,
        RemoteBackgroundProcessStatus.failed,
      );
      expect(next['plans'], same(slices['plans']));
    });

    test('seeds the list when the read carried none', () {
      final next = withBackgroundProcessDelta(
        const {},
        worktree,
        RemoteShellDelta(backgroundProcesses: [process('bg-a')]),
      );

      expect(ids(activityRows(next)), ['bg-a']);
    });

    test('a delta that changes nothing keeps the slices identity', () {
      final slices = <String, dynamic>{
        'backgroundProcesses': [backgroundProcessJson(localId: 'bg-a')],
      };

      final next = withBackgroundProcessDelta(
        slices,
        worktree,
        RemoteShellDelta(
          backgroundProcessRemovals: [removal('bg-z', 'ws-1:wt-1')],
          backgroundProcesses: [process('bg-x', worktreeLocalId: 'wt-2')],
        ),
      );

      expect(next, same(slices));
    });
  });
}
