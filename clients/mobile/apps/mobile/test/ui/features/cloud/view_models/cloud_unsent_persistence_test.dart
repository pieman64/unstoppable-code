import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_session.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_unsent_records.dart';

import 'cloud_chat_test_support.dart';

void main() {
  CloudSendError definitive() => const CloudSendError(
    kind: CloudSendErrorKind.definitive,
    status: 400,
    message: 'bad request',
  );

  test('a record keeps its attachments through the stored JSON', () {
    const photo = ChatAttachmentRef(
      attachmentId: 'att-1',
      filename: 'photo.png',
      mediaType: 'image/png',
      size: 3,
      contentSha256: 'abc',
      storageKind: 'blob',
      source: '/s/att-1',
    );
    final record = CloudUnsentRecord(
      clientRequestId: 'a',
      payload: const CloudSendPayload(text: 'Look', attachments: [photo]),
      createdAt: DateTime.utc(2026),
      status: UnsentStatus.notSent,
      chatId: 'chat',
    );

    final stored = UnsentRecord.fromJson(
      jsonDecode(jsonEncode(record.toUnsentRecord().toJson())),
    );
    final restored = CloudUnsentRecord.fromRecord(stored!)!;

    expect(restored.payload.attachments.map((ref) => ref.toJson()), [
      photo.toJson(),
    ]);
    expect(restored.toFailedEntry().payload.attachments, hasLength(1));
  });

  test('a queued send is written and removed once accepted', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap();
      h.send('a');
      expect(cloudRecordsForChat(store, 'chat').single.clientRequestId, 'a');
      h.accept();
      expect(cloudRecordsForChat(store, 'chat'), isEmpty);
      h.dispose();
    });
  });

  test('a definitive failure is kept as not sent', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap();
      h.send('a');
      h.repository.posts.last.result.completeError(definitive());
      async.flushMicrotasks();
      final record = cloudRecordsForChat(store, 'chat').single;
      expect(record.status, UnsentStatus.notSent);
      expect(record.error, 'bad request');
      final row = h.vm.messages.single;
      expect(row.delivery, ChatDelivery.notSent);
      expect(row.deliveryNote, 'bad request');
      h.dispose();
    });
  });

  test('a failed continuation row agrees with its record', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      final h = Harness(async)..vm.attachDraftStore(store);
      h.repository.continueError = StateError('offline');
      h.bootstrap();
      h.send('a');
      // A terminal session counts as an attempt, but its error is not
      // uncertain: the turn was never accepted.
      h.repository.posts.last.result.completeError(
        const CloudSendError(
          kind: CloudSendErrorKind.terminalSession,
          status: 409,
          message: 'terminal',
        ),
      );
      async.flushMicrotasks();
      expect(h.vm.failedSends.keys, ['a']);
      final record = cloudRecordsForChat(store, 'chat').single;
      expect(record.status, UnsentStatus.notSent);
      expect(h.vm.messages.single.delivery, ChatDelivery.notSent);
      h.dispose();
    });
  });

  test('streaming with nothing to mirror does not rescan the store', () {
    fakeAsync((async) {
      final store = _CountingStore();
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap(live());
      for (var i = 0; i < 5; i++) {
        h.emit('message.start', {
          'role': 'assistant',
          'sourceKey': 'frame-$i',
        }, id: '${20 + i}');
      }
      expect(store.scans, lessThanOrEqualTo(1));

      // A send and its removal still reach the store.
      h.send('a');
      expect(cloudRecordsForChat(store, 'chat'), hasLength(1));
      h.vm.cancelQueued('a');
      expect(cloudRecordsForChat(store, 'chat'), isEmpty);
      h.dispose();
    });
  });

  test('close keeps records and reopening restores them without posting', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap();
      h.send('a'); // left posting: simulates a process death mid-send
      h.vm.close();
      expect(cloudRecordsForChat(store, 'chat'), hasLength(1));

      final posts = h.repository.posts.length;
      h.vm.open('chat', cursorEpoch: 'old-epoch');
      async.flushMicrotasks();
      expect(h.vm.failedSends.keys, ['a']);
      expect(h.vm.messages.single.delivery, ChatDelivery.uncertain);
      async.elapse(const Duration(seconds: 30));
      expect(h.repository.posts.length, posts);
      h.dispose();
    });
  });

  test('opening a landed chat recovers its pending first message', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      store.putUnsent(
        CloudUnsentRecord.pendingCreate(
          workspaceId: 'workspace',
          externalId: 'chat',
          clientRequestId: 'first',
          payload: const CloudSendPayload(text: 'first message'),
          createdAt: DateTime.utc(2026, 10, 3),
        ).toUnsentRecord(),
      );
      final h = Harness(async)..vm.attachDraftStore(store);
      h.vm.close();

      h.vm.open('chat', cursorEpoch: 'old-epoch');
      expect(cloudRecordsForChat(store, 'chat'), hasLength(1));
      expect(h.vm.failedSends.keys, ['first']);
      async.flushMicrotasks();

      expect(h.vm.failedSends.keys, ['first']);
      expect(h.vm.messages.single.text, 'first message');
      expect(h.vm.messages.single.delivery, ChatDelivery.uncertain);
      expect(
        cloudRecordsForChat(store, 'chat').single.clientRequestId,
        'first',
      );
      expect(cloudPendingCreates(store, 'workspace'), isEmpty);
      h.dispose();
    });
  });

  test('a restored record that already landed is pruned on bootstrap', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap();
      h.send('a');
      h.vm.close();
      h.vm.open('chat', cursorEpoch: 'old-epoch');
      async.flushMicrotasks();
      h.bootstrap(bootstrapWithUserRow('a'));
      expect(h.vm.failedSends, isEmpty);
      expect(cloudRecordsForChat(store, 'chat'), isEmpty);
      h.dispose();
    });
  });

  test('Resend of a restored record replays with the same id', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap();
      h.send('a');
      h.vm.close();
      h.vm.open('chat', cursorEpoch: 'old-epoch');
      async.flushMicrotasks();
      h.bootstrap();
      h.vm.resendMessage('optimistic:a');
      async.flushMicrotasks();
      expect(h.repository.posts.last.id, 'a');
      expect(h.repository.posts.last.replay, isTrue);
      h.dispose();
    });
  });

  test('resendMessage ignores an id that is not failed', () {
    fakeAsync((async) {
      final h = Harness(async)..vm.attachDraftStore(InMemoryChatDraftStore());
      h.bootstrap();
      h.send('a');
      final posts = h.repository.posts.length;
      h.vm.resendMessage('optimistic:a');
      h.vm.resendMessage('optimistic:missing');
      expect(h.repository.posts.length, posts);
      h.dispose();
    });
  });

  test('Discard removes the row and the record', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap();
      h.send('a');
      h.repository.posts.last.result.completeError(definitive());
      async.flushMicrotasks();
      h.vm.discardMessage('optimistic:a');
      expect(h.vm.failedSends, isEmpty);
      expect(h.vm.messages, isEmpty);
      expect(cloudRecordsForChat(store, 'chat'), isEmpty);
      h.dispose();
    });
  });

  test('sending clears the chat draft in the same step', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      store.setDraft(const CloudChatDraftTarget('chat'), 'a');
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap();
      h.vm.send(
        clientRequestId: 'a',
        payload: const CloudSendPayload(text: 'a'),
        clearComposerDraft: true,
      );
      expect(store.draftFor(const CloudChatDraftTarget('chat')), '');
      h.dispose();
    });
  });

  test('sending an answer keeps an unrelated composer draft', () {
    fakeAsync((async) {
      final store = InMemoryChatDraftStore();
      store.setDraft(const CloudChatDraftTarget('chat'), 'unsent follow-up');
      final h = Harness(async)..vm.attachDraftStore(store);
      h.bootstrap();
      h.vm.send(
        clientRequestId: 'answer',
        payload: const CloudSendPayload(text: 'Yes'),
      );
      expect(
        store.draftFor(const CloudChatDraftTarget('chat')),
        'unsent follow-up',
      );
      expect(cloudRecordsForChat(store, 'chat').single.payload.text, 'Yes');
      h.dispose();
    });
  });

  test('detaching an older store keeps the newer one attached', () {
    fakeAsync((async) {
      final older = InMemoryChatDraftStore();
      final newer = InMemoryChatDraftStore();
      final h = Harness(async)
        ..vm.attachDraftStore(older)
        ..vm.attachDraftStore(newer)
        ..vm.detachDraftStore(older);
      h.bootstrap();
      h.send('a');
      expect(cloudRecordsForChat(newer, 'chat'), hasLength(1));
      expect(cloudRecordsForChat(older, 'chat'), isEmpty);
      h.vm.detachDraftStore(newer);
      h.send('b');
      expect(cloudRecordsForChat(newer, 'chat'), hasLength(1));
      h.dispose();
    });
  });

  test('record JSON round-trips including a pending create', () {
    final record = CloudUnsentRecord.pendingCreate(
      workspaceId: 'w1',
      externalId: '11111111-1111-4111-8111-111111111111',
      clientRequestId: '22222222-2222-4222-8222-222222222222',
      payload: const CloudSendPayload(text: 'hi', modelDefinitionId: 'm'),
      createdAt: DateTime.utc(2026, 10, 3),
    );
    final decoded = CloudUnsentRecord.fromRecord(record.toUnsentRecord());
    expect(decoded?.isPendingCreate, isTrue);
    expect(decoded?.externalId, record.externalId);
    expect(decoded?.payload.modelDefinitionId, 'm');
    expect(decoded?.payload.autoModel, isFalse);
    expect(record.toUnsentRecord().extra.containsKey('autoModel'), isFalse);
    expect(
      record.toUnsentRecord().targetKey,
      const CloudNewChatDraftTarget('w1').key,
    );
  });

  test('a pending create in Auto survives a restart', () {
    final record = CloudUnsentRecord.pendingCreate(
      workspaceId: 'w1',
      externalId: '11111111-1111-4111-8111-111111111111',
      clientRequestId: '22222222-2222-4222-8222-222222222222',
      payload: const CloudSendPayload(
        text: 'hi',
        modelDefinitionId: 'm',
        autoModel: true,
      ),
      createdAt: DateTime.utc(2026, 10, 3),
    );
    final decoded = CloudUnsentRecord.fromRecord(record.toUnsentRecord());
    expect(decoded?.payload.autoModel, isTrue);
    expect(decoded?.payload.withText('edited').autoModel, isTrue);
  });

  test('a pending create keeps its plugin selection through storage', () {
    final selections = {
      'collectionIds': ['c1'],
      'skillRefs': [
        {'sourceId': 'src', 'skillName': 'notes'},
      ],
      'pluginRefs': <Object>[],
    };
    final record = CloudUnsentRecord.pendingCreate(
      workspaceId: 'w1',
      externalId: 'chat-external',
      clientRequestId: 'request',
      payload: const CloudSendPayload(text: 'hi'),
      createdAt: DateTime.utc(2026, 10, 9),
      pluginSelections: selections,
    );
    // Stored as JSON, read back after the app restarts, then retried.
    final stored = UnsentRecord.fromJson(
      jsonDecode(jsonEncode(record.toUnsentRecord().toJson())),
    )!;
    final restored = CloudUnsentRecord.fromRecord(
      stored,
    )!.copyWith(status: UnsentStatus.notSent, error: 'offline');
    expect(restored.pluginSelections, selections);
    expect(restored.externalId, 'chat-external');
    // Records written before this field existed keep the project defaults.
    final older = CloudUnsentRecord.pendingCreate(
      workspaceId: 'w1',
      externalId: 'chat-external',
      clientRequestId: 'request',
      payload: const CloudSendPayload(text: 'hi'),
      createdAt: DateTime.utc(2026, 10, 9),
    ).toUnsentRecord();
    expect(older.extra.containsKey('pluginSelections'), isFalse);
    expect(CloudUnsentRecord.fromRecord(older)?.pluginSelections, isNull);
  });
}

final class _CountingStore extends ChatDraftStateStore {
  int scans = 0;

  @override
  List<UnsentRecord> unsentFor(String surface) {
    scans++;
    return super.unsentFor(surface);
  }
}
