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
  final _observations = <String, Map<String, dynamic>>{};
  final _liveClears = <String>{};
  final _branchNames = <String, String?>{};
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
      // Checkout changes can be missed offline, and a multi-repo worktree's
      // saved sidebar branch does not identify every child checkout. Rehydrate
      // observations and progress for this connection instead of reusing them.
      _states.clear();
      _observations.clear();
      _liveClears.clear();
      _branchNames.clear();
      _creationSteps.clear();
      _mergeSteps.clear();
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
    final generation = _generation, version = _versions[_key(ref)] ?? 0;
    unawaited(
      run(ref, RemotePrAction.refresh).catchError((Object error) {
        if (!_disposed &&
            generation == _generation &&
            version == (_versions[_key(ref)] ?? 0)) {
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
    final generation = _generation;
    final projectId = request['workspaceLocalId'] as String;
    final worktreeId = request['worktreeLocalId'] as String;
    final action = request['action'];
    if (action == 'get_actions') {
      final key = '$projectId/$worktreeId',
          version = _versions['$projectId/$worktreeId'] ?? 0;
      final workspace = await readDeviceWorkspace(
        ipc,
        DeviceChatRef(
          projectId: projectId,
          worktreeId: worktreeId,
          id: '',
          title: '',
        ),
      );
      if (_disposed ||
          !_connected ||
          generation != _generation ||
          version != (_versions[key] ?? 0)) {
        return remotePrActionDiscardedResult;
      }
      final branchName = workspace.worktree['branchName'] as String?;
      if (_branchNames.containsKey(key) && _branchNames[key] != branchName) {
        _forgetPr(key);
      }
      _branchNames[key] = branchName;
      final saved = _observe(key, workspace.worktree['lastKnownPrStatus']);
      // Establish branch identity before a fast refresh can push a partial
      // observation, especially after a checkout while disconnected.
      await ipc.invoke('github:request-fast-refresh', [
        {'projectId': projectId, 'worktreeId': worktreeId},
      ]);
      return {
        'busy': false,
        'repos': [
          for (final raw in saved?['repos'] as List? ?? const [])
            if (raw is Map<String, dynamic>)
              _actionRepo(raw, {
                'baseBranch':
                    (workspace.worktree['trackedRepoBaseBranches'] is Map
                        ? (workspace.worktree['trackedRepoBaseBranches']
                              as Map)[raw['repoId']]
                        : null) ??
                    workspace.worktree['trackedBaseBranch'],
                'headBranch': workspace.worktree['branchName'],
              }),
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

  void _forgetPr(String key) {
    _observations.remove(key);
    _liveClears.remove(key);
    _branchNames.remove(key);
    _creationSteps.remove(key);
    _mergeSteps.remove(key);
    _states[key] = const DevicePrState(repos: []);
  }

  /// Desktop broadcasts before persistence. Keep the newer observation when a
  /// projects read still contains an older sample, including no saved sample.
  Map<String, dynamic>? _observe(
    String key,
    Object? value, {
    bool fromPush = false,
  }) {
    final previous = _observations[key];
    // Null pushes have no timestamp. A saved sample cannot prove that it was
    // taken after that clear, so wait for a fresh live observation instead.
    if (!fromPush && _liveClears.contains(key)) return previous;
    if (value is! Map<String, dynamic> || value['repos'] is! List) {
      return previous;
    }
    final before = DateTime.tryParse(
      previous?['lastCheckedAt'] as String? ?? '',
    );
    final next = DateTime.tryParse(value['lastCheckedAt'] as String? ?? '');
    if (fromPush && _liveClears.contains(key) && next == null) return previous;
    if (before != null && (next == null || !next.isAfter(before))) {
      return previous;
    }
    _liveClears.remove(key);
    final oldRows = (previous?['repos'] as List? ?? const [])
        .whereType<Map<String, dynamic>>();
    return _observations[key] = {
      ...value,
      'repos': [
        for (final row
            in (value['repos'] as List).whereType<Map<String, dynamic>>())
          if (row['prLookupAvailable'] == false)
            oldRows
                    .where((old) => old['repoId'] == row['repoId'])
                    .firstOrNull ??
                row
          else
            row,
      ],
    };
  }

  Map<String, dynamic> _actionRepo(
    Map<String, dynamic> raw, [
    Map<String, dynamic> branches = const {},
  ]) => {
    ...raw,
    ...branches,
    if (raw['status'] is Map<String, dynamic>)
      'status': {
        ...deviceLinkObject(raw['status']),
        'number': (raw['status'] as Map)['prNumber'],
        'url': (raw['status'] as Map)['prUrl'],
        'checkDetails': [
          for (final check
              in ((raw['status'] as Map)['checkDetails'] as List? ?? const [])
                  .whereType<Map<String, dynamic>>())
            {
              ...check,
              'status': switch (check['status']) {
                'passing' => 'success',
                'failing' => 'failure',
                final value => value,
              },
            },
        ],
      },
  };

  RemotePrRepo _parseRepo(Map<String, dynamic> row) {
    deviceLinkString(row, 'repoId');
    final repo = RemotePrRepo.fromJson(row), status = row['status'];
    return status is Map<String, dynamic> && repo.pr != null
        ? repo.withPr(
            repo.pr!.withMergeQueue(
              RemotePrMergeQueue.tryParse(status['mergeQueue']),
            ),
          )
        : repo;
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
        repos.add(_parseRepo(deviceLinkObject(raw)));
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
    if (channel == 'worktree:branch-changed') {
      if (row['branchName'] is! String ||
          (ref == null && !_states.containsKey(key))) {
        return;
      }
      // A repository checkout also invalidates a multi-repo worktree's PRs.
      // Retire reads before starting one for the newly persisted branch.
      _versions[key] = (_versions[key] ?? 0) + 1;
      _reads.remove(key);
      _forgetPr(key);
      _notify();
      if (ref != null) _reload(ref);
      return;
    }
    if (ref == null ||
        !const [
          'github:pr-status-event',
          'github:pr-creation-progress',
          'github:merge-pr-progress',
        ].contains(channel)) {
      return;
    }
    _versions[key] = (_versions[key] ?? 0) + 1;
    if (channel == 'github:pr-status-event') {
      if (row['status'] == null) _liveClears.add(key);
      // A live null is a confirmed clear. Keep the previous sample's ordering
      // marker so a later read cannot restore that same saved PR.
      final observed = row['status'] == null
          ? _observations[key] = {
              'repos': <Map<String, dynamic>>[],
              'lastCheckedAt': _observations[key]?['lastCheckedAt'],
            }
          : _observe(key, row['status'], fromPush: true);
      if (observed == null) return;
      final previous = state(ref);
      _states[key] = DevicePrState(
        repos: List.unmodifiable([
          for (final raw
              in (observed['repos'] as List).whereType<Map<String, dynamic>>())
            _parseRepo(_actionRepo(raw)),
        ]),
        busy: previous.busy,
        progress: previous.progress,
      );
      _notify();
      return;
    }
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
