import 'dart:async';
import '../desktop/ipc.dart';
import '../chats/dto.dart';
import '../protocol.dart';

final class DeviceCreatedWorktree {
  const DeviceCreatedWorktree(this.projectId, this.id, this.name);
  final String projectId, id, name;
}

/// One UI attempt owns its receipt. Existing create IPC is not idempotent:
/// a missing reply must never cause a second create.
final class DeviceWorktreeCreateAttempt {
  DeviceWorktreeCreateAttempt(this.projectId, {this.onChanged});
  final void Function()? onChanged;
  final String projectId;
  String? worktreeId, name;
  bool mutationSent = false, ready = false;
  Future<DeviceCreatedWorktree>? pending;
  bool get canRetry => worktreeId != null || !mutationSent;
}

final class DeviceWorktreeCreator {
  DeviceWorktreeCreator(this.ipc) {
    _subscription = ipc.events.listen(_event);
  }
  final DesktopIpc ipc;
  late final StreamSubscription<Map<String, dynamic>> _subscription;
  final _active = <String, DeviceWorktreeCreateAttempt>{};
  final _uncertain = <String>{};
  final _git = <String, Map<String, dynamic>>{};
  final _waiters = <String, Completer<Map<String, dynamic>>>{};
  bool _connected = false, _disposed = false;
  int _generation = 0;
  void setConnected(bool value) {
    if (_connected == value) return;
    _connected = value;
    _generation++;
    if (!value) {
      for (final waiter in _waiters.values) {
        if (!waiter.isCompleted) {
          waiter.complete({
            'error': 'Reconnect to check the created worktree.',
          });
        }
      }
      _git.clear();
    }
  }

  void _check(int generation) {
    if (_disposed || !_connected || generation != _generation) {
      throw const DeviceLinkException(
        'The computer connection changed. Refresh before continuing.',
      );
    }
  }

  Future<Map<String, dynamic>> _project(String id) async {
    final result = deviceLinkObject(
      deviceChatDto(await ipc.invoke('projects:load')),
    );
    final project = (result['items'] as List? ?? const [])
        .whereType<Map<String, dynamic>>()
        .where(
          (row) =>
              row['id'] == id &&
              row['hidden'] != true &&
              row['archivedAt'] == null,
        )
        .firstOrNull;
    if (project == null) {
      throw const DeviceLinkException('This project is no longer available.');
    }
    return project;
  }

  Future<DeviceCreatedWorktree> create(DeviceWorktreeCreateAttempt attempt) {
    if (attempt.pending case final pending?) return pending;
    if (!_connected || _disposed) {
      return Future.error(
        const DeviceLinkException('Connect to a computer first.'),
      );
    }
    if (_uncertain.contains(attempt.projectId)) {
      return Future.error(
        const DeviceLinkException(
          'Creation was not confirmed. Check your computer before starting another task.',
        ),
      );
    }
    final active = _active[attempt.projectId];
    if (active != null && !identical(active, attempt)) {
      return Future.error(
        const DeviceLinkException(
          'A task is already being created in this project.',
        ),
      );
    }
    _active[attempt.projectId] = attempt;
    final generation = _generation;
    late final Future<DeviceCreatedWorktree> pending;
    pending = _create(attempt, generation)
        .then(
          (result) => result,
          onError: (Object error, StackTrace stack) {
            if (identical(attempt.pending, pending)) attempt.pending = null;
            Error.throwWithStackTrace(error, stack);
          },
        )
        .whenComplete(() {
          if (identical(_active[attempt.projectId], attempt)) {
            _active.remove(attempt.projectId);
          }
        });
    attempt.pending = pending;
    return pending;
  }

