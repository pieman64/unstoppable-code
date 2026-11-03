// CAN-3429 capture spec: visual evidence only, not regression coverage. The
// durable coverage is can_3429_chat_controllers_device_test.dart plus the
// flutter test suites (remote_chat_screen_test, remote_chat_composer_test,
// and the controller tests under test/ui/features/remote/view_models/).
//
// CAN-3429 moves the Remote chat screen's optimistic tab, composer, PR-poll,
// and attachment-restore state into pure Dart controllers without changing
// what the screen shows. This walks the hydrated chat, two provisional tabs,
// a pending and a rolled-back close, pending and settled composer controls,
// and a restored retry attachment, in the light and then the dark theme. Run
// once per stage on the unchanged and changed trees from apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3429_chat_controllers_capture_test.dart \
//     --dart-define=CAN3429_STAGE=before -d <device-id>
//
// Deterministic: synthetic fixtures (test/support/chat_controllers_fixture
// .dart), fixed ids and transcripts, forced theme mode, no desktop, account,
// or network. Captures land in
// build/promo_screenshots/can-3429-<state>-<stage>-<theme>.png.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../test/support/chat_controllers_fixture.dart';
import '../test/support/composer_driver.dart';
import '../test/support/fake_attachment_picker.dart';

const _stage = String.fromEnvironment('CAN3429_STAGE', defaultValue: 'after');
const _sheetAnimation = Duration(milliseconds: 400);

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  for (final (theme, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('chat controllers ($theme)', (tester) async {
      Future<void> capture(String state) async {
        await tester.pumpAndSettle();
        // Let SVG glyphs and fonts finish their first frames.
        await tester.pump(const Duration(milliseconds: 300));
        await binding.takeScreenshot('can-3429-$state-$_stage-$theme');
      }

      Future<void> openSheet() async {
        await tester.pump(_sheetAnimation);
        await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
        await tester.pumpAndSettle();
      }

      Future<void> dismissSheet() async {
        Navigator.of(
          tester.element(find.byKey(const ValueKey('new-chat-button'))),
        ).pop();
        await tester.pumpAndSettle();
      }

      final repository = ChatControllersRepository();
      final picker = FakeAttachmentPicker()
        ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
          FakeAttachmentPicker.file('diagram.png'),
        ]);
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      Widget host() =>
          chatControllersHost(vm, themeMode: mode, attachmentPicker: picker);
      await tester.pumpWidget(host());
      if (Platform.isAndroid) {
        await binding.convertFlutterSurfaceToImage();
      }
      await capture('hydrated-chat');

      for (var i = 0; i < 2; i++) {
        await openSheet();
        await tester.tap(find.byKey(const ValueKey('new-chat-button')));
        await tester.pumpAndSettle();
      }
      await capture('provisional-chat');
      await openSheet();
      await capture('provisional-tabs');
      await tester.tap(find.byKey(const ValueKey('chat-tab-chat-a')));
      await tester.pumpAndSettle();

      await openSheet();
      await tester.tap(find.byKey(const ValueKey('chat-tab-close-chat-b')));
      await tester.pumpAndSettle();
      await openSheet();
      await capture('close-pending');
      await dismissSheet();
      repository.closeResponses.single.complete('close-b');
      await tester.pumpAndSettle();
      repository.fail('close-b', 'The tab could not be closed.');
      await tester.pumpAndSettle();
      await openSheet();
      await capture('close-rolled-back');
      await dismissSheet();
      vm.clearCommandFailure();

      await toggleComposerPlan(tester);
      await capture('composer-pending');
      repository.planResponses.single.complete('plan-1');
      await tester.pumpAndSettle();
      repository.planMode = true;
      repository.complete('plan-1');
      await tester.pumpAndSettle();
      await vm.refresh();
      await capture('composer-settled');

      // The attachment sources live in the composer's `+` sheet (CAN-3922).
      await tester.tap(find.byKey(const ValueKey('composer-actions')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('composer-action-attach-files')),
      );
      await tester.pumpAndSettle();
      repository.sendResponse = Completer<RemoteChatSendResult>();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Here is the diagram',
      );
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      // The send spinner runs until the response; it never settles.
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      repository.sendResponse!.complete(
        const RemoteChatSendResult(commandId: 'send-1', chatId: 'chat-a'),
      );
      await tester.pumpAndSettle();
      repository.fail('send-1', 'The send was rejected.');
      await tester.pumpAndSettle();
      vm.clearCommandFailure();
      await tester.pumpWidget(host());
      await capture('attachment-restored');

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      vm.dispose();
    });
  }
}
