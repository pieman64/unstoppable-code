import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/services/analytics/app_rating_events.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/store_review_launcher.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/recording_product_analytics.dart';

final class _NoReview implements StoreReviewLauncher {
  @override
  Future<StoreReviewRequestResult> request() async =>
      StoreReviewRequestResult.unavailable;
}

/// The live timer row as the desktop emits it: a system row that streams while
/// the turn runs and completes (keeping its id) when the turn ends.
RemoteChatMessage _timer({required bool done, required int at}) =>
    RemoteChatMessage(
      messageId: 'u1:turn-timer',
      chatId: 'chat-1',
      role: ChatRole.system,
      status: done ? ChatMessageStatus.complete : ChatMessageStatus.streaming,
      text: '',
      updatedAt: DateTime.utc(2026, 9, 1).add(Duration(seconds: at)),
      parts: [
        ChatPart(
          kind: 'turn_timer',
          data: {'startedAt': 1000, 'completedAt': done ? 9000 : null},
        ),
      ],
    );

RemotePortalEventBatch _batch(List<RemoteChatMessage> messages) =>
    RemotePortalEventBatch(
      events: [
        for (final m in messages)
          RemoteChatMessageEvent(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            message: m,
          ),
      ],
      nextCursor: 1,
    );

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'feat/x',
);

const _prompt = 'Are you enjoying the app?';

const _hydratedTurn = [
  RemoteChatMessage(
    messageId: 'u0',
    chatId: 'chat-1',
    role: ChatRole.user,
    status: ChatMessageStatus.complete,
    text: 'earlier question',
  ),
  RemoteChatMessage(
    messageId: 'a0',
    chatId: 'chat-1',
    role: ChatRole.assistant,
    status: ChatMessageStatus.complete,
    text: 'earlier answer',
  ),
];

/// One open Remote chat with a real [SatisfactionPromptController] wired the
/// way production wires it.
final class _Harness {
  _Harness._(this.repository, this.analytics, this.satisfaction, this.vm);

  final FakeRemoteControlRepository repository;
  final RecordingProductAnalytics analytics;
  final SatisfactionPromptController satisfaction;
  final RemoteControlViewModel vm;

  /// Mounts the chat and answers its transcript request with [transcript].
  static Future<_Harness> mount(
    WidgetTester tester, {
    List<RemoteChatMessage> transcript = const [],
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final repository = FakeRemoteControlRepository();
    repository.snapshotBuilder = () => const RemoteSessionSnapshot(
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-1',
          name: 'acme',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: [_worktree],
      standaloneChats: [],
      chatSummaries: [
        RemoteChatSummary(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          title: 'Chat',
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
      ],
    );
    final analytics = RecordingProductAnalytics();
    final satisfaction = SatisfactionPromptController(
      store: InMemorySatisfactionPromptStore(),
      analytics: analytics,
      reviewLauncher: _NoReview(),
      isActive: () => true,
      thresholds: () => SatisfactionThresholds.verification,
    );
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      hydrationRetryWindow: const Duration(days: 1),
      onSuccessfulTurn: (key) => satisfaction.recordSuccessfulTurn(key),
    );
    await vm.connect('123456');

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
          ChangeNotifierProvider<SatisfactionPromptController>.value(
            value: satisfaction,
          ),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: const RemoteChatScreen.worktree(
            worktree: _worktree,
            initialChatId: 'chat-1',
          ),
        ),
      ),
    );
    await tester.pump();
    // The desktop answers the chat's transcript request, so the open chat is
    // hydrated (and quiet) rather than sitting in a load-timeout error.
    repository.eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteStateSnapshotEvent(
            scope: 'chat',
            targetWorkspaceLocalId: 'ws-1',
            targetWorktreeLocalId: 'wt-1',
            targetChatId: 'chat-1',
            targetChatScope: RemoteChatScope.worktree,
            chatMessages: transcript,
          ),
        ],
        nextCursor: 1,
      ),
    );
    await tester.pumpAndSettle();
    return _Harness._(repository, analytics, satisfaction, vm);
  }

  /// Makes a prompt due without a live turn, so a test can check which chat
  /// states hold it back.
  Future<void> makePromptDue(WidgetTester tester) async {
    await satisfaction.recordSuccessfulTurn('remote:seed:turn');
    await tester.pump();
    expect(satisfaction.pendingPrompt, isTrue);
  }

  /// Waits past the host's settle delay.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 1600));
    await tester.pumpAndSettle();
  }
}

