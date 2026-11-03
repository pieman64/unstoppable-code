import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';

import '../../../../support/conversation_v2_fixtures.dart';
import 'cloud_chat_test_support.dart' show Harness, live;
import 'cloud_conversation_view_model_test.dart' show V2Repository;

CloudCoreMessage _row(String id, String role, int at, {String? request}) =>
    CloudCoreMessage(
      id: id,
      clientRequestId: request,
      role: role,
      text: 'text $id',
      cost: const CloudCoreCost(kind: CloudCoreCostKind.pending),
      costBilledViaLlmProxy: false,
      createdAtMs: at,
      artifacts: const [],
    );

void main() {
  void run(
    FakeAsync async,
    String terminalStatus,
    void Function(List<String> keys) verify, {
    bool interruptBeforeEnd = false,
  }) {
    final keys = <String>[];
    final repository = V2Repository();
    final streams = <StreamController<CloudSseFrame>>[];
    final vm = CloudChatViewModel(
      repository: repository,
      observeLifecycle: false,
      now: () => DateTime(2026).add(async.elapsed),
      onSuccessfulTurn: keys.add,
      openStream: (_, {after}) {
        final s = StreamController<CloudSseFrame>(sync: true);
        streams.add(s);
        return s.stream;
      },
    );
    vm.open('chat', cursorEpoch: 'session-1');
    async.flushMicrotasks();
    repository.snapshots.last.complete(
      ConversationSnapshot.fromJson(v2Snapshot()),
    );
    async.flushMicrotasks();

    void changed(String before, String after, List<Map<String, dynamic>> c) {
      streams.last.add(
        CloudSseFrame(
          event: 'conversation.changed',
          id: 'opaque/$after',
          data: jsonEncode({
            'protocolVersion': 2,
            'sessionId': repository.session,
            'previousStateVersion': before,
            'stateVersion': after,
            'changes': c,
          }),
        ),
      );
      async.flushMicrotasks();
    }

    changed('0', '1', [
      {'type': 'message.upsert', 'message': v2Message(id: 'user-r1')},
      {'type': 'turn.upsert', 'turn': v2Turn(status: 'RUNNING')},
    ]);
    expect(vm.turnInProgress, isTrue);
    if (interruptBeforeEnd) {
      // A transient frame names the execution source, which Stop requires.
      streams.last.add(
        CloudSseFrame(
          event: 'message.start',
          data: jsonEncode({
            'turnId': 'turn-1',
            'userMessageId': 'user-r1',
            'inferenceRunId': 'run-turn-1',
            'sourceKey': 'execution-source',
            'executionGeneration': 1,
            'role': 'ASSISTANT',
          }),
        ),
      );
      async.flushMicrotasks();
      repository.interruptResult = const AgentTurnInterruptResult(
        outcome: AgentTurnInterruptOutcome.interruptRequested,
        rawOutcome: 'interrupt_requested',
        turnId: 'execution-source',
      );
      unawaited(vm.interrupt());
      async.flushMicrotasks();
      expect(repository.interrupts, ['execution-source']);
      expect(vm.state!.liveTurn!.interrupting, isTrue);
    }
    changed('1', '2', [
      {
        'type': 'message.upsert',
        'message': v2Message(
          id: 'assistant-1',
          role: 'ASSISTANT',
          text: 'done',
          seq: 2,
        ),
      },
      {'type': 'turn.upsert', 'turn': v2Turn(status: terminalStatus)},
    ]);
    expect(vm.turnInProgress, isFalse);
    verify(keys);

    vm.dispose();
    for (final s in streams) {
      unawaited(s.close());
    }
    async.flushMicrotasks();
  }

  test('a COMPLETED v2 turn is reported once', () {
    fakeAsync((async) {
      run(async, 'COMPLETED', (keys) {
        expect(keys, ['cloud:chat:user-r1']);
      });
    });
  });

  for (final status in ['FAILED', 'INTERRUPTED', 'CANCELLED']) {
    test('a $status v2 turn is not reported', () {
      fakeAsync((async) {
        run(async, status, (keys) => expect(keys, isEmpty));
      });
    });
  }

  test(
    'a v2 turn that was locally stopped is not reported even if COMPLETED',
    () {
      fakeAsync((async) {
        run(
          async,
          'COMPLETED',
          (keys) => expect(keys, isEmpty),
          interruptBeforeEnd: true,
        );
      });
    },
  );

  group('v1 protocol', () {
    test('a live terminal frame with a clean reply is reported once', () {
      fakeAsync((async) {
        final keys = <String>[];
        final h = Harness(async, onSuccessfulTurn: keys.add);
        h.bootstrap(live());
        h.emit('message.delta', {
          'sourceKey': 'turn',
          'textDelta': 'done',
        }, id: '11');
        h.emit('message.finish', {'sourceKey': 'turn'}, id: '12');
        expect(h.vm.state!.liveTurn, isNull);
        expect(keys, ['cloud:chat:user']);
        // A trailing settle of the same turn must not report again.
        h.emit('message.delta', {
          'sourceKey': 'turn',
          'textDelta': 'late',
        }, id: '13');
        expect(keys, ['cloud:chat:user']);
        h.dispose();
      });
    });

    test('a finish with finishReason interrupted is not reported', () {
      fakeAsync((async) {
        final keys = <String>[];
        final h = Harness(async, onSuccessfulTurn: keys.add);
        h.bootstrap(live());
        h.emit('message.delta', {
          'sourceKey': 'turn',
          'textDelta': 'partial',
        }, id: '11');
        h.emit('message.finish', {
          'sourceKey': 'turn',
          'finishReason': 'interrupted',
        }, id: '12');
        expect(h.vm.state!.liveTurn, isNull);
        expect(keys, isEmpty);
        h.dispose();
      });
    });

    test(
      'an end learned by re-bootstrap after going stale is not reported',
      () {
        fakeAsync((async) {
          final keys = <String>[];
          final h = Harness(async, onSuccessfulTurn: keys.add);
          h.bootstrap(live());
          h.vm.setForeground(false);
          async.elapse(const Duration(seconds: 90));
          h.vm.setForeground(true);
          async.flushMicrotasks();
          // The durable assistant row looks clean: bootstrap rows carry no
          // outcome, so this would be a false positive if it counted.
          h.bootstrap(
            CloudChatBootstrap(
              messages: [
                _row('user', 'USER', 100, request: 'r'),
                _row('a1', 'ASSISTANT', 200),
              ],
              toolActivity: const [],
            ),
          );
          expect(h.vm.state!.liveTurn, isNull);
          expect(h.vm.messages.last.role, ChatRole.assistant);
          expect(keys, isEmpty);
          h.dispose();
        });
      },
    );

    test('a bootstrap renaming the same turn is not an end', () {
      fakeAsync((async) {
        final keys = <String>[];
        final h = Harness(async, onSuccessfulTurn: keys.add);
        h.bootstrap(live());
        // A frame for another source creates an `unknown:` placeholder turn.
        h.emit('message.delta', {
          'sourceKey': 'other',
          'textDelta': 'hi',
        }, id: '11');
        expect(h.vm.state!.liveTurn!.userMessageId, 'unknown:other');
        h.vm.setForeground(true);
        async.flushMicrotasks();
        h.bootstrap(
          CloudChatBootstrap(
            messages: [
              _row('a1', 'ASSISTANT', 200),
              _row('user-2', 'USER', 300, request: 'r2'),
              _row('a2', 'ASSISTANT', 400),
            ],
            toolActivity: const [],
            activeTurnId: 'other',
            activeUserMessageId: 'user-2',
            activeStreamAfter: '11',
          ),
        );
        expect(h.vm.state!.liveTurn!.userMessageId, 'user-2');
        expect(keys, isEmpty);
        h.dispose();
      });
    });
  });
}
