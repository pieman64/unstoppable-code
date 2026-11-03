import 'dart:async';
import 'dart:convert';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_unsent_records.dart';
import 'cloud_chat_test_support.dart' show FakeRepository;
import '../../../../support/agent_task_fixtures.dart';
import '../../../../support/conversation_v2_fixtures.dart';

class V2Repository extends FakeRepository {
  String session = 'session-1';
  int discoveries = 0;
  final snapshots = <Completer<ConversationSnapshot>>[];
  final sends =
      <
        ({
          ConversationSendInput input,
          Completer<ConversationAcceptedTurn> result,
        })
      >[];
  final commands = <ConversationCommandInput>[];
  final historyPages = <Completer<ConversationHistoryPage>>[];
  @override
  Future<ConversationDiscoveryMetadata> discoverConversation(
    String chatId,
  ) async {
    discoveries++;
    return ConversationDiscoveryMetadata(
      sessionId: session,
      protocolVersion: 2,
    );
  }

  @override
  Future<ConversationSnapshot> getConversation(String chatId) {
    final result = Completer<ConversationSnapshot>();
    snapshots.add(result);
    return result.future;
  }

  @override
  Future<ConversationAcceptedTurn> postConversationTurn(
    String chatId,
    ConversationSendInput input,
  ) {
    final result = Completer<ConversationAcceptedTurn>();
    sends.add((input: input, result: result));
    return result.future;
  }

  @override
  Future<ConversationCommandReceipt> conversationCommand(
    String chatId,
    String turnId,
    ConversationTurnOperation operation,
    ConversationCommandInput input,
  ) async {
    commands.add(input);
    return ConversationCommandReceipt.fromJson({
      'protocolVersion': 2,
      'sessionId': session,
      'commandId': input.commandId,
      'stateVersion': '2',
      'kind': 'cancelled',
      'turn': v2Turn(status: 'CANCELLED'),
      'replayed': false,
    });
  }

  @override
  Future<ConversationHistoryPage> getConversationHistory(
    String chatId,
    String cursor,
  ) {
    final result = Completer<ConversationHistoryPage>();
    historyPages.add(result);
    return result.future;
  }
}

class V2Harness {
  V2Harness(this.async) {
    vm = CloudChatViewModel(
      repository: repository,
      observeLifecycle: false,
      now: () => DateTime(2026).add(async.elapsed),
      openStream: (_, {after}) {
        cursors.add(after);
        final s = StreamController<CloudSseFrame>(sync: true);
        streams.add(s);
        return s.stream;
      },
    );
    vm.open('chat', cursorEpoch: 'session-1');
    async.flushMicrotasks();
  }
  final FakeAsync async;
  final repository = V2Repository();
  late final CloudChatViewModel vm;
  final cursors = <String?>[];
  final streams = <StreamController<CloudSseFrame>>[];
  void snapshot([Map<String, dynamic>? value]) {
    repository.snapshots.last.complete(
      ConversationSnapshot.fromJson(value ?? v2Snapshot()),
    );
    async.flushMicrotasks();
  }

  void send(String id) {
    vm.send(
      clientRequestId: id,
      payload: CloudSendPayload(text: id),
    );
    async.flushMicrotasks();
  }

  void emit(String event, Map<String, dynamic> body, {String? token}) {
    streams.last.add(
      CloudSseFrame(event: event, data: jsonEncode(body), id: token),
    );
    async.flushMicrotasks();
  }

  void changed(
    String before,
    String after,
    List<Map<String, dynamic>> changes,
  ) => emit('conversation.changed', {
    'protocolVersion': 2,
    'sessionId': repository.session,
    'previousStateVersion': before,
    'stateVersion': after,
    'changes': changes,
  }, token: 'opaque/$after');
  void dispose() {
    vm.dispose();
    for (final s in streams) {
      unawaited(s.close());
    }
    async.flushMicrotasks();
  }
}

const _photo = ChatAttachmentRef(
  attachmentId: 'att-1',
  filename: 'photo.png',
  mediaType: 'image/png',
  size: 3,
  contentSha256: 'abc',
  storageKind: 'blob',
  source: '/s/att-1',
);

