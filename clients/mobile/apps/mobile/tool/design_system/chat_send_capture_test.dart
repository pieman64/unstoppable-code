// Immediate send clearing: SEND_STAGE=before/after flutter test
// tool/design_system/chat_send_capture_test.dart --update-goldens
// Captures both themes with a deferred fake send and no network.
import 'dart:async';
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

void main() {
  for (final dark in [false, true]) {
    testWidgets('pending send ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await (FontLoader('Inter')
            ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf')))
          .load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
      final completion = Completer<RemoteChatSendResult>();
      final repo = FakeRemoteControlRepository()
        ..sendChatMessageHandler = () => completion.future;
      final vm = RemoteControlViewModel(repository: repo);
      await vm.connect('123456');
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const RemoteChatScreen.standalone(
              standaloneChat: RemoteStandaloneChat(
                localId: 'chat-1',
                projectLocalId: 'ws-1',
                title: 'Chat',
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Deploy the fix',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump(const Duration(milliseconds: 100));
      final stage = Platform.environment['SEND_STAGE'] == 'before'
          ? 'before'
          : 'after';
      await expectLater(
        find.byKey(const ValueKey('chat-composer')),
        matchesGoldenFile(
          '../../../../.playwright/mobile-send-clear/pending-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      completion.complete(
        const RemoteChatSendResult(commandId: '', chatId: 'chat-1'),
      );
      await tester.pump();
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });
  }
}
