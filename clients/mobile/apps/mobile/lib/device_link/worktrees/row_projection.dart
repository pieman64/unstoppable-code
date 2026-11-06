import 'package:mobile/data/models/remote_session.dart';
import 'models.dart';

/// The desktop sidebar's pipeline status per `projectId/worktreeId`, built
/// from the execution list and each worktree's seen execution ids. Resolves
/// as desktop `resolvePipelineStatus` does: running, then an unseen failure,
/// then paused, then an unseen result.
Map<String, String> devicePipelineStatuses(
  Iterable<Map<String, dynamic>> executions,
  Map<String, Set<String>> seenByKey,
) {
  final running = <String>{}, failed = <String>{};
  final paused = <String>{}, unseen = <String>{};
  for (final row in executions) {
    final projectId = row['project_id'], worktreeId = row['worktree_id'];
    final id = row['id'], status = row['status'];
    if (projectId is! String || worktreeId is! String || id is! String) {
      continue;
    }
    final key = '$projectId/$worktreeId';
    final seen = seenByKey[key]?.contains(id) ?? false;
    if (status == 'pending' || status == 'running') running.add(key);
    if (status == 'paused') paused.add(key);
    if (seen) continue;
    if (const ['paused', 'success', 'failure', 'cancelled'].contains(status)) {
      unseen.add(key);
    }
    if (status == 'failure') failed.add(key);
  }
  return {
    for (final key in {...running, ...failed, ...paused, ...unseen})
      key: running.contains(key)
          ? 'running'
          : failed.contains(key)
          ? 'unseen-failure'
          : paused.contains(key)
          ? 'paused'
          : 'unseen',
  };
}

/// The shared worktree row's input: the desktop session-snapshot projection
/// (title, PR, diff, script, hook and terminal state), with the live chat
/// state and resolved pipeline status read for this worktree on top.
RemoteWorktree deviceWorktreeRow(DeviceWorktree worktree) {
  final projected = worktree.projection;
  final chatStateKnown =
      worktree.status != 'Loading' && worktree.status != 'Unavailable';
  return RemoteWorktree.fromJson({
    'branch': worktree.name,
    ...?projected,
    'localId': worktree.id,
    'workspaceLocalId': worktree.projectId,
    'pipelineStatus': ?worktree.pipelineStatus,
    if (chatStateKnown) ...{
      'isStreaming': worktree.isStreaming,
      'hasUnread': worktree.unread,
      'awaitingApproval': worktree.pendingApproval,
    },
  });
}
