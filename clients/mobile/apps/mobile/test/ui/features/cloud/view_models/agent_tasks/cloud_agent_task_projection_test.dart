import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_agent_task.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_fold.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_projection.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';
import '../../../../../support/agent_task_fixtures.dart';

CloudTranscriptMessage row(List<ChatPart> parts, {String? sourceKey}) =>
    CloudTranscriptMessage(
      messageId: 'row',
      chatId: 'chat',
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: '',
      parts: parts,
      sourceKey: sourceKey,
    );

ChatPart spawn(
  String id, {
  String name = 'Task',
  Map<String, Object?> input = const {
    'subagent_type': 'Explore',
    'description': 'Map the library',
    'prompt': 'List the exports',
  },
  String? result,
}) => ChatPart(
  kind: 'tool_use',
  toolFamily: 'agent',
  data: {
    'toolUseId': id,
    'toolName': name,
    'input': jsonEncode(input),
    if (result != null)
      'result': {'toolUseId': id, 'output': result, 'isError': false},
  },
);

CloudAgentTask task({
  String taskId = agentTaskId,
  String? parentTaskId,
  String spawnToolCallId = 'spawn',
  String kind = 'subagent',
  String harness = 'CLAUDE_CODE',
  String status = 'running',
  String? summary,
  Map<String, dynamic>? error,
  bool background = false,
  String createdAt = '2026-10-13T10:00:00.000Z',
}) => CloudAgentTask.tryParse({
  ...agentTaskRow(
    taskId: taskId,
    parentTaskId: parentTaskId,
    spawnToolCallId: spawnToolCallId,
    kind: kind,
    harness: harness,
    status: status,
    summary: summary,
    error: error,
    completedAt: status == 'running' ? null : '2026-10-13T10:00:30.500Z',
  ),
  'background': background,
  'createdAt': createdAt,
})!;

Map<String, dynamic> cardOf(List<CloudTranscriptMessage> rows) =>
    rows.single.parts.single.data!;

