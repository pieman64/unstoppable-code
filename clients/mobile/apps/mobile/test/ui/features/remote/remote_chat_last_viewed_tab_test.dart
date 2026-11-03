import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/services/active_chat_tracker.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../../../support/chat_tabs_sheet_driver.dart';
import '../../../support/fake_remote_control_repository.dart';

// CAN-3940: a worktree reopens on the chat tab the user last viewed in it.

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'main',
);
const _otherWorktree = RemoteWorktree(
  localId: 'wt-2',
  workspaceLocalId: 'ws-1',
  branch: 'other',
);

RemoteChatSummary _tab(
  String chatId,
  String title, {
  String worktreeLocalId = 'wt-1',
  bool active = false,
  bool? hasUnread,
  List<AskUserQuestionState>? pendingQuestions,
}) => RemoteChatSummary(
  chatId: chatId,
  scope: RemoteChatScope.worktree,
  workspaceLocalId: 'ws-1',
  worktreeLocalId: worktreeLocalId,
  title: title,
  active: active,
  hasUnread: hasUnread,
  pendingQuestions: pendingQuestions,
);

RemoteChatMessage _answer(String chatId, String text) => RemoteChatMessage(
  messageId: 'answer-$chatId',
  chatId: chatId,
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: text,
);

/// A server that has a pairing to restore once [restorable] is set.
final class _RestorableRepository extends FakeRemoteControlRepository {
  bool restorable = false;

  @override
  Future<RemoteConnection?> restoreSession() async => restorable
      ? RemoteConnection(deviceLabel: 'Test Desktop', pairedAt: DateTime(2026))
      : null;
}

