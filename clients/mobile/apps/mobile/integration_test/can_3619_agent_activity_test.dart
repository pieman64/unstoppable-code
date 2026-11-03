// CAN-3619 — on-device flow for the Agent activity panel in a worktree chat.
// Run from apps/mobile with:
//
//   flutter test integration_test/can_3619_agent_activity_test.dart -d <device-id>
//
// To also keep screenshots of each state (light and dark), drive it instead:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3619_agent_activity_test.dart \
//     --dart-define=CAN3619_SCREENSHOTS=true -d <device-id>
//
// The repository is a local fake: the desktop's runs arrive as raw
// `portal.pipeline.event` upserts carrying `chatTurns`, exactly as an updated
// desktop sends them, so no desktop, agent or network is involved.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

const bool _screenshots = bool.fromEnvironment('CAN3619_SCREENSHOTS');
const String _chatId = 'chat-a';

RemoteChatMessage _message(String id, ChatRole role, String text) =>
    RemoteChatMessage(
      messageId: id,
      chatId: _chatId,
      role: role,
      status: ChatMessageStatus.complete,
      text: text,
    );

RemoteChatMessage _timer(String turn) {
  final now = DateTime.now().millisecondsSinceEpoch;
  return RemoteChatMessage(
    messageId: '$turn:turn-timer',
    chatId: _chatId,
    role: ChatRole.system,
    status: ChatMessageStatus.complete,
    text: '',
    parts: [
      ChatPart(
        kind: 'turn_timer',
        data: {'startedAt': now - 68000, 'completedAt': now},
      ),
    ],
  );
}

Map<String, dynamic> _run(
  String id, {
  required String name,
  required String turn,
  String status = 'running',
  String buildStatus = 'running',
}) => {
  'localId': id,
  'pipelineId': 'pipeline-$id',
  'pipelineName': name,
  'workspaceLocalId': 'ws-1',
  'worktreeLocalId': 'wt-1',
  'status': status,
  'startedAt': DateTime.now()
      .toUtc()
      .subtract(const Duration(minutes: 40))
      .toIso8601String(),
  'chatTurns': [
    {'chatId': _chatId, 'userMessageId': turn, 'relation': 'launched'},
  ],
  'jobs': [
    {'jobId': 'plan', 'name': 'Plan', 'status': 'success', 'needs': []},
    {
      'jobId': 'build',
      'name': 'Build',
      'status': buildStatus,
      'needs': ['plan'],
    },
    {
      'jobId': 'test',
      'name': 'Test',
      'status': 'pending',
      'needs': ['plan'],
    },
    {
      'jobId': 'ship',
      'name': 'Ship',
      'status': 'pending',
      'needs': ['build', 'test'],
    },
  ],
};

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Finder panel(String turn) => find.byKey(ValueKey('agent-activity:$turn'));
  Finder toggle(String turn) =>
      find.byKey(ValueKey('agent-activity-toggle:$turn'));
  Finder card(String id) => find.byKey(ValueKey('agent-activity-run:$id'));
  Finder cancel(String id) => find.byKey(ValueKey('agent-activity-cancel:$id'));

  // Running dots pulse, so frames are pumped for a fixed time, not settled.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
  }

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    testWidgets('CAN-3619 agent activity flow (${mode.name})', (tester) async {
      var cursor = 0;
      final repository = FakeRemoteControlRepository()
        ..supportsPipelineRunChatLinks = true
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
              title: 'Factory chat',
              active: true,
            ),
          ],
          chatMessages: [
            _message('u-1', ChatRole.user, 'Run the release checks'),
            _message('a-1', ChatRole.assistant, 'Started the release checks.'),
            _timer('u-1'),
            _message('u-2', ChatRole.user, 'Start the factory pipeline'),
            _message('a-2', ChatRole.assistant, 'Started the factory run.'),
            _timer('u-2'),
          ],
        );
      Future<void> emit(List<Map<String, dynamic>> runs) async {
        cursor += 1;
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
        await settle(tester);
      }

      Future<void> shot(String name) async {
        if (_screenshots) {
          await binding.takeScreenshot('can-3619-$name-${mode.name}');
        }
      }

      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await viewModel.connect('123456');
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<RemoteControlViewModel>.value(
              value: viewModel,
            ),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: mode,
            home: RemoteChatScreen.worktree(
              worktree: viewModel.allWorktrees.single,
            ),
          ),
        ),
      );
      await settle(tester);
      if (_screenshots) await binding.convertFlutterSurfaceToImage();
      await settle(tester);
      await shot('no-activity');

      // Two turns with runs: only the latest panel starts expanded.
      await emit([
        _run(
          'exec-old',
          name: 'Release checks',
          turn: 'u-1',
          status: 'success',
          buildStatus: 'success',
        ),
        _run(
          'exec-1',
          name: 'Mobile Factory · Experiment v2 · Factory',
          turn: 'u-2',
        ),
      ]);
      expect(panel('u-1'), findsOneWidget);
      expect(panel('u-2'), findsOneWidget);
      expect(card('exec-old'), findsNothing);
      expect(card('exec-1'), findsOneWidget);
      expect(
        find.descendant(of: card('exec-1'), matching: find.text('Running')),
        findsOneWidget,
      );
      await shot('running');

      // A live status change lands without a refresh.
      await emit([
        _run(
          'exec-1',
          name: 'Mobile Factory · Experiment v2 · Factory',
          turn: 'u-2',
          status: 'paused',
          buildStatus: 'paused',
        ),
      ]);
      expect(
        find.descendant(of: card('exec-1'), matching: find.text('Paused')),
        findsOneWidget,
      );

      // Cancel: one command, disabled "Cancelling…" until the run settles.
      await tester.tap(cancel('exec-1'));
      await settle(tester);
      expect(repository.pipelineRunActions, hasLength(1));
      expect(
        find.descendant(
          of: cancel('exec-1'),
          matching: find.text('Cancelling…'),
        ),
        findsOneWidget,
      );
      await shot('cancelling');
      await emit([
        _run(
          'exec-1',
          name: 'Mobile Factory · Experiment v2 · Factory',
          turn: 'u-2',
          status: 'cancelled',
          buildStatus: 'cancelled',
        ),
      ]);
      expect(
        find.descendant(of: card('exec-1'), matching: find.text('Canceled')),
        findsOneWidget,
      );
      expect(cancel('exec-1'), findsNothing);
      await shot('cancelled');

      // The card body opens the run screen; back returns to the chat.
      await tester.tap(
        find.descendant(
          of: card('exec-1'),
          matching: find.text('Mobile Factory · Experiment v2 · Factory'),
        ),
      );
      await settle(tester);
      expect(
        tester
            .widget<RemotePipelineRunScreen>(
              find.byType(RemotePipelineRunScreen),
            )
            .executionId,
        'exec-1',
      );
      await tester.pageBack();
      await settle(tester);
      expect(find.byType(RemotePipelineRunScreen), findsNothing);

      // Collapsing and expanding hold for the screen session.
      await tester.tap(toggle('u-2'));
      await settle(tester);
      await tester.ensureVisible(toggle('u-1'));
      await tester.tap(toggle('u-1'));
      await settle(tester);
      expect(card('exec-1'), findsNothing);
      expect(card('exec-old'), findsOneWidget);
      await shot('older-expanded');
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      viewModel.dispose();
    });
  }
}
