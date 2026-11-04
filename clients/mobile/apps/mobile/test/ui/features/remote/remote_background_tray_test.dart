import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';
import 'package:provider/provider.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/reduced_motion.dart';

const trayWorktree = RemoteWorktree(
  localId: 'wt',
  workspaceLocalId: 'ws',
  branch: 'feature/background-work',
);

RemoteSessionSnapshot traySnapshot({
  int tasks = 1,
  String taskStatus = 'running',
  String? runStatus,
  List<Map<String, dynamic>> runPauses = const [],
  List<ChatPart> parts = const [],
}) => RemoteSessionSnapshot(
  workspaces: const [],
  worktrees: const [trayWorktree],
  standaloneChats: const [],
  chatSummaries: const [
    RemoteChatSummary(
      chatId: 'chat',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      title: 'Review the changes',
      active: true,
    ),
  ],
  chatMessages: [
    RemoteChatMessage(
      messageId: 'message',
      parts: parts,
      chatId: 'chat',
      scope: RemoteChatScope.worktree,
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text:
          'The review is running in the background. You can keep working here.',
    ),
  ],
  raw: {
    if (runStatus != null)
      'pipelineRuns': [
        {
          'localId': 'run',
          'pipelineName': 'Review pipeline',
          'status': runStatus,
          'workspaceLocalId': 'ws',
          'worktreeLocalId': 'wt',
          'pendingPauses': runPauses,
          'chatTurns': [
            {
              'chatId': 'chat',
              'userMessageId': 'message',
              'relation': 'launched',
            },
          ],
        },
      ],
    'backgroundProcesses': [
      for (var i = 0; i < tasks; i++)
        {
          'localId': 'task-$i',
          'workspaceLocalId': 'ws',
          'worktreeLocalId': 'wt',
          'chatId': 'chat',
          'toolUseId': 'tool-$i',
          'taskId': 'provider-$i',
          'kind': 'bash',
          'description': 'Check package $i',
          'status': taskStatus,
          'startedAt': 1000,
          'updatedAt': 2000,
          'lastDescription': 'Running checks',
        },
    ],
  },
);

Widget trayScreenHost(
  RemoteControlViewModel vm, {
  bool dark = false,
  Widget? screen,
}) => MultiProvider(
  providers: [
    ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
    ChangeNotifierProvider<TurnFeedbackController>(
      create: (_) =>
          TurnFeedbackController(repository: MockTurnFeedbackRepository()),
    ),
  ],
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: dark ? AppTheme.dark : AppTheme.light,
    home: screen ?? const RemoteChatScreen.worktree(worktree: trayWorktree),
  ),
);

