// CAN-3631 device verification: a chat load interrupted by a real app
// background neither fails on return nor loses its automatic retry. Run one
// scenario per invocation from apps/mobile with the native lifecycle driver
// (see test_driver/remote_hydration_lifecycle.dart for the host environment):
//
//   flutter drive --driver=test_driver/remote_hydration_lifecycle.dart \
//     --target=integration_test/can_3631_hydration_lifecycle_test.dart \
//     --dart-define=CAN3631_SCENARIO=ac1-standalone -d <device-id>
//
// Scenarios: ac1-standalone and ac1-worktree open the chat, wait 8s, then
// background the app for 55s while it loads: past the 60s load timeout, yet
// under the minute after which a return reloads the session instead of
// replaying the stream. The original reply is sent while the app is away;
// the repository holds it with event delivery paused and replays it on the
// return, the way the live event stream catches up from its cursor.
// ac3-cached lets both attempts time out in the foreground, with one short
// background during the first. They use the production 60s timeout and 15s
// retry delay, so each run takes a few minutes.
//
// The Remote screen stays mounted under the chat, so the app's real lifecycle
// reaches the view model the way it does in production. The repository is
// the local buffering fake: no pairing, desktop or network. The fixture covers the
// phone's side of the flow, not a real desktop. Lifecycle events, request
// counts and banner visibility are reported as response data; screenshots
// land in build/promo_screenshots.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/remote_hydration_fixture.dart';

const _scenario = String.fromEnvironment('CAN3631_SCENARIO');
const _timedOut = 'The conversation took too long to load. Try again.';
const _reply = 'The rerun passed. The release build is on its way.';

RemoteChatMessage _row(
  String id,
  ChatRole role,
  String text, {
  required RemoteChatScope scope,
}) => RemoteChatMessage(
  messageId: id,
  chatId: 'chat-1',
  scope: scope,
  role: role,
  status: ChatMessageStatus.complete,
  text: text,
);

List<RemoteChatMessage> _cached(RemoteChatScope scope) => [
  _row('q1', ChatRole.user, 'Why does the release build fail?', scope: scope),
  _row(
    'a1',
    ChatRole.assistant,
    'The signing key expired yesterday. Rotate it and rerun the job.',
    scope: scope,
  ),
];

RemoteSessionSnapshot _worktreeSnapshot() => const RemoteSessionSnapshot(
  workspaces: [],
  worktrees: [
    RemoteWorktree(localId: 'wt-1', workspaceLocalId: 'ws-1', branch: 'main'),
  ],
  standaloneChats: [],
  chatSummaries: [
    RemoteChatSummary(
      chatId: 'chat-1',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Release build',
      active: true,
    ),
  ],
);

final class _Trace with WidgetsBindingObserver {
  final stopwatch = Stopwatch()..start();
  final events = <Map<String, Object?>>[];

  void record(String event, [Map<String, Object?> data = const {}]) => events
      .add({'event': event, 'ms': stopwatch.elapsedMilliseconds, ...data});

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      record('lifecycle', {'state': state.name});

  int? lastMs(String state) =>
      events
              .where((e) => e['event'] == 'lifecycle' && e['state'] == state)
              .lastOrNull?['ms']
          as int?;
}

