// CAN-3371 capture spec: visual evidence only, not regression coverage. The
// durable coverage is the `flutter test` suite (chat_feed_test,
// transcript_projection_test, incremental_turn_groups_test,
// chat_transcript_store_test, remote_chat_screen_test).
//
// CAN-3371 caches the transcript list, turn grouping and unchanged row
// widgets; the feed must look and behave exactly as before. This walks a
// 320-row Remote chat through streaming, an expanded finished turn, an
// older-history prepend and a pending question with a typed Other answer,
// and captures each state in the light and then the dark theme. Run once per
// stage on the unchanged and changed trees from apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3371_chat_feed_capture_test.dart \
//     --dart-define=CAN3371_STAGE=before -d <device-id>
//
// Deterministic: the repository is the local fake (no pairing, desktop or
// network), every row and timestamp is fixed, the theme mode is forced, and
// the history page is released by the test. Captures land in
// build/promo_screenshots/can3371-<stage>-<theme>-<step>.png.

import 'dart:async';

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
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

const _stage = String.fromEnvironment('CAN3371_STAGE', defaultValue: 'after');
final _epoch = DateTime.utc(2026, 1, 1, 9);

RemoteChatSummary _summary({
  bool turnActive = false,
  List<AskUserQuestionState> pendingQuestions = const [],
}) => RemoteChatSummary(
  chatId: 'chat-a',
  scope: RemoteChatScope.worktree,
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  title: 'Feed capture',
  active: true,
  turnActive: turnActive,
  pendingQuestions: pendingQuestions,
);

RemoteChatMessage _row(
  String id,
  ChatRole role,
  DateTime at, {
  String text = '',
  List<ChatPart> parts = const [],
  ChatMessageStatus status = ChatMessageStatus.complete,
}) => RemoteChatMessage(
  messageId: id,
  chatId: 'chat-a',
  scope: RemoteChatScope.worktree,
  role: role,
  status: status,
  text: text,
  parts: parts,
  occurredAt: at,
);

ChatPart _timer(DateTime at, {bool completed = true}) => ChatPart(
  kind: 'turn_timer',
  data: {
    'startedAt': at.millisecondsSinceEpoch,
    'completedAt': completed
        ? at.add(const Duration(seconds: 42)).millisecondsSinceEpoch
        : null,
  },
);

/// One finished turn: prompt, a tool step, its result, the answer and the
/// completed timer.
List<RemoteChatMessage> _turn(int index) {
  final at = _epoch.add(Duration(minutes: index));
  return [
    _row('prompt-$index', ChatRole.user, at, text: 'Question $index.'),
    _row(
      'step-$index',
      ChatRole.assistant,
      at,
      text: 'Checking the workspace for $index.',
      parts: [
        ChatPart(
          kind: 'tool_use',
          toolFamily: 'bash',
          data: {
            'toolName': 'Bash',
            'toolUseId': 'tool-$index',
            'input': '{"command":"npm test -- $index"}',
          },
        ),
      ],
    ),
    _row(
      'result-$index',
      ChatRole.assistant,
      at,
      parts: [
        ChatPart(
          kind: 'tool_result',
          data: {'toolUseId': 'tool-$index', 'output': 'ok $index'},
        ),
      ],
    ),
    _row(
      'answer-$index',
      ChatRole.assistant,
      at,
      text:
          'Answer $index: the build passes and the change is ready. '
          'Enough text to wrap onto a second line on a phone.',
    ),
    _row('timer-$index', ChatRole.assistant, at, parts: [_timer(at)]),
  ];
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('captures the chat feed states', (tester) async {
    await binding.convertFlutterSurfaceToImage();
    for (final theme in ['light', 'dark']) {
      await _captureTheme(tester, binding, theme);
    }
  });
}

