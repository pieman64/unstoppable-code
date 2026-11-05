import 'hook_repository.dart';
import 'todos.dart';
import 'workspace.dart';
import 'pr_repository.dart';
import '../pipelines/repository.dart';
import 'dart:async';
import 'package:mobile/data/models/computer_activity/activity.dart';
import '../chats/dto.dart';
import '../chats/models.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import '../files/repository.dart';

final class DeviceActivitySnapshot {
  const DeviceActivitySnapshot({
    this.activity = const RemoteWorktreeActivity(),
    this.filesError,
    this.errors = const [],
    this.loading = false,
  });
  final RemoteWorktreeActivity activity;
  final String? filesError;
  final List<String> errors;
  final bool loading;
}

/// Scoped desktop activity composed from separate read/control repositories.
/// One instance belongs to one computer;
/// identical project/chat ids on another computer never address these caches.
final class DeviceActivityRepository {
  DeviceActivityRepository(this.ipc, {this.createTimer = Timer.new})
    : diffs = DeviceFileDiffRepository(ipc, createTimer: createTimer),
      prs = DevicePrRepository(ipc),
      pipelines = DevicePipelineRepository(ipc),
      hooks = DeviceHookRepository(ipc) {
    _subscription = ipc.events.listen(_event);
    _prSubscription = prs.updates.listen((_) => _notify());
    _pipelineSubscription = pipelines.updates.listen((_) => _notify());
    _hookSubscription = hooks.updates.listen((_) => _notify());
  }
  final DesktopIpc ipc;
  final DeviceFileDiffRepository diffs;
  final Timer Function(Duration, void Function()) createTimer;
  final DevicePrRepository prs;
  final DevicePipelineRepository pipelines;
  final DeviceHookRepository hooks;
  late final StreamSubscription<void> _hookSubscription;
  late final StreamSubscription<void> _prSubscription;
  late final StreamSubscription<void> _pipelineSubscription;
  final _updates = StreamController<void>.broadcast();
  Stream<void> get updates => _updates.stream;
  final _workspaceKinds = <String, String>{};
  void setWorkspaceKind(String id, String kind) => _workspaceKinds[id] = kind;
  String? workspaceKind(String id) => _workspaceKinds[id];
  final _snapshots = <String, DeviceActivitySnapshot>{};
  final _todos = <String, DeviceTodos>{};
  String? todoUnavailableReason(DeviceChatRef ref) {
    final current = _todos[_key(ref)];
    if (current == null ||
        (!current.lists.any((list) => list.chatId == ref.id) &&
            !current.unavailable.contains(ref.id))) {
      return 'Todos are loading…';
    }
    return current.unavailable.contains(ref.id)
        ? 'Update your computer to load todos.'
        : null;
  }

  void updateChats(DeviceChatRef ref, Iterable<Map<String, dynamic>> tabs) {
    if (_disposed) return;
    final key = _key(ref), next = deviceTodos(tabs);
    if (_todos[key]?.signature == next.signature) return;
    _todos[key] = next;
    final previous = snapshot(ref);
    _snapshots[key] = DeviceActivitySnapshot(
      activity: previous.activity.withTodoLists(next.lists),
      errors: previous.errors,
      filesError: previous.filesError,
      loading: previous.loading,
    );
    _notify();
  }

  final _reads = <String, Future<void>>{};
  final _watching = <String, DeviceChatRef>{};
  StreamSubscription<Map<String, dynamic>>? _subscription;
  Timer? _refresh;
  int _generation = 0;
  bool _disposed = false, _connected = false;
  String _key(DeviceChatRef ref) => '${ref.projectId}/${ref.worktreeId}';
  DeviceActivitySnapshot snapshot(DeviceChatRef ref) {
    final current =
            _snapshots[_key(ref)] ??
            const DeviceActivitySnapshot(loading: true),
        configured = hooks.state(ref).hooks;
    return configured == null
        ? current
        : DeviceActivitySnapshot(
            activity: current.activity.copyWith(hookDescriptors: configured),
            filesError: current.filesError,
            errors: current.errors,
            loading: current.loading,
          );
  }

  void _notify() {
    if (!_disposed) _updates.add(null);
  }

  bool get connected => _connected;
  int get generation => _generation;

