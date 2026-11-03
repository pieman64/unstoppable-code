/// Projects a known agent task's spawn tool row into an `agent` part with the
/// Portal's `PortalChatAgentBlockData` shape, as the web's `projectAgentParts`
/// does: status, the child's replies and tools, and nested agents.
library;

import 'dart:convert';

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_agent_task.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_fold.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';

String agentTaskSpawnKey(
  String? parentTaskId,
  String toolCallId, [
  String? turnKey,
]) {
  final scope = parentTaskId == null
      ? 'turn:${turnKey ?? ''}'
      : 'task:$parentTaskId\u0000turn:${turnKey ?? ''}';
  return '$scope\u0000$toolCallId';
}

/// Replaces spawn tool rows of known subagent tasks with agent cards.
List<CloudTranscriptMessage> projectAgentTaskCards(
  List<CloudTranscriptMessage> rows,
  CloudAgentTaskFold fold,
) {
  if (fold.isEmpty) return rows;
  final projector = _Projector(fold);
  var changed = false;
  final result = [
    for (final row in rows)
      switch (projector.parts(row.parts, null, 1, row.sourceKey)) {
        null => row,
        final parts => () {
          changed = true;
          return _withParts(row, parts);
        }(),
      },
  ];
  return changed ? List.unmodifiable(result) : rows;
}

CloudTranscriptMessage _withParts(
  CloudTranscriptMessage row,
  List<ChatPart> parts,
) => CloudTranscriptMessage(
  messageId: row.messageId,
  chatId: row.chatId,
  role: row.role,
  status: row.status,
  text: row.text,
  parts: parts,
  occurredAt: row.occurredAt,
  attachments: row.attachments,
  delivery: row.delivery,
  deliveryNote: row.deliveryNote,
  watcherFired: row.watcherFired,
  sourceKey: row.sourceKey,
  clientRequestId: row.clientRequestId,
  model: row.model,
  usage: row.usage,
  cost: row.cost,
  errorCode: row.errorCode,
  errorMessage: row.errorMessage,
);

typedef _Spawn = ({
  String toolUseId,
  String toolName,
  String input,
  ({String output, bool isError})? result,
});

final class _Projector {
  _Projector(this.fold) {
    for (final task in fold.tasks) {
      for (final key in _spawnKeys(task)) {
        _index[key] = task.taskId;
      }
    }
  }
  final CloudAgentTaskFold fold;
  final _index = <String, String>{};

  String? _identity(String? sourceKey, String? turnId) =>
      sourceKey ??
      (turnId == null ? null : fold.turnSourceKey(turnId) ?? turnId);

  Set<String> _spawnKeys(CloudAgentTask task) {
    final spawn = task.spawnToolCallId;
    if (spawn == null) return const {};
    final parent = task.parentTaskId;
    final identity = _identity(
      fold.taskSourceKey(task.taskId),
      task.spawnTurnId,
    );
    final turnKeys = identity == null || parent == null
        ? [identity]
        : [identity, '$identity:task:$parent'];
    return {
      agentTaskSpawnKey(parent, spawn),
      for (final turnKey in turnKeys) agentTaskSpawnKey(parent, spawn, turnKey),
    };
  }

  /// Null when no part changed.
  List<ChatPart>? parts(
    List<ChatPart> parts,
    String? scopeTaskId,
    int depth,
    String? turnKey,
  ) {
    var changed = false;
    final result = <ChatPart>[];
    for (final part in parts) {
      final spawn = _spawnOf(part);
      final agents = spawn == null
          ? null
          : _agentParts(spawn, scopeTaskId, depth, turnKey);
      if (agents == null) {
        result.add(part);
      } else {
        changed = true;
        result.addAll(agents);
      }
    }
    return changed ? result : null;
  }

