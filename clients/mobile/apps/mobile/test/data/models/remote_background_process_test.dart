// CAN-5253: `background_process` rows parse from worktree reads and state
// deltas, including kinds and statuses this build does not know.
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';

import '../../support/fake_remote_control_repository.dart';

void main() {
  group('RemoteBackgroundProcess.fromJson', () {
    test('parses every field', () {
      final process = RemoteBackgroundProcess.fromJson(
        backgroundProcessJson(
          localId: 'bg-1',
          kind: 'agent',
          status: 'completed',
          description: 'Review the diff',
          taskId: 'task-1',
          summary: 'Two findings.',
          lastDescription: 'Reading files',
          canStop: false,
        ),
      )!;

      expect(process.localId, 'bg-1');
      expect(process.workspaceLocalId, 'ws-1');
      expect(process.worktreeLocalId, 'wt-1');
      expect(process.chatId, 'chat-1');
      expect(process.toolUseId, 'tool-bg-1');
      expect(process.taskId, 'task-1');
      expect(process.kind, RemoteBackgroundProcessKind.agent);
      expect(process.description, 'Review the diff');
      expect(process.status, RemoteBackgroundProcessStatus.completed);
      expect(process.startedAt, 1000);
      expect(process.updatedAt, 2000);
      expect(process.summary, 'Two findings.');
      expect(process.lastDescription, 'Reading files');
      expect(process.canStop, isFalse);
    });

    test('parses every known kind and status', () {
      for (final kind in ['agent', 'bash', 'task', 'workflow']) {
        final process = RemoteBackgroundProcess.fromJson(
          backgroundProcessJson(localId: 'bg-1', kind: kind),
        )!;
        expect(process.kind.wire, kind);
      }
      for (final status in [
        'queued',
        'running',
        'completed',
        'failed',
        'stopped',
      ]) {
        final process = RemoteBackgroundProcess.fromJson(
          backgroundProcessJson(localId: 'bg-1', status: status),
        )!;
        expect(process.status.wire, status);
      }
    });

    test('an unknown kind or status parses as unknown', () {
      final process = RemoteBackgroundProcess.fromJson(
        backgroundProcessJson(
          localId: 'bg-1',
          kind: 'monitor',
          status: 'paused',
        ),
      )!;

      expect(process.kind, RemoteBackgroundProcessKind.unknown);
      expect(process.status, RemoteBackgroundProcessStatus.unknown);
    });

    test('missing optional fields fall back', () {
      final process = RemoteBackgroundProcess.fromJson(const {
        'localId': 'bg-1',
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
        'chatId': 'chat-1',
      })!;

      expect(process.toolUseId, '');
      expect(process.taskId, isNull);
      expect(process.kind, RemoteBackgroundProcessKind.unknown);
      expect(process.description, '');
      expect(process.status, RemoteBackgroundProcessStatus.unknown);
      expect(process.startedAt, isNull);
      expect(process.updatedAt, isNull);
      expect(process.summary, isNull);
      expect(process.lastDescription, isNull);
      expect(process.canStop, isFalse);
    });

    test('a row without its process, workspace, worktree or chat is '
        'dropped', () {
      for (final field in [
        'localId',
        'workspaceLocalId',
        'worktreeLocalId',
        'chatId',
      ]) {
        final row = backgroundProcessJson(localId: 'bg-1')..remove(field);
        expect(RemoteBackgroundProcess.fromJson(row), isNull, reason: field);
        expect(
          RemoteBackgroundProcess.fromJson({...row, field: ''}),
          isNull,
          reason: field,
        );
      }
      expect(RemoteBackgroundProcess.fromJson('bg-1'), isNull);
    });

    test('the envelope id wins over the payload id', () {
      final process = RemoteBackgroundProcess.fromJson(
        backgroundProcessJson(localId: 'payload-id'),
        localId: 'envelope-id',
      )!;

      expect(process.localId, 'envelope-id');
    });

    test('toJson reads back the same row', () {
      final row = backgroundProcessJson(
        localId: 'bg-1',
        taskId: 'task-1',
        summary: 'Done',
      );

      expect(RemoteBackgroundProcess.fromJson(row)!.toJson(), row);
    });
  });

  group('RemoteShellDelta background processes', () {
    RemoteStateDeltaEvent parse(Map<String, dynamic> payload, {int? cursor}) =>
        RemotePortalEventBatch.fromJson({
              'events': [
                {
                  'type': 'portal.state.delta',
                  'cursor': ?cursor,
                  'payload': {'scope': 'worktree', ...payload},
                },
              ],
              'nextCursor': cursor,
            }).events.single
            as RemoteStateDeltaEvent;

    test('upserts and removals parse apart from the snapshot rows', () {
      final event = parse({
        'entities': [
          backgroundProcessEntityJson(backgroundProcessJson(localId: 'bg-1')),
          {'entityType': 'background_process', 'localId': 'bg-bad'},
        ],
        'removed': [
          {
            'entityType': 'background_process',
            'localId': 'bg-0',
            'parentLocalId': 'ws-1:wt-1',
          },
          {'entityType': 'worktree', 'localId': 'wt-2'},
        ],
      }, cursor: 7);
      final shell = event.shell;

      expect(
        [for (final row in shell.backgroundProcesses) row.localId],
        ['bg-1'],
      );
      expect(shell.backgroundProcessRemovals.single.localId, 'bg-0');
      expect(shell.backgroundProcessRemovals.single.parentLocalId, 'ws-1:wt-1');
      expect(
        shell.backgroundProcessRemovals.single.type,
        RemoteShellEntityType.backgroundProcess,
      );
      expect(shell.removals.single.type, RemoteShellEntityType.worktree);
      expect(shell.changesBackgroundProcesses, isTrue);
    });

    test('a background-process-only delta without a cursor reads no '
        'overview, which never carries them', () {
      final event = parse({
        'entities': [
          backgroundProcessEntityJson(backgroundProcessJson(localId: 'bg-1')),
        ],
        'removed': [
          {'entityType': 'background_process', 'localId': 'bg-0'},
        ],
      });

      expect(event.shell.isEmpty, isTrue);
      expect(event.shell.changesBackgroundProcesses, isTrue);
      expect(event.requiresOverviewRefresh, isFalse);
    });
  });
}
