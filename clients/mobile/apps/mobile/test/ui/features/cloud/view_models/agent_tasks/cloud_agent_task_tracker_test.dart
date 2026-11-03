import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_fold.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_tracker.dart';
import '../../../../../support/agent_task_fixtures.dart';
import '../../../../../support/conversation_v2_fixtures.dart';

void main() {
  test('a v2 task reply keeps its persisted reasoning object (CAN-5208)', () {
    final tracker = CloudAgentTaskTracker();
    ConversationMessage reply(String id, Object? thinking) =>
        ConversationMessage.fromJson({
          ...v2Message(id: id, role: 'ASSISTANT', text: 'Answer'),
          'taskId': id,
          'sourceKey': agentTaskSourceKey,
          'thinking': thinking,
        });
    tracker.conversationMessages([
      reply('t1', {
        'reasoningTextAvailable': true,
        'reasoningText': 'Check the index first.',
      }),
      reply('t2', {
        'reasoningTextAvailable': false,
        'reasoningText': 'Hidden.',
      }),
      reply('t3', {'reasoningTextAvailable': true, 'reasoningText': ''}),
    ]);
    List<String> shape(String taskId) => [
      for (final e in tracker.fold.activity(taskId)!.entries)
        '${e.kind.name}:${e.text}',
    ];
    expect(shape('t1'), ['reasoning:Check the index first.', 'text:Answer']);
    expect(shape('t2'), ['text:Answer']);
    expect(shape('t3'), ['text:Answer']);
    expect(
      tracker.fold.activity('t1')!.entries.first.kind,
      AgentTaskEntryKind.reasoning,
    );
  });
}