  CloudAgentTask? _taskFor(_Spawn spawn, String? scope, String? turnKey) {
    final latestId = _index[agentTaskSpawnKey(scope, spawn.toolUseId)];
    final latest = latestId == null ? null : fold.task(latestId);
    final fallback =
        latest != null &&
            latest.spawnTurnId == null &&
            fold.taskSourceKey(latest.taskId) == null
        ? latestId
        : null;
    final taskId =
        _index[agentTaskSpawnKey(
          scope,
          spawn.toolUseId,
          _identity(null, turnKey),
        )] ??
        (scope != null && turnKey == null ? latestId : fallback);
    return taskId == null ? null : fold.task(taskId);
  }

  List<ChatPart>? _agentParts(
    _Spawn spawn,
    String? scope,
    int depth,
    String? turnKey,
  ) {
    final task = _taskFor(spawn, scope, turnKey);
    if (task == null || task.kind != 'subagent') return null;
    final codex =
        (spawn.toolName == 'spawnAgent' || spawn.toolName == 'spawn_agent') &&
        task.harness != 'CLAUDE_CODE';
    if (!codex) return [_card(spawn, task, depth, codex: false)];
    // One Codex spawn can create several receivers; each gets its card.
    final identity = _identity(
      fold.taskSourceKey(task.taskId),
      task.spawnTurnId,
    );
    final siblings = fold.tasks.where(
      (t) =>
          t.kind == 'subagent' &&
          t.harness == task.harness &&
          t.parentTaskId == task.parentTaskId &&
          t.spawnToolCallId == task.spawnToolCallId &&
          _identity(fold.taskSourceKey(t.taskId), t.spawnTurnId) == identity,
    );
    final ordered = siblings.toList()
      ..sort((a, b) => (a.createdAtMs ?? 0).compareTo(b.createdAtMs ?? 0));
    return [for (final t in ordered) _card(spawn, t, depth, codex: true)];
  }

  ChatPart _card(
    _Spawn spawn,
    CloudAgentTask task,
    int depth, {
    required bool codex,
  }) {
    final activity = fold.activity(task.taskId);
    final deep = depth > agentTaskMaxDepth;
    final input = _decodeObject(spawn.input);
    final spawnResult = spawn.result;
    final known = task.status != 'unknown';
    final terminal = task.terminal;
    final background = input['run_in_background'] == true || task.background;
    var result = codex ? null : spawnResult?.output;
    if (terminal && (background || result == null || result.isEmpty)) {
      result = task.summary ?? task.errorMessage ?? result;
    }
    final isRunning = known ? !terminal : result == null;
    final isError = known
        ? task.status == 'failed' || task.status == 'lost'
        : spawnResult?.isError == true;
    final subBlocks = deep || activity == null
        ? const <ChatPart>[]
        : _subBlocks(activity, task.taskId, depth);
    final omitted =
        (activity?.omitted ?? 0) + (deep ? activity?.entries.length ?? 0 : 0);
    final usage = _usage(task, activity);
    final modelLabel = task.modelLabel ?? task.modelId;
    return ChatPart(
      kind: 'agent',
      data: {
        'provider': codex ? 'codex' : 'claude',
        'toolUseId': spawn.toolUseId,
        'subagentType':
            _text(input['subagent_type']) ??
            _text(input['agent_type']) ??
            task.subagentType ??
            'Agent',
        'description':
            ?(_text(input['description']) ?? task.description ?? task.title),
        'prompt':
            ?(_text(input['prompt']) ?? _text(input['message']) ?? task.prompt),
        'runInBackground': background,
        'result': ?result,
        if (isRunning) 'isRunning': true,
        if (isError) 'isError': true,
        if (codex) 'model': ?modelLabel,
        if (codex) 'reasoningEffort': ?task.thinkingEffort,
        'usage': ?usage,
        'subBlocks': [for (final part in subBlocks) _partJson(part)],
        if (omitted > 0) 'subBlocksTruncated': true,
        if (omitted > 0) 'omittedSubBlocks': omitted,
        'taskId': task.taskId,
        'taskStatus': task.status,
        if (task.approvalPending) 'taskApprovalPending': true,
        'taskStopReason': task.stopReason,
        'taskErrorMessage': ?task.errorMessage,
        'createdAt': task.createdAtMs,
        'startedAt': task.startedAtMs,
        'completedAt': task.completedAtMs,
        'modelLabel': ?modelLabel,
      },
    );
  }