  Future<void> setConnected(bool connected) async {
    _generation++;
    _connected = connected;
    diffs.setConnected(connected);
    prs.setConnected(connected);
    pipelines.setConnected(connected);
    hooks.setConnected(connected);
    _reads.clear();

    _refresh?.cancel();
    if (connected) {
      for (final ref in _watching.values.toList()) {
        unawaited(load(ref));
      }
    }
    _notify();
    await Future.wait(_reads.values.toList());
  }

  void Function() watch(DeviceChatRef ref) {
    final key = _key(ref);
    _watching[key] = ref;
    final releasePr = prs.watch(ref);
    final releasePipelines = pipelines.watch(ref);
    unawaited(load(ref));
    return () {
      releasePr();
      releasePipelines();
      if (identical(_watching[key], ref)) _watching.remove(key);
    };
  }

  Future<void> load(DeviceChatRef ref) {
    if (!_connected || _disposed) return Future.value();
    final key = _key(ref);
    final existing = _reads[key];
    if (existing != null) return existing;
    late final Future<void> pending;
    pending = Future.wait<void>([_load(ref), hooks.load(ref)])
        .then((_) {})
        .catchError((Object error) {
          // Validation failures must not escape a fire-and-forget drawer refresh.
          if (_disposed || !identical(_reads[key], pending)) return;
          final previous = snapshot(ref).activity;
          _snapshots[key] = DeviceActivitySnapshot(
            activity: previous,
            filesError: 'Could not load changed files. Refresh to retry.',
            errors: const [
              'Could not read activity from this computer. Refresh to retry.',
            ],
          );
          _notify();
        })
        .whenComplete(() {
          if (identical(_reads[key], pending)) _reads.remove(key);
        });
    _reads[key] = pending;
    return pending;
  }

  Future<Map<String, dynamic>> _scripts(DeviceChatRef ref) async {
    final workspace = await readDeviceWorkspace(ipc, ref);
    final scripts = <Map<String, dynamic>>[];
    for (final source in deviceEffectiveSources(
      workspace.project,
      ref.worktreeId,
      'effectiveScripts',
    )) {
      for (final entry in source.values.entries) {
        if (entry.value == null) continue;
        final info = deviceLinkObject(
          deviceChatDto(
            await ipc.invoke('script:source-info', [
              {
                'target': source.target,
                if (source.target == 'project')
                  'projectId': ref.projectId
                else
                  'workspaceId': ref.projectId,
                'worktreeId': ref.worktreeId,
                'repoId': ?source.repoId,
                'scriptName': entry.key,
              },
            ]),
          ),
        );
        if (info['effectiveCommand'] == null) continue;
        scripts.add({
          'name': entry.key,
          'label': info['scriptDisplayName'] ?? entry.key,
          'key': source.repoId == null
              ? '${source.target}:${entry.key}'
              : '${source.target}:${source.repoId}:${entry.key}',
          'target': source.target,
          'repoId': ?source.repoId,
        });
      }
    }
    return {'scripts': scripts};
  }

