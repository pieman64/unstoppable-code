// CAN-4427 device verification: a chat's "took too long to load" banner
// stays with that chat, can be dismissed, and clears when the chat loads
// again. Run from apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_4427_hydration_recovery_test.dart \
//     -d <device-id>
//
// The repository is the local fake: no pairing, desktop or network. Chat
// summaries, snapshots and live rows arrive as synthetic portal events. The
// view model uses a 3s watchdog and a 10s retry window instead of the
// production 60s and 15s, so the whole flow takes about two minutes; timing
// is not a performance measurement. Request targets, banner visibility and
// message text are reported as response data at each checkpoint.

import 'dart:async';

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
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

const _timedOut = 'The conversation took too long to load. Try again.';
const _timeout = Duration(seconds: 3);
const _retryWindow = Duration(seconds: 10);
const _banner = ValueKey('remote-transcript-hydration-failure');
const _dismiss = ValueKey('remote-transcript-hydration-dismiss');

RemoteChatMessage _row(String chatId, String id, ChatRole role, String text) =>
    RemoteChatMessage(
      messageId: id,
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      role: role,
      status: ChatMessageStatus.complete,
      text: text,
    );

final _releaseRows = [
  _row('a', 'a1', ChatRole.user, 'Why does the release build fail?'),
  _row('a', 'a2', ChatRole.assistant, 'The signing key expired yesterday.'),
];
final _docsRows = [
  _row('b', 'b1', ChatRole.user, 'Update the install guide.'),
  _row('b', 'b2', ChatRole.assistant, 'The install guide now covers Linux.'),
];

RemoteChatSummary _tab(String chatId, String title, {required bool active}) =>
    RemoteChatSummary(
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: title,
      active: active,
    );