void main() {
  useReducedMotion();
  testWidgets(
    'agent Open chat shows the live retained transcript and returns to the tray',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      var result = 'Inspecting the implementation';
      var running = true;
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => traySnapshot(
          tasks: 0,
          parts: [
            const ChatPart(
              kind: 'agent',
              data: {
                'delegation': {
                  'delegationId': 'review',
                  'runGeneration': 1,
                  'description': 'Review changes',
                  'executionMode': 'background',
                  'status': 'completed',
                  'prompt': 'Review the release changes',
                },
                'subBlocks': [
                  {
                    'kind': 'text',
                    'data': {'text': 'Earlier review finished'},
                  },
                ],
              },
            ),
            ChatPart(
              kind: 'agent',
              data: {
                'delegation': {
                  'delegationId': 'review',
                  'runGeneration': 2,
                  'description': 'Review changes',
                  'executionMode': 'background',
                  'status': running ? 'running' : 'completed',
                  'prompt': 'Check cancellation first',
                  'requestedModelId': 'review-model',
                },
                'subBlocks': [
                  {
                    'kind': 'text',
                    'data': {
                      'text': 'Check cancellation first',
                      'delegationAuthorKind': 'user',
                      'delegationDelivery': 'follow_up',
                    },
                  },
                  {
                    'kind': 'text',
                    'data': {
                      'text': 'Keep the retry logic intact',
                      'delegationAuthorKind': 'agent',
                      'delegationAuthorDescription': 'Release coordinator',
                    },
                  },
                  {
                    'kind': 'text',
                    'data': {'text': result},
                  },
                ],
              },
            ),
          ],
        );
      final vm = RemoteControlViewModel(repository: repo);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(trayScreenHost(vm));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
      await tester.pump();
      await tester.tap(find.text('Review changes').last);
      await tester.pumpAndSettle();
      expect(find.text('Open chat'), findsOneWidget);
      final openChatText = tester.widget<RichText>(
        find.descendant(
          of: find.text('Open chat'),
          matching: find.byType(RichText),
        ),
      );
      expect(openChatText.text.style?.fontSize, 13);
      await tester.tap(find.text('Open chat'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('background-agent-chat')),
        findsOneWidget,
      );
      expect(find.text('Review the release changes'), findsOneWidget);
      expect(
        find.textContaining('Earlier review finished', findRichText: true),
        findsOneWidget,
      );
      expect(
        find.textContaining('Check cancellation first', findRichText: true),
        findsOneWidget,
      );
      expect(find.text('Release coordinator'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('user-bubble-run-2-child-0')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('user-bubble-run-2-child-1')),
        findsOneWidget,
      );
      expect(
        find.textContaining(
          'Inspecting the implementation',
          findRichText: true,
        ),
        findsOneWidget,
      );
      result = 'The review found no issues';
      running = false;
      await tester.runAsync(vm.refresh);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('The review found no issues', findRichText: true),
        findsOneWidget,
      );
      expect(find.text('Send'), findsNothing);
      expect(find.byKey(const ValueKey('composer-send')), findsNothing);
      expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
      expect(find.textContaining('Stop'), findsNothing);
      await tester.runAsync(vm.disconnect);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpAndSettle();
      expect(find.text('This agent is no longer available.'), findsOneWidget);
      expect(
        find.textContaining('The review found no issues', findRichText: true),
        findsNothing,
      );
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('background-agent-chat')), findsNothing);
      expect(find.byKey(const ValueKey('background-tray')), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    },
  );

  testWidgets(
    'fresh foreground chat loads existing tasks through scoped worktree hydration',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final repo = FakeRemoteControlRepository()
        ..supportsForegroundChat = true
        ..snapshotBuilder = (() => traySnapshot(tasks: 0))
        ..worktreeStateSlices = {'wt': traySnapshot().raw};
      final vm = RemoteControlViewModel(
        repository: repo,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      expect(repo.requestWorktreeStateCalls, 0);
      await tester.pumpWidget(trayScreenHost(vm));
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pumpAndSettle();
      expect(find.text('1 running in the background'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
      await tester.pump();
      expect(find.text('Check package 0'), findsOneWidget);
      expect(repo.requestWorktreeStateCalls, 0);
      expect(repo.fetchWorktreeStateSlicesCalls, 1);
      // A remount shares the session's already hydrated worktree.
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(trayScreenHost(vm));
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pumpAndSettle();
      expect(repo.requestWorktreeStateCalls, 0);
      await tester.runAsync(vm.disconnect);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pumpAndSettle();
      expect(find.text('1 running in the background'), findsOneWidget);
      expect(repo.requestWorktreeStateCalls, 0);
      expect(repo.fetchWorktreeStateSlicesCalls, 2);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    },
  );

  testWidgets('settled tasks immediately leave the tray with their inspector', (
    tester,
  ) async {
    var status = 'running';
    final repo = FakeRemoteControlRepository()
      ..snapshotBuilder = () => traySnapshot(taskStatus: status);
    final vm = RemoteControlViewModel(repository: repo);
    await tester.runAsync(() => vm.connect('123456'));
    await tester.pumpWidget(trayScreenHost(vm));
    for (final terminal in ['completed', 'failed', 'stopped']) {
      status = 'running';
      await tester.runAsync(vm.refresh);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
      await tester.pump();
      await tester.tap(find.text('Check package 0'));
      await tester.pumpAndSettle();
      expect(find.text('Output shows in the desktop app.'), findsOneWidget);
      status = terminal;
      await tester.runAsync(vm.refresh);
      await tester.pump();
      expect(find.byKey(const ValueKey('background-tray')), findsNothing);
      expect(find.text('Output shows in the desktop app.'), findsNothing);
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
  });

  testWidgets(
    'finished live run survives a chat remount but not a new pairing',
    (tester) async {
      var status = 'running';
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => traySnapshot(tasks: 0, runStatus: status);
      final vm = RemoteControlViewModel(repository: repo);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(trayScreenHost(vm));
      await tester.pump();
      expect(find.byKey(const ValueKey('background-tray')), findsOneWidget);
      status = 'failure';
      await tester.runAsync(vm.refresh);
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(trayScreenHost(vm));
      await tester.pump();
      expect(find.byKey(const ValueKey('background-tray')), findsOneWidget);
      await tester.runAsync(vm.disconnect);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pump();
      expect(find.byKey(const ValueKey('background-tray')), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    },
  );
  testWidgets('tray joins the flat composer edge between rounded corners', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repo = FakeRemoteControlRepository()
      ..snapshotBuilder = () => traySnapshot(tasks: 3);
    final vm = RemoteControlViewModel(repository: repo);
    await tester.runAsync(() => vm.connect('123456'));
    await tester.pumpWidget(trayScreenHost(vm));
    await tester.pumpAndSettle();
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    for (final scale in [1.0, 2.0]) {
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      await tester.pump();
      for (final keyboard in [false, true]) {
        tester.view.viewInsets = FakeViewPadding(bottom: keyboard ? 336 : 0);
        await tester.pump();
        for (final expanded in [false, true]) {
          if (expanded) {
            await tester.tap(
              find.byKey(const ValueKey('background-tray-toggle')),
            );
            await tester.pumpAndSettle();
          }
          final tray = tester.getRect(
            find.byKey(const ValueKey('background-tray')),
          );
          final composer = tester.getRect(
            find.byKey(const ValueKey('chat-composer')),
          );
          expect(tray.bottom, closeTo(composer.top, .01));
          final decoration = tester
              .widget<Container>(find.byKey(const ValueKey('chat-composer')))
              .decoration;
          final radius = switch (decoration) {
            BoxDecoration(borderRadius: final corners?) => corners.resolve(
              TextDirection.ltr,
            ),
            _ => throw StateError('Expected a rounded composer'),
          };
          expect(tray.left, closeTo(composer.left + radius.topLeft.x, .01));
          expect(tray.right, closeTo(composer.right - radius.topRight.x, .01));
          expect(
            tray.left - composer.left,
            closeTo(composer.right - tray.right, .01),
          );
          expect(
            tester.getRect(find.byKey(const ValueKey('composer-send'))).bottom,
            lessThanOrEqualTo(keyboard ? 508 : 844),
          );
          expect(tester.takeException(), isNull);
        }
        await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
        await tester.pumpAndSettle();
      }
    }
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
  });

  testWidgets(
    'worktree tray expands above composer without covering Chats with keyboard up',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => traySnapshot(tasks: 20);
      final vm = RemoteControlViewModel(repository: repo);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(trayScreenHost(vm));
      await tester.pump();
      expect(find.text('20 running in the background'), findsOneWidget);
      expect(find.text('Check package 0'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
      await tester.pump();
      expect(find.text('Check package 0'), findsOneWidget);
      tester.view.viewInsets = const FakeViewPadding(bottom: 336);
      await tester.pump();
      expect(tester.takeException(), isNull);
      final send = find.byKey(const ValueKey('composer-send'));
      final fab = find.byKey(const ValueKey('chat-tabs-fab'));
      final tray = find.byKey(const ValueKey('background-tray'));
      expect(tester.getRect(send).bottom, lessThanOrEqualTo(508));
      expect(
        tester.getRect(fab).bottom,
        lessThanOrEqualTo(tester.getRect(tray).top),
      );
      expect(tester.getRect(fab).top, greaterThanOrEqualTo(56));
      await tester.tap(fab);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('new-chat-button')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    },
  );
  testWidgets(
    'standalone chats do not mount a tray even when worktree work exists',
    (tester) async {
      const standalone = RemoteStandaloneChat(
        localId: 'chat',
        projectLocalId: 'ws',
        title: 'Standalone',
      );
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => traySnapshot();
      final vm = RemoteControlViewModel(repository: repo);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(
        trayScreenHost(
          vm,
          screen: const RemoteChatScreen.standalone(standaloneChat: standalone),
        ),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('background-tray')), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    },
  );

  testWidgets(
    'live snapshots hide an empty tray and returning work starts collapsed',
    (tester) async {
      var count = 1;
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => traySnapshot(tasks: count);
      final vm = RemoteControlViewModel(repository: repo);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(trayScreenHost(vm));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
      await tester.pump();
      expect(find.text('Check package 0'), findsOneWidget);
      count = 0;
      await tester.runAsync(vm.refresh);
      await tester.pump();
      expect(find.byKey(const ValueKey('background-tray')), findsNothing);
      count = 1;
      await tester.runAsync(vm.refresh);
      await tester.pump();
      expect(find.text('1 running in the background'), findsOneWidget);
      expect(find.text('Check package 0'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    },
  );

  group('pipeline run actions', () {
    Future<(FakeRemoteControlRepository, RemoteControlViewModel)> open(
      WidgetTester tester, {
      required String status,
      List<Map<String, dynamic>> pauses = const [],
      bool capable = true,
    }) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final repo = FakeRemoteControlRepository()
        ..supportsPipelineDispatch = capable
        ..snapshotBuilder = () =>
            traySnapshot(tasks: 0, runStatus: status, runPauses: pauses);
      final vm = RemoteControlViewModel(repository: repo);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(trayScreenHost(vm));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
      await tester.pump();
      return (repo, vm);
    }

    Future<void> close(WidgetTester tester, RemoteControlViewModel vm) async {
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    }

    testWidgets('Stop cancels the run through its Portal command', (
      tester,
    ) async {
      final (repo, vm) = await open(tester, status: 'running');
      await tester.tap(find.bySemanticsLabel('Stop run'));
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pump();
      expect(repo.pipelineRunActions.single.executionId, 'run');
      expect(
        repo.pipelineRunActions.single.action,
        RemotePipelineRunAction.cancel,
      );
      await close(tester, vm);
    });

    testWidgets('Stop is hidden without the pipeline capability', (
      tester,
    ) async {
      final (repo, vm) = await open(tester, status: 'running', capable: false);
      expect(find.text('Review pipeline'), findsOneWidget);
      expect(find.bySemanticsLabel('Stop run'), findsNothing);
      expect(repo.pipelineRunActions, isEmpty);
      await close(tester, vm);
    });

    testWidgets('Resume sends resume for an action pause', (tester) async {
      final (repo, vm) = await open(
        tester,
        status: 'paused',
        pauses: [
          {'id': 'p', 'kind': 'action', 'jobId': 'j', 'stepId': 's'},
        ],
      );
      await tester.tap(find.bySemanticsLabel('Resume run'));
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pump();
      expect(
        repo.pipelineRunActions.single.action,
        RemotePipelineRunAction.resume,
      );
      await close(tester, vm);
    });

    testWidgets('Respond and capability-less Resume open the run', (
      tester,
    ) async {
      for (final (kind, label, capable) in [
        ('input', 'Respond to run', true),
        ('action', 'Resume run', false),
      ]) {
        final (repo, vm) = await open(
          tester,
          status: 'paused',
          capable: capable,
          pauses: [
            {
              'id': 'p',
              'kind': kind,
              'jobId': 'j',
              'stepId': 's',
              'request': {'message': 'Ship it?'},
            },
          ],
        );
        await tester.tap(find.bySemanticsLabel(label));
        await tester.pumpAndSettle();
        expect(find.byType(RemotePipelineRunScreen), findsOneWidget);
        expect(repo.pipelineRunActions, isEmpty);
        await close(tester, vm);
      }
    });
  });
}
