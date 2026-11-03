// Reproduction probe for the intermittent Android keyboard-sized blank area
// on Remote home. Uses the real HomeShell, native IME, and local fake data.
// Run: flutter drive --driver=test_driver/integration_test.dart \
//   --target=integration_test/remote_keyboard_recovery_test.dart -d <device>
// Add --dart-define=CAPTURE_KEYBOARD_RECOVERY=true for screenshots under
// build/promo_screenshots (captured only after the keyboard cycles).
// For actual background/resume races use test_driver/keyboard_recovery.dart
// with --dart-define=INTERRUPT_KEYBOARD=true and its documented adb environment.
// This mode reproduced flutter/flutter#191156 on Android 17 before the native
// inset recovery. It fails if keyboard space remains after returning.
// This checks viewport geometry and reachability; passing does not rule out
// a device-specific retained rendering clip or missed native inset update.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/main.dart'
    show refreshActivityFeed, watchActivityAccount;
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:provider/provider.dart';

import '../test/support/cloud_chat_providers.dart';
import '../test/support/fake_remote_control_repository.dart';
import '../test/support/settings_root_providers.dart';

RemoteSessionSnapshot _snapshot() => RemoteSessionSnapshot(
  workspaces: [
    for (var i = 0; i < 14; i++)
      RemoteWorkspace(
        localId: 'ws-$i',
        name: 'Project ${i.toString().padLeft(2, '0')}',
        type: RemoteWorkspaceType.singleRepo,
        order: i,
      ),
  ],
  worktrees: [
    for (var i = 0; i < 23; i++)
      RemoteWorktree(
        localId: 'wt-$i',
        workspaceLocalId: 'ws-${i % 14}',
        branch: 'feature/task-$i',
        hasUnread: true,
      ),
  ],
  standaloneChats: const [],
  chatMessages: const [
    RemoteChatMessage(
      messageId: 'message-0',
      chatId: 'chat-0',
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: 'Ready for a new message.',
    ),
  ],
  chatSummaries: const [
    RemoteChatSummary(
      chatId: 'chat-0',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-0',
      worktreeLocalId: 'wt-0',
      title: 'Keyboard recovery',
      active: true,
    ),
  ],
);

final class _KeyboardRepository extends FakeRemoteControlRepository {
  @override
  Future<RemoteConnection?> restoreSession() async =>
      RemoteConnection(deviceLabel: 'Test Desktop', pairedAt: DateTime(2026));
}

class _KeyboardTrace with WidgetsBindingObserver {
  final stopwatch = Stopwatch()..start();
  final events = <Map<String, Object?>>[];

  void record(String event) {
    final view = WidgetsBinding.instance.platformDispatcher.views.first;
    events.add({
      'event': event,
      'ms': stopwatch.elapsedMilliseconds,
      'inset': view.viewInsets.bottom / view.devicePixelRatio,
    });
  }

  @override
  void didChangeMetrics() => record('metrics');

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      record(state.name);
}

