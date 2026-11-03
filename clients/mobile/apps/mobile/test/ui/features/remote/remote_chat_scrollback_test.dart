import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/memory_remote_transcript_storage.dart';

/// The server-cached tail answers when the test completes [cache]; the
/// desktop's transcript arrives only as an explicit snapshot event.
final class _GatedTranscriptRepository extends FakeRemoteControlRepository {
  final cache = Completer<List<RemoteChatMessage>>();

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) => cache.future;

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) =>
      Completer<String?>().future;
}

const _target = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  chatId: 'chat-1',
);

RemoteChatMessage _message(String messageId, {String text = 'hello'}) =>
    RemoteChatMessage(
      messageId: messageId,
      chatId: 'chat-1',
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: text,
    );

Future<void> _pump() => Future<void>.delayed(Duration.zero);

void main() {
  group('RemoteControlViewModel.loadOlderMessages', () {
    Future<RemoteControlViewModel> connectedVm(
      FakeRemoteControlRepository repository,
    ) async {
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      return vm;
    }

    void seedLiveMessage(FakeRemoteControlRepository repository, String id) {
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: _message(id, text: 'live $id'),
            ),
          ],
          nextCursor: 1,
        ),
      );
    }

    test('pages older history, prepending deduped messages until '
        'exhaustion', () async {
      final repository = FakeRemoteControlRepository();
      final vm = await connectedVm(repository);
      seedLiveMessage(repository, 'msg-3');
      await _pump();

      repository.fetchChatHistoryHandler = (before) async {
        if (before == null) {
          // The newest historical page overlaps the live tail: msg-3 must
          // not be duplicated.
          return RemoteChatHistoryChunk(
            messages: [_message('msg-2'), _message('msg-3')],
            nextCursor: 'cur-1',
          );
        }
        expect(before, 'cur-1');
        return RemoteChatHistoryChunk(
          messages: [_message('msg-1')],
          nextCursor: null,
        );
      };

      expect(vm.canLoadOlderMessages(_target), isTrue);
      await vm.loadOlderMessages(_target);
      expect(vm.messagesFor(_target).map((m) => m.messageId).toList(), [
        'msg-2',
        'msg-3',
      ]);
      expect(repository.fetchChatHistoryCalls.single.before, isNull);

      await vm.loadOlderMessages(_target);
      expect(vm.messagesFor(_target).map((m) => m.messageId).toList(), [
        'msg-1',
        'msg-2',
        'msg-3',
      ]);

      // The null nextCursor means the transcript start was reached: no
      // further requests are made.
      expect(vm.canLoadOlderMessages(_target), isFalse);
      await vm.loadOlderMessages(_target);
      expect(repository.fetchChatHistoryCalls, hasLength(2));
    });

    test('history rows that fill a live gap keep transcript order', () async {
      // A turn whose middle and final answer never reached the phone live.
      // The newest history page returns the whole turn; the missing rows
      // belong between the rows the phone already has, not above the prompt.
      RemoteChatMessage row(String id, String role, int atMs) =>
          RemoteChatMessage.fromWireJson({
            'messageId': id,
            'chatId': 'chat-1',
            'scope': 'worktree',
            'role': role,
            'status': 'complete',
            'text': id == 'answer' ? 'Merged develop.' : '',
            'createdAtMs': atMs,
          });
      final prompt = row('prompt', 'user', 1000);
      final early1 = row('early-1', 'assistant', 2000);
      final early2 = row('early-2', 'assistant', 2100);
      final late1 = row('late-1', 'assistant', 3000);
      final late2 = row('late-2', 'assistant', 3100);
      final answer = row('answer', 'assistant', 4900);
      final timer = row('prompt:turn-timer', 'system', 5000);

      final repository = FakeRemoteControlRepository();
      final vm = await connectedVm(repository);
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            for (final message in [prompt, late1, late2, timer])
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: message,
              ),
          ],
          nextCursor: 1,
        ),
      );
      await _pump();

      repository.fetchChatHistoryHandler = (before) async =>
          RemoteChatHistoryChunk(
            messages: [prompt, early1, early2, late1, late2, answer, timer],
            nextCursor: null,
          );
      await vm.loadOlderMessages(_target);

      expect(vm.messagesFor(_target).map((m) => m.messageId).toList(), [
        'prompt',
        'early-1',
        'early-2',
        'late-1',
        'late-2',
        'answer',
        'prompt:turn-timer',
      ]);
    });

    test('concurrent load-older calls collapse into one request', () async {
      final repository = FakeRemoteControlRepository();
      final vm = await connectedVm(repository);
      final gate = Completer<void>();
      repository.fetchChatHistoryHandler = (before) async {
        await gate.future;
        return RemoteChatHistoryChunk(
          messages: [_message('msg-1')],
          nextCursor: null,
        );
      };

      final first = vm.loadOlderMessages(_target);
      final second = vm.loadOlderMessages(_target);
      expect(vm.isLoadingOlderMessages(_target), isTrue);
      gate.complete();
      await first;
      await second;

      expect(repository.fetchChatHistoryCalls, hasLength(1));
      expect(vm.isLoadingOlderMessages(_target), isFalse);
    });

    test('a transport failure leaves scrollback retryable', () async {
      final repository = FakeRemoteControlRepository();
      final vm = await connectedVm(repository);
      var failures = 0;
      repository.fetchChatHistoryHandler = (before) async {
        if (failures == 0) {
          failures += 1;
          throw const RemoteControlException('offline');
        }
        return RemoteChatHistoryChunk(
          messages: [_message('msg-1')],
          nextCursor: null,
        );
      };

      await vm.loadOlderMessages(_target);
      expect(vm.messagesFor(_target), isEmpty);
      expect(vm.canLoadOlderMessages(_target), isTrue);

      await vm.loadOlderMessages(_target);
      expect(vm.messagesFor(_target).single.messageId, 'msg-1');
    });

    testWidgets('scrolling to the top of the transcript loads older '
        'history', (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      const worktree = RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feat/x',
      );
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [
          RemoteWorkspace(
            localId: 'ws-1',
            name: 'acme',
            type: RemoteWorkspaceType.singleRepo,
          ),
        ],
        worktrees: [worktree],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            title: 'Chat',
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
        ],
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        // Keep the chat screen's build-path hydration retry from re-arming a
        // watchdog timer after the test's fake-clock flush.
        hydrationRetryWindow: const Duration(days: 1),
      );
      await vm.connect('123456');

      // Seed a transcript tall enough to scroll: 15 user/assistant pairs.
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            for (var i = 0; i < 15; i++) ...[
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage(
                  messageId: 'u-$i',
                  chatId: 'chat-1',
                  role: ChatRole.user,
                  status: ChatMessageStatus.complete,
                  text: 'question $i about the login redirect flow',
                ),
              ),
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage(
                  messageId: 'a-$i',
                  chatId: 'chat-1',
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  text:
                      'answer $i with a couple of lines of explanation '
                      'so each row takes real vertical space',
                ),
              ),
            ],
          ],
          nextCursor: 1,
        ),
      );
      // Flush the broadcast-stream microtask inside the fake-async zone (a
      // real `Future.delayed` would never complete here without a pump).
      await tester.pump();

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
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: const RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'chat-1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The transcript opens at the bottom; dragging down moves toward the
      // oldest content at the top.
      await tester.drag(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 6000),
      );
      await tester.pump();

      expect(repository.fetchChatHistoryCalls, isNotEmpty);

      // Run down the hydration/turn timers the chat screen armed.
      await tester.pump(const Duration(minutes: 2));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets('CAN-3373 a reader scrolled into a persisted tail keeps '
        'their place while the server tail and snapshot replace it', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      const worktree = RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feat/x',
      );
      RemoteChatMessage question(int i) => RemoteChatMessage(
        messageId: 'u-$i',
        chatId: 'chat-1',
        scope: RemoteChatScope.worktree,
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'question $i about the login redirect flow',
      );
      RemoteChatMessage answer(int i) => RemoteChatMessage(
        messageId: 'a-$i',
        chatId: 'chat-1',
        scope: RemoteChatScope.worktree,
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text:
            'answer $i with a couple of lines of explanation '
            'so each row takes real vertical space',
      );
      List<RemoteChatMessage> turns(int from, int to) => [
        for (var i = from; i < to; i++) ...[question(i), answer(i)],
      ];

      final storage = MemoryRemoteTranscriptStorage();
      const chat = (scope: RemoteChatScope.worktree, chatId: 'chat-1');
      storage.files[(accountScope: 'test:7', sessionId: 'session-1')] = {
        chat: PersistedTranscript(chat: chat, openedAt: 1, rows: turns(0, 20)),
      };
      final repository = _GatedTranscriptRepository()
        ..connectedSessionId = 'session-1'
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            RemoteWorkspace(
              localId: 'ws-1',
              name: 'acme',
              type: RemoteWorkspaceType.singleRepo,
            ),
          ],
          worktrees: [worktree],
          standaloneChats: [],
          chatSummaries: [
            RemoteChatSummary(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              title: 'Chat',
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
            ),
          ],
        );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        hydrationRetryWindow: const Duration(days: 1),
        transcriptCache: RemoteTranscriptCache(
          storage: storage,
          accountScope: 'test:7',
        ),
      );
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
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: const RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'chat-1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(answer(19).text), findsOneWidget);

      // Read part-way up, well away from both ends.
      await tester.drag(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 900),
      );
      await tester.pumpAndSettle();
      final transcript = tester.getRect(
        find.byKey(const ValueKey('remote-chat-transcript')),
      );
      final reading = [
        for (var i = 10; i < 20; i++)
          if (find.text(answer(i).text).evaluate().isNotEmpty &&
              transcript.contains(tester.getCenter(find.text(answer(i).text))))
            answer(i).text,
      ].first;
      // Null once the row left the built viewport.
      double? topOf(String text) => find.text(text).evaluate().isEmpty
          ? null
          : tester.getTopLeft(find.text(text)).dy;
      final readingAt = topOf(reading)!;
      expect(repository.fetchChatHistoryCalls, isEmpty);

      // The server's tail starts later and runs further than the device's.
      repository.cache.complete(turns(5, 22));
      await tester.pumpAndSettle();
      expect(find.text(question(0).text), findsNothing);
      expect(topOf(reading), closeTo(readingAt, 1));

      // The desktop's bounded snapshot drops more of the head.
      repository.eventsController.add(
        RemotePortalEventBatch(
          nextCursor: 2,
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetChatId: 'chat-1',
              targetChatScope: RemoteChatScope.worktree,
              chatMessages: turns(8, 22),
              chatMessagesTruncated: true,
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(question(5).text), findsNothing);
      expect(topOf(reading), closeTo(readingAt, 1));
      expect(tester.takeException(), isNull);

      await tester.pump(const Duration(minutes: 2));
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    });

    test('disconnecting resets scrollback state', () async {
      final repository = FakeRemoteControlRepository();
      final vm = await connectedVm(repository);
      repository.fetchChatHistoryHandler = (before) async =>
          const RemoteChatHistoryChunk(messages: [], nextCursor: null);

      await vm.loadOlderMessages(_target);
      expect(vm.canLoadOlderMessages(_target), isFalse);

      await vm.disconnect();
      await vm.connect('123456');
      expect(vm.canLoadOlderMessages(_target), isTrue);
    });
  });
}
