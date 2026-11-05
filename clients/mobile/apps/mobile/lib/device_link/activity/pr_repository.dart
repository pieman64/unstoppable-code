import 'dart:async';
import 'package:mobile/data/models/computer_activity/pr.dart';
import 'package:mobile/data/models/computer_activity/pr_merge_queue.dart';
import 'package:mobile/data/models/computer_activity/pr_progress.dart';
import '../chats/dto.dart';
import '../chats/models.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'workspace.dart';

final class DevicePrState {
  const DevicePrState({
    this.repos,
    this.busy = false,
    this.progress,
    this.error,
  });
  final List<RemotePrRepo>? repos;
  final bool busy;
  final RemotePrProgressState? progress;
  final String? error;
}

/// Per-computer saved PR observations and existing guarded mutation calls.
/// Cached observations do not imply fresh action eligibility.
final class DevicePrRepository {
  DevicePrRepository(this.ipc, {this.createTimer = Timer.new}) {
    _subscription = ipc.events.listen(_event);
  }
  final DesktopIpc ipc;
  final Timer Function(Duration, void Function()) createTimer;
  final _updates = StreamController<void>.broadcast();
  Stream<void> get updates => _updates.stream;
  late final StreamSubscription<Map<String, dynamic>> _subscription;
  final _states = <String, DevicePrState>{};
  final _reads = <String, Future<Map<String, dynamic>>>{};
  final _mutations = <String>{};
  final _versions = <String, int>{};
  final _creationSteps = <String, List<Map<String, dynamic>>>{};
  final _mergeSteps = <String, List<Map<String, dynamic>>>{};
  final _watching = <String, DeviceChatRef>{};
  Timer? _refresh;
  bool _connected = false, _disposed = false;
  int _generation = 0;
  String _key(DeviceChatRef ref) => '${ref.projectId}/${ref.worktreeId}';
  DevicePrState state(DeviceChatRef ref) =>
      _states[_key(ref)] ?? const DevicePrState();
  void _notify() {
    if (!_disposed) _updates.add(null);
  }

  void setConnected(bool value) {
    _generation++;
    _connected = value;
    _reads.clear();
    _mutations.clear();
    _refresh?.cancel();
    if (value) {
      for (final ref in _watching.values) {
        _reload(ref);
      }
    }
    _notify();
  }

  void Function() watch(DeviceChatRef ref) {
    _watching[_key(ref)] = ref;
    _reload(ref);
    return () {
      if (identical(_watching[_key(ref)], ref)) _watching.remove(_key(ref));
    };
  }

  void _reload(DeviceChatRef ref) {
    final generation = _generation;
    unawaited(
      run(ref, RemotePrAction.refresh).catchError((Object error) {
        if (!_disposed && generation == _generation) {
          final previous = state(ref);
          _states[_key(ref)] = DevicePrState(
            repos: previous.repos,
            busy: previous.busy,
            progress: previous.progress,
            error: error is DeviceLinkException
                ? error.message
                : 'Could not load pull requests. Refresh to retry.',
          );
          _notify();
        }
        return <String, dynamic>{};
      }),
    );
  }

  Future<Object?> _invoke(Map<String, Object?> request) async {
    final projectId = request['workspaceLocalId'] as String;
    final worktreeId = request['worktreeLocalId'] as String;
    final action = request['action'];
    if (action == 'get_actions') {
      final workspace = await readDeviceWorkspace(
        ipc,
        DeviceChatRef(
          projectId: projectId,
          worktreeId: worktreeId,
          id: '',
          title: '',
        ),
      );
      final saved = workspace.worktree['lastKnownPrStatus'];
      return {
        'busy': false,
        'repos': [
          for (final raw
              in saved is Map ? saved['repos'] as List? ?? const [] : const [])
            if (raw is Map<String, dynamic>)
              {
                ...raw,
                'baseBranch':
                    (workspace.worktree['trackedRepoBaseBranches'] is Map
                        ? (workspace.worktree['trackedRepoBaseBranches']
                              as Map)[raw['repoId']]
                        : null) ??
                    workspace.worktree['trackedBaseBranch'],
                'headBranch': workspace.worktree['branchName'],
                if (raw['status'] is Map)
                  'status': {
                    ...deviceLinkObject(raw['status']),
                    'number': (raw['status'] as Map)['prNumber'],
                    'url': (raw['status'] as Map)['prUrl'],
                  },
              },
        ],
      };
    }
    return ipc.invoke(
      action == 'create_auto' ? 'github:create-pr' : 'github:merge-pr',
      [
        {
          'projectId': projectId,
          'worktreeId': worktreeId,
          for (final key in [
            'repoIds',
            'expectedBaseBranch',
            'expectedHeadBranch',
            'expectedPrNumber',
            'confirmUnresolvedComments',
          ])
            if (request.containsKey(key)) key: request[key],
        },
      ],
    );
  }

