import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_agent_task.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_fold.dart';
import '../../../../../support/agent_task_fixtures.dart';

CloudAgentTask task({String status = 'running', String version = '3'}) =>
    CloudAgentTask.tryParse(
      agentTaskRow(status: status, stateVersion: version),
    )!;

CloudChatToolActivity tool(
  String id, {
  bool result = false,
  String? sourceKey = agentTaskSourceKey,
  String output = 'ok',
}) => CloudChatToolActivity(
  kind: result ? CloudToolActivityKind.result : CloudToolActivityKind.call,
  rawKind: result ? 'result' : 'call',
  raw: const {},
  sourceKey: sourceKey,
  toolCallId: id,
  toolName: result ? null : 'Read',
  input: result ? null : '{"file_path":"a.ts"}',
  output: result ? output : null,
  isError: result ? false : null,
);

List<String> shape(CloudAgentTaskFold fold) => [
  for (final e in fold.activity(agentTaskId)?.entries ?? <AgentTaskEntry>[])
    switch (e.kind) {
      AgentTaskEntryKind.text => 'text:${e.text}',
      AgentTaskEntryKind.reasoning => 'reasoning:${e.text}',
      AgentTaskEntryKind.tool =>
        'tool:${e.toolCallId}${e.result == null ? '' : '=${e.result!.output}'}',
    },
];

