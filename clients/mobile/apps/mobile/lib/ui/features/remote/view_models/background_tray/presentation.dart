import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';
import 'items.dart';

String? backgroundTrayTaskDetail(BackgroundTrayTask task) {
  final detail = task.process.lastDescription ?? task.process.summary;
  return detail == task.title ? null : detail;
}

String? backgroundTrayAgentActivity(BackgroundTrayAgent agent) {
  final activity = agent.activity;
  if (activity != null && activity.isNotEmpty && activity != agent.title) {
    return activity;
  }
  return agent.steps.isEmpty ? null : backgroundTrayStepLabel(agent.steps.last);
}

String backgroundTrayStepLabel(BackgroundTrayAgentStep step) {
  final label = toolCallLabel(
    ChatPart(
      kind: 'tool_use',
      toolFamily:
          step.toolFamily ??
          switch (step.toolName) {
            'Read' => 'read',
            'Edit' => 'edit',
            'Write' => 'write',
            'Bash' || 'PowerShell' || 'command' => 'bash',
            'Grep' => 'grep',
            'Glob' => 'glob',
            'WebSearch' || 'WebFetch' => 'web',
            _ => null,
          },
      data: {'toolName': step.toolName, 'input': step.input},
    ),
  );
  return [label.title, ?label.detail].join(' ');
}
