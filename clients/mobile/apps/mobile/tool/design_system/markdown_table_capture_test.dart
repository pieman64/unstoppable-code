// Markdown tables in the remote chat feed: TABLE_STAGE=before/after
// flutter test tool/design_system/markdown_table_capture_test.dart --update-goldens
// Seeds the exact assistant reply from the bug report (a two-column GFM
// table) plus a five-column table that cannot wrap, through the fake
// repository at a 390-wide phone viewport with bundled fonts and no network.
// Both color modes are captured on each run; `after` is the default stage.
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
  final stage = Platform.environment['TABLE_STAGE'] ?? 'after';

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
        title: 'Ask-user card',
        active: true,
      ),
    ],
    chatMessages: [
      RemoteChatMessage(
        messageId: 'u-1',
        chatId: 'chat-1',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'What has the UI handled so far?',
      ),
      RemoteChatMessage(
        messageId: 'a-1',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text:
            'Running tally of what the UI has now handled:\n'
            '| Shape | Result |\n'
            '|---|---|\n'
            '| 2 questions, free-form on one | Free-form arrived as "Additional", no option |\n'
            '| 2 questions, single + multi-select | Both returned verbatim |\n'
            '| 1 question, ~100-char labels | Returned verbatim, no truncation |\n'
            '| 3 questions, dismissed | Whole batch discarded as an error |\n'
            '\n'
            'Per-field timings, which are too wide to wrap:\n'
            '| Field | Parse | Validate | Render | Total |\n'
            '|:--|--:|--:|--:|--:|\n'
            '| `free_form_answer` | 0.4 ms | 1.2 ms | 3.9 ms | 5.5 ms |\n'
            '| `multi_select_answer` | 0.3 ms | 0.8 ms | 4.1 ms | 5.2 ms |',
      ),
    ],
  );

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    testWidgets('markdown table $mode', (tester) async {
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
          '../../../../.playwright/mobile-markdown-table/$name-$stage-$mode.png',
        ),
      );
      // The feed opens scrolled to the newest message.
      await capture('feed');

      // The wide table pans in place. It is found through its own scroll
      // view (not the first horizontal scroller, which is the tab strip);
      // the `before` tree renders the cell as prose with no scroller, and
      // this spec must compile against both trees.
      final wideTable = find.ancestor(
        of: find.textContaining('Validate', findRichText: true),
        matching: find.byType(SingleChildScrollView),
      );
      if (wideTable.evaluate().isNotEmpty) {
        await tester.drag(wideTable.first, const Offset(-200, 0));
        await tester.pumpAndSettle();
        await capture('feed-scrolled');
      }

      // Scroll the feed up so the reply's opening line and the header row of
      // the first table are visible.
      await tester.drag(find.byType(ListView).last, const Offset(0, 260));
      await tester.pumpAndSettle();
      await capture('feed-top');
      expect(tester.takeException(), isNull);
    });
  }
}
