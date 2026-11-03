import 'dart:convert';

import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';

import '../pipeline_run_status.dart';
import 'items.dart';

List<BackgroundTrayAgent> mapBackgroundTrayAgents(
  Iterable<ChatMessage> messages,
  Iterable<BackgroundTrayTask> tasks,
) {
  final taskList = tasks.toList();
  final latest = <String, BackgroundTrayAgent?>{};
  void visit(ChatPart part) {
    final data = part.data;
    if (part.kind != 'agent' || data == null) return;
    final delegation = data['delegation'];
    if (delegation is Map<String, dynamic> &&
        _text(delegation, 'delegationId') != null) {
      final id = 'managed:${delegation['delegationId']}';
      latest[id] = _delegateRow(id, delegation, data);
    } else {
      final toolUseId = _text(data, 'toolUseId');
      if (toolUseId != null) {
        latest[toolUseId] = _nativeRow(toolUseId, data, taskList);
      }
    }
    final children = data['subBlocks'];
    if (children is List) {
      for (final child in children.whereType<Map<String, dynamic>>()) {
        visit(ChatPart.fromJson(child));
      }
    }
  }

  for (final message in messages) {
    for (final part in message.parts) {
      visit(part);
    }
  }
  for (final task in taskList) {
    final owner = task.process.toolUseId;
    if (task.kind != BackgroundTrayKind.agent ||
        (task.process.status != RemoteBackgroundProcessStatus.queued &&
            task.process.status != RemoteBackgroundProcessStatus.running) ||
        owner.isEmpty ||
        latest.containsKey(owner)) {
      continue;
    }
    latest[owner] = BackgroundTrayAgent(
      id: 'claude:$owner',
      title: task.title,
      kind: BackgroundTrayAgentKind.claude,
      status: task.process.status == RemoteBackgroundProcessStatus.queued
          ? BackgroundTrayAgentStatus.queued
          : BackgroundTrayAgentStatus.running,
      activity: task.process.lastDescription,
      startedAt: task.process.startedAt,
      meta: 'Claude',
      taskId: task.id,
    );
  }
  return List.unmodifiable(latest.values.whereType<BackgroundTrayAgent>());
}

BackgroundTrayAgent? _delegateRow(
  String id,
  Map<String, dynamic> delegation,
  Map<String, dynamic> data,
) {
  final status = delegation['status'];
  if (delegation['executionMode'] != 'background' ||
      (status != 'pending' && status != 'running')) {
    return null;
  }
  final route = delegation['routeSnapshot'];
  final model = route is Map<String, dynamic>
      ? _text(route, 'runtimeModelLabel') ??
            _text(route, 'selectedModelLabel') ??
            _text(route, 'runtimeModelId') ??
            _text(delegation, 'requestedModelId')
      : _text(delegation, 'requestedModelId');
  return BackgroundTrayAgent(
    id: id,
    title: _text(delegation, 'description') ?? 'Subagent',
    kind: BackgroundTrayAgentKind.delegate,
    status: status == 'pending'
        ? BackgroundTrayAgentStatus.queued
        : delegation['approvalPending'] == true
        ? BackgroundTrayAgentStatus.approval
        : BackgroundTrayAgentStatus.running,
    steps: _steps(data),
    prompt: _text(delegation, 'prompt'),
    meta: model == null ? 'Delegate' : 'Delegate · $model',
    target: BackgroundTrayAgentTarget(
      kind: BackgroundTrayAgentTargetKind.managed,
      id: id.substring('managed:'.length),
    ),
  );
}

BackgroundTrayAgent? _nativeRow(
  String toolUseId,
  Map<String, dynamic> data,
  List<BackgroundTrayTask> tasks,
) {
  if (data['isRunning'] != true) return null;
  final codex = data['provider'] == 'codex';
  if (!codex && data['runInBackground'] != true) return null;
  final subagentType = _text(data, 'subagentType');
  BackgroundTrayTask? task;
  if (!codex) {
    for (final candidate in tasks) {
      if (candidate.process.toolUseId == toolUseId) {
        task = candidate;
        break;
      }
    }
  }
  return BackgroundTrayAgent(
    id: '${codex ? 'codex' : 'claude'}:$toolUseId',
    title: _text(data, 'description') ?? subagentType ?? 'Subagent',
    kind: codex
        ? BackgroundTrayAgentKind.codex
        : BackgroundTrayAgentKind.claude,
    status: BackgroundTrayAgentStatus.running,
    activity: task?.process.lastDescription,
    startedAt: task?.process.startedAt,
    steps: _steps(data),
    prompt: _text(data, 'prompt'),
    meta: codex
        ? [
            'Codex',
            ?_text(data, 'model'),
            ?_text(data, 'reasoningEffort'),
          ].join(' · ')
        : subagentType == null
        ? 'Claude'
        : 'Claude · $subagentType',
    taskId: task?.id,
    target: codex
        ? null
        : BackgroundTrayAgentTarget(
            kind: BackgroundTrayAgentTargetKind.claudeNative,
            id: toolUseId,
          ),
  );
}

