// CAN-3642 — foreground pushes render nothing in the app. Pumps the real
// [App] composition so any wrapper around the root navigator is covered, and
// works on a focused composer with the keyboard inset applied.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/main.dart';
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../../support/foreground_push_fixture.dart';
import '../../support/memory_remote_transcript_storage.dart';

void main() {
  late PushMessageCoordinator coordinator;
  late FakePushMessaging messaging;
  late RemoteControlViewModel viewModel;

  Future<void> pumpApp(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      App(
        themeController: ThemeController(store: InMemoryThemePreferenceStore()),
        transcriptStorage: MemoryRemoteTranscriptStorage(),
      ),
    );
    // Flush the mock auth restore() timer.
    await tester.pump(const Duration(seconds: 1));
    coordinator = tester
        .element(find.byType(AuthGate))
        .read<PushMessageCoordinator>();
    final appMessaging = coordinator.messaging;
    if (appMessaging is! FakePushMessaging) {
      fail('Tests run the app with its fake push messaging');
    }
    messaging = appMessaging;
    // The coordinator is app-lifetime; start it the way sign-in does and
    // leave it stopped for the next test.
    await coordinator.start();
    addTearDown(coordinator.stop);
    viewModel = RemoteControlViewModel(repository: Can3642Repository());
    await tester.runAsync(() => viewModel.connect('123456'));
  }

  // The worktree-setup spinner never settles; pump past route transitions.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
  }

  // Unmounts the app and the paired view model so no refresh timer outlives
  // the test.
  Future<void> tearDownApp(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    viewModel.dispose();
    await tester.pump(const Duration(minutes: 1));
  }

  BuildContext rootContext(WidgetTester tester) =>
      tester.element(find.byType(AuthGate));

  Future<void> openChat(WidgetTester tester, RemoteChatScreen screen) async {
    unawaited(can3642OpenChat(rootContext(tester), viewModel, screen));
    await settle(tester);
  }

  Future<void> focusComposerWithKeyboard(WidgetTester tester) async {
    final draft = find.byKey(const ValueKey('composer-draft'));
    await tester.tap(draft);
    await tester.enterText(draft, can3642Draft);
    // The keyboard occupies the bottom of the screen (physical pixels).
    tester.view.viewInsets = const FakeViewPadding(bottom: 1008);
    addTearDown(tester.view.resetViewInsets);
    await settle(tester);
  }

  EditableTextState composer(WidgetTester tester) => tester.state(
    find.descendant(
      of: find.byKey(const ValueKey('composer-draft')),
      matching: find.byType(EditableText),
    ),
  );

  Future<void> deliverAllPushes(WidgetTester tester) async {
    for (final push in can3642Pushes) {
      messaging.emitForegroundMessage(push);
      await tester.pump();
    }
    await tester.pump(const Duration(milliseconds: 300));
  }

  void expectComposerUntouched(WidgetTester tester) {
    final state = composer(tester);
    expect(state.textEditingValue.text, can3642Draft);
    expect(
      state.textEditingValue.selection,
      const TextSelection.collapsed(offset: can3642Draft.length),
    );
    expect(state.widget.focusNode.hasFocus, isTrue);
    expect(
      MediaQuery.of(tester.element(find.byType(RemoteChatScreen))).viewInsets,
      const EdgeInsets.only(bottom: 336),
    );
    expect(find.byType(RemoteChatScreen), findsOneWidget);
    expect(coordinator.pendingTap.value, isNull);
  }

  testWidgets(
    'pushes during new-chat worktree setup leave the focused composer alone',
    (tester) async {
      await pumpApp(tester);
      await openChat(
        tester,
        const RemoteChatScreen.create(workspace: can3642Workspace),
      );
      expect(find.text('Creating worktree…'), findsOneWidget);
      await focusComposerWithKeyboard(tester);

      await deliverAllPushes(tester);

      expect(can3642NotificationSurface(), findsNothing);
      expect(find.byType(SnackBar), findsNothing);
      expectComposerUntouched(tester);
      expect(find.text('Creating worktree…'), findsOneWidget);

      // Nothing appears later either: past the former six-second banner
      // lifetime for every queued push.
      for (var i = 0; i < can3642Pushes.length; i++) {
        await tester.pump(const Duration(seconds: 7));
        expect(can3642NotificationSurface(), findsNothing);
        expect(find.byType(SnackBar), findsNothing);
      }
      expectComposerUntouched(tester);
      expect(tester.takeException(), isNull);
      await tearDownApp(tester);
    },
  );

  testWidgets('repeated pushes across navigation never queue or replay', (
    tester,
  ) async {
    await pumpApp(tester);
    await openChat(
      tester,
      const RemoteChatScreen.worktree(
        worktree: can3642Worktree,
        initialChatId: can3642ChatId,
      ),
    );
    await focusComposerWithKeyboard(tester);
    await deliverAllPushes(tester);
    expect(can3642NotificationSurface(), findsNothing);
    expectComposerUntouched(tester);

    // Leave the chat, push again on the root screen, then reopen.
    Navigator.of(tester.element(find.byType(RemoteChatScreen))).pop();
    await settle(tester);
    await deliverAllPushes(tester);
    expect(can3642NotificationSurface(), findsNothing);
    await openChat(
      tester,
      const RemoteChatScreen.create(workspace: can3642Workspace),
    );
    await deliverAllPushes(tester);
    await tester.pump(const Duration(seconds: 7));
    expect(can3642NotificationSurface(), findsNothing);
    expect(find.byType(SnackBar), findsNothing);

    // A sign-out/sign-in cycle restarts the coordinator; earlier pushes stay
    // gone and new ones stay silent.
    // Stream cancellation needs a real async zone.
    await tester.runAsync(coordinator.stop);
    await tester.runAsync(coordinator.start);
    await deliverAllPushes(tester);
    for (var i = 0; i < can3642Pushes.length * 3; i++) {
      await tester.pump(const Duration(seconds: 7));
      expect(can3642NotificationSurface(), findsNothing);
      expect(find.byType(SnackBar), findsNothing);
    }
    expect(find.byType(RemoteChatScreen), findsOneWidget);
    expect(coordinator.pendingTap.value, isNull);
    expect(tester.takeException(), isNull);
    await tearDownApp(tester);
  });

  testWidgets('action feedback SnackBars still show and expire normally', (
    tester,
  ) async {
    await pumpApp(tester);
    await openChat(
      tester,
      const RemoteChatScreen.worktree(
        worktree: can3642Worktree,
        initialChatId: can3642ChatId,
      ),
    );
    ScaffoldMessenger.of(
      tester.element(find.byType(RemoteChatScreen)),
    ).showSnackBar(const SnackBar(content: Text('Copied to clipboard')));
    await tester.pump();
    await deliverAllPushes(tester);

    expect(find.text('Copied to clipboard'), findsOneWidget);
    expect(can3642NotificationSurface(), findsNothing);

    // The default four-second feedback expires and nothing replaces it.
    await tester.pump(const Duration(seconds: 5));
    await settle(tester);
    expect(find.text('Copied to clipboard'), findsNothing);
    expect(find.byType(SnackBar), findsNothing);
    expect(can3642NotificationSurface(), findsNothing);
    expect(tester.takeException(), isNull);
    await tearDownApp(tester);
  });
}
