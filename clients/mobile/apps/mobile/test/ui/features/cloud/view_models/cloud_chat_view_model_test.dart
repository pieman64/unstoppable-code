import 'dart:async';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';

import 'cloud_chat_test_support.dart';
import '../../../../support/agent_task_fixtures.dart';

const _photo = ChatAttachmentRef(
  attachmentId: 'att-1',
  filename: 'photo.png',
  mediaType: 'image/png',
  size: 3,
  contentSha256: 'abc',
  storageKind: 'blob',
  source: '/s/att-1',
);

Map<String, dynamic> _agentCard(CloudChatViewModel vm) => vm.messages
    .expand((m) => m.parts)
    .singleWhere((p) => p.kind == 'agent')
    .data!;

List<Object?> _subTexts(Map<String, dynamic> card) => [
  for (final sub in card['subBlocks'] as List)
    ((sub as Map)['data'] as Map)['text'],
];

void main() {
  test(
    'live subagent frames become a nested agent card (CAN-5208)',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.emit('message.start', {
        'role': 'assistant',
        'sourceKey': 'turn',
        'turnId': 'turn-1',
      }, id: '11');
      h.emit('tool.call', {
        'sourceKey': 'turn',
        'toolCallId': 'spawn',
        'toolName': 'Task',
        'args': {'subagent_type': 'Explore', 'description': 'Map it'},
      }, id: '12');
      h.emit('task.upsert', {
        'agentSessionId': 's',
        'task': agentTaskRow(spawnToolCallId: 'spawn'),
      }, id: '13');
      h.emit('message.delta', {
        'sourceKey': 'turn:task:$agentTaskId',
        'taskId': agentTaskId,
        'textDelta': 'Child reply',
      }, id: '14');
      h.emit('message.delta', {
        'sourceKey': 'turn',
        'textDelta': 'Root text',
      }, id: '15');
      async.flushMicrotasks();
      final card = _agentCard(h.vm);
      expect(card['subagentType'], 'Explore');
      expect(card['isRunning'], isTrue);
      expect(_subTexts(card), ['Child reply']);
      expect(h.vm.messages.map((m) => m.text), contains('Root text'));
      expect(h.vm.messages.map((m) => m.text), isNot(contains('Child reply')));
      h.emit('task.upsert', {
        'task': agentTaskRow(
          spawnToolCallId: 'spawn',
          status: 'completed',
          stateVersion: '4',
          summary: 'All mapped',
        ),
      }, id: '16');
      async.flushMicrotasks();
      expect(_agentCard(h.vm).containsKey('isRunning'), isFalse);
      expect(_agentCard(h.vm)['result'], 'All mapped');
      h.dispose();
    }),
  );
  test(
    'a reloaded chat folds attached tasks and their replies (CAN-5208)',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(
        CloudChatBootstrap.fromJson({
          'messages': [
            {
              'id': 'root',
              'role': 'ASSISTANT',
              'sourceKey': 'turn',
              'text': 'Root',
              'createdAtMs': 1,
              'contentBlocks': [
                {
                  'type': 'tool_call',
                  'toolCallId': 'spawn',
                  'toolName': 'Task',
                },
                {'type': 'text', 'text': 'Root'},
              ],
            },
            {
              'id': 'child',
              'role': 'ASSISTANT',
              'sourceKey': 'turn:task:$agentTaskId',
              'taskId': agentTaskId,
              'text': 'Child reply',
              'createdAtMs': 2,
            },
          ],
          'toolActivity': [
            {
              'kind': 'call',
              'call': {
                'sourceKey': 'turn',
                'toolCallId': 'spawn',
                'toolName': 'Task',
                'input': '{"subagent_type":"Explore"}',
                'agentTask': agentTaskRow(
                  spawnToolCallId: 'spawn',
                  status: 'completed',
                  completedAt: '2026-10-13T10:00:10.500Z',
                ),
              },
            },
          ],
        }),
      );
      final card = _agentCard(h.vm);
      expect(card['taskStatus'], 'completed');
      expect(_subTexts(card), ['Child reply']);
      expect(h.vm.messages.map((m) => m.text), ['', 'Root']);
      h.dispose();
    }),
  );
  test(
    'a send carries its attachments to the post and its optimistic row',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.vm.send(
        clientRequestId: 'a',
        payload: const CloudSendPayload(text: 'Look', attachments: [_photo]),
      );
      async.flushMicrotasks();

      expect(h.repository.posts.single.attachments, [_photo]);
      final row = h.vm.messages.singleWhere((m) => m.role == ChatRole.user);
      expect(row.attachments.single.attachmentId, 'att-1');
      expect(row.attachments.single.filename, 'photo.png');
      h.dispose();
    }),
  );
  test(
    'a refused send keeps its attachments on the row and on resend',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.vm.send(
        clientRequestId: 'a',
        payload: const CloudSendPayload(text: 'Look', attachments: [_photo]),
      );
      async.flushMicrotasks();
      h.repository.posts.single.result.completeError(
        const CloudSendError(
          kind: CloudSendErrorKind.definitive,
          status: 400,
          message: 'invalid cloudAttachments',
        ),
      );
      async.flushMicrotasks();

      final failed = h.vm.messages.singleWhere((m) => m.role == ChatRole.user);
      expect(failed.delivery, ChatDelivery.notSent);
      expect(failed.attachments.single.attachmentId, 'att-1');

      h.vm.retrySend('a', fresh: (text) => CloudSendPayload(text: text));
      async.flushMicrotasks();

      expect(h.repository.posts, hasLength(2));
      expect(h.repository.posts.last.text, 'Look');
      expect(h.repository.posts.last.attachments, [_photo]);
      h.dispose();
    }),
  );
  test(
    'task-scoped frames neither settle nor demote the unbound live turn and stay out of the transcript',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      h.accept();
      h.emit('message.start', {
        'role': 'assistant',
        'sourceKey': 'turn:task:t1',
        'taskId': 't1',
      }, id: '11');
      h.emit('message.delta', {
        'sourceKey': 'turn:task:t1',
        'taskId': 't1',
        'textDelta': 'child',
      }, id: '12');
      h.emit('message.finish', {
        'sourceKey': 'turn:task:t1',
        'taskId': 't1',
      }, id: '13');
      expect(h.vm.state!.liveTurn, isNotNull);
      expect(h.vm.state!.liveTurn!.turnId, null);
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.live);
      expect(h.vm.state!.cursor, '13');
      expect(h.repository.bootstraps.length, 1);
      h.emit('message.start', {
        'role': 'assistant',
        'sourceKey': 'turn',
      }, id: '14');
      h.emit('message.delta', {
        'sourceKey': 'turn',
        'textDelta': 'root',
      }, id: '15');
      h.emit('message.delta', {
        'sourceKey': 'turn:task:t1',
        'taskId': 't1',
        'textDelta': 'child2',
      }, id: '16');
      h.emit('message.finish', {'sourceKey': 'turn'}, id: '17');
      expect(h.vm.state!.liveTurn, null);
      expect(
        h.vm.messages
            .where((m) => m.role == ChatRole.assistant)
            .map((m) => m.text),
        ['root'],
      );
      h.dispose();
    }),
  );
  test(
    'superseded interrupt naming the same turn preserves its canonical identity',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.repository.interruptResult = const AgentTurnInterruptResult(
        outcome: AgentTurnInterruptOutcome.superseded,
        rawOutcome: 'superseded',
        turnId: 'turn',
        activeTurnId: 'turn',
      );
      unawaited(h.vm.interrupt());
      async.flushMicrotasks();
      expect(h.vm.state!.liveTurn!.userMessageId, 'user');
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.live);
      h.dispose();
    }),
  );
  test(
    'terminal bootstrap allows explicit continue without a pending send',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(
        const CloudChatBootstrap(
          messages: [],
          toolActivity: [],
          terminalSession: CloudTerminalSession(
            status: 'completed',
            sourceAgentSessionId: 'old-epoch',
          ),
        ),
      );
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.terminal);
      expect(h.repository.continuations, isEmpty);
      unawaited(h.vm.continueChat());
      async.flushMicrotasks();
      h.bootstrap();
      expect(h.vm.state!.cursorEpoch, 'new-epoch');
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.live);
      h.dispose();
    }),
  );
  test(
    'continuation replaces the previous epoch history with the copied history',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(
        CloudChatBootstrap(
          messages: [
            message('old-user', text: 'testing', createdAtMs: 100),
            message(
              'old-assistant',
              role: 'ASSISTANT',
              text: 'received',
              createdAtMs: 200,
            ),
          ],
          toolActivity: const [],
          terminalSession: const CloudTerminalSession(
            status: 'completed',
            sourceAgentSessionId: 'old-epoch',
          ),
        ),
      );
      h.send('question');
      async.flushMicrotasks();
      expect(h.repository.continuations, ['old-epoch']);

      h.bootstrap(
        CloudChatBootstrap(
          messages: [
            message('new-user', text: 'testing', createdAtMs: 100),
            message(
              'new-assistant',
              role: 'ASSISTANT',
              text: 'received',
              createdAtMs: 200,
            ),
          ],
          toolActivity: const [],
        ),
      );

      expect(h.repository.posts.single.id, 'question');
      expect(h.vm.messages.map((m) => m.text), [
        'testing',
        'received',
        'question',
      ]);
      h.dispose();
    }),
  );
  test(
    'continuation retains loaded history older than the copied bootstrap page',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(
        CloudChatBootstrap(
          messages: [
            for (var index = 0; index < 60; index++)
              message('old-$index', text: 'message $index', createdAtMs: index),
          ],
          toolActivity: const [],
          terminalSession: const CloudTerminalSession(
            status: 'completed',
            sourceAgentSessionId: 'old-epoch',
          ),
        ),
      );
      h.send('question');
      async.flushMicrotasks();
      h.bootstrap(
        CloudChatBootstrap(
          messages: [
            for (var index = 10; index < 60; index++)
              message('new-$index', text: 'message $index', createdAtMs: index),
          ],
          toolActivity: const [],
        ),
      );

      expect(h.vm.messages.map((m) => m.text), [
        for (var index = 0; index < 60; index++) 'message $index',
        'question',
      ]);
      h.dispose();
    }),
  );
  test(
    'continuation clears the accepted checkpoint from the previous epoch',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      h.accept(cursor: '50');
      unawaited(h.vm.refresh());
      h.bootstrap(
        const CloudChatBootstrap(
          messages: [],
          toolActivity: [],
          terminalSession: CloudTerminalSession(
            status: 'completed',
            sourceAgentSessionId: 'old-epoch',
          ),
        ),
      );

      unawaited(h.vm.continueChat());
      async.flushMicrotasks();
      h.bootstrap(live(cursor: '1'));
      h.emit('message.delta', {
        'sourceKey': 'turn',
        'textDelta': 'new epoch',
      }, id: '2');

      expect(h.vm.state!.cursor, '2');
      expect(h.vm.messages.last.text, 'new epoch');
      h.dispose();
    }),
  );
  test(
    'terminal stream auth failure surfaces and does not retry automatically',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.streams.last.addError(
        const CloudEventStreamException(
          kind: CloudEventStreamErrorKind.authentication,
          statusCode: 401,
        ),
      );
      async.elapse(const Duration(seconds: 10));
      expect(h.repository.bootstraps.length, 1);
      expect(h.vm.bootstrapError, "Couldn't load chat history.");
      h.dispose();
    }),
  );

  test(
    'composite historical frames at accepted sequence are replay, not a new turn',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      h.accept(cursor: '10');
      h.emit('message.start', {
        'role': 'assistant',
        'sourceKey': 'old',
      }, id: 'stream:10:0');
      h.emit('message.finish', {'sourceKey': 'old'}, id: 'stream:10:turn:99');
      expect(h.vm.state!.liveTurn!.turnId, isNull);
      expect(h.vm.state!.cursor, '10');
      h.dispose();
    }),
  );

  test(
    'composite resume cursor accepts the next frame in the same sequence',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live(cursor: 'stream:3521:chat%3Aassistant%3A0:4'));
      h.emit('message.delta', {
        'sourceKey': 'turn',
        'textDelta': 'next',
      }, id: 'stream:3521:chat%3Aassistant%3A0:5');
      expect(h.vm.state!.cursor, 'stream:3521:chat%3Aassistant%3A0:5');
      expect(h.vm.messages.single.text, 'next');
      h.dispose();
    }),
  );

  test(
    'stale cross-turn delta never rebinds the live turn',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.emit('message.delta', {
        'sourceKey': 'turn',
        'textDelta': 'current',
      }, id: '11');
      h.emit('message.delta', {
        'sourceKey': 'old',
        'textDelta': 'stale',
      }, id: '12');
      expect(h.vm.state!.liveTurn!.turnId, 'turn');
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.live);
      h.dispose();
    }),
  );
  test(
    'refresh during bootstrap queues a second authoritative read',
    () => fakeAsync((async) {
      final h = Harness(async);
      unawaited(h.vm.refresh());
      h.bootstrap(live());
      async.elapse(const Duration(seconds: 2));
      expect(h.repository.bootstraps.length, 2);
      h.dispose();
    }),
  );
  test(
    'refresh during post defers its authoritative read until post settles',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');

      unawaited(h.vm.refresh());
      expect(h.repository.bootstraps.length, 1);

      h.accept();
      expect(h.repository.bootstraps.length, 2);
      h.dispose();
    }),
  );
  test(
    'terminal trailing frames cannot reopen the old turn while next send posts',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.send('a');
      h.emit('message.finish', {'sourceKey': 'turn'}, id: '11');
      h.emit('message.delta', {
        'sourceKey': 'turn',
        'textDelta': 'late',
      }, id: '12');
      expect(h.vm.state!.liveTurn, isNull);
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.live);
      h.dispose();
    }),
  );

  test(
    'send before bootstrap survives; strict FIFO waits for matching terminal',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.send('a');
      h.send('b');
      expect(h.repository.posts, isEmpty);
      expect(h.vm.state!.visibleTranscript.length, 2);
      h.bootstrap();
      expect(h.repository.posts.map((p) => p.id), ['a']);
      h.accept();
      expect(h.vm.state!.optimistic.keys, ['b']);
      expect(h.cursors, ['10']);
      h.emit('message.start', {
        'role': 'assistant',
        'sourceKey': 'turn',
      }, id: '11');
      h.emit('message.finish', {'sourceKey': 'other'}, id: '12');
      expect(h.repository.posts.length, 1);
      h.emit('message.finish', {'sourceKey': 'turn'}, id: '13');
      expect(h.repository.posts.map((p) => p.id), ['a', 'b']);
      h.accept(cursor: '13');
      expect(h.cursors, ['10', '13']);
      h.dispose();
    }),
  );
  test(
    'retryable failure waits until deadline and replays same key and payload',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      h.send('b');
      h.repository.posts.last.result.completeError(
        const CloudSendError(
          kind: CloudSendErrorKind.retryable,
          status: 503,
          message: 'busy',
          retryAfter: Duration(seconds: 5),
        ),
      );
      async.flushMicrotasks();
      h.vm.editQueued('a', 'changed');
      async.elapse(const Duration(seconds: 4));
      expect(h.repository.posts.length, 1);
      async.elapse(const Duration(seconds: 1));
      expect(h.repository.posts.length, 2);
      expect(h.repository.posts.last.id, 'a');
      expect(h.repository.posts.last.text, 'a');
      expect(h.repository.posts.last.replay, isTrue);
      h.accept(replayed: true);
      expect(h.vm.state!.liveTurn, isNull);
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.unknown);
      expect(h.repository.posts.length, 2);
      async.elapse(const Duration(seconds: 2));
      h.bootstrap();
      expect(h.repository.posts.last.id, 'b');
      h.dispose();
    }),
  );
  test(
    'definitive error exposes failed row and manual retry',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      h.repository.posts.last.result.completeError(
        const CloudSendError(
          kind: CloudSendErrorKind.definitive,
          status: 400,
          message: 'bad request',
        ),
      );
      async.flushMicrotasks();
      expect(h.vm.state!.outbox, isEmpty);
      expect(h.vm.state!.visibleTranscript.single.errorMessage, 'bad request');
      async.elapse(const Duration(seconds: 10));
      expect(h.repository.posts.length, 1);
      h.vm.retrySend('a');
      expect(h.repository.posts.length, 2);
      h.accept();
      expect(h.vm.state!.visibleTranscript.single.messageId, 'user-a');
      h.dispose();
    }),
  );
  test(
    'terminal send continues, changes epoch, bootstraps and requeues FIFO',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      h.send('b');
      h.repository.posts.last.result.completeError(
        const CloudSendError(
          kind: CloudSendErrorKind.terminalSession,
          status: 409,
          message: 'terminal',
        ),
      );
      async.flushMicrotasks();
      expect(h.repository.continuations, ['old-epoch']);
      expect(h.vm.state!.cursorEpoch, 'new-epoch');
      expect(h.vm.state!.cursor, isNull);
      h.bootstrap();
      async.elapse(const Duration(seconds: 2));
      expect(h.repository.posts.map((p) => p.id), ['a', 'a']);
      expect(h.repository.posts.last.replay, isTrue);
      h.dispose();
    }),
  );
  test(
    'failed continuation surfaces manual retry without a fork loop',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.repository.continueError = StateError('offline');
      h.bootstrap();
      h.send('a');
      h.repository.posts.last.result.completeError(
        const CloudSendError(
          kind: CloudSendErrorKind.terminalSession,
          status: 409,
          message: 'terminal',
        ),
      );
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 20));
      expect(h.repository.continuations.length, 1);
      expect(h.vm.failedSends.keys, ['a']);
      expect(
        h.vm.state!.bootstrapError,
        "Couldn't continue this chat. Try again.",
      );
      h.dispose();
    }),
  );
  test(
    'drops frames at or before accepted checkpoint and never guesses terminal identity',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      h.send('b');
      h.accept();
      h.emit('message.start', {
        'role': 'assistant',
        'sourceKey': 'historical',
      }, id: '9');
      h.emit('message.finish', {'sourceKey': 'historical'}, id: '10');
      expect(h.vm.state!.liveTurn!.turnId, isNull);
      expect(h.vm.state!.cursor, '10');
      h.emit('message.finish', {'sourceKey': 'unbound'}, id: '11');
      expect(h.vm.state!.liveTurn, isNotNull);
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.unknown);
      expect(h.repository.posts.length, 1);
      async.elapse(const Duration(seconds: 2));
      h.bootstrap();
      expect(h.repository.posts.last.id, 'b');
      h.dispose();
    }),
  );
  for (final data in <String>['{}', 'not-json']) {
    test(
      'unkeyed terminal $data requires bootstrap',
      () => fakeAsync((async) {
        final h = Harness(async);
        h.bootstrap(live());
        h.streams.last.add(
          CloudSseFrame(event: 'message.finish', data: data, id: '11'),
        );
        expect(h.vm.state!.liveTurn!.turnId, 'turn');
        expect(h.vm.state!.attachment, CloudAttachmentStatus.stale);
        h.dispose();
      }),
    );
  }
  test(
    'cursorless acceptance and partial bootstrap cannot drain or attach',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      h.send('b');
      h.accept(cursor: null);
      expect(h.streams, isEmpty);
      async.elapse(const Duration(seconds: 2));
      h.bootstrap(live(cursor: null));
      expect(h.streams, isEmpty);
      expect(h.repository.posts.length, 1);
      async.elapse(const Duration(seconds: 2));
      h.bootstrap(live(user: null));
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.unknown);
      expect(h.streams, isEmpty);
      h.dispose();
    }),
  );
  test(
    'deferred bootstrap reconciles user key after acknowledgement',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.send('a');
      unawaited(h.vm.refresh());
      h.accept(cursor: null);
      h.bootstrap(
        CloudChatBootstrap(
          messages: [message('canonical', requestId: 'a')],
          toolActivity: const [],
        ),
      );
      expect(h.vm.state!.outbox, isEmpty);
      expect(h.vm.state!.liveTurn, isNull);
      expect(h.vm.state!.cursor, isNull);
      h.dispose();
    }),
  );
  test(
    'assistant request id does not adopt optimistic user',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.send('a');
      h.bootstrap(
        CloudChatBootstrap(
          messages: [message('assistant', requestId: 'a', role: 'ASSISTANT')],
          toolActivity: const [],
          livenessUnknown: true,
        ),
      );
      expect(h.vm.state!.outbox.single.clientRequestId, 'a');
      expect(h.vm.state!.visibleTranscript.length, 2);
      h.dispose();
    }),
  );
  test(
    'background detaches; foreground reattaches cursor or bootstraps unknown',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.emit('message.delta', {
        'sourceKey': 'turn',
        'textDelta': 'hello',
      }, id: '11');
      h.vm.setForeground(false);
      expect(h.cancellations, 1);
      expect(h.vm.state!.attachment, CloudAttachmentStatus.detached);
      h.vm.setForeground(true);
      expect(h.cursors, ['10', '11']);
      h.vm.setForeground(false);
      async.elapse(const Duration(seconds: 61));
      h.vm.setForeground(true);
      expect(h.repository.bootstraps.length, 2);
      expect(h.cursors.length, 2);
      h.dispose();
    }),
  );
  test(
    'foreground re-bootstrap reconciles an idle detached chat',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap();
      h.vm.setForeground(false);

      h.vm.setForeground(true);
      expect(h.repository.bootstraps.length, 2);
      h.bootstrap(
        CloudChatBootstrap(
          messages: [message('remote', text: 'while backgrounded')],
          toolActivity: const [],
        ),
      );

      expect(h.vm.messages.single.text, 'while backgrounded');
      h.dispose();
    }),
  );
  test(
    'live composite harness id deduplicates its hydrated durable notice',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(
        CloudChatBootstrap(
          messages: const [],
          toolActivity: const [],
          activeTurnId: 'turn',
          activeUserMessageId: 'user',
          activeStreamAfter: '3520',
          harnessWarnings: const [
            {
              'eventId': '3521',
              'occurredAtMs': 100,
              'warningCode': 'code',
              'warningMessage': 'Warning',
            },
          ],
        ),
      );
      h.emit('harness.warning', {
        'warningCode': 'code',
        'warningMessage': 'Warning',
      }, id: 'stream:3521:chat%3Aharness%3Awarning:5');

      expect(h.vm.messages.map((message) => message.messageId), [
        'cloud:chat:harness-warning:3521',
      ]);
      h.dispose();
    }),
  );
  test(
    'late background bootstrap reconciles again before posting on foreground',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.send('a');
      h.vm.setForeground(false);
      h.bootstrap();
      expect(h.repository.posts, isEmpty);
      h.vm.setForeground(true);
      expect(h.repository.bootstraps.length, 2);
      expect(h.repository.posts, isEmpty);
      h.bootstrap();
      expect(h.repository.posts.length, 1);
      h.dispose();
    }),
  );
  test(
    'close/reopen and disposal ignore old bootstrap and post completions',
    () => fakeAsync((async) {
      final h = Harness(async);
      final oldBootstrap = h.repository.bootstraps.single;
      h.vm.close();
      h.vm.open('chat', cursorEpoch: 'old-epoch');
      oldBootstrap.complete(live());
      async.flushMicrotasks();
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.unknown);
      h.bootstrap();
      h.send('a');
      final oldPost = h.repository.posts.last;
      h.vm.close();
      h.vm.open('chat', cursorEpoch: 'new-epoch');
      oldPost.result.complete(accepted('a'));
      async.flushMicrotasks();
      expect(h.vm.state!.transcript, isEmpty);
      final pending = h.repository.bootstraps.last;
      h.dispose();
      pending.complete(idle);
      async.flushMicrotasks();
    }),
  );
  test(
    'bootstrap failures back off and preserve queued sends',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.send('a');
      h.repository.bootstraps.last.completeError(StateError('offline'));
      async.flushMicrotasks();
      expect(h.vm.state!.bootstrapError, "Couldn't load chat history.");
      expect(h.repository.posts, isEmpty);
      async.elapse(const Duration(seconds: 1));
      expect(h.repository.bootstraps.length, 1);
      async.elapse(const Duration(seconds: 1));
      h.bootstrap();
      expect(h.repository.posts.length, 1);
      h.dispose();
    }),
  );
  test(
    'bootstrap keeps monotonic cursor but replaces synthesized assistant rows',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.emit('message.delta', {
        'sourceKey': 'turn',
        'textDelta': 'live',
      }, id: '20');
      unawaited(h.vm.refresh());
      h.bootstrap(
        CloudChatBootstrap(
          messages: [message('durable', role: 'ASSISTANT')],
          toolActivity: const [],
          activeStreamAfter: '5',
        ),
      );
      expect(h.vm.state!.cursor, '20');
      expect(h.vm.state!.transcript.map((m) => m.messageId), ['durable']);
      expect(h.vm.state!.liveTurn, isNull);
      h.dispose();
    }),
  );
  test(
    'interrupt uses exact turn; already-terminal releases FIFO',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.send('a');
      unawaited(h.vm.interrupt());
      async.flushMicrotasks();
      expect(h.repository.interrupts, ['turn']);
      expect(h.vm.state!.canInterrupt, isFalse);
      h.vm.setForeground(false);
      h.vm.setForeground(true);
      h.dispose();
    }),
  );
  test(
    'failed interrupt surfaces the error and reconciles stale session state',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.bootstrap(live());
      h.repository.interruptError = StateError('interrupt failed');

      unawaited(h.vm.interrupt());
      async.flushMicrotasks();

      expect(h.vm.state!.bootstrapError, "Couldn't stop this turn. Try again.");
      expect(h.vm.state!.attachment, CloudAttachmentStatus.stale);
      expect(h.vm.state!.sessionStatus, CloudSessionStatus.unknown);
      async.elapse(const Duration(seconds: 2));
      expect(h.repository.bootstraps, hasLength(2));
      h.dispose();
    }),
  );
  test(
    'queued edit and cancellation preserve order and posting cannot be cancelled',
    () => fakeAsync((async) {
      final h = Harness(async);
      h.send('a');
      h.send('b');
      h.vm.editQueued('a', 'edited');
      h.vm.cancelQueued('b');
      expect(h.vm.state!.visibleTranscript.single.text, 'edited');
      h.bootstrap();
      h.vm.cancelQueued('a');
      expect(h.vm.state!.outbox.single.status, CloudOutboxStatus.posting);
      expect(h.repository.posts.single.text, 'edited');
      h.dispose();
    }),
  );
}