  Future<void> _load(DeviceChatRef ref) async {
    final generation = _generation, key = _key(ref);
    final previous = snapshot(ref).activity;
    _snapshots[key] = DeviceActivitySnapshot(activity: previous, loading: true);
    _notify();
    final errors = <String>[];
    Future<Object?> read(
      String channel,
      String label, [
      Map<String, dynamic>? args,
    ]) async {
      try {
        return deviceChatDto(await ipc.invoke(channel, [args ?? ref.scope]));
      } catch (cause) {
        errors.add(
          cause is DesktopIpcRefusal &&
                  cause.code == 'remote_channel_unavailable'
              ? 'Update your computer to load $label.'
              : 'Could not load $label. Refresh to retry.',
        );
        return null;
      }
    }

    final first = await Future.wait([
      read('activity:changed-files', 'changed files'),
      read('worktree-summary:load', 'summary'),
      read('tracked-plans:list', 'plans'),
    ]);
    if (_disposed || generation != _generation) return;
    final next = await Future.wait([
      read('script:load-worktree-runs', 'script runs', {
        ...ref.scope,
        'maxLines': 0,
      }),
      read('hook:load-worktree-runs', 'hook runs', {
        ...ref.scope,
        'maxLines': 0,
      }),
      _scripts(ref).catchError((Object _) {
        errors.add('Could not load configured scripts. Refresh to retry.');
        return <String, dynamic>{'scripts': <Object?>[]};
      }),
    ]);
    if (_disposed || generation != _generation) return;
    List<Map<String, dynamic>> rows(Object? value) =>
        value is List ? value.whereType<Map<String, dynamic>>().toList() : [];
    final roster = first[0] is Map ? deviceLinkObject(first[0]) : null;
    final files = roster == null
        ? previous.changedFiles
        : [
            for (final source in ['uncommitted', 'committed'])
              for (final row in rows(roster[source]))
                RemoteChangedFile(
                  filePath: deviceLinkString(row, 'path'),
                  status: deviceLinkString(row, 'status'),
                  committed: source == 'committed',
                  repoId: row['repoId'] as String?,
                  repoName: row['repoName'] as String?,
                  insertions: (row['insertions'] as num?)?.toInt(),
                  deletions: (row['deletions'] as num?)?.toInt(),
                ),
          ];
    final summary = first[1] is Map ? deviceLinkObject(first[1]) : null;
    final plansValue = first[2] is Map
        ? deviceLinkObject(first[2])['plans']
        : first[2];
    final scripts = next[2] is Map
        ? rows(deviceLinkObject(next[2])['scripts'])
        : <Map<String, dynamic>>[];
    final activity = RemoteWorktreeActivity(
      todoLists: _todos[key]?.lists ?? previous.todoLists,
      changedFiles: files,
      summary: summary == null
          ? null
          : RemoteWorktreeSummary(
              title: summary['title'] as String? ?? '',
              description: summary['description'] as String? ?? '',
              generatedAt: summary['generatedAt'] as String?,
            ),
      plans: [
        for (final row in rows(plansValue))
          if (row['hidden'] != true && row['dismissedAt'] == null)
            RemoteActivityPlan(
              title: row['title'] as String? ?? 'Untitled plan',
              status: row['reviewStatus'] as String? ?? '',
            ),
      ],
      scriptDescriptors: [
        for (final row in scripts)
          RemoteScriptDescriptor(
            scriptKey: deviceLinkString(row, 'key'),
            scriptName: deviceLinkString(row, 'name'),
            name: deviceLinkString(row, 'label'),
            target: deviceLinkString(row, 'target'),
          ),
      ],
      scriptRuns: [
        for (final row in rows(next[0]))
          if (row['script'] is Map)
            RemoteScriptRun.fromJson({
              ...deviceLinkObject(row['script']),
              'name': deviceLinkObject(row['script'])['label'],
              'status': row['status'],
              'startedAt': row['startedAt'],
            }),
      ],
      hookRuns: [
        for (final row in rows(next[1]))
          RemoteActivityRun(
            name: row['triggerDisplayName'] as String? ?? 'Hook',
            status: row['status'] as String? ?? '',
          ),
      ],
    );
    _snapshots[key] = DeviceActivitySnapshot(
      activity: activity,
      errors: errors,
      filesError: roster == null
          ? 'Could not load changed files. Refresh to retry.'
          : null,
    );
    _notify();
  }

  void _event(Map<String, dynamic> event) {
    if (!_connected || _watching.isEmpty || event['name'] != 'ipc.push') return;
    final push = event['payload'];
    if (push is! Map ||
        !const [
          'worktrees:file-changed',
          'workspace:worktrees-updated',
          'worktree-summary:updated',
          'tracked-plans:updated',
          'script:started',
          'script:complete',
          'hook:started',
          'hook:complete',
        ].contains(push['channel'])) {
      return;
    }
    _refresh?.cancel();
    _refresh = createTimer(const Duration(seconds: 2), () {
      for (final ref in _watching.values.toList()) {
        unawaited(load(ref));
      }
    });
  }

  Future<void> dispose() async {
    _disposed = true;
    _generation++;
    _refresh?.cancel();
    await _subscription?.cancel();
    await diffs.dispose();
    await _prSubscription.cancel();
    await prs.dispose();
    await _pipelineSubscription.cancel();
    await pipelines.dispose();
    await _hookSubscription.cancel();
    await hooks.dispose();
    await _updates.close();
  }
}
