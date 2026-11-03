// CAN-3642 — device verification that foreground pushes render nothing and
// leave a focused composer, its draft, the native keyboard and the current
// screen alone, across repeated pushes and navigation. Pumps the real App
// composition with its fake push messaging; the repository is the synthetic
// fixture (no pairing, desktop, account or network).
//
//   flutter drive --no-pub --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3642_foreground_push_device_test.dart \
//     -d <device-id>
//
// iOS simulators need the software keyboard enabled (I/O > Keyboard >
// Toggle Software Keyboard); the test fails if no native inset appears.
// This does not cover OS notification delivery or taps, which Firebase
// presents outside the app.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/main.dart';
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/foreground_push_fixture.dart';
import '../test/support/memory_remote_transcript_storage.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final report = <String, Object?>{};

  testWidgets('CAN-3642 foreground pushes never interrupt the composer', (
    tester,
  ) async {
    await tester.pumpWidget(
      App(
        themeController: ThemeController(store: InMemoryThemePreferenceStore()),
        transcriptStorage: MemoryRemoteTranscriptStorage(),
      ),
    );
    await tester.pump(const Duration(seconds: 1));
    final root = tester.element(find.byType(AuthGate));
    final coordinator = root.read<PushMessageCoordinator>();
    final messaging = coordinator.messaging;
    if (messaging is! FakePushMessaging) {
      fail('Run without an API configuration so pushes are synthetic');
    }
    await coordinator.start();
    final viewModel = RemoteControlViewModel(repository: Can3642Repository());
    await viewModel.connect('123456');

    final draftField = find.byKey(const ValueKey('composer-draft'));
    EditableTextState composer() => tester.state(
      find.descendant(of: draftField, matching: find.byType(EditableText)),
    );
    double inset() => tester.view.viewInsets.bottom;

    Future<void> pumpFor(Duration duration) async {
      final end = DateTime.now().add(duration);
      while (DateTime.now().isBefore(end)) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> open(RemoteChatScreen screen) async {
      unawaited(can3642OpenChat(root, viewModel, screen));
      await pumpFor(const Duration(seconds: 1));
    }

    Future<double> focusWithKeyboard() async {
      await tester.tap(draftField);
      for (var frame = 0; frame < 50 && inset() == 0; frame++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(inset(), greaterThan(0), reason: 'The native keyboard must open');
      // Type through the same entry point the IME uses.
      composer().userUpdateTextEditingValue(
        const TextEditingValue(
          text: can3642Draft,
          selection: TextSelection.collapsed(offset: can3642Draft.length),
        ),
        SelectionChangedCause.keyboard,
      );
      await pumpFor(const Duration(milliseconds: 800));
      return inset();
    }

    var observations = 0;
    void expectUntouched(double keyboardInset, String step) {
      observations++;
      expect(can3642NotificationSurface(), findsNothing, reason: step);
      expect(find.byType(SnackBar), findsNothing, reason: step);
      final state = composer();
      expect(state.textEditingValue.text, can3642Draft, reason: step);
      expect(
        state.textEditingValue.selection,
        const TextSelection.collapsed(offset: can3642Draft.length),
        reason: step,
      );
      expect(state.widget.focusNode.hasFocus, isTrue, reason: step);
      expect(inset(), keyboardInset, reason: step);
      expect(find.byType(RemoteChatScreen), findsOneWidget, reason: step);
      expect(coordinator.pendingTap.value, isNull, reason: step);
    }

    Future<void> deliverPushes(double keyboardInset, String step) async {
      for (final push in can3642Pushes) {
        messaging.emitForegroundMessage(push);
        await pumpFor(const Duration(milliseconds: 250));
        expectUntouched(keyboardInset, '$step: ${push.title}');
      }
    }

    // New chat while its worktree is still being set up.
    await open(const RemoteChatScreen.create(workspace: can3642Workspace));
    expect(find.text('Creating worktree…'), findsOneWidget);
    final createInset = await focusWithKeyboard();
    await deliverPushes(createInset, 'new chat');
    // Longer than the former six-second banner lifetime.
    await pumpFor(const Duration(seconds: 7));
    expectUntouched(createInset, 'new chat after 7s');
    expect(find.text('Creating worktree…'), findsOneWidget);

    // Leave, receive pushes on the root screen, then open an existing chat.
    await SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
    Navigator.of(tester.element(find.byType(RemoteChatScreen))).pop();
    await pumpFor(const Duration(seconds: 1));
    for (final push in can3642Pushes) {
      messaging.emitForegroundMessage(push);
    }
    await pumpFor(const Duration(seconds: 1));
    expect(can3642NotificationSurface(), findsNothing);
    await open(
      const RemoteChatScreen.worktree(
        worktree: can3642Worktree,
        initialChatId: can3642ChatId,
      ),
    );
    final chatInset = await focusWithKeyboard();
    await deliverPushes(chatInset, 'existing chat');
    await pumpFor(const Duration(seconds: 7));
    expectUntouched(chatInset, 'existing chat after 7s');

    // Ordinary action feedback still shows, and no push replaces it.
    ScaffoldMessenger.of(
      tester.element(find.byType(RemoteChatScreen)),
    ).showSnackBar(const SnackBar(content: Text('Copied to clipboard')));
    await pumpFor(const Duration(milliseconds: 500));
    for (final push in can3642Pushes) {
      messaging.emitForegroundMessage(push);
    }
    await pumpFor(const Duration(milliseconds: 500));
    expect(find.text('Copied to clipboard'), findsOneWidget);
    await pumpFor(const Duration(seconds: 6));
    expect(find.text('Copied to clipboard'), findsNothing);
    expectUntouched(chatInset, 'after feedback expired');

    expect(tester.takeException(), isNull);
    report.addAll({
      'pushesPerBurst': can3642Pushes.length,
      'observations': observations,
      'createInsetPx': createInset,
      'chatInsetPx': chatInset,
      'devicePixelRatio': tester.view.devicePixelRatio,
      'physicalSize': [
        tester.view.physicalSize.width,
        tester.view.physicalSize.height,
      ],
    });
    binding.reportData = {'can3642': report};
    await SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
    await coordinator.stop();
    await tester.pumpWidget(const SizedBox.shrink());
    viewModel.dispose();
  });
}