  Future<DeviceCreatedWorktree> _create(
    DeviceWorktreeCreateAttempt attempt,
    int generation,
  ) async {
    final project = await _project(attempt.projectId);
    _check(generation);
    if (attempt.worktreeId == null) {
      final multi = project['type'] == 'multi-repo';
      if (project['type'] == 'cowork') {
        throw const DeviceLinkException(
          'Choose a code project to create a worktree.',
        );
      }
      final ids = [
        for (final row
            in (project['worktrees'] as List? ?? const []).whereType<Map>())
          if (row['id'] is String) row['id'],
      ];
      final request = <String, Object?>{
        if (multi)
          'workspaceId': attempt.projectId
        else
          'projectId': attempt.projectId,
        if (!multi) 'repoPath': deviceLinkString(project, 'repoPath'),
        'existingWorktreeIds': ids,
      };
      attempt.mutationSent = true;
      Map<String, dynamic> result;
      try {
        result = deviceLinkObject(
          deviceChatDto(
            await ipc.invoke(
              multi ? 'workspace:create-worktree' : 'worktree:create',
              [request],
            ),
          ),
        );
        attempt.worktreeId = deviceLinkString(result, 'id');
        attempt.name = result['branchName'] as String? ?? 'New task';
        attempt.ready = result['setupPhase'] != 'git-pending';
        attempt.onChanged?.call();
      } catch (error) {
        if (error is DesktopIpcNotSent ||
            error is DesktopIpcRefusal &&
                error.code == 'remote_channel_unavailable') {
          attempt.mutationSent = false;
        } else {
          _uncertain.add(attempt.projectId);
        }
        rethrow;
      }
    }
    _check(generation);
    final key = '${attempt.projectId}/${attempt.worktreeId}';
    if (!attempt.ready) {
      final fresh = await _project(attempt.projectId);
      _check(generation);
      final row = (fresh['worktrees'] as List? ?? const [])
          .whereType<Map>()
          .where((row) => row['id'] == attempt.worktreeId)
          .firstOrNull;
      final creation = row?['creation'];
      if (row?['setupPhase'] == 'git-ready' ||
          creation is Map && creation['state'] == 'complete') {
        attempt.ready = true;
      }
      if (creation is Map && creation['state'] == 'recovery-required') {
        throw const DeviceLinkException(
          'Worktree setup needs attention on your computer.',
        );
      }
      if (!attempt.ready) {
        final cached = _git[key];
        final waiter = _waiters.putIfAbsent(
          key,
          () => Completer<Map<String, dynamic>>(),
        );
        final Map<String, dynamic> event;
        try {
          event =
              cached ??
              await waiter.future.timeout(const Duration(seconds: 45));
        } finally {
          if (identical(_waiters[key], waiter)) _waiters.remove(key);
        }
        _check(generation);
        if (event['error'] != null) {
          throw DeviceLinkException(event['error'] as String);
        }
        attempt.name = event['branchName'] as String? ?? attempt.name;
        attempt.ready = true;
      }
    }
    _git.remove(key);
    return DeviceCreatedWorktree(
      attempt.projectId,
      attempt.worktreeId!,
      attempt.name!,
    );
  }

  void _event(Map<String, dynamic> event) {
    if (!_connected || _disposed || event['name'] != 'ipc.push') return;
    final payload = deviceChatDto(event['payload']);
    if (payload is! Map ||
        ![
          'worktree:git-ready',
          'worktree:git-failed',
        ].contains(payload['channel'])) {
      return;
    }
    final args = payload['args'];
    if (args is! List || args.isEmpty || args.first is! Map<String, dynamic>) {
      return;
    }
    final row = deviceLinkObject(args.first), project = row['projectId'];
    if (!_active.containsKey(project)) return;
    final key = '$project/${row['worktreeId']}';
    final value = payload['channel'] == 'worktree:git-failed'
        ? {
            ...row,
            'error':
                'Worktree setup failed. Check your computer before retrying.',
          }
        : row;
    if (_git.length < 32 || _git.containsKey(key)) _git[key] = value;
    final waiter = _waiters[key];
    if (waiter != null && !waiter.isCompleted) waiter.complete(value);
  }

  Future<void> dispose() async {
    setConnected(false);
    _disposed = true;
    await _subscription.cancel();
  }
}
