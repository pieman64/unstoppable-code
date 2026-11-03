// CAN-3940 — device regression flow for reopening a worktree on the chat tab
// the user last viewed. Run from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3940_last_viewed_tab_device_test.dart \
//     -d <device-id>
//
// In both themes it opens a worktree from the Remote Control workspace list
// (tab A is the desktop's active tab), selects tab B in the tabs sheet, goes
// back, and opens the same worktree again: tab B must show. Data is synthetic
// (`FakeRemoteControlRepository`): no desktop, account or network.
// Screenshots live in the separate capture harness.

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
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import 'package:provider/provider.dart';

import '../test/support/chat_tabs_sheet_driver.dart';
import '../test/support/fake_remote_control_repository.dart';

const _row = ValueKey('worktree-ws-1-wt-1');

RemoteChatSummary _tab(String chatId, String title, {bool active = false}) =>
    RemoteChatSummary(
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: title,
      active: active,
    );

RemoteChatMessage _answer(String chatId, String text) => RemoteChatMessage(
  messageId: 'answer-$chatId',
  chatId: chatId,
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: text,
);

FakeRemoteControlRepository _repository() =>
    FakeRemoteControlRepository()
      ..snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [
          RemoteWorkspace(
            localId: 'ws-1',
            name: 'Repository',
            type: RemoteWorkspaceType.singleRepo,
          ),
        ],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/tabs',
            label: 'koala',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: [
          _tab('chat-a', 'Tab A', active: true),
          _tab('chat-b', 'Tab B'),
        ],
        chatMessages: [
          _answer('chat-a', 'Answer in tab A'),
          _answer('chat-b', 'Answer in tab B'),
        ],
      );

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> openWorktree(WidgetTester tester) async {
    if (find.byKey(_row).evaluate().isEmpty) {
      await tester.tap(find.text('Repository'));
      await tester.pumpAndSettle();
    }
    await tester.tap(find.byKey(_row));
    await tester.pumpAndSettle();
    expect(find.byType(RemoteChatScreen), findsOneWidget);
  }

  for (final mode in const [ThemeMode.light, ThemeMode.dark]) {
    testWidgets('reopens the last viewed tab (${mode.name})', (tester) async {
      final viewModel = RemoteControlViewModel(
        repository: _repository(),
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
            home: const Scaffold(body: WorkspacesListView()),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await openWorktree(tester);
      expect(find.text('Answer in tab A'), findsOneWidget);

      await tester.selectTabFromSheet('Tab B');
      await tester.pumpAndSettle();
      expect(find.text('Answer in tab B'), findsOneWidget);

      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.byType(RemoteChatScreen), findsNothing);

      await openWorktree(tester);
      expect(find.text('Answer in tab B'), findsOneWidget);
      expect(find.text('Answer in tab A'), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      viewModel.dispose();
    });
  }
}
