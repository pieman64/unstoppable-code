import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_run_chat_activity.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_run_chat_activity_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../../../../support/fake_remote_control_repository.dart';

Map<String, dynamic> _runJson(
  String id, {
  String status = 'running',
  String startedAt = '2026-10-04T10:00:00.000Z',
  String worktreeLocalId = 'wt-1',
  bool hidden = false,
  String? parentExecutionId,
  List<(String, String)>? links,
  List<Map<String, dynamic>>? jobs,
}) => {
  'localId': id,
  'pipelineName': 'Pipeline $id',
  'workspaceLocalId': 'ws-1',
  'worktreeLocalId': worktreeLocalId,
  'status': status,
  'startedAt': startedAt,
  'hidden': hidden,
  'parentExecutionId': ?parentExecutionId,
  if (links != null)
    'chatTurns': [
      for (final (chatId, turn) in links)
        {'chatId': chatId, 'userMessageId': turn, 'relation': 'launched'},
    ],
  'jobs': ?jobs,
};

RemotePipelineRun _run(
  String id, {
  String startedAt = '2026-10-04T10:00:00.000Z',
  String worktreeLocalId = 'wt-1',
  bool hidden = false,
  String? parentExecutionId,
  List<(String, String)>? links,
}) => RemotePipelineRun.fromJson(
  _runJson(
    id,
    startedAt: startedAt,
    worktreeLocalId: worktreeLocalId,
    hidden: hidden,
    parentExecutionId: parentExecutionId,
    links: links,
  ),
)!;

