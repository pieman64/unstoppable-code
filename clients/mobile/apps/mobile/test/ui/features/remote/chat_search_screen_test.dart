import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/chat_search_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/workspace_context_fixture.dart';

const _workspace = RemoteWorkspace(
  localId: 'ws-code',
  name: 'acme-web',
  type: RemoteWorkspaceType.singleRepo,
);

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-code',
  branch: 'feature/oauth',
);

void main() {
  group('ChatSearchScreen', () {
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    FakeRemoteControlRepository repository({bool capability = true}) {
      final repository = FakeRemoteControlRepository();
      repository.supportsWorktreeChatSummariesScope = capability;
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [_workspace],
        worktrees: [_worktree],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            title: 'Fix the OAuth redirect',
            workspaceLocalId: 'ws-code',
            worktreeLocalId: 'wt-1',
            order: 1,
          ),
          RemoteChatSummary(
            chatId: 'chat-b',
            scope: RemoteChatScope.worktree,
            title: 'Ship dark mode',
            workspaceLocalId: 'ws-code',
            worktreeLocalId: 'wt-1',
            order: 2,
          ),
        ],
      );
      return repository;
    }

    Future<RemoteControlViewModel> connectedViewModel(
      FakeRemoteControlRepository repository,
    ) async {
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        // Keep the chat screen's build-path hydration retry from re-arming a
        // watchdog timer after the test's fake-clock flush.
        hydrationRetryWindow: const Duration(days: 1),
      );
      await viewModel.connect('123456');
      return viewModel;
    }

    Widget buildSubject(RemoteControlViewModel viewModel) => MultiProvider(
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
        home: const ChatSearchScreen(),
      ),
    );

    testWidgets('failed chat loading offers retry and keeps cached results', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = repository()
        ..requestWorktreeChatSummariesHandler = () async {
          throw const RemoteControlException('private transport detail');
        };
      final vm = await connectedViewModel(repo);
      addTearDown(vm.dispose);
      await tester.pumpWidget(buildSubject(vm));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('chat-search-field')),
        'oauth',
      );
      await tester.pumpAndSettle();
      expect(find.text('Fix the OAuth redirect'), findsOneWidget);
      expect(
        find.text("Couldn't load chats from your desktop."),
        findsOneWidget,
      );
      expect(find.text('private transport detail'), findsNothing);
      expect(
        tester
            .getTopLeft(find.text("Couldn't load chats from your desktop."))
            .dy,
        greaterThanOrEqualTo(
          tester.getBottomLeft(find.byType(CanopyAppBar)).dy,
        ),
      );
      final cachedSummaries = vm.allChatSummaries;
      repo.requestWorktreeChatSummariesHandler = () async {
        repo.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree_chat_summaries',
                chatSummaries: cachedSummaries,
              ),
            ],
            nextCursor: 1,
          ),
        );
      };
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(repo.requestWorktreeChatSummariesStateCalls, 2);
      expect(find.text("Couldn't load chats from your desktop."), findsNothing);
      expect(find.text('Fix the OAuth redirect'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('empty search identifies the selected context', (tester) async {
      usePhoneViewport(tester);
      final vm = await connectedViewModel(repository(capability: false));
      addTearDown(vm.dispose);
      await tester.pumpWidget(
        Provider<WorkspaceContext>.value(
          value: const WorkspaceContext.personal(),
          child: buildSubject(vm),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('chat-search-field')),
        'absent',
      );
      await tester.pumpAndSettle();
      expect(
        find.text('No chats match your search in Personal.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('hydrates the summaries index once and filters by title', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = repository();
      final viewModel = await connectedViewModel(repo);
      addTearDown(viewModel.dispose);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      // Capability present: exactly one batched summaries request per
      // session, fired when the search surface opens.
      expect(repo.requestWorktreeChatSummariesStateCalls, 1);

      await tester.enterText(
        find.byKey(const ValueKey('chat-search-field')),
        'oauth',
      );
      await tester.pumpAndSettle();

      expect(find.text('Fix the OAuth redirect'), findsOneWidget);
      expect(find.text('Ship dark mode'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await viewModel.disconnect();
    });

    testWidgets('opens the tapped worktree chat', (tester) async {
      usePhoneViewport(tester);
      final repo = repository();
      final viewModel = await connectedViewModel(repo);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const ValueKey('chat-search-field')),
        'dark mode',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Ship dark mode'));
      // The opened chat keeps loading (and animating) until its retry, so
      // pump through the route transition instead of settling.
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(find.byType(RemoteChatScreen), findsOneWidget);

      // Dispose the view model before checking for pending retry timers.
      await tester.pumpWidget(const SizedBox());
      viewModel.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets('skips the hydration request without the capability', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = repository(capability: false);
      final viewModel = await connectedViewModel(repo);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      expect(repo.requestWorktreeChatSummariesStateCalls, 0);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'CAN-4429 searches only the selected context, even on the same snapshot',
      (tester) async {
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()
          ..supportsWorktreeChatSummariesScope = true
          ..snapshotBuilder = () =>
              RemoteSessionSnapshot.fromJson(workspaceContextShellState());
        final viewModel = await connectedViewModel(repo);
        addTearDown(viewModel.dispose);
        final selected = ValueNotifier<WorkspaceContext>(
          const WorkspaceContext.personal(),
        );
        addTearDown(selected.dispose);
        await tester.pumpWidget(
          ValueListenableBuilder<WorkspaceContext>(
            valueListenable: selected,
            builder: (context, workspaceContext, _) =>
                Provider<WorkspaceContext>.value(
                  value: workspaceContext,
                  child: buildSubject(viewModel),
                ),
          ),
        );
        await tester.pumpAndSettle();
        final snapshot = viewModel.snapshot;

        await tester.enterText(
          find.byKey(const ValueKey('chat-search-field')),
          'chat',
        );
        await tester.pumpAndSettle();
        expect(find.text('Personal task chat'), findsOneWidget);
        expect(find.text('Loose chat'), findsOneWidget);
        expect(find.text('Acme task chat'), findsNothing);
        expect(find.text('Acme chat'), findsNothing);
        expect(find.text('Orphan chat'), findsNothing);

        selected.value = const WorkspaceContext.organization(
          workspaceContextOrgA,
        );
        await tester.pumpAndSettle();

        expect(identical(viewModel.snapshot, snapshot), isTrue);
        expect(find.text('Acme task chat'), findsOneWidget);
        expect(find.text('Acme cloud chat'), findsOneWidget);
        // A standalone chat attached to the tree project Acme API.
        final acmeChat = find.byKey(
          const ValueKey('chat-search-result-chat-acme'),
        );
        expect(acmeChat, findsOneWidget);
        expect(
          find.descendant(of: acmeChat, matching: find.text('Acme API')),
          findsOneWidget,
        );
        expect(find.text('Personal task chat'), findsNothing);
        expect(find.text('Loose chat'), findsNothing);

        selected.value = const WorkspaceContext.organization(
          workspaceContextOrgB,
        );
        await tester.pumpAndSettle();

        expect(find.text('Acme chat'), findsNothing);
        expect(find.text('Acme task chat'), findsNothing);
        // This fixture submits a summary read without delivering its reply.
        expect(find.text('Loading chats from your desktop…'), findsOneWidget);
        expect(find.textContaining('No chats match'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        await viewModel.disconnect();
      },
    );

    testWidgets(
      'CAN-4429 a context change closes a chat opened from search and keeps '
      'the search open',
      (tester) async {
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()
          ..supportsWorktreeChatSummariesScope = true
          ..snapshotBuilder = () =>
              RemoteSessionSnapshot.fromJson(workspaceContextShellState());
        final viewModel = await connectedViewModel(repo);
        final selected = ValueNotifier<WorkspaceContext>(
          const WorkspaceContext.personal(),
        );
        addTearDown(selected.dispose);
        await tester.pumpWidget(
          ValueListenableBuilder<WorkspaceContext>(
            valueListenable: selected,
            builder: (context, workspaceContext, _) =>
                Provider<WorkspaceContext>.value(
                  value: workspaceContext,
                  child: buildSubject(viewModel),
                ),
          ),
        );
        await tester.pumpAndSettle();
        final connection = viewModel.connection;

        await tester.enterText(
          find.byKey(const ValueKey('chat-search-field')),
          'chat',
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Loose chat'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(RemoteChatScreen), findsOneWidget);

        selected.value = const WorkspaceContext.organization(
          workspaceContextOrgA,
        );
        // Bounded pumps cover the closing transition of the chat route.
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 1));

        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(find.byType(ChatSearchScreen), findsOneWidget);
        expect(find.text('Acme task chat'), findsOneWidget);
        expect(identical(viewModel.connection, connection), isTrue);
        expect(viewModel.isConnected, isTrue);
        expect(repo.disconnectCalls, 0);

        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        expect(tester.takeException(), isNull);
      },
    );
  });
}
