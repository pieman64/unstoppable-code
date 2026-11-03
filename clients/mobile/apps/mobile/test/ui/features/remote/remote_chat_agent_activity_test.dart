// CAN-3619: a worktree chat shows, under each turn, the pipeline runs the
// desktop links to that turn (`PortalPipelineRun.chatTurns`).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';
import 'package:provider/provider.dart';

import '../../../support/chat_tabs_sheet_driver.dart';
import '../../../support/fake_remote_control_repository.dart';

const _chatId = 'chat-a';

Map<String, dynamic> _link(
  String userMessageId, {
  String chatId = _chatId,
  String relation = 'launched',
}) => {'chatId': chatId, 'userMessageId': userMessageId, 'relation': relation};

Map<String, dynamic> _run(
  String id, {
  String name = 'Mobile Factory · Experiment v2 · Factory',
  String status = 'running',
  List<Map<String, dynamic>>? chatTurns,
  String worktreeLocalId = 'wt-1',
  bool hidden = false,
  String? parentExecutionId,
  Duration startedAgo = const Duration(minutes: 40),
  List<Map<String, dynamic>>? jobs,
}) => {
  'localId': id,
  'pipelineId': 'pipeline-$id',
  'pipelineName': name,
  'workspaceLocalId': 'ws-1',
  'worktreeLocalId': worktreeLocalId,
  'status': status,
  'startedAt': DateTime.now().toUtc().subtract(startedAgo).toIso8601String(),
  'hidden': hidden,
  'parentExecutionId': ?parentExecutionId,
  'chatTurns': ?chatTurns,
  'jobs':
      jobs ??
      [
        {'jobId': 'plan', 'name': 'Plan', 'status': 'success', 'needs': []},
        {
          'jobId': 'build',
          'name': 'Build',
          'status': status == 'running' ? 'running' : status,
          'needs': ['plan'],
        },
        {
          'jobId': 'verify',
          'name': 'Verify',
          'status': 'pending',
          'needs': ['build'],
        },
      ],
};

RemoteChatMessage _user(String id, String text) => RemoteChatMessage(
  messageId: id,
  chatId: _chatId,
  role: ChatRole.user,
  status: ChatMessageStatus.complete,
  text: text,
);

RemoteChatMessage _answer(String id, String text) => RemoteChatMessage(
  messageId: id,
  chatId: _chatId,
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: text,
);

RemoteChatMessage _timer(String turn, {required bool completed}) {
  final now = DateTime.now().millisecondsSinceEpoch;
  return RemoteChatMessage(
    messageId: '$turn:turn-timer',
    chatId: _chatId,
    role: ChatRole.system,
    status: completed
        ? ChatMessageStatus.complete
        : ChatMessageStatus.streaming,
    text: '',
    parts: [
      ChatPart(
        kind: 'turn_timer',
        data: {'startedAt': now - 68000, 'completedAt': completed ? now : null},
      ),
    ],
  );
}

/// Two completed turns: `u-1` (older) and `u-2` (latest).
List<RemoteChatMessage> _twoCompletedTurns() => [
  _user('u-1', 'Start the factory'),
  _answer('a-1', 'Started the factory pipeline.'),
  _timer('u-1', completed: true),
  _user('u-2', 'Run it again'),
  _answer('a-2', 'Started another run.'),
  _timer('u-2', completed: true),
];

