// Remote chat tabs: horizontal chip strip -> conversations FAB + bottom sheet.
//
// What changed: the always-on 48px tab strip above the transcript is gone.
// A small FAB in the transcript's bottom-right corner carries a blue dot when
// any conversation in the worktree is unread, and opens a bottom sheet listing
// every tab (title, unread dot or working spinner, per-row close) with a
// pinned "New chat" action.
//
// Run from apps/mobile, on the unchanged tree first and the changed tree
// second. Both color modes run together:
//   REMOTE_TAB_SHEET_STAGE=before flutter test \
//     tool/remote_tabs/sheet_capture_test.dart --update-goldens
//   REMOTE_TAB_SHEET_STAGE=after flutter test \
//     tool/remote_tabs/sheet_capture_test.dart --update-goldens
//
// The `after` stage additionally captures the opened sheet; the `before` tree
// has no FAB to open, so that shot exists only on the changed side.
//
// Deterministic: fixed chat summaries from a fake desktop projection, bundled
// fonts, a pinned viewport, and no network, timers-of-consequence, or live
// agents.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import '../../test/support/fake_remote_control_repository.dart';

const _captureDir = '.playwright/remote-tab-sheet';

void main() {
  final stage = Platform.environment['REMOTE_TAB_SHEET_STAGE'] == 'before'
      ? 'before'
      : 'after';
  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    testWidgets('chat tabs $mode', (tester) async {
      tester.view.physicalSize = const Size(440, 760);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      final repo = FakeRemoteControlRepository();
      repo.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
        'workspaces': [],
        'worktrees': [
          {
            'localId': 'wt-1',
            'workspaceLocalId': 'ws-1',
            'branch': 'Remote tabs',
          },
        ],
        'standaloneChats': [],
        'chatSummaries': [
          for (final title in [
            'Idle',
            'Running',
            'Unread',
            'Rewrite the onboarding copy for non-technical users',
          ])
            {
              'chatId': title,
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': title,
              'active': title == 'Idle',
              'turnActive': title == 'Running',
              'hasUnread': title == 'Unread',
            },
        ],
        'chatMessages': [
          {
            'localMessageId': 'idle-1',
            'localChatId': 'Idle',
            'scope': 'worktree',
            'role': 'user',
            'status': 'complete',
            'content': 'Where did the tab strip go?',
          },
          {
            'localMessageId': 'idle-2',
            'localChatId': 'Idle',
            'scope': 'worktree',
            'role': 'assistant',
            'status': 'complete',
            'content':
                'It moved behind the conversations button in the corner.',
          },
        ],
      });
      final vm = RemoteControlViewModel(
        repository: repo,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      await tester.pumpWidget(
        // The boundary wraps the whole app, not just `home`: the tab sheet is
        // a route in the navigator's overlay, so a boundary inside `home`
        // would capture the screen with the sheet cropped away.
        RepaintBoundary(
          key: const ValueKey('capture'),
          child: MultiProvider(
            providers: [
              ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
              ChangeNotifierProvider(
                create: (_) => TurnFeedbackController(
                  repository: MockTurnFeedbackRepository(),
                ),
              ),
            ],
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: dark ? AppTheme.dark : AppTheme.light,
              home: RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      Directory('../../$_captureDir').createSync(recursive: true);
      await expectLater(
        find.byKey(const ValueKey('capture')),
        matchesGoldenFile('../../../../$_captureDir/screen-$stage-$mode.png'),
      );

      if (stage == 'after') {
        await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        await expectLater(
          find.byKey(const ValueKey('capture')),
          matchesGoldenFile('../../../../$_captureDir/sheet-$stage-$mode.png'),
        );
      }

      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
      await repo.eventsController.close();
    });
  }
}
