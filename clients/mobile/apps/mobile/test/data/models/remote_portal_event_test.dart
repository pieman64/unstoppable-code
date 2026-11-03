import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';

import '../../support/overview_snapshot_fixture.dart';

void main() {
  group('RemotePortalEventBatch.fromJson', () {
    test('state events keep their server row cursors', () {
      final batch = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.snapshot',
            'eventId': 'old-head',
            'commandId': 'hydrate-1',
            'cursor': 99,
            'payload': {'scope': 'overview', 'entities': []},
          },
          {
            'type': 'portal.state.delta',
            'eventId': 'new-row',
            'cursor': 101,
            'payload': {'scope': 'worktree', 'entities': []},
          },
        ],
        'nextCursor': 101,
      });

      expect((batch.events.first as RemoteStateSnapshotEvent).cursor, 99);
      expect(
        (batch.events.first as RemoteStateSnapshotEvent).commandId,
        'hydrate-1',
      );
      expect((batch.events.last as RemoteStateDeltaEvent).cursor, 101);
    });

    test(
      'PR patches distinguish complete status from progress and malformed data',
      () {
        RemoteStateDeltaEvent parse(Map<String, dynamic> payload) =>
            RemotePortalEventBatch.fromJson({
                  'events': [
                    {
                      'type': 'portal.state.delta',
                      'payload': {
                        'scope': 'pr',
                        'target': {
                          'workspaceLocalId': 'ws-1',
                          'worktreeLocalId': 'wt-1',
                        },
                        'entities': [
                          {
                            'entityType': 'pr_status',
                            'localId': 'wt-1',
                            'parentLocalId': 'ws-1:wt-1',
                            'payload': payload,
                          },
                        ],
                      },
                    },
                  ],
                }).events.single
                as RemoteStateDeltaEvent;

        expect(parse({'creationProgress': null}).prStatuses, isEmpty);
        expect(parse({'repos': 'invalid'}).prStatuses, isEmpty);
        expect(parse({'repos': null, 'number': 42}).prStatuses, isEmpty);
        expect(parse({'number': 'invalid'}).prStatuses, isEmpty);
        expect(parse({'repos': []}).prStatuses['ws-1:wt-1'], isEmpty);
        expect(
          parse({
            'repos': [
              {'repoId': 'app', 'status': null, 'prLookupAvailable': false},
            ],
          }).prStatuses,
          isEmpty,
        );
        expect(parse({'number': null}).prStatuses, isEmpty);
        expect(
          parse({
            'number': null,
            'creationProgress': {'phase': 'creating'},
          }).prStatuses,
          isEmpty,
        );
        expect(
          parse({
            'number': null,
            'mergeProgress': {'phase': 'merging'},
          }).prStatuses,
          isEmpty,
        );
        final primary = parse({
          'number': 42,
          'state': 'open',
        }).prStatuses['ws-1:wt-1']!;
        expect(primary.single.prNumber, 42);
        expect(primary.single.state, 'open');
      },
    );

    test('parses overview shell metadata using the PR wire shape', () {
      final event = overviewBatch().events.single as RemoteStateSnapshotEvent;
      expect(event.workspaces!.single.name, 'Renamed repository');
      expect(event.worktrees!.single.workspaceLocalId, 'ws-1');
      expect(event.worktrees!.single.status, 'done');
      expect(event.worktrees!.single.prStatuses.single.state, 'merged');
      expect(event.worktrees!.single.prStatuses.single.prNumber, 3061);
      final empty =
          overviewBatch(entities: []).events.single as RemoteStateSnapshotEvent;
      expect(empty.workspaces, isEmpty);
      expect(empty.worktrees, isEmpty);
    });

    test(
      'missing or malformed entities are not authoritative empty shell lists',
      () {
        for (final entities in [null, 'invalid', 12]) {
          final event =
              RemotePortalEventBatch.fromJson({
                    'events': [
                      {
                        'type': 'portal.state.snapshot',
                        'payload': {'scope': 'overview', 'entities': ?entities},
                      },
                    ],
                  }).events.single
                  as RemoteStateSnapshotEvent;
          expect(event.workspaces, isNull);
          expect(event.worktrees, isNull);
        }
        final event =
            overviewBatch(
                  entities: [
                    {'entityType': 'workspace', 'payload': {}},
                    {
                      'entityType': 'worktree',
                      'payload': {'localId': 'orphan'},
                    },
                    {'entityType': 'workspace', 'payload': 'invalid'},
                  ],
                ).events.single
                as RemoteStateSnapshotEvent;
        expect(event.workspaces, isEmpty);
        expect(event.worktrees, isEmpty);
      },
    );

    test(
      'tolerates the provider usage singleton on overview snapshots and deltas (CAN-3635)',
      () {
        final providerUsage = {
          'entityType': 'provider_usage',
          'localId': 'overview',
          'payload': {
            'updatedAt': '2026-10-04T17:05:00.000Z',
            'providers': [
              {
                'provider': 'claude',
                'authState': 'authenticated',
                'windows': [
                  {
                    'id': 'session-primary',
                    'label': '5-hour window',
                    'usedPercent': 42,
                  },
                ],
              },
              {
                'provider': 'codex',
                'authState': 'unauthenticated',
                'windows': [],
              },
            ],
          },
        };
        final snapshot =
            overviewBatch(
                  entities: [
                    {
                      'entityType': 'workspace',
                      'localId': 'ws-1',
                      'payload': overviewWorkspace(includeLocalId: false),
                    },
                    providerUsage,
                  ],
                ).events.single
                as RemoteStateSnapshotEvent;
        expect(snapshot.workspaces!.single.name, 'Repository');

        final delta =
            RemotePortalEventBatch.fromJson({
                  'events': [
                    {
                      'type': 'portal.state.delta',
                      'eventId': 'usage-1',
                      'payload': {
                        'scope': 'overview',
                        'entities': [providerUsage],
                      },
                    },
                  ],
                }).events.single
                as RemoteStateDeltaEvent;
        expect(delta.requiresOverviewRefresh, isFalse);
        // A present entity list is authoritative about the shell rows it
        // carries: this delta carries none, so nothing is upserted.
        expect(delta.workspaces, isEmpty);
        expect(delta.worktrees, isEmpty);
        expect(delta.chatSummaries, isEmpty);
        expect(delta.prStatuses, isEmpty);
      },
    );

    test('cursored shell deltas need no overview read (CAN-4874)', () {
      RemoteStateDeltaEvent parse(
        Map<String, dynamic> payload, {
        int? cursor = 101,
      }) =>
          RemotePortalEventBatch.fromJson({
                'events': [
                  {
                    'type': 'portal.state.delta',
                    'cursor': ?cursor,
                    'payload': payload,
                  },
                ],
              }).events.single
              as RemoteStateDeltaEvent;
      final payloads = <String, Map<String, dynamic>>{
        'standalone chat': {
          'scope': 'standalone_chat',
          'entities': [
            {
              'entityType': 'standalone_chat',
              'localId': 'sc-1',
              'parentLocalId': 'ws-cowork',
              'payload': {'title': 'Plan launch'},
            },
          ],
        },
        'workspace': {
          'scope': 'workspace',
          'entities': [
            {
              'entityType': 'workspace',
              'localId': 'ws-1',
              'payload': {'name': 'Repository'},
            },
          ],
        },
        for (final type in const [
          'workspace',
          'worktree',
          'standalone_chat',
          'chat_summary',
          'pr_status',
        ])
          '$type removal': {
            'scope': 'worktree',
            'removed': [
              {'entityType': type, 'localId': 'id-1'},
            ],
          },
      };
      for (final MapEntry(key: name, value: payload) in payloads.entries) {
        expect(parse(payload).requiresOverviewRefresh, isFalse, reason: name);
        // Older servers send no per-event cursor and keep the fallback.
        expect(
          parse(payload, cursor: null).requiresOverviewRefresh,
          isTrue,
          reason: '$name without a cursor',
        );
      }
      // The overview read carries neither chat projects nor chat todos, so
      // re-reading it could not apply them.
      for (final payload in [
        {
          'scope': 'standalone_chat',
          'entities': [
            {
              'entityType': 'chat_project',
              'localId': 'cp-1',
              'payload': {'name': 'Launch'},
            },
          ],
          'removed': [
            {'entityType': 'chat_project', 'localId': 'cp-2'},
          ],
        },
        {
          'scope': 'worktree',
          'removed': [
            {'entityType': 'chat_todo', 'localId': 'chat-1'},
          ],
        },
      ]) {
        expect(parse(payload).requiresOverviewRefresh, isFalse);
        expect(parse(payload, cursor: null).requiresOverviewRefresh, isFalse);
      }
    });

    test('parses a mixed batch preserving order', () {
      final batch = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.chat.event',
            'eventId': 'ev-1',
            'occurredAt': '2026-07-16T10:00:00Z',
            'payload': {
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'chatId': 'chat-1',
              'message': {
                'messageId': 'msg-1',
                'chatId': 'chat-1',
                'role': 'assistant',
                'status': 'streaming',
                'text': 'Running tests…',
                'createdAtMs': 1752600000000,
              },
            },
          },
          {
            'type': 'portal.state.snapshot',
            'eventId': 'ev-2',
            'occurredAt': '2026-07-16T10:00:01Z',
            'payload': {
              'scope': 'chat',
              'target': {'standaloneChatLocalId': 'chat-1'},
              'entities': [],
              'chatMessages': [
                {
                  'messageId': 'msg-0',
                  'chatId': 'chat-1',
                  'role': 'user',
                  'status': 'complete',
                  'text': 'Run the tests',
                  'createdAtMs': 1752599000000,
                },
              ],
            },
          },
          {
            'type': 'portal.state.delta',
            'eventId': 'ev-3',
            'occurredAt': '2026-07-16T10:00:02Z',
            'payload': {'entities': []},
          },
          {
            'type': 'portal.session.ended',
            'eventId': 'ev-4',
            'occurredAt': '2026-07-16T10:00:03Z',
            'payload': {},
          },
          {
            'type': 'portal.heartbeat',
            'eventId': 'ev-5',
            'occurredAt': '2026-07-16T10:00:04Z',
            'payload': {},
          },
        ],
        'nextCursor': 42,
        'connectionStatus': 'active',
      });

      expect(batch.nextCursor, 42);
      expect(batch.connectionStatus, RemotePortalConnectionStatus.active);
      expect(batch.events, hasLength(5));

      final chatEvent = batch.events[0];
      expect(chatEvent, isA<RemoteChatMessageEvent>());
      chatEvent as RemoteChatMessageEvent;
      expect(chatEvent.chatId, 'chat-1');
      expect(chatEvent.scope, RemoteChatScope.worktree);
      expect(chatEvent.worktreeLocalId, 'wt-1');
      expect(chatEvent.message.messageId, 'msg-1');
      expect(chatEvent.message.isStreaming, isTrue);

      final snapshotEvent = batch.events[1];
      expect(snapshotEvent, isA<RemoteStateSnapshotEvent>());
      snapshotEvent as RemoteStateSnapshotEvent;
      expect(snapshotEvent.scope, 'chat');
      expect(snapshotEvent.targetChatId, 'chat-1');
      expect(snapshotEvent.targetChatScope, RemoteChatScope.standalone);
      expect(snapshotEvent.chatMessages, hasLength(1));
      expect(snapshotEvent.chatMessages.first.messageId, 'msg-0');
      expect(snapshotEvent.chatMessagesTruncated, isFalse);

      expect(batch.events[2], isA<RemoteStateDeltaEvent>());
      expect(batch.events[3], isA<RemoteSessionEndedEvent>());

      final unknown = batch.events[4];
      expect(unknown, isA<RemoteUnknownPortalEvent>());
      expect((unknown as RemoteUnknownPortalEvent).type, 'portal.heartbeat');
    });

    test('parses a worktreeSetupFailure off a state delta', () {
      final batch = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.delta',
            'eventId': 'ev-1',
            'occurredAt': '2026-08-18T10:00:00Z',
            'payload': {
              'entities': [],
              'worktreeSetupFailure': {
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-9',
                'error': 'Could not fetch origin/develop.',
              },
            },
          },
          {
            'type': 'portal.state.delta',
            'eventId': 'ev-2',
            'occurredAt': '2026-08-18T10:00:01Z',
            'payload': {'entities': []},
          },
        ],
        'nextCursor': 1,
      });

      final failed = batch.events.first;
      expect(failed, isA<RemoteStateDeltaEvent>());
      failed as RemoteStateDeltaEvent;
      final failure = failed.worktreeSetupFailure;
      expect(failure, isNotNull);
      expect(failure?.workspaceLocalId, 'ws-1');
      expect(failure?.worktreeLocalId, 'wt-9');
      expect(failure?.error, 'Could not fetch origin/develop.');

      final plain = batch.events[1];
      plain as RemoteStateDeltaEvent;
      expect(plain.worktreeSetupFailure, isNull);
    });

    test('tolerates an empty/malformed body', () {
      final batch = RemotePortalEventBatch.fromJson(const {});
      expect(batch.events, isEmpty);
      expect(batch.nextCursor, 0);
      expect(batch.connectionStatus, isNull);
    });

    test('parses chat_summary entities off a worktree snapshot', () {
      final batch = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.snapshot',
            'eventId': 'ev-1',
            'occurredAt': '2026-07-17T10:00:00Z',
            'payload': {
              'scope': 'worktree',
              'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
              'entities': [
                {
                  'entityType': 'chat_summary',
                  'localId': 'chat-1',
                  'parentLocalId': 'wt-1',
                  'payload': {
                    'chatId': 'chat-1',
                    'scope': 'worktree',
                    'workspaceLocalId': 'ws-1',
                    'worktreeLocalId': 'wt-1',
                    'title': 'Fix flaky test',
                    'order': 0,
                    'active': true,
                  },
                },
                {
                  'entityType': 'worktree',
                  'localId': 'wt-1',
                  'payload': {'localId': 'wt-1', 'branch': 'main'},
                },
              ],
            },
          },
        ],
        'nextCursor': 10,
      });

      final event = batch.events.single;
      expect(event, isA<RemoteStateSnapshotEvent>());
      event as RemoteStateSnapshotEvent;
      expect(event.targetWorktreeLocalId, 'wt-1');
      expect(event.chatSummaries, hasLength(1));
      expect(event.chatSummaries.single.chatId, 'chat-1');
      expect(event.chatSummaries.single.title, 'Fix flaky test');
      expect(event.chatSummaries.single.active, isTrue);
    });

    test('degrades a chat event with no message to unknown', () {
      final batch = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.chat.event',
            'eventId': 'ev-1',
            'occurredAt': '2026-07-16T10:00:00Z',
            'payload': {'chatId': 'chat-1'},
          },
        ],
        'nextCursor': 7,
      });

      expect(batch.events.single, isA<RemoteUnknownPortalEvent>());
    });

    test('parses command completions with their result payload', () {
      final batch = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.command.completed',
            'payload': {
              'commandId': 'cmd-9',
              'result': {'id': 'wt-new', 'branchName': 'canopy/otter'},
            },
          },
        ],
        'nextCursor': 3,
      });

      final event = batch.events.single;
      expect(event, isA<RemoteCommandCompletedEvent>());
      event as RemoteCommandCompletedEvent;
      expect(event.commandId, 'cmd-9');
      expect(event.result?['id'], 'wt-new');
    });

    test('parses structured asynchronous command failures', () {
      final batch = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.command.failed',
            'commandId': 'cmd-1',
            'payload': {
              'error': {
                'code': 'execution_failed',
                'message': 'The model could not be changed.',
              },
            },
          },
        ],
        'nextCursor': 8,
      });

      final event = batch.events.single;
      expect(event, isA<RemoteCommandFailedEvent>());
      event as RemoteCommandFailedEvent;
      expect(event.commandId, 'cmd-1');
      expect(event.message, 'The model could not be changed.');
    });

    test('parses chatMessagesTruncated on a chat snapshot', () {
      final batch = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.snapshot',
            'payload': {
              'scope': 'chat',
              'chatMessagesTruncated': true,
              'chatMessages': const [],
              'target': {'chatLocalId': 'chat-1'},
            },
          },
        ],
        'nextCursor': 1,
      });
      final event = batch.events.single;
      expect(event, isA<RemoteStateSnapshotEvent>());
      event as RemoteStateSnapshotEvent;
      expect(event.chatMessagesTruncated, isTrue);
    });

    test('extracts pr_status progress feeds from a delta', () {
      final event =
          RemotePortalEventBatch.fromJson({
                'events': [
                  {
                    'type': 'portal.state.delta',
                    'payload': {
                      'scope': 'pr',
                      'entities': [
                        {
                          'entityType': 'pr_status',
                          'localId': 'wt-1',
                          'payload': {
                            'workspaceLocalId': 'ws-1',
                            'worktreeLocalId': 'wt-1',
                            'creationProgress': {
                              'currentPhase': 'pushing',
                              'steps': [
                                {'phase': 'gathering_changes'},
                                {'phase': 'summarizing'},
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              }).events.single
              as RemoteStateDeltaEvent;

      final progress = event.prProgress!['ws-1:wt-1']!;
      expect(progress.creation!.currentPhase, RemotePrCreationPhase.pushing);
      expect(progress.creation!.steps, hasLength(2));
      expect(progress.merge, isNull);
    });

    test('extracts pr_status merge feeds from a snapshot', () {
      final event =
          RemotePortalEventBatch.fromJson({
                'events': [
                  {
                    'type': 'portal.state.snapshot',
                    'payload': {
                      'scope': 'pr',
                      'entities': [
                        {
                          'entityType': 'pr_status',
                          'localId': 'wt-1',
                          'payload': {
                            'workspaceLocalId': 'ws-1',
                            'worktreeLocalId': 'wt-1',
                            'mergeProgress': {
                              'currentPhase': 'merging',
                              'steps': [
                                {'phase': 'checking_mergeability'},
                                {'phase': 'merging'},
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              }).events.single
              as RemoteStateSnapshotEvent;

      expect(
        event.prProgress!['ws-1:wt-1']!.merge!.currentPhase,
        RemoteMergePrPhase.merging,
      );
    });

    test('pr_status rows without a progress feed are omitted', () {
      final event =
          RemotePortalEventBatch.fromJson({
                'events': [
                  {
                    'type': 'portal.state.delta',
                    'payload': {
                      'scope': 'pr',
                      'entities': [
                        {
                          'entityType': 'pr_status',
                          'localId': 'wt-1',
                          'payload': {
                            'workspaceLocalId': 'ws-1',
                            'worktreeLocalId': 'wt-1',
                            'number': 7,
                          },
                        },
                      ],
                    },
                  },
                ],
              }).events.single
              as RemoteStateDeltaEvent;

      expect(event.prProgress, isEmpty);
    });

    test('unknown pr_status progress phases become clear patches', () {
      final event =
          RemotePortalEventBatch.fromJson({
                'events': [
                  {
                    'type': 'portal.state.delta',
                    'payload': {
                      'scope': 'pr',
                      'entities': [
                        {
                          'entityType': 'pr_status',
                          'localId': 'wt-1',
                          'payload': {
                            'workspaceLocalId': 'ws-1',
                            'worktreeLocalId': 'wt-1',
                            'creationProgress': {
                              'currentPhase': 'teleporting',
                              'steps': const [],
                            },
                            'mergeProgress': {
                              'currentPhase': 'queued-v2',
                              'steps': const [],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              }).events.single
              as RemoteStateDeltaEvent;

      final progress = event.prProgress!['ws-1:wt-1']!;
      expect(progress.creation, isNull);
      expect(progress.merge, isNull);
      expect(progress.clearCreation, isTrue);
      expect(progress.clearMerge, isTrue);
    });

    test('preserves explicit progress tombstones', () {
      final event =
          RemotePortalEventBatch.fromJson({
                'events': [
                  {
                    'type': 'portal.state.delta',
                    'payload': {
                      'scope': 'pr',
                      'entities': [
                        {
                          'entityType': 'pr_status',
                          'localId': 'wt-1',
                          'payload': {
                            'workspaceLocalId': 'ws-1',
                            'worktreeLocalId': 'wt-1',
                            'creationProgress': null,
                            'mergeProgress': null,
                          },
                        },
                      ],
                    },
                  },
                ],
              }).events.single
              as RemoteStateDeltaEvent;

      expect(event.prProgress, contains('ws-1:wt-1'));
      expect(event.prProgress!['ws-1:wt-1']!.isEmpty, isFalse);
    });
  });

  group('portal.pipeline.event', () {
    RemotePortalEvent parse(Map<String, dynamic> envelope) =>
        RemotePortalEventBatch.fromJson({
          'events': [envelope],
          'nextCursor': 1,
        }).events.single;

    test('parses an upsert into a run, carrying the command id', () {
      final event =
          parse({
                'type': 'portal.pipeline.event',
                'commandId': 'cmd-7',
                'payload': {
                  'kind': 'upsert',
                  'entity': {
                    'entityType': 'pipeline_run',
                    'localId': 'exec-1',
                    'payload': {
                      'pipelineName': 'CI',
                      'status': 'running',
                      'worktreeLocalId': 'wt-1',
                      'jobs': [
                        {
                          'jobId': 'build',
                          'name': 'Build',
                          'status': 'running',
                          'steps': [
                            {
                              'stepId': 's1',
                              'name': 'Compile',
                              'status': 'running',
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              })
              as RemotePipelineRunEvent;

      expect(event.commandId, 'cmd-7');
      expect(event.run.localId, 'exec-1');
      expect(event.run.pipelineName, 'CI');
      expect(event.run.worktreeLocalId, 'wt-1');
      expect(event.run.jobs!.single.steps.single.stepId, 's1');
    });

    test('infers the run entity type the way the portal cache does', () {
      final event =
          parse({
                'type': 'portal.pipeline.event',
                'payload': {
                  'kind': 'upsert',
                  'entity': {
                    'id': 'exec-2',
                    'payload': {'status': 'success', 'pipelineName': 'Nightly'},
                  },
                },
              })
              as RemotePipelineRunEvent;
      expect(event.run.localId, 'exec-2');
      expect(event.run.status, 'success');
    });

    test('a pipeline descriptor upsert is not a run', () {
      final event = parse({
        'type': 'portal.pipeline.event',
        'payload': {
          'kind': 'upsert',
          'entity': {
            'entityType': 'pipeline',
            'localId': 'pipe-1',
            'payload': {'name': 'CI'},
          },
        },
      });
      expect(event, isA<RemoteUnknownPortalEvent>());
    });

    test('parses a run removal', () {
      final event =
          parse({
                'type': 'portal.pipeline.event',
                'payload': {
                  'kind': 'remove',
                  'entityType': 'pipeline_run',
                  'localId': 'exec-3',
                },
              })
              as RemotePipelineRunRemovedEvent;
      expect(event.localId, 'exec-3');
    });

    test('a malformed envelope is ignored rather than thrown', () {
      for (final payload in <Object>[
        {'kind': 'upsert'},
        {'kind': 'upsert', 'entity': 'nope'},
        {'kind': 'upsert', 'entity': <String, dynamic>{}},
      ]) {
        expect(
          parse({'type': 'portal.pipeline.event', 'payload': payload}),
          isA<RemoteUnknownPortalEvent>(),
        );
      }
    });
  });

  // CAN-4875: the desktop sends `portal.hook.event` upserts after a hook
  // pause or resume (`createFeatureUpsertEvent` in hooks-adapter.ts).
  group('portal.hook.event', () {
    RemotePortalEvent parse(Map<String, dynamic> payload) =>
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.hook.event',
              'commandId': 'cmd-hook',
              'payload': payload,
            },
          ],
          'nextCursor': 1,
        }).events.single;

    const summary = {
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': 'wt-1',
      'hookId': 'hook-lint',
      'hookKey': 'hook-lint',
      'name': 'Lint on save',
      'triggerName': 'pre_task',
      'target': 'project',
      'paused': true,
    };

    test('parses a descriptor upsert with its worktree and row', () {
      final event =
          parse({
                'kind': 'upsert',
                'entity': {
                  'entityType': 'hook_descriptor',
                  'localId': 'hook-lint',
                  'parentLocalId': 'ws-1:wt-1',
                  'payload': summary,
                },
              })
              as RemoteHookDescriptorEvent;

      expect(event.workspaceLocalId, 'ws-1');
      expect(event.worktreeLocalId, 'wt-1');
      expect(event.hookKey, 'hook-lint');
      expect(event.descriptor, summary);
    });

    test('takes the worktree from the parent id when the row omits it', () {
      final event =
          parse({
                'kind': 'upsert',
                'entity': {
                  'entityType': 'hook_descriptor',
                  'localId': 'hook-lint',
                  'parentLocalId': 'ws-1:wt-1',
                  'payload': {'name': 'Lint on save', 'paused': false},
                },
              })
              as RemoteHookDescriptorEvent;

      expect(event.worktreeLocalId, 'wt-1');
      expect(event.descriptor, {
        'name': 'Lint on save',
        'paused': false,
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
        'hookKey': 'hook-lint',
      });
    });

    test('parses a removal that names its worktree', () {
      final event =
          parse({
                'kind': 'remove',
                'entityType': 'hook_descriptor',
                'localId': 'hook-lint',
                'parentLocalId': 'ws-1:wt-1',
              })
              as RemoteHookDescriptorEvent;

      expect(event.worktreeLocalId, 'wt-1');
      expect(event.hookKey, 'hook-lint');
      expect(event.descriptor, isNull);
    });

    for (final (label, payload) in <(String, Map<String, dynamic>)>[
      (
        'a hook run',
        {
          'kind': 'upsert',
          'entity': {
            'entityType': 'hook_run',
            'localId': 'run-1',
            'parentLocalId': 'ws-1:wt-1',
            'payload': {'status': 'running'},
          },
        },
      ),
      (
        'a removal without a worktree',
        {'kind': 'remove', 'entityType': 'hook_descriptor', 'localId': 'h'},
      ),
      (
        'an upsert without a row',
        {
          'kind': 'upsert',
          'entity': {
            'entityType': 'hook_descriptor',
            'localId': 'hook-lint',
            'parentLocalId': 'ws-1:wt-1',
          },
        },
      ),
    ]) {
      test('ignores $label', () {
        expect(parse(payload), isA<RemoteUnknownPortalEvent>());
      });
    }
  });

  group('App Advisor events (CAN-3989)', () {
    RemotePortalEvent parse(Map<String, dynamic> envelope) =>
        RemotePortalEventBatch.fromJson({
          'events': [envelope],
          'nextCursor': 1,
        }).events.single;

    Map<String, dynamic> chatEntity(Map<String, dynamic> payload) => {
      'entityType': 'app_advisor_chat',
      'localId': payload['chatId'],
      'payload': payload,
    };

    test('parses a streamed message', () {
      final event =
          parse({
                'type': 'portal.app_advisor.event',
                'payload': {
                  'chatId': 'c1',
                  'message': {
                    'messageId': 'm1',
                    'chatId': 'c1',
                    'role': 'assistant',
                    'status': 'streaming',
                    'text': 'Working',
                  },
                },
              })
              as RemoteAppAdvisorMessageEvent;
      expect(event.chatId, 'c1');
      expect(event.message.messageId, 'm1');
      expect(event.message.status, ChatMessageStatus.streaming);
    });

    test('a message event without a message is ignored', () {
      expect(
        parse({
          'type': 'portal.app_advisor.event',
          'payload': {'chatId': 'c1'},
        }),
        isA<RemoteUnknownPortalEvent>(),
      );
    });

    test('parses an untargeted snapshot with its transcript seed', () {
      final event =
          parse({
                'type': 'portal.state.snapshot',
                'commandId': 'hydrate-1',
                'payload': {
                  'scope': 'app_advisor',
                  'entities': [
                    {
                      'entityType': 'app_advisor_item_groups',
                      'localId': 'app-advisor',
                      'payload': {'groups': []},
                    },
                    chatEntity({
                      'localId': 'c1',
                      'chatId': 'c1',
                      'title': 'Plan the release',
                      'order': 0,
                      'active': true,
                      'turnActive': true,
                      'workEntryId': 'e1',
                      'workEntryTitle': 'Release',
                      'workEntryOrder': 2,
                      'desktopCurrent': true,
                    }),
                  ],
                  'chatMessages': [
                    {
                      'messageId': 'm1',
                      'chatId': 'c1',
                      'role': 'user',
                      'status': 'complete',
                      'text': 'Hello',
                    },
                  ],
                  'chatMessagesTruncated': true,
                },
              })
              as RemoteAppAdvisorSnapshotEvent;
      expect(event.commandId, 'hydrate-1');
      expect(event.targetChatId, isNull);
      expect(event.chatMessagesTruncated, isTrue);
      expect(event.chatMessages.single.text, 'Hello');
      final chat = event.chats.single;
      expect(chat.chatId, 'c1');
      expect(chat.summary.title, 'Plan the release');
      expect(chat.summary.turnActive, isTrue);
      expect(chat.summary.active, isTrue);
      expect(chat.workEntryId, 'e1');
      expect(chat.workEntryTitle, 'Release');
      expect(chat.workEntryOrder, 2);
      expect(chat.desktopCurrent, isTrue);
    });

    test('a targeted snapshot names its chat', () {
      final event =
          parse({
                'type': 'portal.state.snapshot',
                'payload': {
                  'scope': 'app_advisor',
                  'target': {'chatLocalId': 'c1'},
                  'entities': [],
                },
              })
              as RemoteAppAdvisorSnapshotEvent;
      expect(event.targetChatId, 'c1');
      expect(event.chats, isEmpty);
    });

    test('removal-only Advisor deltas ignore unrelated and malformed rows', () {
      final event =
          parse({
                'type': 'portal.state.delta',
                'payload': {
                  'scope': 'app_advisor',
                  'removed': [
                    {'entityType': 'app_advisor_chat', 'localId': 'c1'},
                    {'entityType': 'worktree', 'localId': 'other'},
                    {'entityType': 'app_advisor_chat', 'localId': ''},
                    {'entityType': 'app_advisor_chat', 'localId': 42},
                    null,
                  ],
                },
              })
              as RemoteAppAdvisorDeltaEvent;
      expect(event.chats, isEmpty);
      expect(event.removedChatIds, ['c1']);
    });

    test('delta rows keep omitted pending questions apart from cleared', () {
      final event =
          parse({
                'type': 'portal.state.delta',
                'payload': {
                  'scope': 'app_advisor',
                  'entities': [
                    chatEntity({'chatId': 'c1', 'title': 'One'}),
                    chatEntity({
                      'chatId': 'c2',
                      'title': 'Two',
                      'pendingQuestions': [],
                    }),
                    chatEntity({
                      'chatId': 'c3',
                      'title': 'Three',
                      'pendingQuestions': [
                        {
                          'requestId': 'q1',
                          'questions': [
                            {'question': 'Ship it?'},
                          ],
                        },
                      ],
                    }),
                  ],
                },
              })
              as RemoteAppAdvisorDeltaEvent;
      final [one, two, three] = event.chats;
      expect(one.summary.pendingQuestions, isNull);
      expect(two.summary.pendingQuestions, isEmpty);
      expect(three.summary.pendingQuestions!.single.requestId, 'q1');
    });

    test('other scopes still parse as shell state events', () {
      expect(
        parse({
          'type': 'portal.state.delta',
          'payload': {'scope': 'overview', 'entities': []},
        }),
        isA<RemoteStateDeltaEvent>(),
      );
    });
  });
}
