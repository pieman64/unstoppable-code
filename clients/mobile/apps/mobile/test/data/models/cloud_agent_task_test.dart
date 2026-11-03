import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_agent_task.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';
import '../../support/agent_task_fixtures.dart';

void main() {
  test('reads a Core task row and the BFF task DTO', () {
    final core = CloudAgentTask.tryParse(
      agentTaskRow(status: 'failed', error: {'code': 'x', 'message': 'Boom'}),
    )!;
    expect(core.taskId, agentTaskId);
    expect(core.stateVersion, BigInt.from(3));
    expect(core.kind, 'subagent');
    expect(core.harness, 'CLAUDE_CODE');
    expect(core.status, 'failed');
    expect(core.terminal, isTrue);
    expect(core.errorMessage, 'Boom');
    expect(core.modelLabel, 'Claude Sonnet 4.5');
    expect(
      core.startedAtMs,
      DateTime.parse('2026-10-13T10:00:00.500Z').millisecondsSinceEpoch,
    );
    final dto = CloudAgentTask.tryParse({
      ...agentTaskRow(),
      'createdAt': null,
      'createdAtMs': 1000,
      'usage': {'outputTokens': 12, 'inputTokens': -1},
    })!;
    expect(dto.createdAtMs, 1000);
    expect(dto.usage, {'outputTokens': 12});
  });

  test('unknown values degrade and unreadable rows are dropped', () {
    final task = CloudAgentTask.tryParse({
      ...agentTaskRow(),
      'kind': 'future_kind',
      'harness': 'NEW',
      'status': 'sleeping',
      'stopReason': 'robot',
      'parentTaskId': '',
      'model': 'not an object',
    })!;
    expect(task.kind, 'unknown');
    expect(task.harness, 'unknown');
    expect(task.status, 'unknown');
    expect(task.terminal, isFalse);
    expect(task.stopReason, isNull);
    expect(task.parentTaskId, isNull);
    expect(task.modelId, isNull);
    for (final bad in [
      null,
      'task',
      {...agentTaskRow(), 'stateVersion': 3},
      {...agentTaskRow(), 'stateVersion': '-1'},
      {...agentTaskRow(), 'taskId': ''},
    ]) {
      expect(CloudAgentTask.tryParse(bad), isNull);
    }
  });

  test('reads task rows and task-scoped frames from the stream', () {
    final upsert = parseCloudAgentTaskEvent('task.upsert', {
      'agentSessionId': 's',
      'sourceKey': 'turn-source',
      'task': agentTaskRow(),
    });
    expect(upsert, isA<CloudAgentTaskUpsert>());
    expect((upsert as CloudAgentTaskUpsert).sourceKey, 'turn-source');
    expect(upsert.task.taskId, agentTaskId);
    expect(parseCloudAgentTaskEvent('task.upsert', {'task': 'bad'}), isNull);

    final delta = parseCloudAgentTaskEvent('message.delta', {
      'sourceKey': agentTaskSourceKey,
      'taskId': agentTaskId,
      'textDelta': 'Reading',
    });
    expect(delta, isA<CloudAgentTaskActivity>());
    final activity = delta as CloudAgentTaskActivity;
    expect(activity.taskId, agentTaskId);
    expect((activity.frame as CloudMessageDelta).text, 'Reading');
    expect(activity.frame.sourceKey, agentTaskSourceKey);

    final finish = parseCloudAgentTaskEvent('message.finish', {
      'taskId': agentTaskId,
      'sourceKey': agentTaskSourceKey,
      'finalMessage': {'content': 'Done'},
    });
    expect(
      ((finish as CloudAgentTaskActivity).frame as CloudMessageFinish)
          .finalText,
      'Done',
    );
    expect(
      parseCloudAgentTaskEvent('harness.event', {
        'taskId': agentTaskId,
        'kind': 'task_error',
        'errorMessage': 'Boom',
      }),
      isNull,
    );
    expect(
      parseCloudAgentTaskEvent('message.delta', {'textDelta': 'root'}),
      isNull,
    );
    expect(parseCloudAgentTaskEvent('message.delta', 'nope'), isNull);
  });
}
