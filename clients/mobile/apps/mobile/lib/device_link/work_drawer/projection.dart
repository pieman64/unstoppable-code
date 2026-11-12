import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import '../chats/state.dart';
import '../pipelines/chat_activity.dart';
import 'package:mobile/data/models/composer_work.dart';

Map<String, dynamic> workObject(Object? value) =>
    value is Map<String, dynamic> ? value : const {};
List<Map<String, dynamic>> workRows(Object? value) =>
    value is List ? value.whereType<Map<String, dynamic>>().toList() : const [];
String? workText(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;
String workLabel(Object? value) {
  final text = (workText(value) ?? 'Unknown')
      .replaceAll('_', ' ')
      .replaceAll('-', ' ');
  return switch (text) {
    'success' => 'Succeeded',
    'failure' => 'Failed',
    'in progress' => 'Running',
    'pending' => 'Queued',
    'action required' => 'Needs input',
    _ => '${text[0].toUpperCase()}${text.substring(1)}',
  };
}

bool watcherMatches(Map<String, dynamic> row, DeviceChatState chat) {
  final destination = workObject(row['destination']);
  return chat.ref.matchesScope(destination) &&
      destination['chatId'] == chat.ref.id;
}

bool followingWatcher(Map<String, dynamic> row) =>
    row['status'] == 'active' ||
    (row['status'] == 'firing' &&
        (row['trigger'] == 'github_workflow_runs_changed' ||
            row['trigger'] == 'github_pull_requests_changed'));

/// Safe links only. Desktop sends these as observations, never synthesize one.
String? workGithubUrl(Object? value) {
  final uri = value is String ? Uri.tryParse(value) : null;
  return uri != null &&
          uri.scheme == 'https' &&
          uri.host == 'github.com' &&
          uri.userInfo.isEmpty &&
          !uri.hasPort
      ? uri.toString()
      : null;
}

List<WorkItem> projectWork({
  required DeviceChatState chat,
  required List<Map<String, dynamic>> tasks,
  required List<Map<String, dynamic>> watchers,
  required List<Map<String, dynamic>> delegations,
  required List<RemotePipelineRun> pipelines,
  List<Map<String, dynamic>> agents = const [],
  List<Map<String, dynamic>> queue = const [],
}) {
  final result = <WorkItem>[];
  for (final row in queue) {
    final id = workText(row['id']);
    if (id == null) continue;
    final unlocked =
        row['editLocked'] != true &&
        row['forceLocked'] != true &&
        row['retryBlockedReason'] == null;
    result.add(
      WorkItem(
        id: 'message:$id',
        group: WorkGroup.queued,
        kind: WorkKind.message,
        title: workText(row['text']) ?? 'Queued message',
        status: row['retryBlockedReason'] == 'insufficient_credits'
            ? 'Add credits first'
            : switch (row['waitingReason']) {
                'background_work' => 'Waiting for background work',
                'steer_unavailable' => 'Waiting for current step',
                final reason => reason == null ? null : workLabel(reason),
              },
        actionId: id,
        action: row['editLocked'] == true ? null : WorkAction.cancelQueued,
        extraActions: [
          if (unlocked) WorkAction.forceQueued,
          if (unlocked &&
              row['canSteer'] == true &&
              (row['turnPhase'] == null || row['turnPhase'] == 'foreground'))
            WorkAction.steerQueued,
        ],
        actionLabels: {
          WorkAction.forceQueued: row['retryable'] == true
              ? 'Try again'
              : row['turnPhase'] == 'foreground'
              ? 'Interrupt'
              : 'Run now',
        },
        details: {
          'Message': ?workText(row['text']),
          if (row['restartHeldChanges'] is List)
            'Settings waiting to apply': (row['restartHeldChanges'] as List)
                .map(workLabel)
                .join(', '),
          if (row['blockedByBackgroundWork'] == true)
            'Sending':
                'Interrupt stops the current reply. This message still waits for background work.',
          if (row['blockedByBackgroundWork'] == true)
            'Waiting for': 'Background work to finish',
          if (row['retryBlockedReason'] != null)
            'Waiting for': workLabel(row['retryBlockedReason']),
          if (row['attachmentPaths'] is List)
            'Attachments': '${(row['attachmentPaths'] as List).length}',
        },
      ),
    );
  }
  final queued = chat.runtime['queuedMessageIds'];
  if (queued is List) {
    for (final id in queued.whereType<String>()) {
      if (result.any((item) => item.id == 'message:$id')) continue;
      final message = chat.messages.where((m) => m.id == id).firstOrNull;
      result.add(
        WorkItem(
          id: 'message:$id',
          group: WorkGroup.queued,
          kind: WorkKind.message,
          title: workText(message?.text) ?? 'Queued message',
          details: {'Message': ?workText(message?.text)},
        ),
      );
    }
  }
  for (final task in tasks) {
    final id = workText(task['taskId']);
    if (id == null) continue;
    final paused = task['status'] == 'paused';
    result.add(
      WorkItem(
        id: 'task:$id',
        group: paused ? WorkGroup.needsYou : WorkGroup.running,
        kind: switch (task['taskType']) {
          'agent' ||
          'local_agent' ||
          'remote_agent' ||
          'in_process_teammate' => WorkKind.agent,
          'bash' ||
          'shell' ||
          'local_bash' ||
          'monitor_ws' ||
          'monitor_mcp' => WorkKind.command,
          'workflow' || 'local_workflow' => WorkKind.workflow,
          _ => WorkKind.task,
        },
        title:
            workText(task['description']) ??
            workText(task['workflowName']) ??
            'Background task',
        subtitle: workText(task['summary']) ?? workText(task['phase']),
        status: task['status'] == 'pending'
            ? 'Queued'
            : paused
            ? 'Paused'
            : 'Running',
        tone: paused ? WorkTone.attention : WorkTone.running,
        action: task['stoppable'] == false ? null : WorkAction.stopTask,
        actionId: id,
        details: {
          'Progress': ?workText(task['summary']),
          'Phase': ?workText(task['phase']),
          if (workObject(task['usage'])['totalTokens'] is num)
            'Tokens': '${workObject(task['usage'])['totalTokens']}',
          if (workObject(task['usage'])['toolUses'] is num)
            'Tool calls': '${workObject(task['usage'])['toolUses']}',
          if (workObject(task['usage'])['durationMs'] is num)
            'Duration':
                '${((workObject(task['usage'])['durationMs'] as num) / 1000).round()}s',
        },
      ),
    );
  }
  var listed = 0;
  for (final entry in agents) {
    final snapshot = workObject(entry['snapshot']);
    if (entry['executionMode'] != 'background' ||
        !const ['pending', 'running'].contains(snapshot['status'])) {
      continue;
    }
    final id = workText(snapshot['delegationId']);
    if (id == null) continue;
    listed++;
    final approval = snapshot['approvalPending'] == true;
    result.add(
      WorkItem(
        id: 'delegate:$id',
        group: approval ? WorkGroup.needsYou : WorkGroup.running,
        kind: WorkKind.agent,
        title: workText(entry['description']) ?? 'Delegate',
        status: approval
            ? 'Needs approval'
            : snapshot['status'] == 'pending'
            ? 'Queued'
            : 'Running',
        tone: approval ? WorkTone.attention : WorkTone.running,
        action: WorkAction.stopDelegate,
        actionId: id,
        details: {
          'Prompt': ?workText(entry['prompt']),
          'Progress': ?workText(snapshot['partialText']),
          'Model': ?workText(
            workObject(snapshot['routeSnapshot'])['runtimeModelLabel'],
          ),
        },
      ),
    );
  }
  // The host's count includes nested agents and turns outside the loaded tail.
  final activity = delegations
      .where((r) => chat.ref.matchesScope(r) && r['chatId'] == chat.ref.id)
      .firstOrNull;
  final live = (activity?['live'] as num?)?.toInt() ?? 0;
  final pending = (activity?['queued'] as num?)?.toInt() ?? 0;
  final unlisted = (live + pending - listed).clamp(0, live + pending);
  if (unlisted > 0) {
    result.add(
      WorkItem(
        id: 'delegates',
        group: WorkGroup.running,
        kind: WorkKind.agent,
        title:
            '$unlisted ${listed > 0 ? 'more ' : ''}${unlisted == 1 ? 'delegate' : 'delegates'}',
        subtitle: [
          if (live > 0) '$live running',
          if (pending > 0) '$pending queued',
        ].join(' · '),
        tone: WorkTone.running,
        count: unlisted,
        action: WorkAction.stopDelegates,
      ),
    );
  }

  final scoped = <String, Map<String, dynamic>>{
    for (final watcher in watchers)
      if (watcherMatches(watcher, chat) && workText(watcher['id']) != null)
        watcher['id'] as String: watcher,
  }.values;
  final prs = <String, Map<String, dynamic>>{},
      runs = <String, Map<String, dynamic>>{};
  final activeRuns = <String>{};
  final counts = <String, int>{};
  for (final watcher in scoped) {
    final active = followingWatcher(watcher);
    for (final pr in workRows(
      workObject(watcher['githubPullRequestProgress'])['pullRequests'],
    )) {
      final key = 'pr:${pr['repository']}#${pr['number']}';
      if (!prs.containsKey(key) ||
          '${pr['observedAt']}'.compareTo('${prs[key]!['observedAt']}') > 0) {
        prs[key] = pr;
      }
      if (active) {
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    for (final run in workRows(workObject(watcher['githubProgress'])['runs'])) {
      final key =
          'github:${run['repository']}/${run['runId']}/${run['runAttempt']}';
      if (!runs.containsKey(key) ||
          '${run['observedAt']}'.compareTo('${runs[key]!['observedAt']}') > 0) {
        runs[key] = run;
      }
      if (active) {
        activeRuns.add(key);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    if (watcher['status'] != 'active' &&
        watcher['status'] != 'delivery_failed') {
      continue;
    }
    final target = workObject(watcher['target']);
    final targetItems = workRows(target['items']);
    final watching = {
      for (final item in targetItems)
        if (workText(item['repository']) case final repo?)
          '$repo${item['number'] == null ? '' : '#${item['number']}'}',
    }.join(', ');
    final failed = watcher['status'] == 'delivery_failed';
    final sourceFailed = failed && watcher['failureKind'] == 'source';
    final status = sourceFailed ? 'Source unavailable' : 'Delivery failed';
    final details = <String, String>{
      'Watching': watching.isNotEmpty ? watching : _targetLabel(target),
      ..._targetDetails(target),
      'Trigger': workLabel(watcher['trigger']),
      'Status': failed ? status : 'Watching',
      'Follow-up': ?workText(watcher['followUpInstruction']),
      sourceFailed ? 'Source error' : 'Delivery error': ?workText(
        watcher['deliveryError'],
      ),
      'Resumes': ?workText(watcher['githubRateLimitedUntil']),
      if (workObject(watcher['localProgress']) case final progress
          when progress.isNotEmpty)
        'Progress':
            'Attempt ${progress['attempts'] ?? 0}${progress['nextAttemptAt'] == null ? '' : ', next ${progress['nextAttemptAt']}'}',
    };
    result.add(
      WorkItem(
        id: 'watcher:${watcher['id']}',
        group: WorkGroup.watching,
        kind: WorkKind.watcher,
        title: workText(watcher['label']) ?? details['Watching']!,
        subtitle: details['Watching'],
        status: failed ? status : null,
        tone: failed ? WorkTone.attention : WorkTone.info,
        details: details,
        action: WorkAction.deleteWatcher,
        actionId: workText(watcher['id']),
      ),
    );
  }
  for (final entry in prs.entries) {
    final pr = entry.value, queue = workObject(entry.value['queue']);
    final state = workText(pr['state']) ?? 'unknown';
    // Every PR state has a permanent home, independent of active work.
    result.add(
      WorkItem(
        id: entry.key,
        group: WorkGroup.pullRequests,
        kind: WorkKind.pullRequest,
        title: '#${pr['number']} ${workText(pr['title']) ?? ''}'.trim(),
        subtitle: workText(pr['repository']),
        tone: state == 'merged'
            ? WorkTone.merged
            : state == 'open'
            ? WorkTone.success
            : WorkTone.neutral,
        watcherCount: counts[entry.key] ?? 0,
        url: workGithubUrl(pr['url']),
        details: {
          'Status': queue.isNotEmpty && state == 'open'
              ? 'In merge queue${queue['position'] == null ? '' : ' · ${queue['position']}'}'
              : workLabel(state),
          if (queue.isNotEmpty && state == 'open')
            'Queue': workLabel(queue['phase']),
          'Base branch': ?workText(pr['baseRefName']),
          if (pr['additions'] is num) 'Added': '+${pr['additions']}',
          if (pr['deletions'] is num) 'Removed': '-${pr['deletions']}',
          'Last checked': ?workText(pr['observedAt']),
        },
      ),
    );
  }
  for (final entry in runs.entries) {
    final run = entry.value, state = workObject(entry.value['state']);
    final terminal = state['kind'] == 'terminal' || state['terminal'] == true;
    if (!terminal && !activeRuns.contains(entry.key)) continue;
    final status =
        workText(state['conclusion']) ?? workText(state['status']) ?? 'unknown';
    final runStatus = !terminal
        ? 'Running'
        : switch (status) {
            'success' => 'Succeeded',
            'failure' ||
            'timed_out' ||
            'startup_failure' ||
            'action_required' => 'Failed',
            'cancelled' => 'Cancelled',
            _ => 'Completed',
          };
    final number = run['runNumber'] ?? run['runId'];
    final name = workText(run['workflowName']);
    result.add(
      WorkItem(
        id: entry.key,
        group: WorkGroup.running,
        kind: WorkKind.github,
        title:
            '${name ?? 'Run'} #$number${run['runAttempt'] is num && (run['runAttempt'] as num) > 1 ? ' · attempt ${run['runAttempt']}' : ''}',
        subtitle: workText(run['repository']),
        status: runStatus,
        tone: terminal
            ? (status == 'action_required'
                  ? WorkTone.failed
                  : _terminalTone(status))
            : WorkTone.running,
        finished: terminal,
        watcherCount: counts[entry.key] ?? 0,
        url: workGithubUrl(run['htmlUrl']),
        details: {
          'Status': workLabel(status),
          for (final job in workRows(run['jobs']))
            '${job['name'] ?? job['jobId']}': _jobStatus(job),
          'Last checked': ?workText(run['observedAt']),
        },
      ),
    );
  }
  final receipts = devicePipelineReceiptIds(chat.ref, chat.messages);
  for (final run in pipelines) {
    if (run.hidden ||
        !run.isRoot ||
        run.workspaceLocalId != chat.ref.projectId ||
        run.worktreeLocalId != chat.ref.worktreeId ||
        (!receipts.contains(run.localId) &&
            !(run.chatTurns?.any((t) => t.chatId == chat.ref.id) ?? false))) {
      continue;
    }
    final terminal = const [
      'success',
      'failure',
      'cancelled',
    ].contains(run.status);
    final attention = run.status == 'paused';
    result.add(
      WorkItem(
        id: 'pipeline:${run.localId}',
        group: attention ? WorkGroup.needsYou : WorkGroup.running,
        kind: WorkKind.pipeline,
        title: run.pipelineName,
        status:
            run.status == 'paused' &&
                run.pendingPauses.any((p) => p.kind == 'input')
            ? 'Needs input'
            : workLabel(run.status),
        tone: attention
            ? WorkTone.attention
            : terminal
            ? _terminalTone(run.status)
            : WorkTone.running,
        finished: terminal,
        pipelineId: run.localId,
        details: {
          'Status':
              run.status == 'paused' &&
                  run.pendingPauses.any((p) => p.kind == 'input')
              ? 'Needs input'
              : workLabel(run.status),
          for (final pause in run.pendingPauses)
            pause.title ?? (pause.kind == 'input' ? 'Needs input' : 'Paused'): [
              if (pause.message != null) pause.message!,
              ...pause.fieldLabels,
            ].join(' · '),
          for (final reason in run.statusReasons)
            'Waiting for': workLabel(reason.code),
          for (final job in run.jobs ?? <RemotePipelineRunJob>[])
            job.name: workLabel(job.status),
          if (run.outputTail case final tail? when tail.isNotEmpty)
            'Output': tail,
        },
      ),
    );
  }
  return result;
}

WorkTone _terminalTone(String status) => switch (status) {
  'success' => WorkTone.success,
  'failure' || 'timed_out' || 'startup_failure' => WorkTone.failed,
  _ => WorkTone.neutral,
};
String _jobStatus(Map<String, dynamic> job) {
  final state = workObject(job['state']);
  return workLabel(
    state['conclusion'] ??
        state['status'] ??
        job['conclusion'] ??
        job['status'],
  );
}

String _targetLabel(Map<String, dynamic> target) => switch (target['kind']) {
  'scheduled_wakeup' => 'Scheduled wakeup',
  'command_watch' => workText(target['command']) ?? 'Command',
  'worktree_pipeline' => workText(target['pipelineName']) ?? 'Pipeline',
  'worktree_hook' => workText(target['hookLabel']) ?? 'Hook',
  'worktree_chat' ||
  'standalone_chat' => workText(target['chatTitle']) ?? 'Chat',
  'worktree_chat_scope' =>
    workText(target['worktreeBranchName']) ?? 'New chats',
  'standalone_chat_project' => workText(target['projectName']) ?? 'New chats',
  'automation' => workText(target['automationName']) ?? 'Automation',
  'github_workflow_runs' => 'GitHub runs',
  'github_pull_requests' => 'Pull requests',
  _ => 'Chat activity',
};

Map<String, String> _targetDetails(Map<String, dynamic> target) => {
  'Project':
      ?workText(target['workspaceName']) ?? workText(target['projectName']),
  'Branch': ?workText(target['worktreeBranchName']),
  'Description': ?workText(target['chatDescription']),
  'Pipeline': ?workText(target['pipelineName']),
  'Execution': ?workText(target['executionId']),
  'Hook': ?workText(target['hookLabel']),
  'Trigger': ?workText(target['triggerName']),
  'Repository': ?workText(target['repoName']),
  'Scheduled for': ?workText(target['scheduledFor']),
  if (target['delaySeconds'] is num)
    'Delay': '${target['delaySeconds']} seconds',
  if (target['intervalSeconds'] is num)
    'Check interval': '${target['intervalSeconds']} seconds',
  if (target['maxAttempts'] is num) 'Attempt limit': '${target['maxAttempts']}',
  'Command': ?workText(target['command']),
  'Directory': ?workText(target['cwd']),
};
