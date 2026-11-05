import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../../../support/chat_tabs_sheet_driver.dart';

// Golden: a session paired with a code shows a worktree chat's seeded
// transcript and its tabs, a sent message streams the scripted reply into the
// transcript, and a standalone chat renders its transcript.
void main() {
  group('RemoteChatScreen', () {
    void usePhoneViewport(WidgetTester tester) {
      // Narrow phone width so RenderFlex overflow in bubbles/chips surfaces.
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    // Connect via [WidgetTester.runAsync]: the mock's `Future.delayed` never
    // resolves under the FakeAsync zone until a pump advances timers, so
    // awaiting connect before the first pump would otherwise hang the test.
    Future<RemoteControlViewModel> connectedViewModel(
      WidgetTester tester,
    ) async {
      final viewModel = RemoteControlViewModel(
        repository: MockRemoteControlRepository(latency: Duration.zero),
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      return viewModel;
    }

    Widget buildSubject(RemoteControlViewModel viewModel, Widget screen) {
      return MultiProvider(
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
          home: screen,
        ),
      );
    }

    RemoteWorktree worktreeWithChats(RemoteControlViewModel viewModel) =>
        viewModel
            .worktreesFor('ws-app')
            .firstWhere((w) => w.localId == 'wt-feature-auth');

    testWidgets('renders the seeded transcript and chat tabs', (tester) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(worktree: worktreeWithChats(viewModel)),
        ),
      );
      // The timed pump advances the fake clock so the mock's zero-latency
      // transcript request fires instead of leaking as a pending timer.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      // Tabs live behind the FAB now; the strip no longer competes with the
      // transcript for vertical space.
      await tester.openTabsSheet();
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('PKCE implementation'),
        ),
        findsOneWidget,
      );
      expect(find.text('Widget test cleanup'), findsOneWidget);
      await tester.dismissTabsSheet();

      // Seeded transcript for the active chat renders both roles.
      expect(find.text('Add PKCE to the mobile OAuth flow'), findsOneWidget);
      expect(find.textContaining('All 42 auth tests pass'), findsOneWidget);

      // Aggregate worktree activity cannot make a completed chat run.
      expect(find.byKey(const ValueKey('composer-stop')), findsNothing);

      // The intermediate agent steps are collapsed behind one summary card
      // of per-category counts — not rendered as a wall of tool rows.
      expect(
        find.bySemanticsLabel('Agent steps: 1 bash, 1 write/edit'),
        findsOneWidget,
      );
      expect(find.text('Run the auth tests'), findsNothing);
      expect(find.text('Edit'), findsNothing);

      // Expanding the row reveals flat icon rows with the friendly
      // verb + parameter labels: the Bash description heads its row with the
      // command as a mono detail, and Edit shows the touched file basename.
      await tester.tap(find.byKey(const ValueKey('turn-steps-seed-1')));
      await tester.pump();
      expect(find.text('Run the auth tests'), findsOneWidget);
      expect(find.text('npm test -- auth'), findsOneWidget);
      expect(find.byIcon(Icons.terminal), findsOneWidget);
      expect(find.text('Edit'), findsOneWidget);
      expect(find.text('oauth_pkce.dart'), findsOneWidget);

      // The correlated tool_result opens from the row.
      await tester.tap(find.text('Run the auth tests'));
      await tester.pump();
      expect(find.text('Result'), findsOneWidget);
      expect(find.text('42 passing (3.1s)'), findsOneWidget);

      // Collapsing hides the step rows again.
      final steps = find.byKey(const ValueKey('turn-steps-seed-1'));
      await tester.ensureVisible(steps);
      await tester.pump();
      await tester.tap(steps);
      await tester.pump();
      expect(find.text('Run the auth tests'), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('sends a message and streams the scripted reply', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(worktree: worktreeWithChats(viewModel)),
        ),
      );
      // The timed pump advances the fake clock so the mock's zero-latency
      // transcript request fires instead of leaking as a pending timer.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      await tester.enterText(find.byType(TextField), 'Deploy the fix');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      // Let the send round-trip and the scripted reply timers run for real.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      expect(find.text('Deploy the fix'), findsOneWidget);
      expect(
        find.textContaining('the diff is ready for review'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('standalone chats render their transcript', (tester) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);
      final projectedChat = viewModel
          .standaloneChatsFor('ws-app')
          .firstWhere((c) => c.localId == 'chat-arch');
      final chat = RemoteStandaloneChat(
        localId: projectedChat.localId,
        projectLocalId: projectedChat.projectLocalId,
        title: 'Raw chat title',
        description: '  ',
        workEntryTitle: 'Executor architecture',
      );

      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.standalone(standaloneChat: chat),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('How should we break the executor circular dependency?'),
        findsOneWidget,
      );
      expect(find.textContaining('dynamic import'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.text('Executor architecture'),
        ),
        findsOneWidget,
      );
      // Standalone chats have no worktree tab chips.
      expect(find.text('PKCE implementation'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });
}