/// The desktop's tab list, with the given chat active.
RemotePortalEventBatch _tabs(
  String active, {
  List<RemoteChatMessage> rows = const [],
}) => RemotePortalEventBatch(
  nextCursor: 1,
  events: [
    RemoteStateSnapshotEvent(
      scope: 'worktree_chat_summaries',
      chatSummaries: [
        _tab('a', 'Release build', active: active == 'a'),
        _tab('b', 'Install guide', active: active == 'b'),
      ],
      chatMessages: rows,
    ),
  ],
);

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'CAN-4427 hydration failure ownership and recovery',
    (tester) async {
      final repository = FakeRemoteControlRepository()
        ..supportsForegroundChat = true
        ..cachedChatMessages = _docsRows
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        hydrationTimeout: _timeout,
        hydrationRetryWindow: _retryWindow,
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
            home: const Scaffold(body: Center(child: Text('Workspaces'))),
          ),
        ),
      );
      await tester.pump();
      final worktree = vm.worktreesFor('ws-1').single;
      // The worktree opens before Mobile knows its chats: the desktop picks.
      unawaited(
        navigator.currentState!.push(
          MaterialPageRoute<void>(
            builder: (_) => RemoteChatScreen.worktree(worktree: worktree),
          ),
        ),
      );

      final stopwatch = Stopwatch()..start();
      final checkpoints = <Map<String, Object?>>[];
      bool shown(String text) => find.text(text).evaluate().isNotEmpty;
      bool bannerShown() => find.byKey(_banner).evaluate().isNotEmpty;
      void checkpoint(String name) {
        checkpoints.add({
          'name': name,
          'ms': stopwatch.elapsedMilliseconds,
          'requests': [
            for (final target in repository.requestChatTranscriptTargets)
              target.chatId ?? '(desktop picks)',
          ],
          'banner': bannerShown(),
          'dismiss': find.byKey(_dismiss).evaluate().isNotEmpty,
          'retry': shown('Retry'),
          'releaseChat': shown('The signing key expired yesterday.'),
          'docsChat': shown('The install guide now covers Linux.'),
        });
        binding.reportData = {
          ...?binding.reportData,
          'checkpoints': checkpoints,
        };
      }

      Future<void> frames(Duration duration) async {
        final end = stopwatch.elapsed + duration;
        while (stopwatch.elapsed < end) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }

      /// Picks [chatId] in the phone's chat tabs sheet.
      Future<void> pickTab(String chatId) async {
        await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
        await frames(const Duration(seconds: 1));
        await tester.tap(find.byKey(ValueKey('chat-tab-$chatId')));
        await frames(const Duration(seconds: 1));
      }

      List<String?> requested() => [
        for (final target in repository.requestChatTranscriptTargets)
          target.chatId,
      ];

      await frames(const Duration(milliseconds: 500));
      checkpoint('opened');
      expect(requested(), [null]);

      // The desktop names its chats during the discovery's last attempt.
      await frames(_timeout + _retryWindow + const Duration(milliseconds: 500));
      expect(requested(), [null, null]);
      repository.eventsController.add(_tabs('a', rows: _releaseRows));
      await frames(const Duration(milliseconds: 500));
      expect(shown('The signing key expired yesterday.'), isTrue);
      expect(bannerShown(), isFalse);

      await frames(_timeout);
      checkpoint('release-failed');
      expect(bannerShown(), isTrue);
      expect(shown(_timedOut), isTrue);
      expect(shown('The signing key expired yesterday.'), isTrue);

      // The desktop switches tabs. The phone keeps showing its chat, and the
      // failure stays with it.
      repository.eventsController.add(_tabs('b'));
      await frames(const Duration(milliseconds: 500));
      checkpoint('desktop-switched');
      expect(bannerShown(), isTrue);
      expect(requested(), [null, null]);

      // Picking the other chat on the phone loads it on its own.
      await pickTab('b');
      checkpoint('other-chat');
      expect(bannerShown(), isFalse);
      expect(requested(), [null, null, 'b']);
      expect(shown('The install guide now covers Linux.'), isTrue);
      repository.eventsController.add(
        RemotePortalEventBatch(
          nextCursor: 1,
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              targetChatId: 'b',
              targetChatScope: RemoteChatScope.worktree,
              chatMessages: _docsRows,
            ),
          ],
        ),
      );
      await frames(const Duration(milliseconds: 500));
      checkpoint('docs-loaded');
      expect(bannerShown(), isFalse);

      // The docs snapshot leaves the release failure in place. Back on the
      // failed chat inside the retry window, nothing is sent.
      await pickTab('a');
      checkpoint('release-inside-window');
      expect(bannerShown(), isTrue);
      expect(shown(_timedOut), isTrue);
      expect(requested(), [null, null, 'b']);

      // Shown again after the retry window: one fresh load.
      await frames(_retryWindow);
      await pickTab('b');
      expect(requested(), [null, null, 'b']);
      await pickTab('a');
      checkpoint('release-reopened');
      expect(requested(), [null, null, 'b', 'a']);
      expect(bannerShown(), isFalse);
      expect(shown('The signing key expired yesterday.'), isTrue);

      await frames(_timeout + _retryWindow + _timeout);
      checkpoint('release-failed-again');
      expect(requested(), [null, null, 'b', 'a', 'a']);
      expect(bannerShown(), isTrue);

      // Dismiss hides this failure without a request.
      await tester.tap(find.byKey(_dismiss));
      await frames(const Duration(seconds: 1));
      checkpoint('dismissed');
      expect(bannerShown(), isFalse);
      expect(shown('The signing key expired yesterday.'), isTrue);
      await frames(_retryWindow);
      expect(bannerShown(), isFalse);
      expect(requested(), hasLength(5));

      // Leaving and returning after the retry window loads it again; its
      // failure shows the banner again, and Retry still works.
      unawaited(
        navigator.currentState!.push(
          MaterialPageRoute<void>(
            builder: (_) =>
                const Scaffold(body: Center(child: Text('Elsewhere'))),
          ),
        ),
      );
      await frames(_retryWindow + const Duration(milliseconds: 500));
      navigator.currentState!.pop();
      await frames(const Duration(milliseconds: 500));
      checkpoint('returned');
      expect(requested(), hasLength(6));
      expect(bannerShown(), isFalse);
      await frames(_timeout + _retryWindow + _timeout);
      expect(bannerShown(), isTrue);
      await tester.tap(find.text('Retry'));
      await frames(const Duration(milliseconds: 500));
      checkpoint('retried');
      expect(requested(), hasLength(8));
      expect(bannerShown(), isFalse);

      // A live row proves the chat loads: the banner clears without Retry.
      await frames(_timeout + _retryWindow + _timeout);
      expect(bannerShown(), isTrue);
      repository.eventsController.add(
        RemotePortalEventBatch(
          nextCursor: 2,
          events: [
            RemoteChatMessageEvent(
              chatId: 'a',
              scope: RemoteChatScope.worktree,
              message: _row('a', 'a3', ChatRole.user, 'Rerun the release job.'),
            ),
          ],
        ),
      );
      await frames(const Duration(milliseconds: 500));
      checkpoint('live-row');
      expect(bannerShown(), isFalse);
      expect(shown('Rerun the release job.'), isTrue);
      expect(shown('The signing key expired yesterday.'), isTrue);
      expect(requested(), hasLength(9));

      // A reconnected event stream reloads the chat once.
      repository.eventsLiveController.add(false);
      await frames(const Duration(seconds: 3));
      checkpoint('offline');
      repository.eventsLiveController.add(true);
      await frames(const Duration(milliseconds: 500));
      checkpoint('reconnected');
      expect(requested(), hasLength(10));
      expect(requested().last, 'a');
      expect(bannerShown(), isFalse);
      await frames(const Duration(seconds: 1));
      expect(requested(), hasLength(10));

      checkpoint('done');
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
