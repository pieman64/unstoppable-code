import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';
import 'package:mobile/data/models/remote_watcher.dart';

import '../../support/fake_remote_control_repository.dart';

void main() {
  test('recognizes the Portal watcher entity type', () {
    expect(
      RemoteShellEntityType.fromWire('watcher'),
      RemoteShellEntityType.watcher,
    );
  });

  test('parses the display projection and round trips every field', () {
    final json = watcherJson()
      ..['deliveryError'] = 'Notification could not be delivered.'
      ..['display'] = {
        'title': 'Check CI',
        'subtitle': 'GitHub workflow',
        'watching': 'CI',
        'watchingSubtitle': 'owner/repo',
        'status': 'Active',
        'details': [
          {'label': 'Run', 'value': '42'},
        ],
        'ownerDelegate': {'name': 'Reviewer', 'detail': 'Code review'},
        'github': {
          'subtitle': '1 run',
          'filters': [
            {'label': 'Conclusion', 'value': 'Any'},
          ],
          'samples': ['CI #42'],
          'totalCount': 1,
        },
      };
    final row = RemoteWatcher.fromJson(json)!;
    expect(row.id, 'watch-pr');
    expect(row.projectId, 'ws-1');
    expect(row.worktreeId, 'wt-1');
    expect(row.chatId, 'chat-1');
    expect(row.trigger, 'github_pull_requests_changed');
    expect(row.status, 'active');
    expect(row.createdAt, '2026-10-27T12:00:00.000Z');
    expect(row.followUpInstruction, 'Report the result in this chat.');
    expect(row.deliveryError, 'Notification could not be delivered.');
    expect(row.display!.details.single.value, '42');
    expect(row.display!.ownerDelegate!.name, 'Reviewer');
    expect(row.display!.github!.samples, ['CI #42']);
    expect(row.toJson(), json);
  });

  test('unknown triggers and statuses survive hydration without throwing', () {
    final row = RemoteWatcher.fromJson(
      watcherJson(trigger: 'new_trigger', status: 'new_status'),
    )!;
    expect(row.trigger, 'new_trigger');
    expect(row.status, 'new_status');
    expect(row.isVisible, isFalse);
    expect(RemoteWatcher.fromJson(row.toJson())!.status, 'new_status');
  });

  test(
    'missing optional fields stay null and missing identity drops a row',
    () {
      final json = <String, dynamic>{
        'id': 'w',
        'projectId': 'ws',
        'worktreeId': 'wt',
        'chatId': 'c',
      };
      final row = RemoteWatcher.fromJson(json)!;
      expect(row.createdAt, isNull);
      expect(row.targetKind, isNull);
      expect(row.followUpInstruction, isNull);
      expect(row.deliveryError, isNull);
      expect(row.display, isNull);
      for (final key in ['id', 'projectId', 'worktreeId', 'chatId']) {
        expect(RemoteWatcher.fromJson({...json}..remove(key)), isNull);
        expect(RemoteWatcher.fromJson({...json, key: ''}), isNull);
      }
      expect(RemoteWatcher.fromJson(null), isNull);
      expect(
        RemoteWatcher.fromJson({
          ...json,
          'display': {'title': 'Title'},
        })!.display!.ownerDelegate,
        isNull,
      );
    },
  );

  test('worktree activity reads only its watcher slice', () {
    final activity = RemoteWorktreeActivity.fromState(
      worktreeLocalId: 'wt-1',
      state: {
        'watchers': [
          watcherJson(),
          watcherJson(id: 'other', worktreeId: 'wt-2'),
          null,
        ],
      },
    );
    expect(activity.watchers.map((row) => row.id), ['watch-pr']);
    expect(
      RemoteWorktreeActivity.fromState(
        worktreeLocalId: 'wt-1',
        state: const {},
      ).watchers,
      isEmpty,
    );
  });

  test('deltas keep watchers out of the overview and prefer envelope ids', () {
    final delta = RemoteShellDelta.fromPayload({
      'entities': [
        {...watcherEntityJson(watcherJson()), 'localId': 'envelope'},
        {'entityType': 'watcher', 'localId': 'bad', 'payload': {}},
      ],
      'removed': [
        {
          'entityType': 'watcher',
          'localId': 'gone',
          'parentLocalId': 'ws-1:wt-1',
        },
        {'entityType': 'worktree', 'localId': 'wt-2'},
      ],
    });
    expect(delta.watchers.single.id, 'envelope');
    expect(delta.watcherRemovals.single.localId, 'gone');
    expect(delta.watcherRemovals.single.parentLocalId, 'ws-1:wt-1');
    expect(delta.removals.single.type, RemoteShellEntityType.worktree);
    expect(delta.changesWatchers, isTrue);
    final event =
        RemotePortalEventBatch.fromJson({
              'events': [
                {
                  'type': 'portal.state.delta',
                  'payload': {
                    'scope': 'chat',
                    'entities': [watcherEntityJson(watcherJson())],
                  },
                },
              ],
            }).events.single
            as RemoteStateDeltaEvent;
    expect(event.shell.isEmpty, isTrue);
    expect(event.requiresOverviewRefresh, isFalse);
  });

  test(
    'command failure preserves its typed code and supports legacy errors',
    () {
      RemoteCommandFailedEvent parse(Object error) =>
          RemotePortalEventBatch.fromJson({
                'events': [
                  {
                    'type': 'portal.command.failed',
                    'payload': {'commandId': 'cmd', 'error': error},
                  },
                ],
              }).events.single
              as RemoteCommandFailedEvent;
      expect(
        parse({'code': 'not_found_or_firing', 'message': 'Gone'}).code,
        'not_found_or_firing',
      );
      expect(parse('Legacy failure').code, isNull);
      expect(parse('Legacy failure').message, 'Legacy failure');
    },
  );
}
