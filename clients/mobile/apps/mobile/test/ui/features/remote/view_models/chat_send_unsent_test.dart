import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;
import 'package:mobile/ui/features/remote/view_models/remote_client_engine.dart';
import 'package:mobile/ui/features/remote/view_models/remote_unsent_sends.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/pipeline_follow_up_fixture.dart';
import '../../../../support/remote_engine_harness.dart';

/// Mirrors desktop `already_applied`: a repeated userMessageId is accepted
/// without appending a second message (chat-state-service.ts:4637).
final class _DedupingRepository extends FakeRemoteControlRepository {
  final Map<String, List<String>> hostMessages = {};
  Object? failNext;

  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) async {
    sendChatMessageCalls.add((target: target, text: text, options: options));
    final chatId = target.chatId ?? 'host-minted';
    final id = options?.userMessageId ?? 'none';
    final messages = hostMessages.putIfAbsent(chatId, () => []);
    if (!messages.contains(id)) messages.add(id);
    final failure = failNext;
    failNext = null;
    if (failure != null) throw failure;
    return RemoteChatSendResult(commandId: 'cmd-$id', chatId: chatId);
  }
}

void main() {
  const target = RemoteWorktreeChatTarget(
    workspaceLocalId: 'ws-1',
    worktreeLocalId: 'wt-1',
    chatId: 'chat-1',
  );
  const draft = RemoteWorktreeChatDraftTarget(
    workspaceLocalId: 'ws-1',
    worktreeLocalId: 'wt-1',
    chatId: 'chat-1',
  );
  Future<void> pump() => Future<void>.delayed(Duration.zero);

  Future<(_DedupingRepository, RemoteClientEngine, InMemoryChatDraftStore)>
  connected({InMemoryChatDraftStore? store}) async {
    final repository = _DedupingRepository();
    final drafts = store ?? InMemoryChatDraftStore();
    final engine = buildRemoteEngine(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      unsentStore: drafts,
    );
    await engine.session.connect('123456');
    return (repository, engine, drafts);
  }

  void echo(FakeRemoteControlRepository repository, String id) {
    repository.eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteChatMessageEvent(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            message: RemoteChatMessage(
              messageId: id,
              chatId: 'chat-1',
              role: ChatRole.user,
              status: ChatMessageStatus.complete,
              scope: RemoteChatScope.worktree,
              text: 'hello',
            ),
          ),
        ],
        nextCursor: 1,
      ),
    );
  }

  test('a send records the message and clears the draft first', () async {
    final (repository, engine, store) = await connected();
    store.setDraft(draft, 'hello');
    await engine.sends.sendChatMessage(target, 'hello', clearDraft: draft);
    expect(store.draftFor(draft), '');
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;
    expect(engine.unsent.byId(id)?.status, UnsentStatus.sending);
  });

  test('the exact-id echo removes the record', () async {
    final (repository, engine, _) = await connected();
    await engine.sends.sendChatMessage(target, 'hello');
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;
    echo(repository, id);
    await pump();
    expect(engine.unsent.byId(id), isNull);
  });

  test('an echo that beats the send result leaves no record', () async {
    final repository = _GatedRepository();
    final engine = buildRemoteEngine(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      unsentStore: InMemoryChatDraftStore(),
    );
    await engine.session.connect('123456');
    final sending = engine.sends.sendChatMessage(target, 'hello');
    await pump();
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;
    echo(repository, id);
    await pump();
    repository.completer.complete(
      RemoteChatSendResult(commandId: 'cmd-1', chatId: 'chat-1'),
    );
    await sending;
    expect(engine.unsent.byId(id), isNull);
  });

  test('sending while disconnected marks not sent without a request', () async {
    final (repository, engine, _) = await connected();
    await engine.session.disconnect();
    await expectLater(
      engine.sends.sendChatMessage(target, 'hello'),
      throwsA(isA<RemoteChatSendNotSentException>()),
    );
    expect(repository.sendChatMessageCalls, isEmpty);
    final record = engine.unsent.recordsFor(target).single;
    expect(record.status, UnsentStatus.notSent);
    expect(record.error, kRemoteOfflineReason);
  });

  test('an unconfirmed unknown outcome becomes uncertain', () async {
    final (repository, engine, _) = await connected();
    repository.failNext = const RemoteChatSendOutcomeUnknownException('lost');
    await expectLater(
      engine.sends.sendChatMessage(target, 'hello'),
      throwsA(isA<RemoteChatSendNotSentException>()),
    );
    expect(
      engine.unsent.recordsFor(target).single.status,
      UnsentStatus.uncertain,
    );
  });

  test('an async command failure keeps the row as not sent', () async {
    final (repository, engine, _) = await connected();
    await engine.sends.sendChatMessage(target, 'hello');
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;
    repository.eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteCommandFailedEvent(
            message: 'Choose a model.',
            commandId: 'cmd-$id',
          ),
        ],
        nextCursor: 1,
      ),
    );
    await pump();
    final rows = engine.messagesFor(target);
    expect(rows.single.messageId, id);
    expect(rows.single.delivery, ChatDelivery.notSent);
    expect(rows.single.deliveryNote, 'Choose a model.');
  });

  test('resend after a lost acknowledgement delivers exactly once', () async {
    final (repository, engine, _) = await connected();
    repository.failNext = const RemoteChatSendOutcomeUnknownException('lost');
    await expectLater(
      engine.sends.sendChatMessage(target, 'hello'),
      throwsA(isA<RemoteChatSendNotSentException>()),
    );
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;
    await engine.sends.resend(id);
    expect(repository.sendChatMessageCalls, hasLength(2));
    expect(repository.sendChatMessageCalls.last.options!.userMessageId, id);
    expect(repository.hostMessages['chat-1'], [id]);
  });

  test(
    'deduplicated resend retires a record from the canonical cache',
    () async {
      final (repository, engine, _) = await connected();
      repository.failNext = const RemoteControlException('rejected');
      await expectLater(
        engine.sends.sendChatMessage(target, 'hello'),
        throwsA(isA<RemoteChatSendNotSentException>()),
      );
      final id = repository.sendChatMessageCalls.single.options!.userMessageId!;
      repository.cachedChatMessages = [
        RemoteChatMessage(
          messageId: id,
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          scope: RemoteChatScope.worktree,
          text: 'hello',
        ),
      ];

      await engine.sends.resend(id);

      expect(repository.cachedChatFetches, 1);
      expect(engine.unsent.byId(id), isNull);
    },
  );

  test('unconfirmed resend remains recoverable', () async {
    final (repository, engine, _) = await connected();
    repository.failNext = const RemoteControlException('rejected');
    await expectLater(
      engine.sends.sendChatMessage(target, 'hello'),
      throwsA(isA<RemoteChatSendNotSentException>()),
    );
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;

    await engine.sends.resend(id);

    expect(engine.unsent.byId(id)?.status, UnsentStatus.uncertain);
    final visible = engine.messagesFor(target).single;
    expect(visible.messageId, id);
    expect(visible.delivery, ChatDelivery.uncertain);
    expect(engine.transcripts.messagesFor(target), isEmpty);
  });

  test('resend replays every non-attachment send option', () async {
    final store = InMemoryChatDraftStore();
    final (repository, engine, _) = await connected(store: store);
    const standalone = RemoteStandaloneChatTarget(
      chatId: 'cc-1',
      projectLocalId: 'ws-flat',
    );
    repository.failNext = const RemoteControlException('rejected');
    await expectLater(
      engine.sends.sendChatMessage(
        standalone,
        'dictated',
        options: const RemoteChatSendOptions(
          model: 'claude-opus',
          providerType: 'claude',
          planMode: true,
          thinkingLevel: 'high',
          fastMode: true,
          inputMode: 'voice',
        ),
      ),
      throwsA(isA<RemoteChatSendNotSentException>()),
    );
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;

    // A restarted engine over the same store replays the stored options.
    final (restartedRepository, restarted, _) = await connected(store: store);
    await restarted.sends.resend(id);
    final options = restartedRepository.sendChatMessageCalls.single.options!;
    expect(options.userMessageId, id);
    expect(options.model, 'claude-opus');
    expect(options.providerType, 'claude');
    expect(options.planMode, isTrue);
    expect(options.thinkingLevel, 'high');
    expect(options.fastMode, isTrue);
    expect(options.inputMode, 'voice');
    expect(options.attachments, isNull);
  });

  test('resend ignores a record that is already sending', () async {
    final (repository, engine, _) = await connected();
    repository.failNext = const RemoteControlException('rejected');
    await expectLater(
      engine.sends.sendChatMessage(target, 'hello'),
      throwsA(isA<RemoteChatSendNotSentException>()),
    );
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;
    await Future.wait([engine.sends.resend(id), engine.sends.resend(id)]);
    expect(repository.sendChatMessageCalls, hasLength(2));
  });

  test('a first send with no chat mints an id and creates the tab', () async {
    final (repository, engine, _) = await connected();
    const empty = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
    );
    final result = await engine.sends.sendChatMessage(empty, 'hello');
    expect(result.chatId, startsWith('chat-m'));
    expect(repository.createChatTabTargets.single.chatId, result.chatId);
    expect(repository.sendChatMessageCalls.single.target.chatId, result.chatId);
  });

  test('sends with attachments keep the old non-durable path', () async {
    final (repository, engine, store) = await connected();
    await engine.sends.sendChatMessage(
      target,
      'photo',
      options: const RemoteChatSendOptions(
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
      ),
    );
    expect(store.unsentFor(kRemoteUnsentSurface), isEmpty);
  });

  test('an accepted send without an echo survives a reconnect', () async {
    final (repository, engine, _) = await connected();
    await engine.sends.sendChatMessage(target, 'hello');
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;

    await engine.session.disconnect();
    await engine.session.connect('123456');

    final row = engine.messagesFor(target).single;
    expect(row.messageId, id);
    expect(row.delivery, ChatDelivery.uncertain);
    await engine.sends.resend(id);
    expect(repository.sendChatMessageCalls, hasLength(2));
    expect(repository.sendChatMessageCalls.last.options!.userMessageId, id);
    expect(repository.hostMessages['chat-1'], [id]);
  });

  test('a send that succeeds after a reset stays visible', () async {
    final repository = _GatedRepository();
    final engine = buildRemoteEngine(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      unsentStore: InMemoryChatDraftStore(),
    );
    await engine.session.connect('123456');
    final sending = engine.sends.sendChatMessage(target, 'hello');
    await pump();
    final id = repository.sendChatMessageCalls.single.options!.userMessageId!;

    await engine.session.disconnect();
    repository.completer.complete(
      RemoteChatSendResult(commandId: 'cmd-1', chatId: 'chat-1'),
    );
    await sending;

    final row = engine.messagesFor(target).single;
    expect(row.messageId, id);
    expect(row.delivery, ChatDelivery.uncertain);
  });

  test('a send that fails after a reset records the failure', () async {
    final repository = _GatedRepository();
    final engine = buildRemoteEngine(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      unsentStore: InMemoryChatDraftStore(),
    );
    await engine.session.connect('123456');
    final sending = engine.sends.sendChatMessage(target, 'hello');
    await pump();

    await engine.session.disconnect();
    repository.completer.completeError(
      const RemoteControlException('rejected'),
    );
    await expectLater(sending, throwsA(isA<RemoteChatSendNotSentException>()));

    final row = engine.messagesFor(target).single;
    expect(row.delivery, ChatDelivery.notSent);
    expect(row.deliveryNote, 'rejected');
  });

  test('records survive an engine restart as uncertain rows', () async {
    final store = InMemoryChatDraftStore();
    final (repository, engine, _) = await connected(store: store);
    repository.failNext = const RemoteChatSendOutcomeUnknownException('lost');
    await expectLater(
      engine.sends.sendChatMessage(target, 'hello'),
      throwsA(isA<RemoteChatSendNotSentException>()),
    );
    final (_, restarted, _) = await connected(store: store);
    expect(
      restarted.messagesFor(target).single.delivery,
      ChatDelivery.uncertain,
    );
  });

  test('an uncertain pipeline follow-up keeps its single record and the '
      'draft, and only the exact echo confirms it (CAN-3719)', () async {
    final repository = _DedupingRepository()
      ..snapshotBuilder = (() => followUpSnapshot)
      ..followUpChatId = 'chat-1'
      ..failNext = const RemoteChatSendOutcomeUnknownException('lost');
    final store = InMemoryChatDraftStore()..setDraft(draft, 'keep me');
    final engine = buildRemoteEngine(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      unsentStore: store,
    );
    addTearDown(engine.dispose);
    await engine.session.connect('123456');
    final run = RemotePipelineRun.fromJson({
      'localId': 'exec-1',
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': 'wt-1',
      'status': 'failed',
      'chatFollowUp': {'planAvailable': true, 'reportAvailable': false},
    })!;

    final receiving = await engine.pipelineFollowUps.start(
      run,
      RemotePipelineFollowUpOutput.plan,
    );
    await pump();

    expect(receiving?.chatId, 'chat-1');
    expect(repository.sendChatMessageCalls, hasLength(1));
    final record = engine.unsent.recordsFor(target).single;
    expect(record.status, UnsentStatus.uncertain);
    expect(record.text, 'Review this plan: /plans/invoice-rounding.md');
    expect(store.draftFor(draft), 'keep me');

    echo(repository, record.userMessageId);
    await pump();
    expect(engine.unsent.recordsFor(target), isEmpty);
    expect(repository.sendChatMessageCalls, hasLength(1));
    expect(store.draftFor(draft), 'keep me');
  });

  test('a pipeline follow-up prepared after the engine is disposed sends '
      'nothing and creates no chat (CAN-3719)', () async {
    final answer = Completer<RemotePortalCommandResult>();
    final repository = _DedupingRepository()
      ..snapshotBuilder = (() => followUpSnapshot)
      ..followUpPrepareHandler = (() => answer.future);
    var changes = 0;
    final engine = buildRemoteEngine(
      repository: repository,
      onChanged: () => changes++,
      stateRefreshDebounce: Duration.zero,
    );
    await engine.session.connect('123456');
    final run = RemotePipelineRun.fromJson({
      'localId': 'exec-1',
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': 'wt-1',
      'status': 'failed',
      'chatFollowUp': {'planAvailable': true, 'reportAvailable': false},
    })!;
    final pending = engine.pipelineFollowUps.start(
      run,
      RemotePipelineFollowUpOutput.plan,
    );
    expect(engine.pipelineFollowUps.isPending('exec-1'), isTrue);
    final generation = engine.session.sessionGeneration;

    engine.dispose();
    final changesAtDisposal = changes;
    // No receiving chat: a send would ask the desktop to create one.
    answer.complete(
      RemotePortalCommandResult(
        commandId: 'prep-1',
        result: followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
          output: RemotePipelineFollowUpOutput.plan,
        ),
      ),
    );

    expect(await pending, isNull);
    await pump();
    expect(engine.session.sessionGeneration, generation);
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(repository.createChatTabTargets, isEmpty);
    expect(engine.pipelineFollowUps.error('exec-1'), isNull);
    expect(changes, changesAtDisposal);
  });
}

final class _GatedRepository extends FakeRemoteControlRepository {
  final Completer<RemoteChatSendResult> completer = Completer();

  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) {
    sendChatMessageCalls.add((target: target, text: text, options: options));
    return completer.future;
  }
}