// The host driver performs real Android Home/resume actions over adb. The
// loopback bridge exists only in this integration-test entry point.
Future<void> _backgroundAndResume(int delayMs) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse('http://127.0.0.1:18765/cycle?delayMs=$delayMs'),
    );
    final response = await request.close().timeout(const Duration(seconds: 20));
    final body = await response.transform(utf8.decoder).join();
    if (response.statusCode != 200) throw StateError(body);
  } finally {
    client.close(force: true);
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Remote home reclaims the keyboard viewport after chat navigation',
    (tester) async {
      const background = bool.fromEnvironment('INTERRUPT_KEYBOARD');
      const cycleCount = background ? 20 : 6;
      final trace = _KeyboardTrace();
      binding.addObserver(trace);
      addTearDown(() => binding.removeObserver(trace));
      final cycleResults = <Map<String, Object?>>[];
      binding.reportData = {'events': trace.events, 'cycles': cycleResults};
      final repository = _KeyboardRepository()..snapshotBuilder = _snapshot;
      final remote = RemoteControlViewModel(repository: repository);
      await remote.connect('123456');
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ...settingsRootTestProviders(),
            ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
            ChangeNotifierProvider<HomeTabController>(
              create: (_) => HomeTabController(tabs: const [HomeTab.remote]),
            ),
            ...cloudChatTestProviders(),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            home: const HomeShell(
              refreshActivity: refreshActivityFeed,
              activityAccount: watchActivityAccount,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final list = find.byKey(const ValueKey('remote-workspaces-list'));
      final fullListRect = tester.getRect(list);
      expect(find.text('14'), findsOneWidget);
      final scrollable = find.descendant(
        of: list,
        matching: find.byType(Scrollable),
      );
      await tester.scrollUntilVisible(
        find.text('Project 00').last,
        200,
        scrollable: scrollable,
      );
      await tester.tap(find.text('Project 00').last);
      await tester.pumpAndSettle();
      final worktree = find.byKey(const ValueKey('worktree-ws-0-wt-0'));

      // Exercise both a fully closed IME before popping and a route popped
      // during IME dismissal. Never inject viewInsets: Android must supply them.
      for (var cycle = 0; cycle < cycleCount; cycle++) {
        await tester.scrollUntilVisible(worktree, 150, scrollable: scrollable);
        // The floating app bar covers the viewport's leading edge. Center the
        // row after lazy construction so the tap cannot land on that chrome.
        await Scrollable.ensureVisible(
          tester.element(worktree),
          alignment: 0.5,
        );
        await tester.pumpAndSettle();
        await tester.tap(worktree);
        await tester.pumpAndSettle();
        final input = find
            .descendant(
              of: find.byKey(const ValueKey('chat-composer')),
              matching: find.byType(TextField),
            )
            .first;
        trace.record('cycle-$cycle-tap');
        final eventStart = trace.events.length;
        await tester.tap(input);
        if (background) {
          // Alternate interrupting immediately after the tap and waiting for
          // the first nonzero inset, then sweep the additional host delay.
          if (cycle.isOdd) {
            for (
              var frame = 0;
              frame < 100 && tester.view.viewInsets.bottom == 0;
              frame++
            ) {
              await tester.pump(const Duration(milliseconds: 10));
            }
            expect(
              tester.view.viewInsets.bottom,
              greaterThan(0),
              reason: 'The native keyboard must actually open (cycle $cycle)',
            );
          }
          final delayMs = [0, 30, 75, 150, 250][(cycle ~/ 2) % 5];
          trace.record('cycle-$cycle-background-request');
          await _backgroundAndResume(delayMs);
          await tester.pump(const Duration(milliseconds: 100));
          FocusManager.instance.primaryFocus?.unfocus();
          for (var frame = 0; frame < 10; frame++) {
            await tester.pump(const Duration(milliseconds: 100));
          }
          final lifecycle = trace.events
              .skip(eventStart)
              .map((e) => e['event'])
              .toList();
          expect(
            lifecycle,
            contains('paused'),
            reason: 'Must actually background',
          );
          expect(
            lifecycle,
            contains('resumed'),
            reason: 'Must actually resume',
          );
        } else {
          for (
            var frame = 0;
            frame < 30 && tester.view.viewInsets.bottom == 0;
            frame++
          ) {
            await tester.pump(const Duration(milliseconds: 100));
          }
          expect(
            tester.view.viewInsets.bottom,
            greaterThan(0),
            reason: 'The native keyboard must actually open (cycle $cycle)',
          );
          await tester.pumpAndSettle();
          expect(
            tester.getRect(find.byKey(const ValueKey('chat-composer'))).bottom,
            lessThanOrEqualTo(
              (tester.view.physicalSize.height -
                      tester.view.viewInsets.bottom) /
                  tester.view.devicePixelRatio,
            ),
            reason: 'The composer must remain above the real keyboard',
          );
          if (cycle.isEven) {
            await SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
            await tester.pumpAndSettle();
          }
        }
        await tester.tap(find.byTooltip('Back'));
        await tester.pumpAndSettle();
        for (
          var frame = 0;
          frame < 30 && tester.view.viewInsets.bottom != 0;
          frame++
        ) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        trace.record('cycle-$cycle-returned');
        cycleResults.add({
          'cycle': cycle,
          'background': background,
          'inset': tester.view.viewInsets.bottom / tester.view.devicePixelRatio,
          'listHeight': tester.getRect(list).height,
          'expectedListHeight': fullListRect.height,
        });
        expect(
          tester.view.viewInsets.bottom,
          0,
          reason: 'cycle $cycle; ${cycleResults.last}',
        );
        expect(tester.getRect(list), fullListRect, reason: 'cycle $cycle');
      }

      if (const bool.fromEnvironment('CAPTURE_KEYBOARD_RECOVERY')) {
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('workspace-ws-0')),
          -200,
          scrollable: scrollable,
        );
        await tester.tap(find.text('Project 00').last);
        final position = tester.state<ScrollableState>(scrollable).position;
        position.jumpTo(0);
        await tester.pumpAndSettle();
        await binding.convertFlutterSurfaceToImage();
        await tester.pumpAndSettle();
        await binding.takeScreenshot('remote-keyboard-recovered');
      }
      await tester.scrollUntilVisible(
        find.text('Project 13'),
        250,
        scrollable: scrollable,
      );
      expect(find.text('Project 13').hitTestable(), findsOneWidget);
      if (const bool.fromEnvironment('CAPTURE_KEYBOARD_RECOVERY')) {
        await tester.pumpAndSettle();
        await binding.takeScreenshot('remote-keyboard-last-project');
      }
      expect(tester.takeException(), isNull);
      binding.reportData = {
        ...?binding.reportData,
        'cycleCount': cycleCount,
        'projects': 14,
      };
      await tester.pumpWidget(const SizedBox.shrink());
      remote.dispose();
      await repository.eventsController.close();
    },
  );
}