void main() {
  test(
    'v2 task rows, replies and live task frames fold into an agent card '
    '(CAN-5208)',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot({
        ...v2Snapshot(
          version: '5',
          turns: [v2Turn(status: 'COMPLETED')],
          messages: [
            v2Message(id: 'user-r1', seq: 1),
            {
              ...v2Message(id: 'a1', role: 'ASSISTANT', seq: 2, text: 'Done'),
              'sourceKey': 'turn-source',
              'contentBlocks': [
                {
                  'type': 'tool_call',
                  'toolCallId': 'spawn',
                  'toolName': 'Task',
                  'input': {'subagent_type': 'Explore'},
                },
                {'type': 'text', 'text': 'Done'},
              ],
            },
            {
              ...v2Message(id: 'c1', role: 'ASSISTANT', seq: 3, text: 'Child'),
              'source': 'agent_task',
              'sourceKey': agentTaskSourceKey,
              'taskId': agentTaskId,
            },
          ],
        ),
        'tasks': [agentTaskRow(spawnToolCallId: 'spawn')],
      });
      Map<String, dynamic> card() => h.vm.messages
          .expand((m) => m.parts)
          .singleWhere((p) => p.kind == 'agent')
          .data!;
      List<Object?> texts() => [
        for (final sub in card()['subBlocks'] as List)
          ((sub as Map)['data'] as Map)['text'],
      ];
      expect(card()['subagentType'], 'Explore');
      expect(card()['isRunning'], isTrue);
      expect(texts(), ['Child']);
      expect(h.vm.messages.map((m) => m.text), isNot(contains('Child')));

      h.emit('message.delta', {
        'sourceKey': agentTaskSourceKey,
        'taskId': agentTaskId,
        'textDelta': 'More',
      }, token: 'opaque/task-1');
      expect(texts(), ['Child', 'More']);

      h.changed('5', '6', [
        {
          'type': 'task.upsert',
          'task': agentTaskRow(
            spawnToolCallId: 'spawn',
            status: 'completed',
            stateVersion: '4',
          ),
        },
      ]);
      expect(h.vm.state!.attachment, isNot(CloudAttachmentStatus.stale));
      expect(card()['taskStatus'], 'completed');
      expect(card().containsKey('isRunning'), isFalse);
      h.dispose();
    }),
  );
  test(
    'a v2 send carries its attachments as cloudAttachments',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      h.vm.send(
        clientRequestId: 'pending',
        payload: const CloudSendPayload(text: 'Look', attachments: [_photo]),
      );
      async.flushMicrotasks();

      expect(h.repository.sends.single.input.cloudAttachments, [_photo]);
      expect(
        h.vm.messages.last.attachments.single.attachmentId,
        _photo.attachmentId,
      );
      h.dispose();
    }),
  );
  test(
    'task-scoped frames cannot bind the v2 execution or add output',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot(v2Snapshot(turns: [v2Turn(status: 'RUNNING')]));
      final link = {
        'turnId': 'turn-1',
        'userMessageId': 'user-r1',
        'inferenceRunId': 'run-turn-1',
        'sourceKey': 'execution-source',
        'executionGeneration': 1,
      };
      h.emit('message.start', {
        ...link,
        'sourceKey': 'execution-source:task:t1',
        'taskId': 't1',
        'role': 'ASSISTANT',
      });
      h.emit('message.delta', {
        ...link,
        'sourceKey': 'execution-source:task:t1',
        'taskId': 't1',
        'streamIndex': 0,
        'textDelta': 'child',
      });
      h.emit('message.start', {...link, 'role': 'ASSISTANT'});
      h.emit('message.delta', {
        ...link,
        'streamIndex': 0,
        'textDelta': 'hello',
      });
      expect(h.vm.messages.single.text, 'hello');
      h.repository.interruptResult = const AgentTurnInterruptResult(
        outcome: AgentTurnInterruptOutcome.interruptRequested,
        rawOutcome: 'interrupt_requested',
        turnId: 'execution-source',
      );
      unawaited(h.vm.interrupt());
      async.flushMicrotasks();
      expect(h.repository.interrupts, ['execution-source']);
      h.dispose();
    }),
  );
  test(
    'replacement snapshot session forces discovery before pending send',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      unawaited(h.vm.refresh());
      async.flushMicrotasks();
      h.repository.session = 'replacement';
      h.snapshot(v2Snapshot(session: 'replacement'));
      h.send('pending');
      expect(h.repository.sends, isEmpty);
      async.elapse(const Duration(seconds: 2));
      async.flushMicrotasks();
      expect(h.repository.discoveries, 2);
      h.snapshot(v2Snapshot(session: 'replacement'));
      expect(h.vm.state!.cursorEpoch, 'replacement');
      expect(h.repository.sends.single.input.clientRequestId, 'pending');
      h.dispose();
    }),
  );
  test(
    'snapshot protocol mismatch rediscovers and preserves pending delivery',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.send('pending');
      h.repository.snapshots.single.completeError(
        CloudSendError(
          kind: CloudSendErrorKind.definitive,
          status: 409,
          message: 'mismatch',
          coreError: ConversationCoreError.tryParse({
            'code': 'AGENT_CONVERSATION_PROTOCOL_MISMATCH',
            'metadata': {'sessionId': 'session-1', 'protocolVersion': 2},
          }),
        ),
      );
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 2));
      async.flushMicrotasks();
      expect(h.repository.discoveries, 2);
      h.snapshot();
      expect(h.repository.sends.single.input.clientRequestId, 'pending');
      h.dispose();
    }),
  );
  test(
    'recovery frame resnapshots without following its endpoint',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      h.emit('conversation.recovery_required', {
        '@type': 'agent_conversation_recovery_required',
        'protocolVersion': 2,
        'sessionId': 'session-1',
        'reason': 'CURSOR_UNAVAILABLE',
        'action': 'RESNAPSHOT',
        'preserveOutbox': true,
        'safeBoundary': {
          'kind': 'SNAPSHOT',
          'endpoint': 'https://not-a-trusted-api.test',
        },
      });
      h.send('pending');
      expect(h.repository.sends, isEmpty);
      async.elapse(const Duration(seconds: 2));
      async.flushMicrotasks();
      h.snapshot();
      expect(h.repository.sends.single.input.clientRequestId, 'pending');
      h.dispose();
    }),
  );

  test(
    'attaches idle v2 chats and sends strict FIFO with one HTTP admission in flight',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      expect(h.cursors, ['opaque:resume/0+==']);
      h.send('a');
      h.send('b');
      expect(h.repository.sends, hasLength(1));
      h.repository.sends.first.result.complete(
        ConversationAcceptedTurn.fromJson(v2Accepted('a', 'a')),
      );
      async.flushMicrotasks();
      expect(h.repository.sends.map((s) => s.input.clientRequestId), [
        'a',
        'b',
      ]);
      expect(h.repository.posts, isEmpty);
      h.dispose();
    }),
  );
  test(
    'changed-before-HTTP reconciles optimistic rows and ignores late acceptance',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      h.send('r1');
      h.changed('0', '1', [
        {'type': 'message.upsert', 'message': v2Message(id: 'user-r1')},
        {'type': 'turn.upsert', 'turn': v2Turn(status: 'COMPLETED')},
      ]);
      expect(h.vm.state!.outbox, isEmpty);
      h.repository.sends.single.result.complete(
        ConversationAcceptedTurn.fromJson(v2Accepted('r1', 'late')),
      );
      async.flushMicrotasks();
      expect(
        h.vm.messages.where((m) => m.clientRequestId == 'r1'),
        hasLength(1),
      );
      expect(h.vm.messages.single.text, 'hello agent');
      expect(h.vm.turnInProgress, isFalse);
      h.dispose();
    }),
  );
  test(
    'changed-before-HTTP still applies the model selection the server saved',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      h.send('r1');
      h.changed('0', '1', [
        {'type': 'message.upsert', 'message': v2Message(id: 'user-r1')},
        {'type': 'turn.upsert', 'turn': v2Turn(status: 'COMPLETED')},
      ]);
      expect(h.vm.state!.outbox, isEmpty);
      var notified = 0;
      h.vm.addListener(() => notified++);
      h.repository.sends.single.result.complete(
        ConversationAcceptedTurn.fromJson({
          ...v2Accepted('r1', 'late'),
          'modelDefinitionId': 'claude-opus-5',
          'modelSelectionMode': 'manual',
        }),
      );
      async.flushMicrotasks();
      final selection = h.vm.acceptedModelSelection;
      expect(selection?.chatId, 'chat');
      expect(selection?.modelSelectionMode, 'manual');
      expect(selection?.modelDefinitionId, 'claude-opus-5');
      expect(notified, greaterThan(0));
      expect(h.vm.messages.single.text, 'hello agent');
      h.dispose();
    }),
  );
  test(
    'uncertain sends retain the original key, content and attachments and block later admissions',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      h.vm.send(
        clientRequestId: 'a',
        payload: const CloudSendPayload(text: 'a', attachments: [_photo]),
      );
      async.flushMicrotasks();
      h.send('b');
      h.repository.sends.first.result.completeError(
        const CloudSendError(
          kind: CloudSendErrorKind.retryable,
          status: 503,
          message: 'retry',
          uncertain: true,
        ),
      );
      async.flushMicrotasks();
      h.vm.editQueued('a', 'different');
      async.elapse(const Duration(seconds: 2));
      async.flushMicrotasks();
      expect(h.repository.sends.map((s) => s.input.clientRequestId), [
        'a',
        'a',
      ]);
      expect(h.repository.sends.last.input.content, 'a');
      expect(h.repository.sends.last.input.retryUncertain, isTrue);
      for (final send in h.repository.sends) {
        expect(send.input.cloudAttachments, [_photo]);
      }
      h.dispose();
    }),
  );
  test(
    'retry after a clear v2 failure does not request uncertain recovery',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      h.send('rate-limited');
      h.repository.sends.single.result.completeError(
        const CloudSendError(
          kind: CloudSendErrorKind.retryable,
          status: 429,
          message: 'rate limited',
          retryAfter: Duration(seconds: 2),
        ),
      );
      async.flushMicrotasks();
      expect(h.vm.state!.outbox.single.lastError!.uncertain, isFalse);
      async.elapse(const Duration(seconds: 2));
      expect(h.repository.sends, hasLength(2));
      expect(h.repository.sends.last.input.retryUncertain, isFalse);
      h.dispose();
    }),
  );
  test(
    'retry after a v2 timeout requests uncertain recovery',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      h.send('timed-out');
      h.repository.sends.single.result.completeError(
        TimeoutException('admission timed out'),
      );
      async.flushMicrotasks();
      expect(h.vm.state!.outbox.single.lastError!.uncertain, isTrue);
      async.elapse(const Duration(seconds: 2));
      expect(h.repository.sends, hasLength(2));
      expect(h.repository.sends.last.input.retryUncertain, isTrue);
      h.dispose();
    }),
  );
  test(
    'version gap resnapshots and preserves unacknowledged outbox',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot();
      h.changed('2', '3', []);
      h.send('pending');
      expect(h.repository.sends, isEmpty);
      async.elapse(const Duration(seconds: 2));
      async.flushMicrotasks();
      h.snapshot(v2Snapshot(version: '3'));
      expect(h.repository.sends.single.input.clientRequestId, 'pending');
      expect(h.cursors.last, 'opaque:resume/3+==');
      h.dispose();
    }),
  );
  test(
    'duplicate indices and foreign executions do not append output; Stop uses sourceKey',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot(v2Snapshot(turns: [v2Turn(status: 'RUNNING')]));
      final link = {
        'turnId': 'turn-1',
        'userMessageId': 'user-r1',
        'inferenceRunId': 'run-turn-1',
        'sourceKey': 'execution-source',
        'executionGeneration': 1,
      };
      h.emit('message.start', {...link, 'role': 'ASSISTANT'});
      h.emit('message.delta', {
        ...link,
        'streamIndex': 0,
        'textDelta': 'hello',
      });
      h.emit('message.delta', {
        ...link,
        'streamIndex': 0,
        'textDelta': 'duplicate',
      });
      h.emit('message.delta', {
        ...link,
        'inferenceRunId': 'old',
        'streamIndex': 1,
        'textDelta': 'wrong',
      });
      expect(h.vm.messages.single.text, 'hello');
      h.repository.interruptResult = const AgentTurnInterruptResult(
        outcome: AgentTurnInterruptOutcome.interruptRequested,
        rawOutcome: 'interrupt_requested',
        turnId: 'execution-source',
      );
      unawaited(h.vm.interrupt());
      async.flushMicrotasks();
      expect(h.repository.interrupts, ['execution-source']);
      h.changed('0', '1', [
        {
          'type': 'message.upsert',
          'message': v2Message(
            id: 'assistant',
            role: 'ASSISTANT',
            text: 'canonical',
          ),
        },
        {'type': 'turn.upsert', 'turn': v2Turn(status: 'COMPLETED')},
      ]);
      expect(h.vm.messages.single.text, 'canonical');
      expect(h.vm.turnInProgress, isFalse);
      h.dispose();
    }),
  );
  test(
    'old snapshot cannot hydrate a newly opened chat',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      final old = h.repository.snapshots.single;
      h.vm.open('other', cursorEpoch: 'session-1');
      async.flushMicrotasks();
      old.complete(
        ConversationSnapshot.fromJson(
          v2Snapshot(messages: [v2Message(text: 'stale')]),
        ),
      );
      async.flushMicrotasks();
      expect(h.vm.messages, isEmpty);
      h.snapshot();
      expect(h.vm.state!.chatId, 'other');
      h.dispose();
    }),
  );
  test(
    'queued commands carry current version and snapshot after partial receipts',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot(v2Snapshot(version: '1', turns: [v2Turn()]));
      unawaited(h.vm.commandTurn('turn-1', ConversationTurnOperation.cancel));
      async.flushMicrotasks();
      expect(h.repository.commands.single.expectedStateVersion, '1');
      expect(
        h.repository.commands.single.commandId,
        matches(RegExp(r'^[0-9a-f-]{36}$')),
      );
      async.elapse(const Duration(seconds: 2));
      async.flushMicrotasks();
      expect(h.repository.snapshots, hasLength(2));
      h.dispose();
    }),
  );
  test(
    'history paging is single flight and does not rewind the stream token',
    () => fakeAsync((async) {
      final h = V2Harness(async);
      h.snapshot(
        v2Snapshot(
          version: '5',
          history: 'history/+=',
          messages: [v2Message(text: 'new')],
        ),
      );
      unawaited(h.vm.loadOlder());
      unawaited(h.vm.loadOlder());
      async.flushMicrotasks();
      expect(h.repository.historyPages, hasLength(1));
      h.repository.historyPages.single.complete(
        ConversationHistoryPage.fromJson({
          ...v2Snapshot(messages: [v2Message(id: 'old', seq: 0, turnId: null)]),
          '@type': 'agent_conversation_history_page',
          'snapshotStateVersion': '5',
          'messageWatermark': '1',
        }),
      );
      async.flushMicrotasks();
      expect(h.vm.messages.map((m) => m.messageId), ['old', 'user-1']);
      expect(h.vm.state!.cursor, 'opaque:resume/5+==');
      expect(h.vm.hasMoreHistory, isFalse);
      h.dispose();
    }),
  );
  group('persisted unsent sends', () {
    test(
      'close keeps records and reopening restores them without posting',
      () => fakeAsync((async) {
        final store = InMemoryChatDraftStore();
        final h = V2Harness(async)..vm.attachDraftStore(store);
        h.snapshot();
        h.send('a'); // left in flight: simulates a process death mid-send
        h.vm.close();
        expect(cloudRecordsForChat(store, 'chat'), hasLength(1));

        final sends = h.repository.sends.length;
        h.vm.open('chat', cursorEpoch: 'session-1');
        async.flushMicrotasks();
        expect(h.vm.failedSends.keys, ['a']);
        expect(h.vm.messages.single.delivery, ChatDelivery.uncertain);
        async.elapse(const Duration(seconds: 30));
        expect(h.repository.sends.length, sends);
        h.dispose();
      }),
    );
    test(
      'Resend of a restored record sets retryUncertain',
      () => fakeAsync((async) {
        final store = InMemoryChatDraftStore();
        final h = V2Harness(async)..vm.attachDraftStore(store);
        h.snapshot();
        h.send('a');
        h.vm.close();
        h.vm.open('chat', cursorEpoch: 'session-1');
        async.flushMicrotasks();
        h.snapshot();
        h.vm.resendMessage('optimistic:a');
        async.flushMicrotasks();
        expect(h.repository.sends.last.input.clientRequestId, 'a');
        expect(h.repository.sends.last.input.content, 'a');
        expect(h.repository.sends.last.input.retryUncertain, isTrue);
        h.dispose();
      }),
    );
  });
}