void main() {
  group('selectPipelineRunChatActivity', () {
    PipelineRunChatActivity select(List<RemotePipelineRun> runs) =>
        selectPipelineRunChatActivity(
          chatId: 'chat-a',
          worktreeLocalId: 'wt-1',
          runs: runs,
        );

    test('groups visible root runs by the turns of this chat', () {
      final activity = select([
        _run(
          'late',
          startedAt: '2026-10-04T11:00:00.000Z',
          links: [('chat-a', 'u-1')],
        ),
        _run('early', links: [('chat-a', 'u-1'), ('chat-a', 'u-2')]),
      ]);
      expect(activity.runsByTurn.keys, unorderedEquals(['u-1', 'u-2']));
      // Oldest start first, as the desktop lists them while they launch.
      expect(activity.runsByTurn['u-1']!.map((run) => run.localId), [
        'early',
        'late',
      ]);
      expect(activity.runsByTurn['u-2']!.single.localId, 'early');
    });

    test('a run listed twice under one turn gets one card', () {
      final run = RemotePipelineRun.fromJson({
        ..._runJson('exec-1'),
        'chatTurns': [
          {'chatId': 'chat-a', 'userMessageId': 'u-1', 'relation': 'launched'},
          {'chatId': 'chat-a', 'userMessageId': 'u-1', 'relation': 'watching'},
        ],
      })!;
      expect(select([run]).runsByTurn['u-1'], hasLength(1));
    });

    test('hidden, child, unlinked, foreign-chat and foreign-worktree runs '
        'claim nothing', () {
      final activity = select([
        _run('hidden', hidden: true, links: [('chat-a', 'u-1')]),
        _run('child', parentExecutionId: 'root', links: [('chat-a', 'u-1')]),
        _run('old-host'),
        _run('unlinked', links: const []),
        _run('other-chat', links: [('chat-b', 'u-1')]),
        _run('other-wt', worktreeLocalId: 'wt-2', links: [('chat-a', 'u-1')]),
      ]);
      expect(activity.isEmpty, isTrue);
    });

    test('ties on start time order by execution id', () {
      final activity = select([
        _run('b', links: [('chat-a', 'u-1')]),
        _run('a', links: [('chat-a', 'u-1')]),
      ]);
      expect(activity.runsByTurn['u-1']!.map((run) => run.localId), ['a', 'b']);
    });

    test('the latest turn is the newest transcript turn with activity', () {
      final activity = select([
        _run('one', links: [('chat-a', 'u-1')]),
        _run('two', links: [('chat-a', 'u-2')]),
      ]);
      expect(activity.latestTurnKey(['u-1', 'u-2', 'u-3']), 'u-2');
      // A linked turn outside the loaded transcript is never the latest.
      expect(activity.latestTurnKey(['u-1']), 'u-1');
      expect(activity.latestTurnKey(const []), isNull);
    });
  });

  group('showsPipelineRunChatActivity', () {
    const worktree = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'main',
    );
    RemoteWorkspace workspace(String id, RemoteWorkspaceType type) =>
        RemoteWorkspace(localId: id, name: id, type: type);

    test('shows panels for a worktree chat', () {
      expect(
        showsPipelineRunChatActivity(worktree, [
          workspace('ws-1', RemoteWorkspaceType.multiRepo),
        ]),
        isTrue,
      );
      // An unlisted workspace is not known to be cowork.
      expect(showsPipelineRunChatActivity(worktree, const []), isTrue);
    });

    test('shows none for a cowork entry', () {
      expect(
        showsPipelineRunChatActivity(worktree, [
          workspace('ws-1', RemoteWorkspaceType.cowork),
        ]),
        isFalse,
      );
      // Another workspace being cowork does not matter.
      expect(
        showsPipelineRunChatActivity(worktree, [
          workspace('ws-1', RemoteWorkspaceType.multiRepo),
          workspace('ws-2', RemoteWorkspaceType.cowork),
        ]),
        isTrue,
      );
    });
  });

  group('PipelineRunChatActivityHost', () {
    late FakeRemoteControlRepository repository;
    late RemoteControlViewModel viewModel;
    late PipelineRunChatActivityHost host;

    const tree = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'main',
    );
    const sibling = RemoteWorktree(
      localId: 'wt-2',
      workspaceLocalId: 'ws-1',
      branch: 'feature',
    );
    const cowork = RemoteWorktree(
      localId: 'wt-c',
      workspaceLocalId: 'ws-c',
      branch: 'main',
    );

    setUp(() async {
      repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            RemoteWorkspace(
              localId: 'ws-1',
              name: 'Tree',
              type: RemoteWorkspaceType.multiRepo,
            ),
            RemoteWorkspace(
              localId: 'ws-c',
              name: 'Cowork',
              type: RemoteWorkspaceType.cowork,
            ),
          ],
          standaloneChats: [],
          worktrees: [tree, sibling, cowork],
          chatSummaries: [],
          chatMessages: [],
        );
      viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await viewModel.connect('123456');
      host = PipelineRunChatActivityHost();
    });

    tearDown(() {
      host.dispose();
      viewModel.dispose();
    });

    test('keeps one controller per worktree across calls', () {
      final first = host.controllerFor(viewModel, tree)!;
      expect(first.workspaceLocalId, 'ws-1');
      expect(first.worktreeLocalId, 'wt-1');
      expect(host.controllerFor(viewModel, tree), same(first));
    });

    test('another worktree replaces and disposes the held controller', () {
      final first = host.controllerFor(viewModel, tree)!;
      final second = host.controllerFor(viewModel, sibling)!;
      expect(second, isNot(same(first)));
      expect(second.worktreeLocalId, 'wt-2');
      expect(first.isDisposed, isTrue);
      expect(second.isDisposed, isFalse);
    });

    test('standalone chats and cowork entries get none', () {
      final held = host.controllerFor(viewModel, tree)!;
      expect(host.controllerFor(viewModel, null), isNull);
      expect(host.controllerFor(viewModel, cowork), isNull);
      // The held controller, and so its expansion choices, stays.
      expect(held.isDisposed, isFalse);
      expect(host.controllerFor(viewModel, tree), same(held));
    });

    test('dispose disposes the held controller', () {
      final held = host.controllerFor(viewModel, tree)!;
      host.dispose();
      expect(held.isDisposed, isTrue);
      host = PipelineRunChatActivityHost();
    });
  });

  group('PipelineRunChatActivityController', () {
    late FakeRemoteControlRepository repository;
    late RemoteControlViewModel viewModel;
    late PipelineRunChatActivityController controller;
    var notifications = 0;
    var cursor = 0;
    const retryWindow = Duration(milliseconds: 20);

    Future<void> emit(Map<String, dynamic> run) async {
      cursor += 1;
      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.pipeline.event',
              'payload': {
                'kind': 'upsert',
                'entity': {
                  'entityType': 'pipeline_run',
                  'localId': run['localId'],
                  'payload': run,
                },
              },
            },
          ],
          'nextCursor': cursor,
        }),
      );
      await pumpEventQueue();
    }

    setUp(() async {
      notifications = 0;
      cursor = 0;
      repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          standaloneChats: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          chatSummaries: [],
          chatMessages: [],
        );
      viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        hydrationRetryWindow: retryWindow,
        hydrationTimeout: retryWindow * 2,
      );
      await viewModel.connect('123456');
      controller = PipelineRunChatActivityController(
        viewModel: viewModel,
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      )..addListener(() => notifications += 1);
    });

    tearDown(() {
      controller.dispose();
      viewModel.dispose();
    });

    test('notifies only for changes a panel shows', () async {
      expect(controller.bind('chat-a').isEmpty, isTrue);
      final jobs = [
        {'jobId': 'build', 'name': 'Build', 'status': 'running'},
      ];
      await emit(_runJson('exec-1', links: [('chat-a', 'u-1')], jobs: jobs));
      expect(notifications, 1);
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);

      // Live step output the card does not show changes nothing.
      await emit({
        ..._runJson('exec-1', jobs: jobs),
        'truncated': true,
        'progress': {'completedSteps': 1, 'totalSteps': 4},
      });
      expect(notifications, 1);

      // A job status the dots show does.
      await emit(
        _runJson(
          'exec-1',
          jobs: [
            {'jobId': 'build', 'name': 'Build', 'status': 'success'},
          ],
        ),
      );
      expect(notifications, 2);
    });

    test(
      'binding a chat on a foreground-chat host reads its runs once',
      () async {
        repository
          ..supportsForegroundChat = true
          ..worktreePipelineSlices = {
            'wt-1': {
              'pipelineRuns': [
                _runJson(
                  'exec-1',
                  status: 'success',
                  links: [('chat-a', 'u-1')],
                ),
              ],
            },
          };

        expect(controller.bind('chat-a').isEmpty, isTrue);
        await pumpEventQueue();
        expect(repository.fetchWorktreePipelineSlicesCalls, 1);
        expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
        expect(notifications, 1);
        expect(repository.requestWorktreeStateCalls, 0);
        expect(repository.fetchWorktreeStateSlicesCalls, 0);

        // Another chat, a rebind, or a second screen on the same worktree
        // reuses the read already made.
        controller
          ..bind('chat-b')
          ..bind('chat-a');
        final other = PipelineRunChatActivityController(
          viewModel: viewModel,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        )..bind('chat-a');
        addTearDown(other.dispose);
        await pumpEventQueue();
        expect(repository.fetchWorktreePipelineSlicesCalls, 1);
      },
    );

    test('concurrent binds share one in-flight read', () async {
      repository.supportsForegroundChat = true;
      controller.bind('chat-a');
      final other = PipelineRunChatActivityController(
        viewModel: viewModel,
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      )..bind('chat-a');
      addTearDown(other.dispose);
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 1);
    });

    test(
      'a cold cache reads again once the pipelines snapshot lands',
      () async {
        repository
          ..supportsForegroundChat = true
          ..worktreePipelineSlicesRefreshing = true;
        controller.bind('chat-a');
        await pumpEventQueue();
        expect(repository.fetchWorktreePipelineSlicesCalls, 1);

        repository
          ..worktreePipelineSlicesRefreshing = false
          ..worktreePipelineSlices = {
            'wt-1': {
              'pipelineRuns': [
                _runJson(
                  'exec-1',
                  status: 'success',
                  links: [('chat-a', 'u-1')],
                ),
              ],
            },
          };
        Future<void> snapshot() async {
          cursor += 1;
          repository.eventsController.add(
            RemotePortalEventBatch(
              nextCursor: cursor,
              events: const [
                RemoteStateSnapshotEvent(
                  scope: 'pipelines',
                  targetWorkspaceLocalId: 'ws-1',
                  targetWorktreeLocalId: 'wt-1',
                ),
              ],
            ),
          );
          await pumpEventQueue();
        }

        await snapshot();
        expect(repository.fetchWorktreePipelineSlicesCalls, 2);
        expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
        // Later pipelines snapshots, from any client, do not read again.
        await snapshot();
        expect(repository.fetchWorktreePipelineSlicesCalls, 2);
      },
    );

    Map<String, Map<String, dynamic>> linkedFinishedRun() => {
      'wt-1': {
        'pipelineRuns': [
          _runJson('exec-1', status: 'success', links: [('chat-a', 'u-1')]),
        ],
      },
    };

    /// Lets real retry timers fire until [reads] pipeline reads went out.
    Future<void> untilReads(int reads) async {
      for (var i = 0; i < 100; i++) {
        if (repository.fetchWorktreePipelineSlicesCalls >= reads) break;
        await Future<void>.delayed(retryWindow);
      }
      await pumpEventQueue();
    }

    Future<void> pipelinesSnapshot() async {
      cursor += 1;
      repository.eventsController.add(
        RemotePortalEventBatch(
          nextCursor: cursor,
          events: const [
            RemoteStateSnapshotEvent(
              scope: 'pipelines',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ],
        ),
      );
      await pumpEventQueue();
    }

    test('a pipelines snapshot landing before the cold-cache reply still '
        'reads once more', () async {
      final initialReply = Completer<void>();
      repository
        ..supportsForegroundChat = true
        ..worktreePipelineSlicesRefreshing = true
        ..worktreePipelineSlicesGate = initialReply;
      controller.bind('chat-a');
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 1);

      // The server enqueued the desktop request before answering, so the
      // desktop's snapshot can overtake the HTTP reply.
      repository
        ..worktreePipelineSlicesRefreshing = false
        ..worktreePipelineSlicesGate = null
        ..worktreePipelineSlices = linkedFinishedRun();
      await pipelinesSnapshot();
      expect(repository.fetchWorktreePipelineSlicesCalls, 1);

      initialReply.complete();
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 2);
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
      await pipelinesSnapshot();
      expect(repository.fetchWorktreePipelineSlicesCalls, 2);
      expect(repository.requestWorktreeStateCalls, 0);
      expect(repository.fetchWorktreeStateSlicesCalls, 0);
    });

    test(
      'a chat bound while disconnected reads its runs once connected',
      () async {
        repository
          ..supportsForegroundChat = true
          ..worktreePipelineSlices = linkedFinishedRun();
        await viewModel.disconnect();
        expect(controller.bind('chat-a').isEmpty, isTrue);
        await pumpEventQueue();
        expect(repository.fetchWorktreePipelineSlicesCalls, 0);

        await viewModel.connect('123456');
        await pumpEventQueue();
        expect(repository.fetchWorktreePipelineSlicesCalls, 1);
        expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
        expect(repository.requestWorktreeStateCalls, 0);
        expect(repository.fetchWorktreeStateSlicesCalls, 0);
      },
    );

    test('a new session reads the same chat\'s runs again', () async {
      repository
        ..supportsForegroundChat = true
        ..worktreePipelineSlices = linkedFinishedRun();
      controller.bind('chat-a');
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 1);
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);

      // The reset drops the session's runs; the screen stays on the chat.
      await viewModel.disconnect();
      await pumpEventQueue();
      expect(controller.bind('chat-a').isEmpty, isTrue);
      await viewModel.connect('123456');
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 2);
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
      expect(repository.requestWorktreeStateCalls, 0);
      expect(repository.fetchWorktreeStateSlicesCalls, 0);
    });

    test('a failed read retries after the retry window', () async {
      repository
        ..supportsForegroundChat = true
        ..worktreePipelineSlices = linkedFinishedRun()
        ..worktreePipelineSlicesFailures = 1;
      controller.bind('chat-a');
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 1);
      expect(controller.bind('chat-a').isEmpty, isTrue);

      await untilReads(2);
      expect(repository.fetchWorktreePipelineSlicesCalls, 2);
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
    });

    test('failed reads give up after three attempts', () async {
      repository
        ..supportsForegroundChat = true
        ..worktreePipelineSlicesFailures = 99;
      controller.bind('chat-a');
      await untilReads(3);
      await Future<void>.delayed(retryWindow * 5);
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 3);
      // Later changes do not restart the read this session.
      await emit(_runJson('exec-2', links: [('chat-a', 'u-2')]));
      expect(repository.fetchWorktreePipelineSlicesCalls, 3);
    });

    test('a cold cache whose snapshot never lands retries', () async {
      repository
        ..supportsForegroundChat = true
        ..worktreePipelineSlicesRefreshing = true;
      controller.bind('chat-a');
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 1);
      repository
        ..worktreePipelineSlicesRefreshing = false
        ..worktreePipelineSlices = linkedFinishedRun();
      await untilReads(2);
      expect(repository.fetchWorktreePipelineSlicesCalls, 2);
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
    });

    group('a full activity read issued while the pipelines read is out', () {
      late Completer<void> pipelinesReply;
      late Completer<void> activityReply;
      late Future<void> activityRead;

      /// Starts the chat's pipelines read, then a full activity read for the
      /// same worktree; both replies wait for their completers.
      Future<void> startBothReads({required bool activityFails}) async {
        pipelinesReply = Completer<void>();
        activityReply = Completer<void>();
        repository
          ..supportsForegroundChat = true
          ..worktreePipelineSlices = linkedFinishedRun()
          ..worktreePipelineSlicesGate = pipelinesReply;
        controller.bind('chat-a');
        await pumpEventQueue();
        repository
          ..worktreeStateSlicesGate = activityReply
          ..worktreeStateSlicesFailures = activityFails ? 1 : 0;
        activityRead = viewModel.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        await pumpEventQueue();
        expect(repository.fetchWorktreePipelineSlicesCalls, 1);
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
      }

      test('shows the runs when that read fails after the pipelines '
          'reply', () async {
        await startBothReads(activityFails: true);
        pipelinesReply.complete();
        await pumpEventQueue();
        activityReply.complete();
        await activityRead;
        await pumpEventQueue();

        expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        expect(repository.requestWorktreeStateCalls, 0);
      });

      test('shows the runs when that read fails before the pipelines '
          'reply', () async {
        await startBothReads(activityFails: true);
        activityReply.complete();
        await activityRead;
        pipelinesReply.complete();
        await pumpEventQueue();

        expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
      });

      test('shows the runs when that read never answers', () async {
        await startBothReads(activityFails: false);
        pipelinesReply.complete();
        await pumpEventQueue();
        expect(controller.bind('chat-a').isEmpty, isTrue);

        // The held reply applies once the read deadline passes.
        await Future<void>.delayed(retryWindow * 3);
        await pumpEventQueue();
        expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        activityReply.complete();
        await activityRead;
      });

      /// Lets both reads succeed, the activity read with [activityRuns]
      /// (fixed when it starts), answering first when [activityFirst].
      Future<void> bothReadsSucceed(
        List<Map<String, dynamic>> activityRuns, {
        required bool activityFirst,
      }) async {
        repository.worktreeStateSlices = {
          'wt-1': {'pipelineRuns': activityRuns},
        };
        await startBothReads(activityFails: false);
        if (activityFirst) {
          activityReply.complete();
          await activityRead;
          pipelinesReply.complete();
          await pumpEventQueue();
        } else {
          pipelinesReply.complete();
          await pumpEventQueue();
          activityReply.complete();
          await activityRead;
        }
        await Future<void>.delayed(retryWindow * 3);
        await pumpEventQueue();
        expect(repository.fetchWorktreePipelineSlicesCalls, 1);
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
      }

      for (final activityFirst in [false, true]) {
        final order = activityFirst
            ? 'answering before the pipelines reply'
            : 'answering after the pipelines reply';

        test(
          'keeps that read\'s newer rows when it succeeds, $order',
          () async {
            await bothReadsSucceed([
              _runJson('exec-1', status: 'failed', links: [('chat-a', 'u-1')]),
            ], activityFirst: activityFirst);

            final runs = controller.bind('chat-a').runsByTurn['u-1'];
            expect(runs?.single.status, 'failed');
          },
        );

        test('keeps the pipelines reply\'s links where that read\'s newer '
            'rows omit them, $order', () async {
          await bothReadsSucceed([
            _runJson('exec-1', status: 'failed'),
          ], activityFirst: activityFirst);

          final activity = controller.bind('chat-a');
          expect(activity.runsByTurn.keys, ['u-1']);
          expect(activity.runsByTurn['u-1']?.single.status, 'failed');
        });

        test('an explicit empty link list in that read clears the pipelines '
            'reply\'s links, $order', () async {
          await bothReadsSucceed([
            _runJson('exec-1', status: 'failed', links: const []),
          ], activityFirst: activityFirst);

          expect(controller.bind('chat-a').isEmpty, isTrue);
          expect(viewModel.pipelineRunsFor('wt-1').single.status, 'failed');
          expect(viewModel.pipelineRunsFor('wt-1').single.chatTurns, isEmpty);
        });

        test('a run that read no longer lists stays gone, $order', () async {
          await bothReadsSucceed([
            _runJson('exec-2', status: 'failed'),
          ], activityFirst: activityFirst);

          expect(controller.bind('chat-a').isEmpty, isTrue);
          expect(viewModel.pipelineRunsFor('wt-1').map((run) => run.localId), [
            'exec-2',
          ]);
        });
      }
    });

    test('a drawer refresh whose rows omit chat links keeps the held links; '
        'an explicit empty list clears them', () async {
      repository
        ..supportsForegroundChat = true
        ..worktreePipelineSlices = linkedFinishedRun();
      controller.bind('chat-a');
      await pumpEventQueue();
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);

      // The desktop could not attribute chats this time, so it left the
      // field out; every other field still comes from the newer row.
      repository.worktreeStateSlices = {
        'wt-1': {
          'pipelineRuns': [_runJson('exec-1', status: 'failed')],
        },
      };
      await viewModel.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      final kept = controller.bind('chat-a').runsByTurn['u-1'];
      expect(kept?.single.localId, 'exec-1');
      expect(kept?.single.status, 'failed');
      expect(viewModel.pipelineRunsFor('wt-1').single.chatTurns, hasLength(1));

      // A refresh that omits the field again still keeps them.
      await viewModel.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);

      repository.worktreeStateSlices = {
        'wt-1': {
          'pipelineRuns': [
            _runJson('exec-1', status: 'failed', links: const []),
          ],
        },
      };
      await viewModel.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      expect(controller.bind('chat-a').isEmpty, isTrue);
      expect(viewModel.pipelineRunsFor('wt-1').single.chatTurns, isEmpty);
    });

    test('a settled refresh without the run still removes it', () async {
      repository
        ..supportsForegroundChat = true
        ..worktreePipelineSlices = linkedFinishedRun();
      controller.bind('chat-a');
      await pumpEventQueue();
      expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);

      repository.worktreeStateSlices = {
        'wt-1': {'pipelineRuns': <Object?>[]},
      };
      await viewModel.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      expect(viewModel.pipelineRunsFor('wt-1'), isEmpty);
      expect(controller.bind('chat-a').isEmpty, isTrue);
    });

    test('a pipelines read whose rows omit chat links keeps the links the '
        'snapshot holds', () async {
      await viewModel.disconnect();
      repository
        ..supportsForegroundChat = true
        ..snapshotBuilder = (() => RemoteSessionSnapshot(
          workspaces: const [],
          standaloneChats: const [],
          worktrees: const [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          chatSummaries: const [],
          chatMessages: const [],
          raw: {
            'pipelineRuns': [
              _runJson('exec-1', links: [('chat-a', 'u-1')]),
            ],
          },
        ))
        ..worktreePipelineSlices = {
          'wt-1': {
            'pipelineRuns': [_runJson('exec-1', status: 'success')],
          },
        };
      await viewModel.connect('123456');
      controller.bind('chat-a');
      await pumpEventQueue();

      expect(repository.fetchWorktreePipelineSlicesCalls, 1);
      final kept = controller.bind('chat-a').runsByTurn['u-1'];
      expect(kept?.single.localId, 'exec-1');
      expect(kept?.single.status, 'success');
    });

    test('older hosts and hosts without links read nothing here', () async {
      // Without foreground chat, opening the chat hydrates the worktree.
      controller.bind('chat-a');
      repository
        ..supportsForegroundChat = true
        ..supportsPipelineRunChatLinks = false;
      controller.bind('chat-b');
      await pumpEventQueue();
      expect(repository.fetchWorktreePipelineSlicesCalls, 0);
    });

    test('without the capability no chat has activity', () async {
      repository.supportsPipelineRunChatLinks = false;
      await emit(_runJson('exec-1', links: [('chat-a', 'u-1')]));
      expect(controller.bind('chat-a').isEmpty, isTrue);
    });

    test('the latest turn starts expanded; choices hold per chat', () {
      expect(
        controller.isExpanded('chat-a', 'u-2', latestTurnKey: 'u-2'),
        isTrue,
      );
      expect(
        controller.isExpanded('chat-a', 'u-1', latestTurnKey: 'u-2'),
        isFalse,
      );

      controller.toggle('chat-a', 'u-2', latestTurnKey: 'u-2');
      controller.toggle('chat-a', 'u-1', latestTurnKey: 'u-2');
      expect(notifications, 2);
      expect(
        controller.isExpanded('chat-a', 'u-2', latestTurnKey: 'u-2'),
        isFalse,
      );
      expect(
        controller.isExpanded('chat-a', 'u-1', latestTurnKey: 'u-2'),
        isTrue,
      );
      // A newer turn gaining activity leaves the explicit choices alone.
      expect(
        controller.isExpanded('chat-a', 'u-1', latestTurnKey: 'u-3'),
        isTrue,
      );
      // Another chat's same turn key keeps its own default.
      expect(
        controller.isExpanded('chat-b', 'u-2', latestTurnKey: 'u-2'),
        isTrue,
      );
    });

    test('cancel sends the scoped pipeline cancel command', () async {
      await emit(_runJson('exec-1', links: [('chat-a', 'u-1')]));
      await controller.cancel('exec-1');
      final action = repository.pipelineRunActions.single;
      expect(action.action, RemotePipelineRunAction.cancel);
      expect(action.executionId, 'exec-1');
      expect(action.worktreeLocalId, 'wt-1');
    });
  });

  group('pipeline read deadline', () {
    const tick = Duration(milliseconds: 1);

    Map<String, Map<String, dynamic>> linkedRun(String status) => {
      'wt-1': {
        'pipelineRuns': [
          _runJson('exec-1', status: status, links: [('chat-a', 'u-1')]),
        ],
      },
    };

    /// Runs [body] on a fake clock with the production hydration budgets
    /// and a foreground-chat host bound to chat-a.
    void withBoundChat(
      void Function(
        FakeAsync time,
        FakeRemoteControlRepository repository,
        PipelineRunChatActivityController controller,
        void Function() pipelinesSnapshot,
      )
      body,
    ) {
      fakeAsync((time) {
        var cursor = 0;
        final repository = FakeRemoteControlRepository()
          ..supportsForegroundChat = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            standaloneChats: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            chatSummaries: [],
            chatMessages: [],
          );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          clock: () => DateTime(2026).add(time.elapsed),
        );
        viewModel.connect('123456');
        time.flushMicrotasks();
        final controller = PipelineRunChatActivityController(
          viewModel: viewModel,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        void pipelinesSnapshot() {
          cursor += 1;
          repository.eventsController.add(
            RemotePortalEventBatch(
              nextCursor: cursor,
              events: const [
                RemoteStateSnapshotEvent(
                  scope: 'pipelines',
                  targetWorkspaceLocalId: 'ws-1',
                  targetWorktreeLocalId: 'wt-1',
                ),
              ],
            ),
          );
          time.flushMicrotasks();
        }

        body(time, repository, controller, pipelinesSnapshot);
        expect(repository.requestWorktreeStateCalls, 0);
        expect(repository.fetchWorktreeStateSlicesCalls, 0);
        controller.dispose();
        viewModel.dispose();
        time.flushMicrotasks();
      });
    }

    test('an unanswered read expires and retries the narrow read', () {
      withBoundChat((time, repository, controller, _) {
        final unanswered = Completer<void>();
        repository
          ..worktreePipelineSlices = linkedRun('running')
          ..worktreePipelineSlicesGate = unanswered;
        controller.bind('chat-a');
        time.flushMicrotasks();
        expect(repository.fetchWorktreePipelineSlicesCalls, 1);

        time.elapse(kRemoteHydrationTimeout - tick);
        controller.bind('chat-a');
        time.flushMicrotasks();
        expect(repository.fetchWorktreePipelineSlicesCalls, 1);

        repository
          ..worktreePipelineSlicesGate = null
          ..worktreePipelineSlices = linkedRun('success');
        time.elapse(tick + kRemoteHydrationRetryWindow);
        expect(repository.fetchWorktreePipelineSlicesCalls, 2);
        final runs = controller.bind('chat-a').runsByTurn['u-1'];
        expect(runs?.single.status, 'success');

        // The expired attempt's late reply cannot overwrite the retry.
        unanswered.complete();
        time.flushMicrotasks();
        expect(
          controller.bind('chat-a').runsByTurn['u-1']?.single.status,
          'success',
        );
        time.elapse(kRemoteHydrationTimeout * 3);
        expect(repository.fetchWorktreePipelineSlicesCalls, 2);
      });
    });

    test('unanswered reads give up after three attempts', () {
      withBoundChat((time, repository, controller, _) {
        repository.worktreePipelineSlicesGate = Completer<void>();
        controller.bind('chat-a');
        time.flushMicrotasks();
        time.elapse(
          (kRemoteHydrationTimeout + kRemoteHydrationRetryWindow) * 5,
        );
        expect(repository.fetchWorktreePipelineSlicesCalls, 3);
        expect(controller.bind('chat-a').isEmpty, isTrue);
      });
    });

    test('a snapshot that landed during an expired read is honoured by the '
        'retry', () {
      withBoundChat((time, repository, controller, pipelinesSnapshot) {
        repository
          ..worktreePipelineSlicesRefreshing = true
          ..worktreePipelineSlicesGate = Completer<void>();
        controller.bind('chat-a');
        time.flushMicrotasks();
        pipelinesSnapshot();
        time.elapse(kRemoteHydrationTimeout);

        // The retry's cold-cache reply reads again at once instead of
        // waiting for a snapshot that already landed.
        final retryReply = Completer<void>();
        repository.worktreePipelineSlicesGate = retryReply;
        time.elapse(kRemoteHydrationRetryWindow);
        expect(repository.fetchWorktreePipelineSlicesCalls, 2);
        repository
          ..worktreePipelineSlicesRefreshing = false
          ..worktreePipelineSlicesGate = null
          ..worktreePipelineSlices = linkedRun('success');
        retryReply.complete();
        time.flushMicrotasks();
        expect(repository.fetchWorktreePipelineSlicesCalls, 3);
        expect(controller.bind('chat-a').runsByTurn.keys, ['u-1']);
      });
    });
  });
}