  List<ChatPart> _subBlocks(
    AgentTaskActivity activity,
    String taskId,
    int depth,
  ) {
    final parts = <ChatPart>[];
    for (final entry in activity.entries) {
      switch (entry.kind) {
        case AgentTaskEntryKind.text:
          if (entry.text.isEmpty) continue;
          parts.add(
            ChatPart(
              kind: 'text',
              data: {
                'text': entry.truncated
                    ? '${entry.text}\n\n[truncated]'
                    : entry.text,
              },
            ),
          );
        case AgentTaskEntryKind.reasoning:
          if (entry.text.isEmpty) continue;
          parts.add(ChatPart(kind: 'thinking', data: {'text': entry.text}));
        case AgentTaskEntryKind.tool:
          final call = entry.call;
          if (call == null) continue;
          final tool = _toolPart(call, entry.result);
          if (tool == null) continue;
          final turnKey = entry.sourceKey ?? entry.turnId;
          parts.addAll(
            this.parts([tool], taskId, depth + 1, turnKey) ?? [tool],
          );
      }
    }
    return parts;
  }
}

ChatPart? _toolPart(CloudChatToolActivity call, CloudChatToolActivity? result) {
  var parts = foldCloudToolActivity(const [], call);
  if (parts == null) return null;
  if (result != null) parts = foldCloudToolActivity(parts, result) ?? parts;
  return parts.singleOrNull;
}

_Spawn? _spawnOf(ChatPart part) {
  final data = part.data;
  if (part.kind != 'tool_use' || data == null) return null;
  final id = data['toolUseId'], name = data['toolName'];
  if (id is! String ||
      id.isEmpty ||
      name is! String ||
      !agentSpawnToolNames.contains(name)) {
    return null;
  }
  final input = data['input'];
  final result = data['result'];
  return (
    toolUseId: id,
    toolName: name,
    input: input is String ? input : (input == null ? '' : jsonEncode(input)),
    result:
        result is Map && result['output'] is String && result['isError'] is bool
        ? (
            output: result['output'] as String,
            isError: result['isError'] as bool,
          )
        : null,
  );
}

Map<String, dynamic> _partJson(ChatPart part) => {
  'kind': part.kind,
  'toolFamily': ?part.toolFamily,
  'data': ?part.data,
};

Map<String, dynamic> _decodeObject(String input) {
  try {
    final value = jsonDecode(input);
    return value is Map<String, dynamic> ? value : const {};
  } on Object {
    return const {};
  }
}

String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;

Map<String, dynamic>? _usage(CloudAgentTask task, AgentTaskActivity? activity) {
  final u = task.usage ?? const <String, num>{};
  final toolUses =
      activity?.entries
          .where((e) => e.kind == AgentTaskEntryKind.tool && e.call != null)
          .length ??
      0;
  final started = task.startedAtMs, completed = task.completedAtMs;
  final duration = started != null && completed != null
      ? completed - started
      : null;
  final cost = task.costUsd == null ? null : num.tryParse(task.costUsd!);
  final usage = <String, dynamic>{
    'inputTokens': ?u['inputTokens'],
    'outputTokens': ?u['outputTokens'],
    'cacheReadInputTokens': ?u['cacheReadTokens'],
    'cacheCreationInputTokens': ?u['cacheWriteTokens'],
    'contextTokens': ?u['contextTokens'],
    'contextWindow': ?u['contextWindow'],
    if (toolUses > 0) 'toolUses': toolUses,
    if (duration != null && duration >= 0) 'durationMs': duration,
    if (cost != null && cost.isFinite) 'totalCostUsd': cost,
    'model': ?(task.modelLabel ?? task.modelId),
  };
  return usage.isEmpty ? null : usage;
}
