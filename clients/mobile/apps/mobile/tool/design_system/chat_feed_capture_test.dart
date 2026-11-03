// Remote chat feed (desktop-parity transcript): FEED_STAGE=before/after
// flutter test tool/design_system/chat_feed_capture_test.dart --update-goldens
// Seeded transcript through the fake repository, bundled fonts, no network,
// reduce-motion so the streaming spinner renders a static frame. Both color
// modes are captured on each run; `after` is the default stage.
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
  final stage = Platform.environment['FEED_STAGE'] ?? 'after';

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
        title: 'Login badge',
        active: true,
        turnActive: true,
        turnElapsedMs: 126000,
      ),
    ],
    chatMessages: [
      RemoteChatMessage(
        messageId: 'u-1',
        chatId: 'chat-1',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'Fix the login badge so it only shows on the sign-in screen.',
      ),
      RemoteChatMessage(
        messageId: 'a-1',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: '',
        parts: [
          ChatPart(
            kind: 'thinking',
            data: {'text': 'First I will inspect the auth flow.'},
          ),
          ChatPart(
            kind: 'tool_use',
            toolFamily: 'read',
            data: {
              'toolName': 'Read',
              'input': '{"file_path":"lib/auth/login_badge.dart"}',
            },
          ),
          ChatPart(
            kind: 'tool_use',
            toolFamily: 'bash',
            data: {
              'toolName': 'Bash',
              'input':
                  '{"command":"npm test -- auth","description":"Run the auth tests"}',
            },
          ),
          ChatPart(
            kind: 'tool_use',
            toolFamily: 'edit',
            data: {
              'toolName': 'Edit',
              'input': '{"file_path":"lib/auth/login_badge.dart"}',
            },
          ),
        ],
      ),
      RemoteChatMessage(
        messageId: 'a-2',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text:
            'Done. The badge now renders only on the sign-in screen.\n\n'
            '- Moved the visibility check into `LoginBadge`\n'
            '- Added a regression test in `login_badge_test.dart`\n\n'
            'All 42 auth tests pass.',
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
      RemoteChatMessage(
        messageId: 'u-2',
        chatId: 'chat-1',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'Great, now update the runbook to match.',
      ),
      RemoteChatMessage(
        messageId: 'a-3',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        // A settled carrier can coexist with an authoritative live timer.
        // This is the regression shape: feedback must remain hidden.
        status: ChatMessageStatus.complete,
        text: 'I found the section. Updating it now.',
        parts: [
          ChatPart(
            kind: 'thinking',
            data: {'text': 'Locating the runbook section on badges.'},
          ),
          ChatPart(
            kind: 'tool_use',
            toolFamily: 'grep',
            data: {
              'toolName': 'Grep',
              'input': '{"pattern":"login badge","path":"docs"}',
            },
          ),
        ],
      ),
    ],
  );

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    testWidgets('remote chat feed $mode', (tester) async {
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
          '../../../../.playwright/mobile-chat-feed/$name-$stage-$mode.png',
        ),
      );
      await capture('collapsed');

      // Expand the first turn's steps (the row is the only tappable steps
      // control for a completed turn; the streaming turn has none yet).
      final stepsRow = find.byKey(const ValueKey('turn-steps-u-1'));
      await tester.tap(
        // The `before` tree has no keyed steps row; it is a text pill.
        stepsRow.evaluate().isEmpty
            ? find.textContaining('1 step · Read')
            : stepsRow,
      );
      await tester.pumpAndSettle();
      await capture('expanded');
      expect(tester.takeException(), isNull);
    });
  }
}