Future<void> _captureTheme(
  WidgetTester tester,
  IntegrationTestWidgetsFlutterBinding binding,
  String theme,
) async {
  {
    final olderPage = Completer<RemoteChatHistoryChunk>();
    final repository = FakeRemoteControlRepository()
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
        chatSummaries: [_summary()],
        chatMessages: [for (var i = 10; i < 74; i++) ..._turn(i)],
      );
    repository.fetchChatHistoryHandler = (_) => olderPage.future;
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    final worktree = viewModel.worktreesFor('ws-1').single;

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
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: theme == 'dark' ? ThemeMode.dark : ThemeMode.light,
          home: RemoteChatScreen.worktree(worktree: worktree),
        ),
      ),
    );
    await tester.pumpAndSettle();

    var cursor = 0;
    Future<void> deliver(List<RemotePortalEvent> events) async {
      repository.eventsController.add(
        RemotePortalEventBatch(nextCursor: ++cursor, events: events),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
    }

    Future<void> capture(String step) async {
      await tester.pump(const Duration(milliseconds: 500));
      await binding.takeScreenshot('can3371-$_stage-$theme-$step');
    }

    final liveAt = _epoch.add(const Duration(days: 1));
    RemoteChatMessage liveAnswer(String text, ChatMessageStatus status) => _row(
      'live-answer',
      ChatRole.assistant,
      liveAt,
      text: text,
      status: status,
    );

    // 1. A live turn streams into the newest content.
    await deliver([
      RemoteStateDeltaEvent(chatSummaries: [_summary(turnActive: true)]),
      RemoteChatMessageEvent(
        chatId: 'chat-a',
        scope: RemoteChatScope.worktree,
        message: _row(
          'live-prompt',
          ChatRole.user,
          liveAt,
          text: 'Tighten the release notes.',
        ),
      ),
    ]);
    for (final text in [
      'Reading the notes',
      'Reading the notes and the changelog',
      'Reading the notes and the changelog to tighten the wording.',
    ]) {
      await deliver([
        RemoteChatMessageEvent(
          chatId: 'chat-a',
          scope: RemoteChatScope.worktree,
          message: liveAnswer(text, ChatMessageStatus.streaming),
        ),
      ]);
    }
    await capture('01-live-streaming');

    // 2. The turn completes; the previous finished turn is expanded with
    // its tool result.
    await deliver([
      RemoteStateDeltaEvent(chatSummaries: [_summary()]),
      RemoteChatMessageEvent(
        chatId: 'chat-a',
        scope: RemoteChatScope.worktree,
        message: liveAnswer(
          'Release notes tightened: three bullets, one link.',
          ChatMessageStatus.complete,
        ),
      ),
      RemoteChatMessageEvent(
        chatId: 'chat-a',
        scope: RemoteChatScope.worktree,
        message: _row(
          'live-timer',
          ChatRole.assistant,
          liveAt,
          parts: [_timer(liveAt)],
        ),
      ),
    ]);
    final steps = find.byKey(const ValueKey('turn-steps-prompt-73'));
    await tester.ensureVisible(steps);
    await tester.pumpAndSettle();
    await tester.tap(steps);
    await tester.pumpAndSettle();
    final tool = find.byKey(const ValueKey('tool-step-73-tool-73'));
    await tester.ensureVisible(tool);
    await tester.tap(tool);
    await tester.pumpAndSettle();
    await capture('02-completed-expanded');

    // 3. Reading near the oldest content pages older history; the reader's
    // row stays put when it lands.
    final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
    final position = tester.widget<ListView>(transcript).controller!.position;
    position.jumpTo(600);
    await tester.pump();
    await tester.drag(transcript, const Offset(0, 500));
    await tester.pump();
    await capture('03-older-loading');
    olderPage.complete(
      RemoteChatHistoryChunk(
        messages: [for (var i = 0; i < 10; i++) ..._turn(i)],
      ),
    );
    await tester.pumpAndSettle();
    await capture('04-older-prepended');

    // 4. A pending question with a typed Other answer, kept while the
    // transcript keeps changing above it.
    await tester.tap(
      find.byKey(const ValueKey('remote-chat-scroll-to-bottom')),
    );
    await tester.pumpAndSettle();
    await deliver([
      RemoteStateDeltaEvent(
        chatSummaries: [
          _summary(
            pendingQuestions: const [
              AskUserQuestionState(
                requestId: 'req-1',
                questions: [
                  AskUserQuestion(
                    id: 'q-1',
                    header: 'Release',
                    question: 'When should the notes ship?',
                    options: ['Today', 'Next week'],
                    allowOther: true,
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ]);
    await tester.pumpAndSettle();
    final other = find.text('Other');
    await tester.ensureVisible(other);
    await tester.tap(other);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('question-other-field-req-1-0')),
      'After the freeze',
    );
    // The soft keyboard's show timing varies run to run; close it so the
    // capture shows the card and its draft the same way every time.
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 1));
    await deliver([
      RemoteChatMessageEvent(
        chatId: 'chat-a',
        scope: RemoteChatScope.worktree,
        message: _row(
          'question-step',
          ChatRole.assistant,
          liveAt.add(const Duration(minutes: 1)),
          text: 'Waiting for your answer.',
          status: ChatMessageStatus.streaming,
        ),
      ),
    ]);
    expect(find.text('After the freeze'), findsOneWidget);
    await capture('05-question-other');

    await tester.pumpWidget(const SizedBox());
    viewModel.dispose();
  }
}