// The host driver backgrounds and restores the app over adb or simctl. The
// loopback bridge exists only in this integration-test entry point.
Future<void> _requestBackground(int seconds) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse('http://127.0.0.1:18766/background?seconds=$seconds'),
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

  testWidgets('CAN-3631 $_scenario', (tester) async {
    if (!const {
      'ac1-standalone',
      'ac1-worktree',
      'ac3-cached',
    }.contains(_scenario)) {
      fail(
        'Set CAN3631_SCENARIO to ac1-standalone, ac1-worktree or '
        'ac3-cached',
      );
    }
    final worktreeChat = _scenario == 'ac1-worktree';
    final scope = worktreeChat
        ? RemoteChatScope.worktree
        : RemoteChatScope.standalone;
    final trace = _Trace()..record('start', {'pid': pid});
    binding.addObserver(trace);
    addTearDown(() => binding.removeObserver(trace));

    final repository = BufferingRemoteControlRepository()
      ..cachedChatMessages = _cached(scope);
    if (worktreeChat) repository.snapshotBuilder = _worktreeSnapshot;
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await vm.connect('123456');
    final navigator = GlobalKey<NavigatorState>();
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
          navigatorKey: navigator,
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: ThemeMode.light,
          home: const RemoteScreen(),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 500));
    unawaited(
      navigator.currentState!.push(
        MaterialPageRoute<void>(
          builder: (_) => worktreeChat
              ? RemoteChatScreen.worktree(
                  worktree: vm.worktreesFor('ws-1').single,
                  initialChatId: 'chat-1',
                )
              : const RemoteChatScreen.standalone(
                  standaloneChat: RemoteStandaloneChat(
                    localId: 'chat-1',
                    projectLocalId: 'ws-1',
                    title: 'Release build',
                  ),
                ),
        ),
      ),
    );

    final checkpoints = <Map<String, Object?>>[];
    bool bannerShown() => find.text(_timedOut).evaluate().isNotEmpty;
    void checkpoint(String name) {
      final entry = {
        'name': name,
        'ms': trace.stopwatch.elapsedMilliseconds,
        'requests': repository.requestChatTranscriptCalls,
        'heldReplies': repository.heldDeliveries,
        'replayedReplies': repository.replayedDeliveries,
        'reply': find.text(_reply).evaluate().isNotEmpty,
        'banner': bannerShown(),
        'retry': find.text('Retry').evaluate().isNotEmpty,
        'cachedText': find
            .text('Why does the release build fail?')
            .evaluate()
            .isNotEmpty,
      };
      checkpoints.add(entry);
      // Merge: takeScreenshot keeps its captures in the same map.
      binding.reportData = {
        ...?binding.reportData,
        'scenario': _scenario,
        'events': trace.events,
        'checkpoints': checkpoints,
      };
    }

    Future<void> frames(Duration duration) async {
      // Frames run in real time; a pump while paused would never return.
      final end = trace.stopwatch.elapsed + duration;
      while (trace.stopwatch.elapsed < end) {
        await tester.pump(const Duration(milliseconds: 250));
      }
    }

    Future<void> backgroundFor(int seconds) async {
      final pausedBefore = trace.lastMs('paused');
      final resumedBefore = trace.lastMs('resumed');
      await _requestBackground(seconds);
      trace.record('background-requested', {'seconds': seconds});
      final deadline =
          trace.stopwatch.elapsed + Duration(seconds: seconds + 60);
      while (trace.stopwatch.elapsed < deadline) {
        await Future<void>.delayed(const Duration(milliseconds: 250));
        final paused = trace.lastMs('paused');
        final resumed = trace.lastMs('resumed');
        if (paused != null &&
            paused != pausedBefore &&
            resumed != null &&
            resumed != resumedBefore &&
            resumed > paused) {
          trace.record('cycle-complete', {
            'awayMs': resumed - paused,
            'pid': pid,
          });
          await tester.pump();
          return;
        }
      }
      fail('The app did not go to the background and return');
    }

    await frames(const Duration(seconds: 2));
    checkpoint('opened');
    expect(repository.requestChatTranscriptCalls, 1);
    expect(bannerShown(), isFalse);

    if (_scenario == 'ac3-cached') {
      await frames(const Duration(seconds: 18));
      checkpoint('before-background');
      await backgroundFor(10);
      final returned = trace.stopwatch.elapsed;
      checkpoint('returned');
      expect(bannerShown(), isFalse);
      // Watch until the final failure, sampling once a second.
      Duration? secondRequestAt;
      Duration? bannerAt;
      while (trace.stopwatch.elapsed < returned + const Duration(minutes: 3)) {
        await frames(const Duration(seconds: 1));
        final requests = repository.requestChatTranscriptCalls;
        secondRequestAt ??= requests >= 2 ? trace.stopwatch.elapsed : null;
        if (bannerShown()) {
          bannerAt = trace.stopwatch.elapsed;
          break;
        }
        expect(find.text('Why does the release build fail?'), findsOneWidget);
        if (requests >= 2 && checkpoints.last['requests'] == 1) {
          checkpoint('second-request');
        }
      }
      checkpoint('final-failure');
      expect(secondRequestAt, isNotNull);
      expect(bannerAt, isNotNull);
      // A fresh 60s after the return, then the 15s retry delay.
      expect(
        secondRequestAt! - returned,
        greaterThanOrEqualTo(const Duration(seconds: 74)),
      );
      expect(
        bannerAt! - secondRequestAt,
        greaterThanOrEqualTo(const Duration(seconds: 59)),
      );
      expect(repository.requestChatTranscriptCalls, 2);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.text('Why does the release build fail?'), findsOneWidget);
      await frames(const Duration(seconds: 5));
      expect(repository.requestChatTranscriptCalls, 2);
    } else {
      // Sent inside the first pause, so it can only arrive by replay.
      repository.onNextPause = () {
        repository.deliver(
          RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                targetWorkspaceLocalId: worktreeChat ? 'ws-1' : null,
                targetWorktreeLocalId: worktreeChat ? 'wt-1' : null,
                targetChatId: 'chat-1',
                targetChatScope: scope,
                chatMessages: [
                  ..._cached(scope),
                  _row('a2', ChatRole.assistant, _reply, scope: scope),
                ],
              ),
            ],
          ),
        );
        trace.record('reply-held', {
          'paused': repository.eventsPaused,
          'held': repository.heldDeliveries,
          'requests': repository.requestChatTranscriptCalls,
        });
      };
      await frames(const Duration(seconds: 6));
      await backgroundFor(55);
      checkpoint('returned');
      expect(repository.heldDeliveries, 1);
      expect(repository.requestChatTranscriptCalls, 1);
      expect(bannerShown(), isFalse);
      await frames(const Duration(seconds: 2));
      checkpoint('reply-landed');
      expect(repository.replayedDeliveries, 1);
      expect(find.text(_reply), findsOneWidget);
      expect(bannerShown(), isFalse);
      await frames(const Duration(seconds: 5));
      checkpoint('settled');
      expect(find.text(_reply), findsOneWidget);
      expect(find.text('Why does the release build fail?'), findsOneWidget);
      expect(repository.requestChatTranscriptCalls, 1);
      expect(checkpoints.where((c) => c['banner'] == true), isEmpty);
    }

    if (Platform.isAndroid) {
      await binding.convertFlutterSurfaceToImage();
      await tester.pump(const Duration(milliseconds: 300));
    }
    await binding.takeScreenshot(
      'can3631-device-$_scenario-${Platform.operatingSystem}',
    );
    checkpoint('done');
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
  }, timeout: const Timeout(Duration(minutes: 8)));
}