void main() {
  group('RemoteChatScreen last viewed tab', () {
    late _RestorableRepository repository;
    late RemoteControlViewModel viewModel;
    late ActiveChatTracker tracker;

    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    /// Pairs with a desktop. Unless [worktreeTabsListed], the first
    /// snapshot does not list the tabs of [_worktree] yet.
    Future<void> connect(
      WidgetTester tester, {
      bool worktreeTabsListed = true,
    }) async {
      usePhoneViewport(tester);
      repository = _RestorableRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot(
          workspaces: const [],
          worktrees: const [_worktree, _otherWorktree],
          standaloneChats: const [],
          chatSummaries: [
            if (worktreeTabsListed) ...[
              _tab('chat-a', 'Chat A', active: true),
              _tab('chat-b', 'Chat B'),
              _tab('chat-e', 'Chat E'),
            ],
            _tab('chat-c', 'Chat C', worktreeLocalId: 'wt-2', active: true),
            _tab('chat-d', 'Chat D', worktreeLocalId: 'wt-2'),
          ],
          chatMessages: [
            _answer('chat-a', 'Answer in chat A'),
            _answer('chat-b', 'Answer in chat B'),
            _answer('chat-e', 'Answer in chat E'),
            _answer('chat-c', 'Answer in chat C'),
            _answer('chat-d', 'Answer in chat D'),
          ],
        );
      viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      tracker = ActiveChatTracker();
      await tester.runAsync(() => viewModel.connect('123456'));
    }

    /// Mounts a fresh worktree chat screen, the way each entry point pushes
    /// a new route.
    Future<void> open(
      WidgetTester tester, {
      RemoteWorktree worktree = _worktree,
      String? initialChatId,
    }) async {
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
            Provider<ActiveChatTracker>.value(value: tracker),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            home: RemoteChatScreen.worktree(
              key: UniqueKey(),
              worktree: worktree,
              initialChatId: initialChatId,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));
    }

    /// Leaves the chat: its route is gone.
    Future<void> leave(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }

    void expectShown(WidgetTester tester, String chatId, String answer) {
      expect(tracker.activeChatId, chatId);
      expect(find.text(answer), findsOneWidget);
      expect(tester.takeException(), isNull);
    }

    Future<void> deliver(WidgetTester tester, RemotePortalEvent event) async {
      repository.eventsController.add(
        RemotePortalEventBatch(events: [event], nextCursor: 2),
      );
      await tester.pump();
      await tester.pump();
    }

    /// Unmounts the chat and releases the view model's timers.
    Future<void> finish(WidgetTester tester) async {
      await leave(tester);
      viewModel.dispose();
    }

    testWidgets('reopens the tab selected before leaving (AC1)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');

      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      expectShown(tester, 'chat-b', 'Answer in chat B');
      await leave(tester);

      final requestsBefore = repository.requestChatTranscriptTargets.length;
      await open(tester);
      expectShown(tester, 'chat-b', 'Answer in chat B');
      expect(find.text('Answer in chat A'), findsNothing);
      expect(
        repository.requestChatTranscriptTargets
            .skip(requestsBefore)
            .map((target) => target.chatId),
        isNot(contains('chat-a')),
      );
      await finish(tester);
    });

    testWidgets('reopening does not load the desktop-active tab first (AC1)', (
      tester,
    ) async {
      await connect(tester);
      repository.supportsForegroundChat = true;
      await open(tester, initialChatId: 'chat-b');
      expectShown(tester, 'chat-b', 'Answer in chat B');
      await leave(tester);

      final requestsBefore = repository.requestChatTranscriptTargets.length;
      await open(tester);
      expectShown(tester, 'chat-b', 'Answer in chat B');
      expect(
        repository.requestChatTranscriptTargets
            .skip(requestsBefore)
            .map((target) => target.chatId),
        isNot(contains('chat-a')),
      );
      await finish(tester);
    });

    testWidgets('unread output or a question in another tab is ignored (AC3)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      await leave(tester);

      await deliver(
        tester,
        RemoteStateDeltaEvent(
          chatSummaries: [
            _tab(
              'chat-a',
              'Chat A',
              active: true,
              hasUnread: true,
              pendingQuestions: const [
                AskUserQuestionState(
                  requestId: 'req-1',
                  questions: [
                    AskUserQuestion(
                      id: 'q-1',
                      header: 'Deploy',
                      question: 'Ship to prod?',
                      options: ['Yes', 'No'],
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      );
      await open(tester);
      expectShown(tester, 'chat-b', 'Answer in chat B');
      await finish(tester);
    });

    testWidgets('a desktop active-tab change does not replace it (AC4)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat E');
      await tester.finishSheetDismiss();
      await leave(tester);

      await deliver(
        tester,
        RemoteStateDeltaEvent(
          chatSummaries: [
            _tab('chat-a', 'Chat A'),
            _tab('chat-b', 'Chat B', active: true),
          ],
        ),
      );
      await open(tester);
      expectShown(tester, 'chat-e', 'Answer in chat E');
      await finish(tester);
    });

    testWidgets('a closed remembered tab falls back and is remembered (AC5)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      await leave(tester);

      // The desktop closes chat B; its authoritative tab list omits it.
      await deliver(
        tester,
        RemoteStateSnapshotEvent(
          scope: 'chat',
          selectedChatOnly: true,
          targetWorkspaceLocalId: 'ws-1',
          targetWorktreeLocalId: 'wt-1',
          targetChatId: 'chat-a',
          targetChatScope: RemoteChatScope.worktree,
          chatSummaries: [
            _tab('chat-a', 'Chat A', active: true),
            _tab('chat-e', 'Chat E'),
          ],
          chatMessages: [_answer('chat-a', 'Answer in chat A')],
        ),
      );
      expect(
        viewModel
            .chatSummariesFor(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1')
            .map((summary) => summary.chatId),
        ['chat-a', 'chat-e'],
      );
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');
      await leave(tester);

      // The fallback tab is now the remembered one.
      await deliver(
        tester,
        RemoteStateDeltaEvent(
          chatSummaries: [
            _tab('chat-a', 'Chat A'),
            _tab('chat-e', 'Chat E', active: true),
          ],
        ),
      );
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');
      await finish(tester);
    });

    testWidgets('an exact chat link opens and becomes remembered (AC6, AC7)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      await leave(tester);

      // A push tap, chat search result, or Recents row names chat E.
      await open(tester, initialChatId: 'chat-e');
      expectShown(tester, 'chat-e', 'Answer in chat E');
      await leave(tester);

      await open(tester);
      expectShown(tester, 'chat-e', 'Answer in chat E');
      await finish(tester);
    });

    testWidgets('an exact chat opened before its tabs are listed is '
        'remembered (AC6, AC7)', (tester) async {
      await connect(tester, worktreeTabsListed: false);
      await open(tester, initialChatId: 'chat-e');
      expect(tracker.activeChatId, 'chat-e');
      await leave(tester);

      await deliver(
        tester,
        RemoteStateDeltaEvent(
          chatSummaries: [
            _tab('chat-a', 'Chat A', active: true),
            _tab('chat-b', 'Chat B'),
            _tab('chat-e', 'Chat E'),
          ],
        ),
      );
      await open(tester);
      expect(tracker.activeChatId, 'chat-e');
      expect(find.text('Answer in chat A'), findsNothing);
      expect(tester.takeException(), isNull);
      await finish(tester);
    });

    testWidgets('a new tab is remembered once the desktop lists it (AC8)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.startNewChatFromSheet();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();
      final created = repository.createChatTabTargets.single.chatId!;
      await deliver(
        tester,
        RemoteStateDeltaEvent(
          chatSummaries: [
            _tab('chat-a', 'Chat A', active: true),
            _tab('chat-b', 'Chat B'),
            _tab('chat-e', 'Chat E'),
            _tab(created, 'New chat'),
          ],
        ),
      );
      expect(tracker.activeChatId, created);
      await leave(tester);

      await open(tester);
      expect(tracker.activeChatId, created);
      expect(find.text('Answer in chat A'), findsNothing);
      expect(tester.takeException(), isNull);
      await finish(tester);
    });

    /// Selects chat B, then starts a new tab whose create the desktop has
    /// accepted but not listed yet. Returns the new tab's chat id.
    Future<String> rememberBThenStartNewTab(WidgetTester tester) async {
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      expectShown(tester, 'chat-b', 'Answer in chat B');
      await tester.startNewChatFromSheet();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();
      final created = repository.createChatTabTargets.single.chatId!;
      expect(tracker.activeChatId, created);
      return created;
    }

    List<RemoteChatSummary> tabsWith(String created) => [
      _tab('chat-a', 'Chat A', active: true),
      _tab('chat-b', 'Chat B'),
      _tab('chat-e', 'Chat E'),
      _tab(created, 'New chat'),
    ];

    testWidgets('a new tab listed after leaving is remembered (AC8)', (
      tester,
    ) async {
      await connect(tester);
      final created = await rememberBThenStartNewTab(tester);
      await leave(tester);

      await deliver(
        tester,
        RemoteStateDeltaEvent(chatSummaries: tabsWith(created)),
      );
      await open(tester);
      expect(tracker.activeChatId, created);
      expect(find.text('Answer in chat B'), findsNothing);
      expect(tester.takeException(), isNull);
      await finish(tester);
    });

    testWidgets('a new tab rejected after leaving is not remembered (AC8)', (
      tester,
    ) async {
      await connect(tester);
      final created = await rememberBThenStartNewTab(tester);
      await leave(tester);

      await deliver(
        tester,
        RemoteCommandFailedEvent(
          message: 'Could not create the chat',
          commandId: repository.createChatTabCommandIds.single,
        ),
      );
      await open(tester);
      expectShown(tester, 'chat-b', 'Answer in chat B');
      expect(tracker.activeChatId, isNot(created));
      await finish(tester);
    });

    /// Makes each later snapshot list the new tab [created].
    void listInNextSnapshot(String created) {
      final base = repository.snapshotBuilder!;
      repository.snapshotBuilder = () {
        final snapshot = base();
        return RemoteSessionSnapshot(
          workspaces: snapshot.workspaces,
          worktrees: snapshot.worktrees,
          standaloneChats: snapshot.standaloneChats,
          chatSummaries: [...snapshot.chatSummaries, _tab(created, 'New')],
          chatMessages: snapshot.chatMessages,
        );
      };
    }

    testWidgets('a new pairing discards a new tab still being created', (
      tester,
    ) async {
      await connect(tester);
      final created = await rememberBThenStartNewTab(tester);
      await leave(tester);

      listInNextSnapshot(created);
      await tester.runAsync(viewModel.disconnect);
      await tester.runAsync(() => viewModel.connect('654321'));
      expect(
        viewModel
            .chatSummariesFor(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1')
            .map((summary) => summary.chatId),
        contains(created),
      );
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');
      await finish(tester);
    });

    testWidgets('remembered tabs are kept per worktree (AC9)', (tester) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      await leave(tester);

      await open(tester, worktree: _otherWorktree);
      expectShown(tester, 'chat-c', 'Answer in chat C');
      await tester.selectTabFromSheet('Chat D');
      await tester.finishSheetDismiss();
      await leave(tester);

      await open(tester);
      expectShown(tester, 'chat-b', 'Answer in chat B');
      await leave(tester);
      await open(tester, worktree: _otherWorktree);
      expectShown(tester, 'chat-d', 'Answer in chat D');
      await finish(tester);
    });

    testWidgets('a disconnect and new pairing forget remembered tabs (AC10)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      await leave(tester);

      await tester.runAsync(viewModel.disconnect);
      await tester.runAsync(() => viewModel.connect('654321'));
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');
      await finish(tester);
    });

    testWidgets('a disconnect with the chat open forgets its tab (AC10)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();

      await tester.runAsync(viewModel.disconnect);
      await tester.pump();
      await leave(tester);
      await tester.runAsync(() => viewModel.connect('654321'));
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');
      await finish(tester);
    });

    testWidgets('a session end with the chat open forgets its tab (AC10)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();

      await deliver(tester, const RemoteSessionEndedEvent());
      expect(viewModel.isConnected, isFalse);
      await leave(tester);
      repository.restorable = true;
      await tester.runAsync(viewModel.restoreIfIdle);
      expect(viewModel.isConnected, isTrue);
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');
      await finish(tester);
    });

    testWidgets('a session end forgets a new tab still on screen (AC10)', (
      tester,
    ) async {
      await connect(tester);
      final created = await rememberBThenStartNewTab(tester);

      listInNextSnapshot(created);
      await deliver(tester, const RemoteSessionEndedEvent());
      expect(viewModel.isConnected, isFalse);
      await leave(tester);
      repository.restorable = true;
      await tester.runAsync(viewModel.restoreIfIdle);
      expect(viewModel.isConnected, isTrue);
      expect(
        viewModel
            .chatSummariesFor(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1')
            .map((summary) => summary.chatId),
        contains(created),
      );
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');
      await finish(tester);
    });

    testWidgets('a new app process starts with no remembered tabs (AC11)', (
      tester,
    ) async {
      await connect(tester);
      await open(tester);
      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      await leave(tester);

      // A restarted app builds a new view model for the same pairing.
      viewModel.dispose();
      viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      await open(tester);
      expectShown(tester, 'chat-a', 'Answer in chat A');
      await finish(tester);
    });
  });
}
