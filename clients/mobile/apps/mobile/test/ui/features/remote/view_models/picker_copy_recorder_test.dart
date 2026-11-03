import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/picker_copy_recorder.dart';

const _worktree = RemoteWorktree(
  localId: 'wt-2',
  workspaceLocalId: 'ws-app',
  branch: 'canopy/otter',
);

void main() {
  /// Each call as its workspace, worktree, then paths.
  late List<List<String>> recorded;
  late PickerCopyRecorder recorder;

  setUp(() {
    recorded = [];
    recorder = PickerCopyRecorder(
      record: (workspaceId, worktreeId, paths) async =>
          recorded.add([workspaceId, worktreeId, ...paths]),
    );
  });

  test('records copies for a bound worktree as they are read', () async {
    await recorder.bind(_worktree);
    await recorder.filesRead(['/cache/a.png']);
    await recorder.filesRead(['/cache/b.png']);

    expect(recorded, [
      ['ws-app', 'wt-2', '/cache/a.png'],
      ['ws-app', 'wt-2', '/cache/b.png'],
    ]);
  });

  test('holds copies read before the worktree exists until it is bound, '
      'then records each once', () async {
    await recorder.filesRead(['/cache/a.png']);
    await recorder.filesRead(['/cache/b.png', '/cache/c.png']);
    expect(recorded, isEmpty);

    await recorder.bind(_worktree);
    await recorder.filesRead(['/cache/d.png']);

    expect(recorded, [
      ['ws-app', 'wt-2', '/cache/a.png', '/cache/b.png', '/cache/c.png'],
      ['ws-app', 'wt-2', '/cache/d.png'],
    ]);
  });
}
