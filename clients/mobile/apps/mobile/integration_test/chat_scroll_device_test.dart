// Chat transcript scrolling, verified on a real iOS device/simulator. Run from
// apps/mobile with:
//
//   flutter drive --profile --driver=test_driver/integration_test.dart \
//     --target=integration_test/chat_scroll_device_test.dart \
//     -d <ios-device-id>
//
// Why this exists alongside the widget tests in
// test/ui/features/chat/chat_feed_test.dart: those run under
// AutomatedTestWidgetsFlutterBinding, where frames are pumped by fake async
// and `debugDefaultTargetPlatformOverride` stands in for the real platform.
// The follow-the-newest-content jump is scheduled in a post-frame callback,
// so its race with a flick's ballistic phase is a question of real frame
// pacing against real BouncingScrollPhysics. This runs both for real.
//
// The repository is the local fake, so no pairing, desktop, or network is
// involved and the transcript is fixed.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

RemoteSessionSnapshot _snapshot() => RemoteSessionSnapshot(
  workspaces: const [],
  worktrees: const [
    RemoteWorktree(localId: 'wt-1', workspaceLocalId: 'ws-1', branch: 'main'),
  ],
  standaloneChats: const [],
  chatSummaries: const [
    RemoteChatSummary(
      chatId: 'chat-a',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Chat A',
      active: true,
    ),
  ],
  chatMessages: [
    for (var i = 0; i < 24; i++) ...[
      RemoteChatMessage(
        messageId: 'u-$i',
        chatId: 'chat-a',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'Question $i with enough text to give the row a stable height.',
      ),
      RemoteChatMessage(
        messageId: 'a-$i',
        chatId: 'chat-a',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: 'Answer $i with enough text to make the transcript scroll.',
      ),
    ],
  ],
);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a flick away from the newest content keeps its travel', (
    tester,
  ) async {
    final repository = FakeRemoteControlRepository();
    repository.snapshotBuilder = _snapshot;
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
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: RemoteChatScreen.worktree(worktree: worktree),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
    expect(transcript, findsOneWidget);
    // Selectable message text carries scrollables of its own, so read the
    // transcript's position from its list rather than any Scrollable below.
    final position = tester.widget<ListView>(transcript).controller!.position;

    // The feed opens pinned to the newest message, which is where the
    // follow jump and a reader's flick contend for the position.
    expect(position.maxScrollExtent - position.pixels, lessThanOrEqualTo(24));
    final start = position.pixels;

    await tester.fling(transcript, const Offset(0, 420), 1200);
    await tester.pumpAndSettle();

    expect(
      start - position.pixels,
      greaterThan(24),
      reason: 'the flick was snapped back to the newest content',
    );

    // Releasing at rest above the newest content must stay there rather than
    // being reeled back in by a late follow jump.
    final settled = position.pixels;
    await tester.pump(const Duration(milliseconds: 500));
    expect(position.pixels, closeTo(settled, 1));

    viewModel.dispose();
  });
}