void main() {
  void usePhoneViewport(WidgetTester tester, {double textScale = 1}) {
    // 390 logical px wide, the narrow phone width the panel must fit.
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }

  FakeRemoteControlRepository repositoryWith(
    List<RemoteChatMessage> messages, {
    bool capability = true,
    List<RemoteWorkspace> workspaces = const [],
  }) => FakeRemoteControlRepository()
    ..supportsPipelineRunChatLinks = capability
    ..snapshotBuilder = () => RemoteSessionSnapshot(
      workspaces: workspaces,
      standaloneChats: const [],
      worktrees: const [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        ),
      ],
      chatSummaries: const [
        RemoteChatSummary(
          chatId: _chatId,
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat A',
          active: true,
        ),
      ],
      chatMessages: messages,
    );

  Widget buildSubject(
    RemoteControlViewModel viewModel,
    Widget screen, {
    ThemeMode themeMode = ThemeMode.light,
  }) => MultiProvider(
    providers: [
      ChangeNotifierProvider<RemoteControlViewModel>.value(value: viewModel),
      ChangeNotifierProvider<TurnFeedbackController>(
        create: (_) =>
            TurnFeedbackController(repository: MockTurnFeedbackRepository()),
      ),
    ],
    child: MaterialApp(
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: themeMode,
      home: screen,
    ),
  );

  Future<RemoteControlViewModel> openWorktreeChat(
    WidgetTester tester,
    FakeRemoteControlRepository repository, {
    ThemeMode themeMode = ThemeMode.light,
  }) async {
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await tester.runAsync(() => viewModel.connect('123456'));
    await tester.pumpWidget(
      buildSubject(
        viewModel,
        RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
        themeMode: themeMode,
      ),
    );
    await tester.pump();
    await tester.pump();
    return viewModel;
  }

  Future<void> emitRuns(
    WidgetTester tester,
    FakeRemoteControlRepository repository,
    List<Map<String, dynamic>> runs, {
    int cursor = 1,
  }) async {
    repository.eventsController.add(
      RemotePortalEventBatch.fromJson({
        'events': [
          for (final run in runs)
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
    await tester.pump();
    await tester.pump();
  }

  Future<void> close(WidgetTester tester, RemoteControlViewModel vm) async {
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
  }

  Finder panel(String turnKey) =>
      find.byKey(ValueKey('agent-activity:$turnKey'));
  Finder toggle(String turnKey) =>
      find.byKey(ValueKey('agent-activity-toggle:$turnKey'));
  Finder card(String executionId) =>
      find.byKey(ValueKey('agent-activity-run:$executionId'));
  Finder cancel(String executionId) =>
      find.byKey(ValueKey('agent-activity-cancel:$executionId'));

  testWidgets('a run launched from a turn shows one card under that turn', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith([
      _user('u-1', 'Start the factory'),
      _answer('a-1', 'Started the factory pipeline.'),
      _timer('u-1', completed: true),
    ]);
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-1')]),
    ]);

    expect(panel('u-1'), findsOneWidget);
    expect(
      find.descendant(of: panel('u-1'), matching: find.text('Agent activity')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: panel('u-1'), matching: find.text('1 item')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: card('exec-1'),
        matching: find.text('Mobile Factory · Experiment v2 · Factory'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: card('exec-1'), matching: find.text('Running')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: card('exec-1'), matching: find.text('40m ago')),
      findsOneWidget,
    );
    // One dot per logical job.
    for (final job in ['plan', 'build', 'verify']) {
      expect(
        find.byKey(ValueKey('pipeline-run-dot:exec-1:$job')),
        findsOneWidget,
      );
    }
    // After the turn footer.
    expect(
      tester.getTopLeft(panel('u-1')).dy,
      greaterThanOrEqualTo(
        tester
            .getBottomLeft(
              find.byKey(const ValueKey('remote-chat-completed-indicator')),
            )
            .dy,
      ),
    );

    // A second run from the same turn.
    await emitRuns(tester, repository, [
      _run(
        'exec-2',
        name: 'Release checks',
        startedAgo: const Duration(minutes: 5),
        chatTurns: [_link('u-1')],
      ),
    ], cursor: 2);
    expect(
      find.descendant(of: panel('u-1'), matching: find.text('2 items')),
      findsOneWidget,
    );
    expect(card('exec-1'), findsOneWidget);
    expect(card('exec-2'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('a live turn shows the panel under its working row', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith([
      _user('u-1', 'Start the factory'),
      _timer('u-1', completed: false),
    ]);
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-1')]),
    ]);

    expect(panel('u-1'), findsOneWidget);
    expect(
      tester.getTopLeft(panel('u-1')).dy,
      greaterThanOrEqualTo(
        tester
            .getBottomLeft(
              find.byKey(const ValueKey('remote-chat-working-indicator')),
            )
            .dy,
      ),
    );
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('watched runs appear under every turn desktop assigns', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith(_twoCompletedTurns());
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run(
        'exec-w',
        name: 'Nightly',
        chatTurns: [
          _link('u-1', relation: 'watching'),
          _link('u-2', relation: 'watching'),
        ],
      ),
    ]);

    expect(panel('u-1'), findsOneWidget);
    expect(panel('u-2'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('status and job changes update the card without a refresh', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith([
      _user('u-1', 'Start the factory'),
      _answer('a-1', 'Started.'),
      _timer('u-1', completed: true),
    ]);
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-1')]),
    ]);
    expect(cancel('exec-1'), findsOneWidget);

    // A live upsert without the links keeps the card where it is.
    final settled = _run('exec-1', status: 'failure')..remove('chatTurns');
    await emitRuns(tester, repository, [settled], cursor: 2);

    expect(
      find.descendant(of: card('exec-1'), matching: find.text('Failed')),
      findsOneWidget,
    );
    expect(cancel('exec-1'), findsNothing);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets(
    'Cancel sends one command, reads Cancelling…, and settles on the update',
    (tester) async {
      usePhoneViewport(tester);
      final repository = repositoryWith([
        _user('u-1', 'Start the factory'),
        _answer('a-1', 'Started.'),
        _timer('u-1', completed: true),
      ]);
      final vm = await openWorktreeChat(tester, repository);
      await emitRuns(tester, repository, [
        _run('exec-1', chatTurns: [_link('u-1')]),
      ]);

      await tester.tap(cancel('exec-1'));
      await tester.pump();
      await tester.pump();

      expect(repository.pipelineRunActions, hasLength(1));
      expect(
        repository.pipelineRunActions.single.action,
        RemotePipelineRunAction.cancel,
      );
      expect(
        find.descendant(
          of: cancel('exec-1'),
          matching: find.text('Cancelling…'),
        ),
        findsOneWidget,
      );
      // Disabled: a second tap sends nothing and does not open the run.
      await tester.tap(cancel('exec-1'), warnIfMissed: false);
      await tester.pump();
      expect(repository.pipelineRunActions, hasLength(1));
      expect(find.byType(RemotePipelineRunScreen), findsNothing);

      await emitRuns(tester, repository, [
        _run('exec-1', status: 'cancelled', chatTurns: [_link('u-1')]),
      ], cursor: 2);

      expect(
        find.descendant(of: card('exec-1'), matching: find.text('Canceled')),
        findsOneWidget,
      );
      expect(cancel('exec-1'), findsNothing);
      expect(tester.takeException(), isNull);
      await close(tester, vm);
    },
  );

  testWidgets('a rejected cancel shows the error and keeps the run state', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository =
        repositoryWith([
            _user('u-1', 'Start the factory'),
            _answer('a-1', 'Started.'),
            _timer('u-1', completed: true),
          ])
          ..pipelineRunActionError = const RemoteControlException(
            'The desktop could not cancel this run.',
          );
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-1')]),
    ]);

    await tester.tap(cancel('exec-1'));
    await tester.pump();
    await tester.pump();

    expect(
      find.descendant(
        of: panel('u-1'),
        matching: find.text('The desktop could not cancel this run.'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: card('exec-1'), matching: find.text('Running')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: cancel('exec-1'), matching: find.text('Cancel')),
      findsOneWidget,
    );

    // Usable again.
    repository.pipelineRunActionError = null;
    await tester.tap(cancel('exec-1'));
    await tester.pump();
    expect(repository.pipelineRunActions, hasLength(2));
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('tapping a card opens the run screen for that execution', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith([
      _user('u-1', 'Start the factory'),
      _answer('a-1', 'Started.'),
      _timer('u-1', completed: true),
    ]);
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-1')]),
    ]);

    await tester.tap(
      find.descendant(
        of: card('exec-1'),
        matching: find.text('Mobile Factory · Experiment v2 · Factory'),
      ),
    );
    // The running card's dots pulse, so the route transitions are pumped
    // for a fixed time instead of settled.
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    final screen = tester.widget<RemotePipelineRunScreen>(
      find.byType(RemotePipelineRunScreen),
    );
    expect(screen.executionId, 'exec-1');
    expect(screen.worktreeLocalId, 'wt-1');
    expect(repository.pipelineRunActions, isEmpty);

    await tester.pageBack();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.byType(RemotePipelineRunScreen), findsNothing);
    expect(panel('u-1'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('only the latest panel starts expanded and toggles hold', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith(_twoCompletedTurns());
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-1')]),
      _run('exec-2', name: 'Release checks', chatTurns: [_link('u-2')]),
    ]);

    expect(panel('u-1'), findsOneWidget);
    expect(panel('u-2'), findsOneWidget);
    expect(card('exec-1'), findsNothing);
    expect(card('exec-2'), findsOneWidget);

    await tester.tap(toggle('u-1'));
    await tester.pump();
    await tester.tap(toggle('u-2'));
    await tester.pump();
    expect(card('exec-1'), findsOneWidget);
    expect(card('exec-2'), findsNothing);

    // A live update and a new message keep the user's choices.
    await emitRuns(tester, repository, [
      _run('exec-2', name: 'Release checks', status: 'success'),
    ], cursor: 2);
    expect(card('exec-1'), findsOneWidget);
    expect(card('exec-2'), findsNothing);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('turns without visible linked root runs show no panel', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith(_twoCompletedTurns());
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      // Hidden, child, another chat, an unknown turn, another worktree.
      _run('hidden', hidden: true, chatTurns: [_link('u-1')]),
      _run('child', parentExecutionId: 'root', chatTurns: [_link('u-1')]),
      _run('other-chat', chatTurns: [_link('u-1', chatId: 'chat-b')]),
      _run('unknown-turn', chatTurns: [_link('u-gone')]),
      _run('other-wt', worktreeLocalId: 'wt-2', chatTurns: [_link('u-2')]),
      // Unlinked.
      _run('plain'),
    ]);

    expect(find.text('Agent activity'), findsNothing);

    // Links removed from a run that had them clear its panel.
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-2')]),
    ], cursor: 2);
    expect(panel('u-2'), findsOneWidget);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: const []),
    ], cursor: 3);
    expect(find.text('Agent activity'), findsNothing);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('a desktop without the capability shows no panel', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith(_twoCompletedTurns(), capability: false);
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-2')]),
    ]);

    expect(find.text('Agent activity'), findsNothing);
    // The run itself is still known to Activity & files.
    expect(vm.pipelineRunsFor('wt-1').map((run) => run.localId), ['exec-1']);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets(
    'a foreground-chat host hydrates finished runs the session has not cached',
    (tester) async {
      usePhoneViewport(tester);
      // Foreground chat opens without the worktree activity slices, and a
      // finished run sends no live update, so only hydration can show it.
      final repository = repositoryWith(_twoCompletedTurns())
        ..supportsForegroundChat = true
        ..worktreePipelineSlices = {
          'wt-1': {
            'pipelineRuns': [
              _run('exec-1', status: 'success', chatTurns: [_link('u-2')]),
            ],
          },
        };
      final vm = await openWorktreeChat(tester, repository);
      await tester.pump();

      expect(repository.fetchWorktreePipelineSlicesCalls, 1);
      expect(panel('u-2'), findsOneWidget);
      expect(card('exec-1'), findsOneWidget);
      expect(find.byType(Drawer), findsNothing);
      // The tray reads cached processes separately without an explicit
      // full-worktree projection command (CAN-3101).
      expect(repository.requestWorktreeStateCalls, 0);
      expect(repository.fetchWorktreeStateSlicesCalls, 1);

      // Rebuilds and later events do not read again.
      await emitRuns(tester, repository, [
        _run('exec-2', chatTurns: [_link('u-1')]),
      ]);
      expect(repository.fetchWorktreePipelineSlicesCalls, 1);
      expect(tester.takeException(), isNull);
      await close(tester, vm);
    },
  );

  testWidgets(
    'a foreground-chat host binds panels and reads runs outside builds',
    (tester) async {
      usePhoneViewport(tester);
      final repository = _BuildProbeRepository()
        ..supportsForegroundChat = true
        ..worktreePipelineSlices = {
          'wt-1': {
            'pipelineRuns': [
              _run('exec-a', status: 'success', chatTurns: [_link('u-2')]),
              _run(
                'exec-b',
                status: 'success',
                chatTurns: [_link('bu-1', chatId: 'chat-b')],
              ),
            ],
          },
        }
        ..snapshotBuilder = () => RemoteSessionSnapshot(
          workspaces: const [],
          standaloneChats: const [],
          worktrees: const [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          chatSummaries: const [
            RemoteChatSummary(
              chatId: _chatId,
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
            ),
            RemoteChatSummary(
              chatId: 'chat-b',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat B',
            ),
          ],
          chatMessages: [
            ..._twoCompletedTurns(),
            const RemoteChatMessage(
              messageId: 'bu-1',
              chatId: 'chat-b',
              role: ChatRole.user,
              status: ChatMessageStatus.complete,
              text: 'Start in chat B',
            ),
            const RemoteChatMessage(
              messageId: 'ba-1',
              chatId: 'chat-b',
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: 'Started in chat B.',
            ),
          ],
        );
      final vm = await openWorktreeChat(tester, repository);
      await tester.pump();

      expect(repository.readsFromBuild, [false]);
      expect(card('exec-a'), findsOneWidget);
      expect(card('exec-b'), findsNothing);

      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();

      expect(find.text('Started in chat B.'), findsOneWidget);
      expect(card('exec-b'), findsOneWidget);
      expect(card('exec-a'), findsNothing);
      expect(repository.readsFromBuild, [false]);
      expect(tester.takeException(), isNull);
      await close(tester, vm);
    },
  );

  testWidgets(
    'a drawer refresh whose run rows omit chat links keeps the panel',
    (tester) async {
      usePhoneViewport(tester);
      final repository = repositoryWith(_twoCompletedTurns())
        ..supportsForegroundChat = true
        ..worktreePipelineSlices = {
          'wt-1': {
            'pipelineRuns': [
              _run('exec-1', status: 'success', chatTurns: [_link('u-2')]),
            ],
          },
        };
      final vm = await openWorktreeChat(tester, repository);
      await tester.pump();
      expect(card('exec-1'), findsOneWidget);

      // Activity & files re-reads the worktree; the desktop could not
      // attribute chats this time and left `chatTurns` out.
      repository.worktreeStateSlices = {
        'wt-1': {
          'pipelineRuns': [_run('exec-1', status: 'failed')],
        },
      };
      await tester.runAsync(
        () => vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
      );
      await tester.pump();

      expect(repository.fetchWorktreeStateSlicesCalls, 2);
      expect(panel('u-2'), findsOneWidget);
      expect(card('exec-1'), findsOneWidget);
      expect(
        vm.pipelineRunsFor('wt-1').single.chatTurns?.single.userMessageId,
        'u-2',
      );
      expect(tester.takeException(), isNull);
      await close(tester, vm);
    },
  );

  testWidgets('a cowork entry on a foreground-chat host hydrates no runs', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith(
      _twoCompletedTurns(),
      workspaces: const [
        RemoteWorkspace(
          localId: 'ws-1',
          name: 'Cowork',
          type: RemoteWorkspaceType.cowork,
        ),
      ],
    )..supportsForegroundChat = true;
    final vm = await openWorktreeChat(tester, repository);

    expect(repository.fetchWorktreePipelineSlicesCalls, 0);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('a standalone chat shows no panel', (tester) async {
    usePhoneViewport(tester);
    const chat = RemoteStandaloneChat(
      localId: 'chat-s',
      projectLocalId: 'ws-1',
      title: 'Cowork chat',
    );
    final repository = FakeRemoteControlRepository()
      ..snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [],
        standaloneChats: const [chat],
        chatMessages: [
          RemoteChatMessage(
            messageId: 'u-s',
            chatId: 'chat-s',
            scope: RemoteChatScope.standalone,
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Start it',
          ),
        ],
      );
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await tester.runAsync(() => vm.connect('123456'));
    await tester.pumpWidget(
      buildSubject(vm, const RemoteChatScreen.standalone(standaloneChat: chat)),
    );
    await tester.pump();
    await emitRuns(tester, repository, [
      _run(
        'exec-s',
        worktreeLocalId: 'chat-s',
        chatTurns: [_link('u-s', chatId: 'chat-s')],
      ),
    ]);

    expect(find.text('Agent activity'), findsNothing);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('a cowork entry in the worktree slot shows no panel', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = repositoryWith(
      _twoCompletedTurns(),
      workspaces: const [
        RemoteWorkspace(
          localId: 'ws-1',
          name: 'Cowork',
          type: RemoteWorkspaceType.cowork,
        ),
      ],
    );
    final vm = await openWorktreeChat(tester, repository);
    await emitRuns(tester, repository, [
      _run('exec-1', chatTurns: [_link('u-2')]),
    ]);

    expect(find.text('Agent activity'), findsNothing);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    testWidgets(
      'lays out at 390px with large text in ${mode.name} mode with 44px targets',
      (tester) async {
        usePhoneViewport(tester, textScale: 2);
        final repository = repositoryWith([
          _user('u-1', 'Start the factory'),
          _answer('a-1', 'Started.'),
          _timer('u-1', completed: true),
        ]);
        final vm = await openWorktreeChat(tester, repository, themeMode: mode);
        await emitRuns(tester, repository, [
          _run(
            'exec-1',
            name:
                'A deliberately long pipeline name that cannot fit on one '
                'narrow phone row without truncation',
            chatTurns: [_link('u-1')],
            jobs: [
              for (var i = 0; i < 24; i += 1)
                {
                  'jobId': 'job-$i',
                  'name': 'Job $i',
                  'status': i < 4
                      ? 'success'
                      : (i == 4 ? 'running' : 'pending'),
                  'needs': i == 0 ? <String>[] : ['job-${i - 1}'],
                },
            ],
          ),
        ]);

        expect(tester.takeException(), isNull);
        await tester.scrollUntilVisible(
          cancel('exec-1'),
          100,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pump();
        for (final target in [
          toggle('u-1'),
          cancel('exec-1'),
          card('exec-1'),
        ]) {
          final size = tester.getSize(target);
          expect(size.width, greaterThanOrEqualTo(44));
          expect(size.height, greaterThanOrEqualTo(44));
        }
        expect(tester.takeException(), isNull);
        await close(tester, vm);
      },
    );
  }
}

/// Whether a widget build method is on the current call stack. Lifecycle
/// methods and listeners run after their ancestors' builds have returned.
bool _calledFromBuild() => RegExp(
  r'\.build(\.<anonymous closure>)* \(',
).hasMatch(StackTrace.current.toString());

/// Records, for each pipeline-run read, whether a build started it.
final class _BuildProbeRepository extends FakeRemoteControlRepository {
  final readsFromBuild = <bool>[];

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreePipelineSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    readsFromBuild.add(_calledFromBuild());
    return super.fetchWorktreePipelineSlices(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    );
  }
}