void main() {
  late CloudAgentTaskFold fold;
  setUp(() => fold = CloudAgentTaskFold());

  test('the newest state version wins; an older row adds a missing source', () {
    fold.upsert(task(version: '5'));
    final revision = fold.revision;
    fold.upsert(task(status: 'completed', version: '4'));
    expect(fold.task(agentTaskId)!.status, 'running');
    expect(fold.taskSourceKey(agentTaskId), isNull);
    fold.upsert(task(version: '4'), sourceKey: 'turn-source');
    expect(fold.taskSourceKey(agentTaskId), 'turn-source');
    expect(fold.turnSourceKey('turn-1'), 'turn-source');
    expect(fold.revision, greaterThan(revision));
    fold.upsert(task(status: 'completed', version: '6'));
    expect(fold.task(agentTaskId)!.status, 'completed');
  });

  test('live deltas merge per source and replays are absorbed', () {
    void delta(String text, String id, {bool reasoning = false}) =>
        fold.applyFrame(
          agentTaskId,
          reasoning
              ? CloudMessageReasoning(text, sourceKey: agentTaskSourceKey)
              : CloudMessageDelta(text, sourceKey: agentTaskSourceKey),
          eventId: id,
        );
    delta('Think', 'e0', reasoning: true);
    delta('Hello ', 'e1');
    delta('world', 'e2');
    delta('world', 'e2');
    fold.applyFrame(agentTaskId, CloudToolFrame(tool('t1')));
    fold.applyFrame(agentTaskId, CloudToolFrame(tool('t1', result: true)));
    fold.applyFrame(agentTaskId, CloudToolFrame(tool('t1', result: true)));
    delta('After', 'e3');
    expect(shape(fold), [
      'reasoning:Think',
      'text:Hello world',
      'tool:t1=ok',
      'text:After',
    ]);
  });

  test('a task finish settles the trailing segment to its final text', () {
    fold.applyFrame(
      agentTaskId,
      const CloudMessageDelta('Before', sourceKey: agentTaskSourceKey),
    );
    fold.applyFrame(agentTaskId, CloudToolFrame(tool('t1')));
    fold.applyFrame(
      agentTaskId,
      const CloudMessageDelta('Aft', sourceKey: agentTaskSourceKey),
    );
    fold.applyFrame(
      agentTaskId,
      const CloudMessageFinish(
        sourceKey: agentTaskSourceKey,
        finalText: 'Before\n\nAfter all',
      ),
    );
    expect(shape(fold), ['text:Before', 'tool:t1', 'text:After all']);
  });

  test('durable rows replace live text and place tools by their blocks', () {
    fold.applyFrame(
      agentTaskId,
      const CloudMessageDelta('Look', sourceKey: agentTaskSourceKey),
    );
    fold.applyFrame(agentTaskId, CloudToolFrame(tool('t1')));
    fold.applyFrame(agentTaskId, CloudToolFrame(tool('t1', result: true)));
    const row = AgentTaskMessage(
      id: 'm1',
      taskId: agentTaskId,
      sourceKey: agentTaskSourceKey,
      contentBlocks: [
        {'type': 'text', 'text': 'Looking'},
        {'type': 'tool_call', 'toolCallId': 't1', 'toolName': 'Read'},
        {'type': 'tool_call', 'toolCallId': 't2', 'toolName': 'Grep'},
        {'type': 'text', 'text': 'Found it'},
      ],
    );
    fold.applyMessages(agentTaskId, [row]);
    expect(shape(fold), [
      'text:Looking',
      'tool:t1=ok',
      'tool:t2',
      'text:Found it',
    ]);
    fold.applyMessages(agentTaskId, [row]);
    expect(shape(fold), [
      'text:Looking',
      'tool:t1=ok',
      'tool:t2',
      'text:Found it',
    ]);
  });

  test('history attaches spawn tasks and the tasks own activity', () {
    fold.applyHistory(
      toolActivity: [
        CloudChatToolActivity.fromJson({
          'kind': 'call',
          'call': {
            'toolCallId': 'spawn',
            'toolName': 'Task',
            'sourceKey': 'turn-source',
            'agentTask': agentTaskRow(),
          },
        }),
        CloudChatToolActivity.fromJson({
          'kind': 'call',
          'call': {
            'toolCallId': 'child',
            'toolName': 'Read',
            'sourceKey': agentTaskSourceKey,
            'taskId': agentTaskId,
          },
        }),
      ],
      messages: const [
        AgentTaskMessage(
          id: 'm1',
          taskId: agentTaskId,
          sourceKey: agentTaskSourceKey,
          text: 'Done',
        ),
      ],
    );
    expect(fold.task(agentTaskId), isNotNull);
    expect(fold.taskSourceKey(agentTaskId), 'turn-source');
    expect(shape(fold), ['text:Done', 'tool:child']);
  });

  test('a task keeps its newest entries and counts the dropped ones', () {
    for (var i = 0; i < agentTaskEntryLimit + 5; i++) {
      fold.applyFrame(agentTaskId, CloudToolFrame(tool('t$i')));
    }
    final activity = fold.activity(agentTaskId)!;
    expect(activity.entries, hasLength(agentTaskEntryLimit));
    expect(activity.omitted, 5);
    expect(activity.entries.first.toolCallId, 't5');
    fold.applyFrame(agentTaskId, CloudToolFrame(tool('t0')));
    expect(activity.omitted, 5);
    expect(fold.activity(agentTaskId)!.entries.last.toolCallId, 't204');
  });

  test('a durable tool_call adopts a folded call without a source key', () {
    fold.applyHistory(
      toolActivity: [
        CloudChatToolActivity.fromJson({
          'kind': 'call',
          'call': {
            'toolCallId': 't1',
            'toolName': 'Read',
            'input': '{}',
            'taskId': agentTaskId,
          },
        }),
        CloudChatToolActivity.fromJson({
          'kind': 'result',
          'result': {
            'toolCallId': 't1',
            'output': 'ok',
            'isError': false,
            'taskId': agentTaskId,
          },
        }),
      ],
      messages: const [
        AgentTaskMessage(
          id: 'm1',
          taskId: agentTaskId,
          sourceKey: agentTaskSourceKey,
          turnId: 'turn-1',
          contentBlocks: [
            {'type': 'tool_call', 'toolCallId': 't1', 'toolName': 'Read'},
            {'type': 'text', 'text': 'Done'},
          ],
        ),
      ],
    );
    expect(shape(fold), ['tool:t1=ok', 'text:Done']);
    final tool = fold.activity(agentTaskId)!.entries.first;
    expect(tool.messageId, 'm1');
    expect(tool.turnId, 'turn-1');
    expect(tool.sourceKey, agentTaskSourceKey);
  });
}
