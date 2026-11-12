import 'dart:math' as math;

Map<String, dynamic> _object(Object? value) =>
    value is Map<String, dynamic> ? value : const {};
List<Map<String, dynamic>> _rows(Object? value) =>
    value is List ? value.whereType<Map<String, dynamic>>().toList() : const [];

int pipelineAttempt(Map<String, dynamic> job) => math.max(
  (job['retry_count'] as num?)?.toInt() ?? 0,
  (job['retry_history'] as List?)?.length ?? 0,
);
int pipelineIteration(Map<String, dynamic> job) =>
    math.max(1, (job['iteration_count'] as num?)?.toInt() ?? 1);

/// Projects existing authoritative execution fields onto the shared mobile
/// run view. A summary omits detail rather than claiming an empty execution.
Map<String, dynamic> pipelineDisplay(Map<String, dynamic> row) {
  final snapshot = _object(row['pipeline_snapshot']);
  final logicalJobs = _object(snapshot['jobs']);
  final definitions = _object(row['job_definitions']);
  final results = _object(row['jobs']);
  final groups = _object(row['job_groups']);

  Map<String, dynamic> physical(String id, Map<String, dynamic> fallback) {
    final definition = _object(definitions[id]);
    final source = definition.isEmpty ? fallback : definition;
    final result = _object(results[id]);
    final steps = _object(result['steps']);
    final declared = _rows(source['steps']);
    final stepIds = <String>{
      for (final step in declared)
        if (step['id'] is String) step['id'] as String,
      ...steps.keys,
    };
    return {
      'jobId': id,
      'name': source['name'] ?? id,
      'status': result['status'] ?? 'pending',
      'matrix': _object(source['matrix'])['values'] ?? const {},
      'steps': [
        for (final stepId in stepIds)
          {
            'stepId': stepId,
            'name':
                declared
                    .where((step) => step['id'] == stepId)
                    .firstOrNull?['name'] ??
                stepId,
            'status': _object(steps[stepId])['status'] ?? 'pending',
            'attempt': pipelineAttempt(result),
            'iteration': pipelineIteration(result),
            'recovery': _object(steps[stepId])['recovery_count'] ?? 0,
          },
      ],
    };
  }

  final jobs = <Map<String, dynamic>>[];
  final represented = <String>{};
  for (final entry in logicalJobs.entries) {
    final definition = _object(entry.value), group = _object(groups[entry.key]);
    final ids =
        (group['variant_job_ids'] as List?)?.whereType<String>().toList() ??
        [entry.key];
    represented.addAll(ids);
    jobs.add({
      ...(group['kind'] == 'matrix'
          ? {
              'jobId': entry.key,
              'status': group['status'] ?? 'pending',
              'steps': const [],
              'variants': [for (final id in ids) physical(id, definition)],
              'expansion': group['expansion'],
              'expansionError': group['error'],
            }
          : physical(ids.firstOrNull ?? entry.key, definition)),
      // Logical identity owns ordering/dependencies; variants keep physical IDs.
      'jobId': entry.key,
      'name': definition['name'] ?? entry.key,
      'needs': definition['needs'] ?? const [],
    });
  }
  for (final id in results.keys.where((id) => !represented.contains(id))) {
    jobs.add(physical(id, const {}));
  }
  final steps = [
    for (final job in jobs) ...[
      ..._rows(job['steps']),
      for (final variant in _rows(job['variants'])) ..._rows(variant['steps']),
    ],
  ];
  return {
    'localId': row['id'],
    'pipelineId': row['pipeline_id'],
    'workspaceLocalId': row['project_id'],
    'worktreeLocalId': row['worktree_id'],
    'pipelineName':
        row['pipeline_name'] ?? snapshot['name'] ?? row['pipeline_id'],
    'status': row['status'],
    'startedAt': row['started_at'],
    'finishedAt': row['completed_at'],
    'parentExecutionId': row['parent_execution_id'],
    'hidden': row['hidden'] == true,
    if (_object(row['trigger_source'])['kind'] == 'hook')
      'triggerSource': 'hook',
    'statusReasons': [
      for (final reason in _rows(row['status_reasons']))
        {...reason, 'resetsAt': reason['resets_at']},
    ],
    'pendingPauses': [
      for (final pause in _rows(row['pending_pauses']))
        {...pause, 'jobId': pause['job_id'], 'stepId': pause['step_id']},
    ],
    if (row['jobs'] is Map) ...{
      'jobs': jobs,
      'progress': {
        'completedSteps': steps
            .where(
              (step) => const {
                'success',
                'failure',
                'cancelled',
                'skipped',
              }.contains(step['status']),
            )
            .length,
        'totalSteps': steps.length,
      },
    },
  };
}
