/// Core agent task rows (subagents and background shells). Mirrors the web
/// boundary in `apps/web/src/lib/cloud/core-wire.ts` (`parseCoreAgentTask`
/// and `parseCloudAgentTaskDto`): unknown enum values read as `unknown`, and
/// a row that cannot be read is dropped instead of failing its envelope.
library;

import 'package:mobile/data/models/cloud_wire_frame.dart';

/// Deepest nesting the cards follow (`AGENT_TASK_MAX_DEPTH`).
const agentTaskMaxDepth = 8;
const _promptMaxChars = 4000;
const _summaryMaxChars = 4000;

const _kinds = {'subagent', 'background_shell'};
const _harnesses = {'CLAUDE_CODE', 'CODEX', 'TOOL_LOOP'};
const _statuses = {
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
};
const _terminalStatuses = {
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
};
const _stopReasons = {'user', 'parent'};

/// Tools that spawn an agent task. Exact, case-sensitive names.
const agentSpawnToolNames = {'Agent', 'Task', 'spawnAgent', 'spawn_agent'};

final class CloudAgentTask {
  const CloudAgentTask({
    required this.taskId,
    required this.stateVersion,
    this.parentTaskId,
    this.spawnTurnId,
    this.spawnToolCallId,
    this.kind = 'unknown',
    this.harness = 'unknown',
    this.status = 'unknown',
    this.stopReason,
    this.title,
    this.description,
    this.prompt,
    this.subagentType,
    this.modelId,
    this.modelLabel,
    this.thinkingEffort,
    this.approvalPending = false,
    this.background = false,
    this.usage,
    this.costUsd,
    this.summary,
    this.errorMessage,
    this.createdAtMs,
    this.startedAtMs,
    this.completedAtMs,
  });

  final String taskId;
  final BigInt stateVersion;
  final String? parentTaskId, spawnTurnId, spawnToolCallId;
  final String kind, harness, status;
  final String? stopReason;
  final String? title, description, prompt, subagentType;
  final String? modelId, modelLabel, thinkingEffort;
  final bool approvalPending, background;
  final Map<String, num>? usage;
  final String? costUsd, summary, errorMessage;
  final int? createdAtMs, startedAtMs, completedAtMs;

  bool get terminal => _terminalStatuses.contains(status);

  /// Reads a Core task row or the web BFF's task DTO; null when unreadable.
  static CloudAgentTask? tryParse(Object? value) {
    if (value is! Map) return null;
    final taskId = _text(value['taskId']);
    final version = value['stateVersion'];
    if (taskId == null ||
        version is! String ||
        !RegExp(r'^\d+$').hasMatch(version)) {
      return null;
    }
    final model = value['model'];
    final error = value['error'];
    final prompt = _text(value['prompt']);
    final summary = _text(value['summary']);
    final cost = value['costUsd'];
    return CloudAgentTask(
      taskId: taskId,
      stateVersion: BigInt.parse(version),
      parentTaskId: _text(value['parentTaskId']),
      spawnTurnId: _text(value['spawnTurnId']),
      spawnToolCallId: _text(value['spawnToolCallId']),
      kind: _oneOf(_kinds, value['kind']),
      harness: _oneOf(_harnesses, value['harness']),
      status: _oneOf(_statuses, value['status']),
      stopReason: _stopReasons.contains(value['stopReason'])
          ? value['stopReason'] as String
          : null,
      title: _text(value['title']),
      description: _text(value['description']),
      prompt: prompt == null || prompt.length <= _promptMaxChars
          ? prompt
          : prompt.substring(0, _promptMaxChars),
      subagentType: _text(value['subagentType']),
      modelId: model is Map ? _text(model['id']) : null,
      modelLabel: model is Map ? _text(model['label']) : null,
      thinkingEffort: _text(value['thinkingEffort']),
      approvalPending: value['approvalPending'] == true,
      background: value['background'] == true,
      usage: _usage(value['usage']),
      costUsd: cost is String && RegExp(r'^\d+(\.\d+)?$').hasMatch(cost)
          ? cost
          : null,
      summary: summary == null || summary.length <= _summaryMaxChars
          ? summary
          : summary.substring(0, _summaryMaxChars),
      errorMessage: error is Map ? _text(error['message']) : null,
      createdAtMs: _epochMs(value['createdAtMs'] ?? value['createdAt']),
      startedAtMs: _epochMs(value['startedAtMs'] ?? value['startedAt']),
      completedAtMs: _epochMs(value['completedAtMs'] ?? value['completedAt']),
    );
  }
}

String? _text(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

String _oneOf(Set<String> values, Object? value) =>
    values.contains(value) ? value as String : 'unknown';

int? _epochMs(Object? value) {
  if (value is num && value.isFinite) return value.toInt();
  if (value is String) return DateTime.tryParse(value)?.millisecondsSinceEpoch;
  return null;
}

Map<String, num>? _usage(Object? value) {
  if (value is! Map) return null;
  final usage = <String, num>{};
  for (final key in [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'contextTokens',
    'contextWindow',
  ]) {
    final n = value[key];
    if (n is num && n.isFinite && n >= 0) usage[key] = n;
  }
  return usage.isEmpty ? null : Map.unmodifiable(usage);
}

/// Agent task data carried on a stream frame: a task row, or one frame of a
/// task's own activity.
sealed class CloudAgentTaskEvent {
  const CloudAgentTaskEvent();
}

final class CloudAgentTaskUpsert extends CloudAgentTaskEvent {
  const CloudAgentTaskUpsert(this.task, {this.sourceKey});
  final CloudAgentTask task;

  /// The spawning turn's stream key, when the frame names it.
  final String? sourceKey;
}

final class CloudAgentTaskActivity extends CloudAgentTaskEvent {
  const CloudAgentTaskActivity(this.taskId, this.frame);
  final String taskId;
  final CloudWireFrame frame;
}

/// The task data on a stream frame, or null for root and unreadable frames.
CloudAgentTaskEvent? parseCloudAgentTaskEvent(String event, Object? data) {
  if (data is! Map<String, dynamic>) return null;
  if (event == 'task.upsert') {
    final task = CloudAgentTask.tryParse(data['task']);
    final sourceKey = _text(data['sourceKey']);
    return task == null
        ? null
        : CloudAgentTaskUpsert(task, sourceKey: sourceKey);
  }
  final taskId = _text(data['taskId']);
  if (taskId == null) return null;
  final frame = parseCloudWireFrame(event, {...data}..remove('taskId'));
  return frame is CloudWireIgnored || frame is CloudWireUnparseable
      ? null
      : CloudAgentTaskActivity(taskId, frame);
}