void main() {
  late CloudAgentTaskFold fold;
  setUp(() => fold = CloudAgentTaskFold());

  test('rows without known tasks stay identical', () {
    final rows = [
      row([spawn('spawn')], sourceKey: 'turn-source'),
    ];
    expect(identical(projectAgentTaskCards(rows, fold), rows), isTrue);
    fold.upsert(task(spawnToolCallId: 'other'), sourceKey: 'turn-source');
    expect(identical(projectAgentTaskCards(rows, fold), rows), isTrue);
  });

  test('a running subagent replaces its spawn row with a live card', () {
    fold.upsert(task(), sourceKey: 'turn-source');
    fold.applyFrame(
      agentTaskId,
      const CloudMessageReasoning('Plan', sourceKey: agentTaskSourceKey),
    );
    fold.applyFrame(
      agentTaskId,
      CloudToolFrame(
        CloudChatToolActivity(
          kind: CloudToolActivityKind.call,
          rawKind: 'call',
          raw: const {},
          sourceKey: agentTaskSourceKey,
          toolCallId: 'child',
          toolName: 'Read',
          input: '{"file_path":"lib/a.ts"}',
        ),
      ),
    );
    fold.applyFrame(
      agentTaskId,
      const CloudMessageDelta('Reading a.ts', sourceKey: agentTaskSourceKey),
    );
    final card = cardOf(
      projectAgentTaskCards([
        row([spawn('spawn')], sourceKey: 'turn-source'),
      ], fold),
    );
    expect(card['provider'], 'claude');
    expect(card['subagentType'], 'Explore');
    expect(card['description'], 'Map the library');
    expect(card['prompt'], 'List the exports');
    expect(card['isRunning'], isTrue);
    expect(card.containsKey('isError'), isFalse);
    expect(card['taskId'], agentTaskId);
    expect(card['taskStatus'], 'running');
    expect(card['modelLabel'], 'Claude Sonnet 4.5');
    final subBlocks = [
      for (final raw in card['subBlocks'] as List)
        ChatPart.fromJson(raw as Map<String, dynamic>),
    ];
    expect(subBlocks.map((p) => p.kind), ['thinking', 'tool_use', 'text']);
    expect(subBlocks[1].toolFamily, 'read');
    expect(subBlocks[2].data?['text'], 'Reading a.ts');
    expect((card['usage'] as Map)['toolUses'], 1);
  });

  test('a settled card shows the spawn result, summary or error', () {
    fold.upsert(task(status: 'completed'), sourceKey: 'turn-source');
    var card = cardOf(
      projectAgentTaskCards([
        row([spawn('spawn', result: 'Final answer')], sourceKey: 'turn-source'),
      ], fold),
    );
    expect(card['result'], 'Final answer');
    expect(card.containsKey('isRunning'), isFalse);
    expect((card['usage'] as Map)['durationMs'], 30000);

    fold.upsert(
      CloudAgentTask.tryParse({
        ...agentTaskRow(
          spawnToolCallId: 'spawn',
          status: 'completed',
          stateVersion: '4',
        ),
        'background': true,
        'summary': 'Background summary',
      })!,
    );
    card = cardOf(
      projectAgentTaskCards([
        row([spawn('spawn', result: 'Started')], sourceKey: 'turn-source'),
      ], fold),
    );
    expect(card['result'], 'Background summary');
    expect(card['runInBackground'], isTrue);

    fold.upsert(
      CloudAgentTask.tryParse(
        agentTaskRow(
          spawnToolCallId: 'spawn',
          status: 'failed',
          stateVersion: '5',
          summary: null,
          error: {'code': 'x', 'message': 'Child failed'},
        ),
      )!,
    );
    card = cardOf(
      projectAgentTaskCards([
        row([spawn('spawn')], sourceKey: 'turn-source'),
      ], fold),
    );
    expect(card['result'], 'Child failed');
    expect(card['isError'], isTrue);
    expect(card['taskErrorMessage'], 'Child failed');
  });

  test('the spawn turn matches through a turn id learned from the stream', () {
    fold.upsert(task());
    final rows = [
      row([spawn('spawn')], sourceKey: 'turn-source'),
    ];
    expect(identical(projectAgentTaskCards(rows, fold), rows), isTrue);
    fold.turnIdentity('turn-1', 'turn-source');
    expect(cardOf(projectAgentTaskCards(rows, fold))['taskId'], agentTaskId);
    expect(
      projectAgentTaskCards([
        row([spawn('spawn')], sourceKey: 'other-turn'),
      ], fold).single.parts.single.kind,
      'tool_use',
    );
  });

  test('a nested subagent renders inside its parent card', () {
    fold.upsert(task(), sourceKey: 'turn-source');
    fold.upsert(
      task(
        taskId: 'child-task',
        parentTaskId: agentTaskId,
        spawnToolCallId: 'nested-spawn',
        status: 'completed',
        summary: 'Nested done',
      ),
    );
    fold.applyFrame(
      agentTaskId,
      CloudToolFrame(
        CloudChatToolActivity(
          kind: CloudToolActivityKind.call,
          rawKind: 'call',
          raw: const {},
          sourceKey: agentTaskSourceKey,
          toolCallId: 'nested-spawn',
          toolName: 'Task',
          input: jsonEncode({'subagent_type': 'Reviewer', 'prompt': 'Check'}),
        ),
      ),
    );
    fold.applyFrame(
      'child-task',
      const CloudMessageDelta('Nested reply', sourceKey: 'turn-source:task:c'),
    );
    final card = cardOf(
      projectAgentTaskCards([
        row([spawn('spawn')], sourceKey: 'turn-source'),
      ], fold),
    );
    final nested = ChatPart.fromJson(
      (card['subBlocks'] as List).single as Map<String, dynamic>,
    );
    expect(nested.kind, 'agent');
    expect(nested.data?['subagentType'], 'Reviewer');
    expect(nested.data?['taskId'], 'child-task');
    expect(nested.data?['result'], 'Nested done');
    expect(((nested.data?['subBlocks'] as List).single as Map)['data'], {
      'text': 'Nested reply',
    });
  });

  test('background shells keep their tool row', () {
    fold.upsert(task(kind: 'background_shell'), sourceKey: 'turn-source');
    final rows = [
      row([spawn('spawn', name: 'Bash')], sourceKey: 'turn-source'),
    ];
    expect(identical(projectAgentTaskCards(rows, fold), rows), isTrue);
  });

  test('each receiver of one Codex spawn gets its own card', () {
    fold.upsert(
      task(taskId: 'a', harness: 'CODEX', createdAt: '2026-10-13T10:00:02Z'),
      sourceKey: 'turn-source',
    );
    fold.upsert(
      task(taskId: 'b', harness: 'CODEX', createdAt: '2026-10-13T10:00:01Z'),
      sourceKey: 'turn-source',
    );
    final parts = projectAgentTaskCards([
      row([
        spawn('spawn', name: 'spawnAgent', input: {'message': 'Do it'}),
      ], sourceKey: 'turn-source'),
    ], fold).single.parts;
    expect(parts.map((p) => p.data?['taskId']), ['b', 'a']);
    expect(parts.first.data?['provider'], 'codex');
    expect(parts.first.data?['prompt'], 'Do it');
    expect(parts.first.data?['model'], 'Claude Sonnet 4.5');
  });

  test('cards past the depth bound count their activity as omitted', () {
    String id(int depth) => depth == 0 ? agentTaskId : 'task-$depth';
    fold.upsert(task(), sourceKey: 'turn-source');
    for (var depth = 1; depth <= agentTaskMaxDepth; depth++) {
      fold.upsert(
        task(
          taskId: id(depth),
          parentTaskId: id(depth - 1),
          spawnToolCallId: 'spawn-$depth',
        ),
      );
      fold.applyFrame(
        id(depth - 1),
        CloudToolFrame(
          CloudChatToolActivity(
            kind: CloudToolActivityKind.call,
            rawKind: 'call',
            raw: const {},
            toolCallId: 'spawn-$depth',
            toolName: 'Task',
            input: '{}',
          ),
        ),
      );
    }
    fold.applyFrame(id(agentTaskMaxDepth), const CloudMessageDelta('Too deep'));
    var card = cardOf(
      projectAgentTaskCards([
        row([spawn('spawn')], sourceKey: 'turn-source'),
      ], fold),
    );
    for (var depth = 1; depth < agentTaskMaxDepth; depth++) {
      card =
          ((card['subBlocks'] as List).single as Map)['data']
              as Map<String, dynamic>;
    }
    expect(card['taskId'], id(agentTaskMaxDepth - 1));
    final deepest =
        ((card['subBlocks'] as List).single as Map)['data']
            as Map<String, dynamic>;
    expect(deepest['taskId'], id(agentTaskMaxDepth));
    expect(deepest['subBlocks'], isEmpty);
    expect(deepest['omittedSubBlocks'], 1);
  });
}
