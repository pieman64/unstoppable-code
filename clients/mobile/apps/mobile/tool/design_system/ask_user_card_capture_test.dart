// Agent input card: ASK_USER_STAGE=before/after
// flutter test tool/design_system/ask_user_card_capture_test.dart --update-goldens
//
// What changed, in two parts:
//  1. Placement — the awaiting AskUserQuestion card used to be a fixed shelf
//     between the transcript and the composer, capped at 40% of the viewport
//     with its own scroller. It is now a transcript row appended below the
//     agent's last message, so it scrolls with the conversation.
//  2. Form — the card now mirrors the shared desktop/web card: no banner
//     title, radio (or checkbox) rows with wrapping labels, "Other" as an
//     explicitly selectable choice whose field only appears once picked, and
//     Submit/Dismiss buttons.
//
// `before` captures the old shelf + chips, `after` the in-feed radio card.
// Both color modes are captured on each run; `after` is the default stage.
// Seeded through the fake repository with bundled fonts, no network, and
// reduce-motion, so every frame is deterministic.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

import '../../test/support/fake_remote_control_repository.dart';
import '../../test/support/reduced_motion.dart';

void main() {
  useReducedMotion();
  final stage = Platform.environment['ASK_USER_STAGE'] ?? 'after';

  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader('JetBrainsMono')..addFont(
          rootBundle.load(
            'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
          ),
        ))
        .load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  RemoteSessionSnapshot snapshot() => RemoteSessionSnapshot(
    workspaces: const [],
    worktrees: const [
      RemoteWorktree(localId: 'wt-1', workspaceLocalId: 'ws-1', branch: 'main'),
    ],
    standaloneChats: const [],
    chatSummaries: const [
      RemoteChatSummary(
        chatId: 'chat-1',
        scope: RemoteChatScope.worktree,
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        title: 'Chat tabs',
        active: true,
        pendingQuestions: [
          AskUserQuestionState(
            requestId: 'req-1',
            questions: [
              AskUserQuestion(
                id: 'q-1',
                question:
                    'What should each row in the tab list sheet carry? '
                    "Today's chips have title + close X + streaming spinner "
                    '+ unread dot.',
                options: [
                  'Everything the chips had: title, unread dot, working spinner',
                  'Title, unread dot and spinner only — drop the close X',
                  'Title, unread dot, spinner, plus a swipe-to-close gesture',
                ],
              ),
            ],
          ),
        ],
      ),
    ],
    chatMessages: [
      RemoteChatMessage(
        messageId: 'u-1',
        chatId: 'chat-1',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'Move the chat tabs into a sheet.',
      ),
      RemoteChatMessage(
        messageId: 'a-1',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text:
            'For cowork/standalone chats the app bar already shows the chat '
            "title, so I'll simply drop the synthetic one-tab strip there and "
            "show no FAB (there's only ever one chat and no new-chat action). "
            'Next:',
      ),
      RemoteChatMessage(
        messageId: 'u-1:turn-timer',
        chatId: 'chat-1',
        role: ChatRole.system,
        status: ChatMessageStatus.complete,
        text: '',
        occurredAt: DateTime.fromMillisecondsSinceEpoch(163000),
        parts: const [
          ChatPart(
            kind: 'turn_timer',
            data: {'startedAt': 100000, 'completedAt': 163000},
          ),
        ],
      ),
    ],
  );

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    testWidgets('agent input card $mode', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      addTearDown(tester.view.reset);

      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = snapshot;
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<RemoteControlViewModel>(
              create: (_) => viewModel,
            ),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: RemoteChatScreen.worktree(worktree: worktree),
          ),
        ),
      );
      await tester.pumpAndSettle();

      Future<void> capture(String name) => expectLater(
        find.byType(RemoteChatScreen),
        matchesGoldenFile(
          '../../../../.playwright/mobile-ask-user-card/$name-$stage-$mode.png',
        ),
      );
      await capture('at-rest');

      // Pick "Other" to show the conditional multi-line field, still anchored
      // at the bottom of the feed. The `before` tree has no Other row (its
      // freeform box is always open), so this step is a no-op there.
      final other = find.text('Other');
      if (other.evaluate().isNotEmpty) {
        await tester.tap(other);
        await tester.pumpAndSettle();
        await capture('other-selected');
        await tester.tap(other);
        await tester.pumpAndSettle();
      }

      // Drag the transcript up by one card's worth. After the change the card
      // travels with the conversation; before it was pinned above the composer
      // and only the messages behind it moved.
      await tester.drag(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 220),
      );
      await tester.pumpAndSettle();
      await capture('scrolled');
      expect(tester.takeException(), isNull);
    });
  }
}
