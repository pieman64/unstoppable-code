import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import '../../support/agent_task_fixtures.dart';
import '../../support/conversation_v2_fixtures.dart';

void main() {
  test('projects only text from mixed structured content', () {
    expect(
      conversationContentText([
        'hello ',
        {'type': 'text', 'text': 'world'},
        {'type': 'image', 'url': 'https://example.com/image.png'},
        {'type': 'image', 'payload': 'encoded-image'},
      ]),
      'hello world',
    );
  });
  test('preserves large decimal versions and opaque tokens', () {
    final snapshot = ConversationSnapshot.fromJson(
      v2Snapshot(
        version: '900719925474099312345',
        history: 'opaque.history/+=',
        turns: [v2Turn(order: '900719925474099312345')],
      ),
    );
    expect(snapshot.stateVersion, '900719925474099312345');
    expect(snapshot.turns.single.queueOrder, '900719925474099312345');
    expect(snapshot.streamResume, 'opaque:resume/900719925474099312345+==');
    expect(snapshot.historyCursor, 'opaque.history/+=');
  });
  test('discovery accepts explicit v1/v2 and old omitted v1 only', () {
    for (final version in [1, 2]) {
      expect(
        ConversationDiscoveryMetadata.fromJson({
          'sessionId': 's',
          'protocolVersion': version,
        }).protocolVersion,
        version,
      );
    }
    expect(
      ConversationDiscoveryMetadata.fromJson({
        'sessionId': 's',
      }).protocolVersion,
      1,
    );
    for (final version in [0, 3, '2', null]) {
      expect(
        () => ConversationDiscoveryMetadata.fromJson({
          'sessionId': 's',
          'protocolVersion': version,
        }),
        throwsFormatException,
      );
    }
  });
  test('rejects malformed successful envelopes and missing content', () {
    for (final patch in [
      {'stateVersion': 42},
      {'stateVersion': '-1'},
      {'sessionStatus': 'READY'},
      {
        'turns': [v2Turn()..['turnId'] = ''],
      },
      {
        'messages': [v2Message()..remove('content')],
      },
      {
        'messages': [v2Message()..['seq'] = -1],
      },
      {'pendingTurnCount': 1.5},
      {'historyCursor': 123},
    ]) {
      expect(
        () => ConversationSnapshot.fromJson({...v2Snapshot(), ...patch}),
        throwsFormatException,
      );
    }
    expect(
      () => ConversationAcceptedTurn.fromJson({
        ...v2Accepted('r1', 'hello'),
        'replayed': 'false',
      }),
      throwsFormatException,
    );
  });
  test('history has an independent pinned version and watermark', () {
    final page = ConversationHistoryPage.fromJson({
      ...v2Snapshot(),
      '@type': 'agent_conversation_history_page',
      'snapshotStateVersion': '100',
      'messageWatermark': '99999999999999999999',
    });
    expect(page.snapshotStateVersion, '100');
    expect(page.messageWatermark, '99999999999999999999');
  });
  test('stream parser is total for malformed and unknown frames', () {
    for (final value in [
      null,
      3,
      [],
      {},
      {'stateVersion': 'x'},
      v2Snapshot(),
    ]) {
      expect(
        parseConversationWireFrame('conversation.changed', value),
        isA<ConversationMalformedFrame>(),
      );
    }
    expect(
      parseConversationWireFrame('future.event', null),
      isA<ConversationOtherFrame>(),
    );
    expect(
      parseConversationWireFrame('conversation.recovery_required', {
        '@type': 'agent_conversation_recovery_required',
        'protocolVersion': 2,
        'sessionId': 's',
        'reason': 'EPOCH_MISMATCH',
        'action': 'RESNAPSHOT',
        'preserveOutbox': true,
        'safeBoundary': {
          'kind': 'SNAPSHOT',
          'endpoint': '/untrusted-not-followed',
        },
      }),
      isA<ConversationRecoveryFrame>(),
    );
  });
  test('changed events skip agent task and unknown changes (CAN-5208)', () {
    final value = {
      'protocolVersion': 2,
      'sessionId': 'session-1',
      'previousStateVersion': '18',
      'stateVersion': '19',
      'changes': [
        {'type': 'task.upsert', 'task': agentTaskRow()},
        {'type': 'task.upsert', 'task': 'not a task'},
        {'type': 'future.change', 'detail': 42},
        {
          'type': 'message.upsert',
          'message': v2Message(id: 'a1', role: 'ASSISTANT', text: 'Done'),
        },
        {'type': 'turn.upsert', 'turn': v2Turn(status: 'RUNNING')},
      ],
    };
    final frame = parseConversationWireFrame('conversation.changed', value);
    expect(frame, isA<ConversationChangedFrame>());
    final event = (frame as ConversationChangedFrame).value;
    expect(event.stateVersion, '19');
    expect(event.messages.single.id, 'a1');
    expect(event.turns.single.status, 'RUNNING');
  });
  test('agent task message rows parse and name their task (CAN-5208)', () {
    final root = ConversationMessage.fromJson(
      v2Message(id: 'root', role: 'ASSISTANT'),
    );
    final child = ConversationMessage.fromJson({
      ...v2Message(id: 'child', role: 'ASSISTANT', text: 'Child reply'),
      'source': 'agent_task',
      'sourceKey': agentTaskSourceKey,
      'taskId': agentTaskId,
      'contentBlocks': [
        {'type': 'text', 'text': 'Child reply'},
        {'type': 'tool_call', 'toolCallId': 'child-tool', 'toolName': 'Read'},
      ],
    });
    expect(root.taskId, isNull);
    expect(child.taskId, agentTaskId);
    final snapshot = ConversationSnapshot.fromJson({
      ...v2Snapshot(messages: [v2Message(), child.json]),
      'tasks': [agentTaskRow(), 'unreadable'],
      'taskStreamResume': {agentTaskId: 'opaque'},
      'taskMessagesTruncated': true,
    });
    expect(snapshot.messages.map((m) => m.taskId), [null, agentTaskId]);
  });
  test('send and command inputs preserve idempotency and explicit reset', () {
    expect(
      const ConversationSendInput(
        clientRequestId: 'id',
        content: 'hello',
        retryUncertain: true,
        modelDefinitionId: 'model',
        resetThinkingEffort: true,
        fastMode: false,
      ).toJson(),
      {
        'clientRequestId': 'id',
        'content': 'hello',
        'retryUncertain': true,
        'modelDefinitionId': 'model',
        'thinkingEffort': null,
        'fastMode': false,
      },
    );
    expect(
      const ConversationCommandInput(
        commandId: 'command',
        expectedStateVersion: '900719925474099312345',
        content: 'edit',
      ).toJson()['expectedStateVersion'],
      '900719925474099312345',
    );
  });
}