List<BackgroundTrayAgentStep> _steps(Map<String, dynamic> data) {
  final children = data['subBlocks'];
  if (children is! List) return const [];
  final steps = <BackgroundTrayAgentStep>[];
  for (final (index, child) in children.indexed) {
    if (child is! Map<String, dynamic> || child['kind'] != 'tool_use') continue;
    final step = child['data'];
    if (step is! Map<String, dynamic>) continue;
    final name = _text(step, 'toolName') ?? _text(step, 'name');
    if (name == null) continue;
    final input = step['input'];
    steps.add(
      BackgroundTrayAgentStep(
        id: _text(step, 'toolUseId') ?? '$index',
        toolName: name,
        toolFamily: _text(child, 'toolFamily'),
        input: input is String
            ? input
            : step.containsKey('input')
            ? jsonEncode(input)
            : '',
      ),
    );
  }
  return List.unmodifiable(
    steps.skip(steps.length > 20 ? steps.length - 20 : 0),
  );
}

List<BackgroundTrayRun> mapBackgroundTrayPipelineRuns({
  required RemoteWorktreeChatTarget target,
  required Iterable<ChatMessage> messages,
  required Iterable<RemotePipelineRun> pipelineRuns,
}) {
  final chatId = target.chatId;
  if (chatId == null) return const [];
  final byId = {
    for (final run in pipelineRuns)
      if (!run.hidden &&
          run.isRoot &&
          (run.workspaceLocalId == null ||
              run.workspaceLocalId == target.workspaceLocalId) &&
          (run.worktreeLocalId == null ||
              run.worktreeLocalId == target.worktreeLocalId))
        run.localId: run,
  };
  final receipts = _pipelineReceipts(
    messages.where((message) => message.chatId == chatId),
  );
  final rows = <BackgroundTrayRun>[];
  for (final entry in receipts.entries) {
    final run = byId[entry.key];
    if (run != null) rows.add(_pipelineRow(run, receipt: entry.value));
  }
  // Mobile also receives the desktop's explicit chat-turn attribution. It
  // keeps a linked run visible when its tool receipt is outside the loaded
  // transcript window. A run linked to several turns still gets one row.
  for (final run in byId.values) {
    if (!receipts.containsKey(run.localId) &&
        (run.chatTurns?.any((turn) => turn.chatId == chatId) ?? false)) {
      rows.add(_pipelineRow(run));
    }
  }
  return List.unmodifiable(rows);
}

Map<String, Map<String, dynamic>> _pipelineReceipts(
  Iterable<ChatMessage> messages,
) {
  final latest = <String, Map<String, dynamic>>{};
  final seenTools = <String>{};
  for (final message in messages) {
    for (final part in message.parts) {
      final data = part.data;
      if (data == null ||
          (part.kind != 'tool_use' && part.kind != 'tool_result')) {
        continue;
      }
      final result = part.kind == 'tool_use' ? data['result'] : data;
      if (result is! Map<String, dynamic> || result['isError'] == true) {
        continue;
      }
      final artifacts = result['agentArtifacts'];
      if (artifacts is! List) continue;
      final valid = <Map<String, dynamic>>[
        for (final artifact in artifacts.whereType<Map<String, dynamic>>())
          if (artifact['version'] == 1 &&
              artifact['kind'] == 'pipeline_run' &&
              _text(artifact, 'executionId') != null &&
              _text(artifact, 'dedupeKey') != null)
            artifact,
      ];
      if (valid.isEmpty) continue;
      final toolUseId = _text(data, 'toolUseId') ?? _text(data, 'tool_use_id');
      if (toolUseId != null && !seenTools.add(toolUseId)) continue;
      for (final artifact in valid) {
        final executionId = _text(artifact, 'executionId');
        if (executionId != null) latest[executionId] = artifact;
      }
    }
  }
  return latest;
}

BackgroundTrayRun _pipelineRow(
  RemotePipelineRun run, {
  Map<String, dynamic>? receipt,
}) {
  RemotePipelinePauseCheckpoint? input;
  for (final pause in run.pendingPauses) {
    if (pause.kind == 'input') {
      input = pause;
      break;
    }
  }
  final status = switch (normalizePipelineRunStatus(run.status)) {
    'paused' =>
      input == null
          ? BackgroundTrayRunStatus.paused
          : BackgroundTrayRunStatus.needsInput,
    'success' => BackgroundTrayRunStatus.succeeded,
    'failure' => BackgroundTrayRunStatus.failed,
    'cancelled' => BackgroundTrayRunStatus.cancelled,
    _ => BackgroundTrayRunStatus.running,
  };
  final startedAt = receipt == null
      ? run.startedAt
      : _text(receipt, 'startedAt') ?? _text(receipt, 'queuedAt');
  return BackgroundTrayRun(
    id: receipt == null
        ? 'canopy:pipeline_run:execution:${run.localId}'
        : _text(receipt, 'dedupeKey')!,
    title: receipt == null
        ? run.pipelineName
        : _text(receipt, 'pipelineName') ?? run.pipelineName,
    kind: BackgroundTrayRunKind.pipeline,
    status: status,
    startedAt: DateTime.tryParse(startedAt ?? '')?.millisecondsSinceEpoch,
    question: input?.message ?? input?.title,
    pipelineRun: run,
  );
}

String? _text(Map<String, dynamic> data, String key) {
  final value = data[key];
  return value is String && value.isNotEmpty ? value : null;
}