const _user = RemoteChatMessage(
  messageId: 'u1',
  chatId: 'chat-1',
  role: ChatRole.user,
  status: ChatMessageStatus.complete,
  text: 'fix the login redirect',
);

RemoteChatMessage _reply() => RemoteChatMessage(
  messageId: 'a1',
  chatId: 'chat-1',
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: 'Fixed.',
  updatedAt: DateTime.utc(2026, 9, 1).add(const Duration(seconds: 2)),
);

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('a completed turn in an open chat shows the prompt once idle', (
    tester,
  ) async {
    final h = await _Harness.mount(tester);

    h.repository.eventsController.add(
      _batch([_user, _timer(done: false, at: 1), _reply()]),
    );
    await tester.pump();
    h.repository.eventsController.add(_batch([_timer(done: true, at: 3)]));
    await tester.pump();
    expect(find.text(_prompt), findsNothing);

    await h.settle(tester);
    expect(find.text(_prompt), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('satisfaction-prompt-not-now')));
    await tester.pumpAndSettle();
    expect(find.text(_prompt), findsNothing);
    expect(h.analytics.names, [
      AppRatingEvents.promptView,
      AppRatingEvents.promptCancel,
    ]);
    expect(
      h.analytics.events.first.properties['trigger_surface'],
      'remote_chat',
    );
  });

  testWidgets('a due prompt waits while the turn is still running', (
    tester,
  ) async {
    final h = await _Harness.mount(tester);
    h.repository.eventsController.add(
      _batch([_user, _timer(done: false, at: 1), _reply()]),
    );
    await tester.pump();
    await h.makePromptDue(tester);

    await tester.pump(const Duration(seconds: 3));
    expect(find.text(_prompt), findsNothing);

    h.repository.eventsController.add(_batch([_timer(done: true, at: 3)]));
    await tester.pump();
    await h.settle(tester);
    expect(find.text(_prompt), findsOneWidget);
  });

  testWidgets('a due prompt waits while a command failure is shown', (
    tester,
  ) async {
    final h = await _Harness.mount(tester, transcript: _hydratedTurn);
    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'one more thing',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump();
    h.repository.eventsController.add(
      const RemotePortalEventBatch(
        events: [
          RemoteCommandFailedEvent(
            commandId: 'fake-cmd',
            message: 'The desktop rejected the message.',
          ),
        ],
        nextCursor: 2,
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(
      find.byKey(const ValueKey('remote-command-failure')),
      findsOneWidget,
    );
    await h.makePromptDue(tester);

    await tester.pump(const Duration(seconds: 3));
    expect(find.text(_prompt), findsNothing);

    await tester.tap(
      find.byKey(const ValueKey('remote-command-failure-dismiss')),
    );
    await tester.pump();
    await h.settle(tester);
    expect(find.text(_prompt), findsOneWidget);
  });

  testWidgets('a due prompt waits while a send is still in flight', (
    tester,
  ) async {
    final h = await _Harness.mount(tester, transcript: _hydratedTurn);
    final accepted = Completer<RemoteChatSendResult>();
    h.repository.sendChatMessageHandler = () => accepted.future;

    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'one more thing',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump();
    expect(h.repository.sendChatMessageCalls, hasLength(1));
    await h.makePromptDue(tester);

    // Longer than the post-send "awaiting the agent" bridge, which lapses on
    // its own; only the unanswered send still marks the chat as busy.
    await tester.pump(kRemoteTurnStartGrace + const Duration(seconds: 1));
    // The composer's sending spinner never settles, so pump the sheet's
    // entrance by hand.
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text(_prompt), findsNothing);

    accepted.complete(
      const RemoteChatSendResult(commandId: 'cmd-1', chatId: 'chat-1'),
    );
    await tester.pump();
    // Accepted: once the agent bridge for the accepted send lapses too, the
    // chat is quiet again and the due prompt shows.
    await tester.pump(kRemoteTurnStartGrace + const Duration(seconds: 1));
    await h.settle(tester);
    expect(find.text(_prompt), findsOneWidget);
  });
}
