import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

/// Seeded watcher projections for demo mode. No target credentials or host
/// paths are part of the Portal display contract.
List<Map<String, dynamic>> mockRemoteWatchers({
  required String projectId,
  required String worktreeId,
  required String chatId,
}) => [
  for (final (id, trigger, kind, title, status) in const [
    (
      'watch-pr',
      'github_pull_requests_changed',
      'github_pull_requests',
      'Pull request #42',
      'active',
    ),
    (
      'watch-ci',
      'github_workflow_runs_changed',
      'github_workflow_runs',
      'CI workflow',
      'active',
    ),
    (
      'watch-wakeup',
      'scheduled_wakeup',
      'scheduled_wakeup',
      'Check the build',
      'active',
    ),
    (
      'watch-failed',
      'scheduled_wakeup',
      'scheduled_wakeup',
      'Review delivery',
      'delivery_failed',
    ),
  ])
    {
      'id': id,
      'projectId': projectId,
      'worktreeId': worktreeId,
      'chatId': chatId,
      'trigger': trigger,
      'targetKind': kind,
      'status': status,
      'createdAt': '2026-10-27T12:00:00.000Z',
      'followUpInstruction': 'Report the result in this chat.',
      if (status == 'delivery_failed')
        'deliveryError': 'The watcher notification could not be delivered.',
      'display': {
        'title': title,
        'subtitle': trigger == 'scheduled_wakeup'
            ? 'Scheduled wakeup'
            : 'GitHub',
        'watching': title,
        'watchingSubtitle': 'Demo watcher',
        'status': status == 'active' ? 'Active' : 'Delivery failed',
        'details': [
          {'label': 'Created', 'value': 'Oct 27, 2026'},
        ],
        if (trigger == 'github_workflow_runs_changed')
          'ownerDelegate': {'name': 'CI reviewer', 'detail': 'Delegate chat'},
        if (trigger.startsWith('github_'))
          'github': {
            'subtitle': 'acme/app',
            'filters': [
              {'label': 'Branch', 'value': 'main'},
            ],
            'samples': ['#41 · main · success', '#42 · main · in progress'],
            'totalCount': 3,
          },
      },
    },
];

/// Demo deletion and subsequent reads share one held projection.
final class MockRemoteWatchers {
  MockRemoteWatchers({this.onDeleted});

  final void Function(String watcherId, Iterable<String> parents)? onDeleted;
  final _parents = <String>{};
  final _deletedIds = <String>{};

  List<Map<String, dynamic>> rows({
    required String projectId,
    required String worktreeId,
    required String chatId,
  }) {
    _parents.add('$projectId:$worktreeId');
    return [
      for (final row in mockRemoteWatchers(
        projectId: projectId,
        worktreeId: worktreeId,
        chatId: chatId,
      ))
        if (!_deletedIds.contains(row['id'])) row,
    ];
  }

  Future<RemotePortalCommandResult> submit(
    String sessionId, {
    required String type,
    required Map<String, dynamic> payload,
  }) async {
    final id = payload['watcherId'];
    if (id is! String ||
        !const {
          'watch-pr',
          'watch-ci',
          'watch-wakeup',
          'watch-failed',
        }.contains(id) ||
        !_deletedIds.add(id)) {
      throw const RemoteWatcherDeleteException(
        RemoteWatcherDeleteFailure.notFoundOrFiring,
        'Watcher not found or currently firing.',
      );
    }
    onDeleted?.call(id, List.unmodifiable(_parents));
    return RemotePortalCommandResult(
      commandId: 'mock-delete-$id',
      result: const {'ok': true},
    );
  }
}