  Future<Map<String, dynamic>> run(
    DeviceChatRef ref,
    RemotePrAction action, {
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) {
    if (!_connected || _disposed) {
      return Future.error(
        const DeviceLinkException('Connect to a computer first.'),
      );
    }
    final key = _key(ref);
    if (action == RemotePrAction.refresh) {
      final existing = _reads[key];
      if (existing != null) return existing;
      late final Future<Map<String, dynamic>> pending;
      pending = _run(ref, action).whenComplete(() {
        if (identical(_reads[key], pending)) _reads.remove(key);
      });
      _reads[key] = pending;
      return pending;
    }
    if (repoId == null ||
        repoId.isEmpty ||
        identity == null ||
        (action == RemotePrAction.merge && identity.prNumber == null)) {
      return Future.error(
        const DeviceLinkException(
          'Refresh and select one repository before continuing.',
        ),
      );
    }
    if (!_mutations.add(key)) {
      return Future.error(
        const DeviceLinkException('A PR action is already running.'),
      );
    }
    final generation = _generation;
    return _run(
      ref,
      action,
      repoId: repoId,
      identity: identity,
      confirmUnresolvedComments: confirmUnresolvedComments,
    ).whenComplete(() {
      if (generation == _generation) _mutations.remove(key);
    });
  }

  Future<Map<String, dynamic>> _run(
    DeviceChatRef ref,
    RemotePrAction action, {
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) async {
    final key = _key(ref),
        generation = _generation,
        version = _versions[_key(ref)] ?? 0;
    final result = deviceLinkObject(
      deviceChatDto(
        await _invoke({
          'workspaceLocalId': ref.projectId,
          'worktreeLocalId': ref.worktreeId,
          'action': action.wireValue,
          if (repoId != null) 'repoIds': [repoId],
          if (identity != null) ...{
            'expectedBaseBranch': identity.baseBranch,
            'expectedHeadBranch': identity.headBranch,
            if (identity.prNumber != null)
              'expectedPrNumber': identity.prNumber,
          },
          if (action == RemotePrAction.merge)
            'confirmUnresolvedComments': confirmUnresolvedComments,
        }),
      ),
    );
    if (_disposed ||
        !_connected ||
        generation != _generation ||
        (action == RemotePrAction.refresh &&
            version != (_versions[key] ?? 0))) {
      return remotePrActionDiscardedResult;
    }
    if (action == RemotePrAction.refresh) {
      final rows = result['repos'];
      if (rows is! List || result['busy'] is! bool) {
        throw const DeviceLinkException(
          'The computer sent invalid pull request state.',
        );
      }
      final repos = <RemotePrRepo>[];
      for (final raw in rows) {
        final row = deviceLinkObject(raw);
        deviceLinkString(row, 'repoId');
        final repo = RemotePrRepo.fromJson(row), status = row['status'];
        repos.add(
          status is Map<String, dynamic> && repo.pr != null
              ? repo.withPr(
                  repo.pr!.withMergeQueue(
                    RemotePrMergeQueue.tryParse(status['mergeQueue']),
                  ),
                )
              : repo,
        );
      }
      _states[key] = DevicePrState(
        repos: List.unmodifiable(repos),
        busy: result['busy'] == true,
        progress: state(ref).progress,
      );
      _notify();
    }
    return result;
  }

  void _event(Map<String, dynamic> event) {
    if (!_connected || event['name'] != 'ipc.push') return;
    final push = deviceChatDto(event['payload']);
    if (push is! Map<String, dynamic>) return;
    final args = push['args'];
    if (args is! List || args.isEmpty || args.first is! Map<String, dynamic>) {
      return;
    }
    final row = deviceLinkObject(args.first), channel = push['channel'];
    final key = '${row['projectId']}/${row['worktreeId']}';
    final ref = _watching[key];
    if (ref == null ||
        !const [
          'github:pr-status-event',
          'github:pr-creation-progress',
          'github:merge-pr-progress',
        ].contains(channel)) {
      return;
    }
    _versions[key] = (_versions[key] ?? 0) + 1;
    if (channel != 'github:pr-status-event') {
      final creating = channel == 'github:pr-creation-progress';
      final steps = (creating ? _creationSteps : _mergeSteps).putIfAbsent(
        key,
        () => [],
      );
      final phase = row['phase'],
          previous = state(ref),
          progress = previous.progress;
      final settled = creating
          ? const [
              'done',
              'error',
            ].contains(progress?.creation?.currentPhase.wireValue)
          : const [
              'done',
              'error',
            ].contains(progress?.merge?.currentPhase.wireValue);
      if (settled && !const ['done', 'error'].contains(phase)) steps.clear();
      steps.add(row);
      if (steps.length > 100) steps.removeAt(0);
      _states[key] = DevicePrState(
        repos: previous.repos,
        busy: previous.busy,
        progress: RemotePrProgressState(
          creation: creating
              ? RemotePrCreationProgress.fromJson({
                  'currentPhase': phase,
                  'steps': steps,
                })
              : progress?.creation,
          merge: creating
              ? progress?.merge
              : RemoteMergePrProgress.fromJson({
                  'currentPhase': phase,
                  'steps': steps,
                }),
        ),
      );
      _notify();
    }
    _refresh?.cancel();
    _refresh = createTimer(const Duration(seconds: 2), () {
      for (final target in _watching.values) {
        _reload(target);
      }
    });
  }

  Future<void> dispose() async {
    _disposed = true;
    _generation++;
    _refresh?.cancel();
    await _subscription.cancel();
    await _updates.close();
  }
}
