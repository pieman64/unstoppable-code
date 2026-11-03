import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';
import 'package:mobile/data/models/remote_watcher.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/watcher_patch.dart';

import '../../../../support/fake_remote_control_repository.dart';

void main() {
  final key = remoteWorktreeKey('ws-1', 'wt-1');
  RemoteShellDelta delta({
    List<Map<String, dynamic>> upserts = const [],
    List<Map<String, dynamic>> removed = const [],
  }) => RemoteShellDelta.fromPayload({
    'entities': [for (final row in upserts) watcherEntityJson(row)],
    'removed': [
      for (final row in removed) {'entityType': 'watcher', ...row},
    ],
  });
  List<RemoteWatcher> rows(Map<String, dynamic> slices) => [
    for (final row in slices['watchers'] as List) RemoteWatcher.fromJson(row)!,
  ];

  test(
    'removes before replacing and adding, without touching other slices',
    () {
      final slices = <String, dynamic>{
        'plans': [],
        'watchers': [watcherJson(id: 'a'), watcherJson(id: 'b')],
      };
      final next = withWatcherDelta(
        slices,
        key,
        delta(
          removed: [
            {'localId': 'a', 'parentLocalId': 'ws-1:wt-1'},
            {'localId': 'b'},
          ],
          upserts: [
            watcherJson(id: 'b', status: 'delivery_failed'),
            watcherJson(id: 'c'),
            watcherJson(id: 'foreign', projectId: 'ws-2'),
          ],
        ),
      );
      expect(rows(next).map((row) => row.id), ['b', 'c']);
      expect(rows(next).first.status, 'delivery_failed');
      expect(next['plans'], same(slices['plans']));
      expect(rows(slices).map((row) => row.id), ['a', 'b']);
    },
  );

  test(
    'scoped removal leaves another workspace alone and no-op keeps identity',
    () {
      final slices = <String, dynamic>{
        'watchers': [watcherJson()],
      };
      expect(
        withWatcherDelta(
          slices,
          key,
          delta(
            removed: [
              {'localId': 'watch-pr', 'parentLocalId': 'ws-2:wt-1'},
            ],
          ),
        ),
        same(slices),
      );
      expect(
        withWatcherDelta(
          slices,
          key,
          delta(upserts: [watcherJson(worktreeId: 'wt-2')]),
        ),
        same(slices),
      );
      final next = withWatcherDelta(
        const {},
        key,
        delta(upserts: [watcherJson()]),
      );
      expect(rows(next).single.id, 'watch-pr');
    },
  );

  test('parentless and legacy removals reach known worktrees', () {
    final known = [key, remoteWorktreeKey('ws-2', 'wt-2')];
    expect(
      watcherWorktrees(
        delta(
          removed: [
            {'localId': 'w'},
          ],
        ),
        known,
      ),
      known.toSet(),
    );
    expect(
      watcherWorktrees(
        delta(
          removed: [
            {'localId': 'w', 'parentLocalId': 'wt-1'},
          ],
        ),
        known,
      ),
      {key},
    );
    expect(
      watcherWorktrees(
        delta(
          removed: [
            {'localId': 'w', 'parentLocalId': 'ws-3:wt-3'},
          ],
        ),
        known,
      ),
      {remoteWorktreeKey('ws-3', 'wt-3')},
    );
  });

  test('chat selector scopes by subscriber and sorts in creation order', () {
    final held = [
      watcherJson(id: 'new', createdAt: '2026-10-28T12:00:00.000Z'),
      watcherJson(id: 'old', status: 'delivery_failed'),
      watcherJson(id: 'other-chat', chatId: 'chat-2'),
      watcherJson(id: 'other-worktree', worktreeId: 'wt-2'),
      watcherJson(id: 'other-project', projectId: 'ws-2'),
      watcherJson(id: 'fired', status: 'fired'),
      watcherJson(id: 'unknown', status: 'future'),
    ].map((json) => RemoteWatcher.fromJson(json)!).toList();
    expect(
      watchersForChat(
        held,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      ).map((row) => row.id),
      ['old', 'new'],
    );
    expect(held.first.id, 'new');
  });
}
