// Instant new-chat tabs, deterministic before/after light/dark evidence.
// REMOTE_TAB_CREATION_STAGE=before (or after) flutter test
// tool/remote_tabs/creation_capture_test.dart --update-goldens, from apps/mobile.
// Fixed summaries, bundled fonts, no network or live agents.
//
// The provisional tab is minted from the conversations sheet's "New chat"
// action; the capture is of the screen right after the sheet dismisses, so it
// shows the new empty conversation opening with no desktop round trip.
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

void main() {
  final stage = Platform.environment['REMOTE_TAB_CREATION_STAGE'] == 'before'
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
    testWidgets('remote tabs ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(440, 700);
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
          for (final title in ['Idle'])
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
      });
      final vm = RemoteControlViewModel(
        repository: repo,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      await tester.pumpWidget(
        MultiProvider(
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
            home: RepaintBoundary(
              key: const ValueKey('capture'),
              child: RemoteChatScreen.worktree(
                worktree: vm.allWorktrees.single,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.byKey(const ValueKey('new-chat-button')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      Directory(
        '../../.playwright/remote-tab-creation',
      ).createSync(recursive: true);
      await expectLater(
        find.byKey(const ValueKey('capture')),
        matchesGoldenFile(
          '../../../../.playwright/remote-tab-creation/tabs-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
      await repo.eventsController.close();
    });
  }
}
