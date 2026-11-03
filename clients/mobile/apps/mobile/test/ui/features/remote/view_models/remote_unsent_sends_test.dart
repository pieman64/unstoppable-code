import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/remote_unsent_sends.dart';

void main() {
  const target = RemoteWorktreeChatTarget(
    workspaceLocalId: 'ws-1',
    worktreeLocalId: 'wt-1',
    chatId: 'chat-1',
  );
  const otherWorktree = RemoteWorktreeChatTarget(
    workspaceLocalId: 'ws-1',
    worktreeLocalId: 'wt-2',
    chatId: 'chat-1',
  );
  final at = DateTime.utc(2026, 10, 3);

  RemoteChatMessage echo(String id, {String chatId = 'chat-1'}) =>
      RemoteChatMessage(
        messageId: id,
        chatId: chatId,
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'hi',
      );

  test('recordSending writes a record and clears the draft', () {
    final store = InMemoryChatDraftStore();
    const draft = RemoteWorktreeChatDraftTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );
    store.setDraft(draft, 'hi');
    final unsent = RemoteUnsentSends(store: store);
    unsent.recordSending(
      target: target,
      userMessageId: 'm1',
      text: 'hi',
      createdAt: at,
      clearDraft: draft,
    );
    expect(store.draftFor(draft), '');
    expect(unsent.byId('m1')?.status, UnsentStatus.sending);
    expect(unsent.byId('m1')?.target, isA<RemoteWorktreeChatTarget>());
  });

  test('send options survive a JSON round trip', () {
    final store = InMemoryChatDraftStore();
    RemoteUnsentSends(store: store).recordSending(
      target: target,
      userMessageId: 'm1',
      text: 'hi',
      createdAt: at,
      options: const RemoteChatSendOptions(
        userMessageId: 'm1',
        thinkingLevel: 'high',
        fastMode: false,
        inputMode: 'voice',
      ),
    );
    final stored = store.unsentById('rc:m1')!;
    final decoded = UnsentRecord.fromJson(
      jsonDecode(jsonEncode(stored.toJson())),
    )!;
    final options = RemoteUnsentRecord.fromRecord(decoded)!.options;
    expect(options.thinkingLevel, 'high');
    expect(options.fastMode, isFalse);
    expect(options.inputMode, 'voice');
    expect(options.userMessageId, isNull);
    expect(options.model, isNull);
  });

  test('worktree and flat-workspace queries list records newest first', () {
    final unsent = RemoteUnsentSends(store: InMemoryChatDraftStore());
    void record(String id, RemoteChatTarget target, int minute) =>
        unsent.recordSending(
          target: target,
          userMessageId: id,
          text: id,
          createdAt: at.add(Duration(minutes: minute)),
        );
    record('old', target, 0);
    record(
      'new',
      const RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        chatId: 'chat-m2',
      ),
      5,
    );
    record('other', otherWorktree, 9);
    record(
      'flat',
      const RemoteStandaloneChatTarget(chatId: 'cc-1', projectLocalId: 'ws-f'),
      3,
    );
    record('elsewhere', const RemoteStandaloneChatTarget(chatId: 'cc-2'), 4);

    expect(
      unsent.recordsForWorktree('ws-1', 'wt-1').map((r) => r.userMessageId),
      ['new', 'old'],
    );
    expect(
      unsent.standaloneRecordsForProject('ws-f').map((r) => r.userMessageId),
      ['flat'],
    );
  });

  test('records are scoped to their worktree and chat', () {
    final unsent = RemoteUnsentSends(store: InMemoryChatDraftStore());
    unsent.recordSending(
      target: target,
      userMessageId: 'm1',
      text: 'hi',
      createdAt: at,
    );
    expect(unsent.recordsFor(target).single.userMessageId, 'm1');
    expect(unsent.recordsFor(otherWorktree), isEmpty);
  });

  test('restart turns sending records into uncertain ones', () {
    final store = InMemoryChatDraftStore();
    RemoteUnsentSends(store: store).recordSending(
      target: target,
      userMessageId: 'm1',
      text: 'hi',
      createdAt: at,
    );
    final restarted = RemoteUnsentSends(store: store);
    expect(restarted.byId('m1')?.status, UnsentStatus.uncertain);
  });

  test('demoteSending turns sending records into uncertain ones', () {
    final unsent = RemoteUnsentSends(store: InMemoryChatDraftStore());
    unsent
      ..recordSending(
        target: target,
        userMessageId: 'm1',
        text: 'hi',
        createdAt: at,
      )
      ..recordSending(
        target: target,
        userMessageId: 'm2',
        text: 'there',
        createdAt: at,
      )
      ..markNotSent('m2', kRemoteOfflineReason);
    const key = (scope: RemoteChatScope.worktree, chatId: 'chat-1');
    final before = unsent.revisionFor(key);

    unsent.demoteSending();

    expect(unsent.byId('m1')?.status, UnsentStatus.uncertain);
    expect(unsent.byId('m2')?.status, UnsentStatus.notSent);
    expect(unsent.byId('m2')?.error, kRemoteOfflineReason);
    expect(unsent.revisionFor(key), greaterThan(before));
    expect(unsent.markSending('m1'), isTrue);
  });

  test('only an exact-id echo in the same chat removes a record', () {
    final unsent = RemoteUnsentSends(store: InMemoryChatDraftStore());
    unsent.recordSending(
      target: target,
      userMessageId: 'm1',
      text: 'hi',
      createdAt: at,
    );
    const key = (scope: RemoteChatScope.worktree, chatId: 'chat-1');
    unsent.confirmEcho(key, echo('other-id'));
    expect(unsent.byId('m1'), isNotNull);
    unsent.confirmEcho(key, echo('m1'));
    expect(unsent.byId('m1'), isNull);
    expect(unsent.revisionFor(key), greaterThan(0));
  });

  test('marking a missing record is a no-op', () {
    final store = InMemoryChatDraftStore();
    final unsent = RemoteUnsentSends(store: store);
    unsent.markNotSent('gone', kRemoteOfflineReason);
    unsent.markUncertain('gone', 'lost');
    expect(store.unsentFor(kRemoteUnsentSurface), isEmpty);
  });

  test('markSending refuses a record that is already sending', () {
    final unsent = RemoteUnsentSends(store: InMemoryChatDraftStore());
    unsent.recordSending(
      target: target,
      userMessageId: 'm1',
      text: 'hi',
      createdAt: at,
    );
    expect(unsent.markSending('m1'), isFalse);
    unsent.markNotSent('m1', kRemoteOfflineReason);
    expect(unsent.markSending('m1'), isTrue);
  });

  test('toMessage maps status to delivery', () {
    final unsent = RemoteUnsentSends(store: InMemoryChatDraftStore());
    unsent.recordSending(
      target: const RemoteStandaloneChatTarget(chatId: 'cc-1'),
      userMessageId: 'm1',
      text: 'hi',
      createdAt: at,
    );
    unsent.markNotSent('m1', kRemoteOfflineReason);
    final row = unsent.byId('m1')!.toMessage();
    expect(row.messageId, 'm1');
    expect(row.chatId, 'cc-1');
    expect(row.delivery, ChatDelivery.notSent);
    expect(row.deliveryNote, kRemoteOfflineReason);
    expect(row.scope, RemoteChatScope.standalone);
  });
}
