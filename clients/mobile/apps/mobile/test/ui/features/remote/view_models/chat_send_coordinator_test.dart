// Chat sends through the assembled engine: the post-send "awaiting agent
// turn" bridge and its release on turn evidence, failure, and grace expiry.
import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/chat_send_coordinator.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/remote_engine_harness.dart';

/// A send with attachments keeps the non-durable path, so a null-chat target
/// still lets the host mint the chat.
const _hostMintedOptions = RemoteChatSendOptions(
  attachments: [
    ChatAttachmentRef(
      attachmentId: 'a1',
      filename: 'a.png',
      mediaType: 'image/png',
      size: 1,
      contentSha256: 'x',
      storageKind: 'blob',
      source: 'library',
    ),
  ],
);

void main() {
  group('ChatSendCoordinator awaiting agent turn', () {
    const target = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );

    RemoteChatMessage row(
      String messageId, {
      ChatRole role = ChatRole.assistant,
      ChatMessageStatus status = ChatMessageStatus.complete,
      List<ChatPart> parts = const [],
      String text = 'hello',
      DateTime? occurredAt,
    }) => RemoteChatMessage(
      messageId: messageId,
      chatId: 'chat-1',
      role: role,
      status: status,
      scope: RemoteChatScope.worktree,
      text: text,
      parts: parts,
      occurredAt: occurredAt,
    );

    Future<void> pump() => Future<void>.delayed(Duration.zero);

    test('an accepted send awaits the agent turn for that chat', () async {
      final repository = FakeRemoteControlRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      expect(engine.sends.isAwaitingAgentTurn(target), isFalse);

      await engine.sends.sendChatMessage(target, 'run the tests');

      expect(engine.sends.isAwaitingAgentTurn(target), isTrue);
    });

    test('a user echo without turn evidence keeps the wait alive', () async {
      // The reported flap: the desktop echoes the user message, a projection
      // refresh replaces the transcript, and no streaming row or turn timer
      // has landed yet — the indicator must NOT drop to "nothing happening".
      final repository = FakeRemoteControlRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      await engine.sends.sendChatMessage(target, 'run the tests');

      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: row(
                'm-echo',
                role: ChatRole.user,
                text: 'run the tests',
              ),
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();

      expect(engine.sends.isAwaitingAgentTurn(target), isTrue);
    });

    test(
      'replayed assistant history does not release a newly accepted send',
      () async {
        final now = DateTime(2026, 8, 10, 12);
        final previousAssistant = row(
          'm-previous-assistant',
          occurredAt: now.subtract(const Duration(minutes: 5)),
        );
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot(
            workspaces: const [],
            worktrees: const [],
            standaloneChats: const [],
            chatMessages: [previousAssistant],
          );
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          clock: () => now,
        );
        await engine.session.connect('123456');
        await engine.sends.sendChatMessage(target, 'run the tests');
        expect(engine.sends.isAwaitingAgentTurn(target), isTrue);

        // A full-snapshot refresh replays the cached transcript, including
        // the assistant row that predates this send. It is not evidence that
        // the newly requested turn has started.
        await engine.refresh();

        expect(engine.sends.isAwaitingAgentTurn(target), isTrue);
      },
    );

    test('turn evidence arriving before submit resolves is retained', () async {
      final repository = _GatedSendRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');

      final send = engine.sends.sendChatMessage(target, 'run the tests');
      await pump();
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: row('m-mid-submit', status: ChatMessageStatus.streaming),
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();
      repository.sendCompleter.complete(
        const RemoteChatSendResult(commandId: 'cmd-race', chatId: 'chat-1'),
      );
      await send;

      expect(engine.sends.isAwaitingAgentTurn(target), isFalse);
    });

    test('turn evidence hands off to the authoritative signals', () async {
      final repository = FakeRemoteControlRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      await engine.sends.sendChatMessage(target, 'run the tests');

      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: row('m-1', status: ChatMessageStatus.streaming),
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();

      expect(engine.sends.isAwaitingAgentTurn(target), isFalse);
    });

    test('a turn timer part is turn evidence even on a user row', () async {
      final repository = FakeRemoteControlRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      await engine.sends.sendChatMessage(target, 'run the tests');

      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: row(
                'm-echo',
                role: ChatRole.user,
                parts: const [
                  ChatPart(
                    kind: 'turn_timer',
                    data: {'startedAt': 1754000000000},
                  ),
                ],
              ),
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();

      expect(engine.sends.isAwaitingAgentTurn(target), isFalse);
    });

    test('a failed send stops the wait', () async {
      final repository = FakeRemoteControlRepository();
      repository.sendChatMessageHandler = () async =>
          const RemoteChatSendResult(commandId: 'cmd-send', chatId: 'chat-1');
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      await engine.sends.sendChatMessage(target, 'run the tests');
      expect(engine.sends.isAwaitingAgentTurn(target), isTrue);

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The send failed.',
              commandId: 'cmd-send',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();

      expect(engine.sends.isAwaitingAgentTurn(target), isFalse);
    });

    test('the wait expires after the grace ceiling', () async {
      final repository = FakeRemoteControlRepository();
      var now = DateTime(2026, 8, 7, 12);
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        clock: () => now,
      );
      await engine.session.connect('123456');
      await engine.sends.sendChatMessage(target, 'run the tests');
      expect(engine.sends.isAwaitingAgentTurn(target), isTrue);

      now = now.add(kRemoteTurnStartGrace + const Duration(seconds: 1));

      expect(engine.sends.isAwaitingAgentTurn(target), isFalse);
    });

    test('grace expiration notifies listeners without another UI event', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        var notifications = 0;
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          clock: async.getClock(DateTime(2026, 8, 7, 12)).now,
          onChanged: () => notifications += 1,
        );
        engine.session.connect('123456');
        async.flushMicrotasks();

        engine.sends.sendChatMessage(target, 'run the tests');
        async.flushMicrotasks();
        final notificationsAfterSend = notifications;

        async.elapse(kRemoteTurnStartGrace);

        expect(notifications, greaterThan(notificationsAfterSend));
        expect(engine.sends.isAwaitingAgentTurn(target), isFalse);
      });
    });

    test('a raced failure rejects a null-chat send', () async {
      final repository = _GatedSendRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      const target = RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );

      final send = engine.sends.sendChatMessage(target, 'run the tests');
      await pump();
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The first send was rejected.',
              commandId: 'cmd-first-send',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();
      repository.sendCompleter.complete(
        const RemoteChatSendResult(commandId: 'cmd-first-send'),
      );

      await expectLater(
        send,
        throwsA(
          isA<RemoteControlException>().having(
            (error) => error.message,
            'message',
            'The first send was rejected.',
          ),
        ),
      );
    });

    test(
      'a null-chat send waits for terminal success after acceptance',
      () async {
        final repository = FakeRemoteControlRepository();
        repository.sendChatMessageHandler = () async =>
            const RemoteChatSendResult(commandId: 'cmd-first-send');
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await engine.session.connect('123456');
        const target = RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );

        var completed = false;
        final send = engine.sends
            .sendChatMessage(
              target,
              'run the tests',
              options: _hostMintedOptions,
            )
            .whenComplete(() => completed = true);
        await pump();
        expect(completed, isFalse);

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandCompletedEvent(
                commandId: 'cmd-first-send',
                result: {'chatId': 'chat-new'},
              ),
            ],
            nextCursor: 1,
          ),
        );

        final result = await send;
        expect(result.chatId, 'chat-new');
      },
    );

    test('a null-chat send stops waiting after the grace ceiling', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        repository.sendChatMessageHandler = () async =>
            const RemoteChatSendResult(commandId: 'cmd-first-send');
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        engine.session.connect('123456');
        async.flushMicrotasks();
        const target = RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );

        RemoteChatSendResult? result;
        engine.sends
            .sendChatMessage(
              target,
              'run the tests',
              options: _hostMintedOptions,
            )
            .then((value) => result = value);
        async.flushMicrotasks();
        expect(result, isNull);

        async.elapse(kRemoteTurnStartGrace);
        async.flushMicrotasks();

        expect(result, isNotNull);
        expect(result?.chatId, isNull);
      });
    });
  });
}

final class _GatedSendRepository extends FakeRemoteControlRepository {
  final Completer<RemoteChatSendResult> sendCompleter = Completer();

  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) => sendCompleter.future;
}
