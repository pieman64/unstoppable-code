import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_conversation_session.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';
import '../../../../support/agent_task_fixtures.dart';
import '../../../../support/conversation_v2_fixtures.dart';

ConversationChangedEvent change(
  String previous,
  String next, {
  String session = 'session-1',
  List<Map<String, dynamic>> changes = const [],
}) => ConversationChangedEvent.fromJson({
  'protocolVersion': 2,
  'sessionId': session,
  'previousStateVersion': previous,
  'stateVersion': next,
  'changes': changes,
});
void main() {
  CloudConversationSession ready({
    String version = '10',
    List<Map<String, dynamic>> messages = const [],
    List<Map<String, dynamic>> turns = const [],
  }) => CloudConversationSession(sessionId: 'session-1').snapshot(
    ConversationSnapshot.fromJson(
      v2Snapshot(version: version, messages: messages, turns: turns),
    ),
  );
  test(
    'requires contiguous versions and ignores duplicate/foreign changes',
    () {
      final s = ready();
      expect(identical(s.changed(change('9', '10')), s), isTrue);
      expect(
        identical(s.changed(change('10', '11', session: 'other')), s),
        isTrue,
      );
      expect(s.changed(change('10', '11')).version, '11');
      final gap = s.changed(change('11', '12'));
      expect(gap.recovering, isTrue);
      expect(gap.version, '10');
      expect(
        gap
            .snapshot(ConversationSnapshot.fromJson(v2Snapshot(version: '12')))
            .recovering,
        isFalse,
      );
    },
  );
  test(
    'receipts reconcile identity without skipping canonical stream changes',
    () {
      final s = ready(version: '0');
      final receipt = ConversationAcceptedTurn.fromJson(
        v2Accepted('r1', 'hello'),
      );
      final next = s.accepted(receipt, 'r1');
      expect(next.version, '0');
      expect(next.acceptedIds, contains('r1'));
      expect(() => s.accepted(receipt, 'other'), throwsFormatException);
      final settled = next.changed(
        change(
          '0',
          '2',
          changes: [
            {'type': 'turn.upsert', 'turn': v2Turn(status: 'COMPLETED')},
          ],
        ),
      );
      expect(settled.accepted(receipt, 'r1').turns.single.status, 'COMPLETED');
    },
  );
  test(
    'pinned history cannot overwrite current rows or advance live version',
    () {
      final s = ready(
        messages: [v2Message(text: 'edited')],
        turns: [v2Turn(status: 'CANCELLED')],
      );
      final page = ConversationHistoryPage.fromJson({
        ...v2Snapshot(
          messages: [v2Message(text: 'old')],
          turns: [v2Turn()],
        ),
        '@type': 'agent_conversation_history_page',
        'snapshotStateVersion': '9',
        'messageWatermark': '1',
      });
      final next = s.history(page);
      expect(next.version, '10');
      expect(next.messages.single.text, 'edited');
      expect(next.turns.single.status, 'CANCELLED');
    },
  );
  test('same-version snapshot keeps the advanced history cursor', () {
    final initial = ready();
    final page = ConversationHistoryPage.fromJson({
      ...v2Snapshot(version: '10', history: 'next-page'),
      '@type': 'agent_conversation_history_page',
      'snapshotStateVersion': '10',
      'messageWatermark': '1',
    });
    final advanced = initial.history(page);
    expect(advanced.historyCursor, 'next-page');
    final sameVersion = advanced.snapshot(
      ConversationSnapshot.fromJson(v2Snapshot(version: '10')),
    );
    expect(sameVersion.historyCursor, 'next-page');
    expect(sameVersion.hasMoreHistory, isTrue);
    final finalPage = ConversationHistoryPage.fromJson({
      ...v2Snapshot(version: '10'),
      '@type': 'agent_conversation_history_page',
      'snapshotStateVersion': '10',
      'messageWatermark': '1',
    });
    final exhausted = sameVersion.history(finalPage);
    expect(exhausted.historyCursor, isNull);
    expect(exhausted.hasMoreHistory, isFalse);
    final newer = sameVersion.snapshot(
      ConversationSnapshot.fromJson(v2Snapshot(version: '11')),
    );
    expect(newer.historyCursor, isNull);
    expect(newer.hasMoreHistory, isFalse);
  });
  test(
    'resnapshot prunes omitted recent and pending rows but retains older history',
    () {
      final s = ready(
        messages: [
          v2Message(id: 'old', seq: 1, turnId: 'old'),
          v2Message(id: 'pending', seq: 2),
        ],
        turns: [
          v2Turn(id: 'old', order: '1', status: 'COMPLETED'),
          v2Turn(order: '2'),
        ],
      );
      final next = s.snapshot(
        ConversationSnapshot.fromJson(
          v2Snapshot(
            version: '11',
            messages: [v2Message(id: 'new', seq: 3, turnId: 'new')],
            turns: [v2Turn(id: 'new', order: '3')],
          ),
        ),
      );
      expect(next.messages.map((m) => m.id), ['old', 'new']);
      expect(next.turns.map((t) => t.turnId), ['old', 'new']);
    },
  );
  test('full execution identity is required for transient frames and stop', () {
    final turn = ConversationTurn.fromJson(v2Turn(status: 'RUNNING'));
    final frame = {
      'turnId': 'turn-1',
      'userMessageId': 'user-r1',
      'inferenceRunId': 'run-turn-1',
      'sourceKey': 'execution-source',
      'executionGeneration': 1,
    };
    expect(ConversationExecution.parse(frame)!.belongsTo(turn), isTrue);
    expect(
      ConversationExecution.parse({
        ...frame,
        'inferenceRunId': 'old',
      })!.belongsTo(turn),
      isFalse,
    );
    expect(
      ConversationExecution.parse({...frame, 'executionGeneration': 0}),
      isNull,
    );
  });
  test('v2 transcript follows sequence when timestamps disagree', () {
    final s = ready(
      messages: [
        {
          ...v2Message(id: 'first', seq: 1),
          'createdAt': '2026-09-23T11:00:00Z',
        },
        {
          ...v2Message(id: 'second', seq: 2),
          'createdAt': '2026-09-23T09:00:00Z',
        },
      ],
    );
    final mapper = CloudTranscriptMapper(chatId: 'chat-1');
    final rows = mapper.hydrate(
      conversationBootstrap(s),
      preserveSequenceOrder: true,
    );
    expect(rows.map((row) => row.messageId), ['first', 'second']);
  });
  test('v2 artifact payload becomes a transcript attachment', () {
    final s = ready(
      messages: [
        {
          ...v2Message(id: 'assistant', role: 'ASSISTANT'),
          'artifacts': [
            {
              'id': 'artifact-1',
              'toolCallId': 'tool-1',
              'toolName': 'write_file',
              'artifactIndex': 0,
              'kind': 'file',
              'label': 'notes.md',
              'storageKind': 'inline',
              'sizeBytes': '4',
              'createdAt': '2026-09-23T10:00:00Z',
              'payload': {'filename': 'notes.md', 'content': 'body'},
            },
          ],
        },
      ],
    );
    final bootstrap = conversationBootstrap(s);
    expect(bootstrap.messages.single.artifacts.single.fileName, 'notes.md');
    expect(bootstrap.messages.single.artifacts.single.fileContent, 'body');
    final rows = CloudTranscriptMapper(chatId: 'chat-1').hydrate(bootstrap);
    expect(rows.single.parts.single.data?['text'], 'notes.md\n\nbody');
  });

  test('v2 user watcher messages map to the watcher title (CAN-4432)', () {
    const envelope =
        '<system_instruction>\n<canopy_watcher_event>\n'
        '{"label": "Chat completion: Notes"}\n</canopy_watcher_event>\n'
        '</system_instruction>\n\nCanopy watcher fired.\n'
        'Chat completion: Notes';
    final s = ready(
      messages: [v2Message(id: 'watcher', seq: 1, text: envelope)],
    );
    final row = CloudTranscriptMapper(
      chatId: 'chat-1',
    ).hydrate(conversationBootstrap(s), preserveSequenceOrder: true).single;
    expect(row.text, 'Canopy watcher fired.\nChat completion: Notes');
    expect(row.watcherFired?.kind, 'Chat completion: Notes');
  });

  test('agent task replies stay out of the root transcript (CAN-5208)', () {
    final s = ready(
      messages: [
        v2Message(id: 'user', seq: 1),
        {
          ...v2Message(id: 'root', role: 'ASSISTANT', seq: 2, text: 'Root'),
          'sourceKey': 'turn-source',
          'contentBlocks': [
            {'type': 'tool_call', 'toolCallId': 'spawn', 'toolName': 'Task'},
            {'type': 'text', 'text': 'Root'},
          ],
        },
        {
          ...v2Message(id: 'child', role: 'ASSISTANT', seq: 3, text: 'Child'),
          'source': 'agent_task',
          'sourceKey': agentTaskSourceKey,
          'taskId': agentTaskId,
          'contentBlocks': [
            {
              'type': 'tool_call',
              'toolCallId': 'child-tool',
              'toolName': 'Read',
            },
            {'type': 'text', 'text': 'Child'},
          ],
        },
      ],
    );
    final next = s.changed(
      change(
        '10',
        '11',
        changes: [
          {'type': 'task.upsert', 'task': agentTaskRow(status: 'completed')},
          {
            'type': 'message.upsert',
            'message': {
              ...v2Message(id: 'child-2', role: 'ASSISTANT', seq: 4),
              'taskId': agentTaskId,
              'sourceKey': agentTaskSourceKey,
            },
          },
        ],
      ),
    );
    expect(next.recovering, isFalse);
    expect(next.version, '11');
    final bootstrap = conversationBootstrap(next);
    expect(bootstrap.messages.map((m) => m.id), ['user', 'root']);
    expect(bootstrap.toolActivity.map((a) => a.toolCallId), ['spawn']);
    final rows = CloudTranscriptMapper(
      chatId: 'chat-1',
    ).hydrate(bootstrap, preserveSequenceOrder: true);
    expect(rows.map((row) => row.text), ['hello agent', '', 'Root']);
    expect(
      rows.expand((row) => row.parts).map((p) => p.toolUseId),
      isNot(contains('child-tool')),
    );
  });
}
