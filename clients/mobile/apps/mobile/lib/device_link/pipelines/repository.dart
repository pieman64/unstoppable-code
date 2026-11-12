import 'dart:async';
import 'package:mobile/data/models/computer_activity/action_exception.dart';
import 'package:mobile/data/models/computer_activity/pipeline_content.dart';
import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'existing_ipc.dart';
import '../chats/dto.dart';
import '../chats/models.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';

final class _PipelineRefusal extends DeviceLinkException {
  const _PipelineRefusal(super.message);
}

/// One peer's portable pipeline projections. Raw execution pushes are only
/// invalidation hints: the host still resolves scope, paths and output policy.
final class DevicePipelineRepository {
  DevicePipelineRepository(this.ipc, {this.createTimer = Timer.new})
    : _existing = DevicePipelineIpc(ipc) {
    _subscription = ipc.events.listen(_event);
  }
  final DesktopIpc ipc;
  final Timer Function(Duration, void Function()) createTimer;
  final DevicePipelineIpc _existing;
  final _updates = StreamController<void>.broadcast();
  Stream<void> get updates => _updates.stream;
  late final StreamSubscription<Map<String, dynamic>> _subscription;
  final _runs = <String, Map<String, RemotePipelineRun>>{};
  final _pipelines = <String, List<RemotePipelineDescriptor>>{};
  final _errors = <String, String>{};
  final _rowVersions = <String, int>{};
  final _eventVersions = <String, int>{};
  int _revision = 0;
  final _pending = <String, Future<RemotePipelineRun?>>{};
  final _starts = <String, ({String id, String payload})>{};
  final _loads = <String, Future<void>>{};
  final _actionErrors = <String, String>{};
  final _actions = <String, RemotePipelineRunAction>{};
  final _watching = <String, ({DeviceChatRef ref, int count})>{};
  final _selectedLogs = <String, ({String job, String step})>{};
  final _dirty = <String, ({DeviceChatRef ref, String id})>{};
  Timer? _refresh;
  bool _connected = false, _disposed = false;
  int _generation = 0;
  bool get connected => _connected;
  int get connectionGeneration => _generation;
  String errorMessage(Object error) => error is RemoteControlException
      ? error.message
      : error is DeviceLinkException
      ? error.message
      : 'The request could not be confirmed. Refresh to check its state.';
  String _scope(DeviceChatRef ref) => '${ref.projectId}/${ref.worktreeId}';
  String _key(DeviceChatRef ref, String id) => '${_scope(ref)}/$id';
  List<RemotePipelineRun> runs(DeviceChatRef ref) {
    final rows =
        _runs[_scope(ref)]?.values.where((run) => !run.hidden).toList() ??
        <RemotePipelineRun>[];
    rows.sort(comparePipelineRunRecency);
    return List.unmodifiable(rows);
  }

  List<RemotePipelineDescriptor> pipelines(DeviceChatRef ref) =>
      _pipelines[_scope(ref)] ?? const [];
  RemotePipelineRun? run(DeviceChatRef ref, String id) =>
      _runs[_scope(ref)]?[id];
  String? actionError(DeviceChatRef ref, String id) =>
      _actionErrors[_key(ref, id)];
  void clearActionError(DeviceChatRef ref, String id) {
    _actionErrors.remove(_key(ref, id));
    _notify();
  }

  String? error(DeviceChatRef ref, [String? id]) =>
      _errors[id == null ? _scope(ref) : _key(ref, id)];
  bool pending(DeviceChatRef ref, String id) =>
      _pending.containsKey(_key(ref, id));
  RemotePipelineRunAction? pendingAction(DeviceChatRef ref, String id) =>
      _actions[_key(ref, id)];
  void _notify() {
    if (!_disposed) _updates.add(null);
  }

  void setConnected(bool value) {
    _connected = value;
    _generation++;
    _pending.clear();
    _loads.clear();
    _actions.clear();
    _dirty.clear();
    _selectedLogs.clear();
    _refresh?.cancel();
    _refresh = null;
    if (value) {
      for (final entry in _watching.values) {
        _reload(entry.ref);
      }
    }
    _notify();
  }

  void Function() watch(DeviceChatRef ref) {
    final key = _scope(ref), previous = _watching[_scope(ref)];
    _watching[key] = (ref: ref, count: (previous?.count ?? 0) + 1);
    _reload(ref);
    return () {
      final current = _watching[key];
      if (current == null) return;
      if (current.count == 1) {
        _watching.remove(key);
      } else {
        _watching[key] = (ref: current.ref, count: current.count - 1);
      }
    };
  }

  void _reload(DeviceChatRef ref) =>
      unawaited(load(ref).catchError((Object _) {}));
  Future<Map<String, dynamic>?> _request(
    DeviceChatRef ref,
    String action, [
    Map<String, Object?> args = const {},
    void Function()? onMutationSent,
  ]) async {
    if (!_connected || _disposed) {
      throw const RemoteControlException('Connect to a computer first.');
    }
    final generation = _generation;
    Object? raw;
    try {
      raw = deviceChatDto(
        await _existing.request(
          ref,
          action,
          args,
          () => !_disposed && _connected && generation == _generation,
          onMutationSent: onMutationSent,
        ),
      );
    } on DesktopIpcRefusal catch (error) {
      throw _PipelineRefusal(
        error.code == 'remote_channel_unavailable'
            ? 'This pipeline operation is unavailable on the connected computer.'
            : error.message,
      );
    }
    if (_disposed || !_connected || generation != _generation) {
      throw const RemoteControlException(
        'The computer connection changed. Refresh to retry.',
      );
    }
    return raw == null ? null : deviceLinkObject(raw);
  }

  RemotePipelineRun _parse(
    DeviceChatRef ref,
    Map<String, dynamic> row, {
    String? id,
  }) {
    final next = RemotePipelineRun.fromJson(row);
    if (next == null ||
        (id != null && next.localId != id) ||
        next.workspaceLocalId != ref.projectId ||
        next.worktreeLocalId != ref.worktreeId) {
      throw const RemoteControlException(
        'The computer sent pipeline state for a different worktree.',
      );
    }
    return next;
  }

  void _put(DeviceChatRef ref, RemotePipelineRun next) {
    final rows = _runs.putIfAbsent(_scope(ref), () => {});
    rows[next.localId] = rows[next.localId]?.mergeWith(next) ?? next;
    _rowVersions[_key(ref, next.localId)] = ++_revision;
  }

  Future<void> load(DeviceChatRef ref) {
    final key = _scope(ref), existing = _loads[_scope(ref)];
    if (existing != null) return existing;
    late final Future<void> pending;
    pending = _load(ref).whenComplete(() {
      if (identical(_loads[key], pending)) _loads.remove(key);
    });
    _loads[key] = pending;
    return pending;
  }

  Future<void> _load(DeviceChatRef ref) async {
    final key = _scope(ref), generation = _generation, revision = _revision;
    try {
      final values = await Future.wait([
        _request(ref, 'executions', {'limit': 50}),
        _request(ref, 'list'),
      ]);
      if (generation != _generation || _disposed) return;
      final rows = values[0]?['runs'], pipelines = values[1]?['pipelines'];
      if (rows is! List || pipelines is! List) {
        throw const RemoteControlException(
          'The computer sent invalid pipeline state.',
        );
      }
      final next = <String, RemotePipelineRun>{};
      for (final raw in rows) {
        final run = _parse(ref, deviceLinkObject(raw));
        next[run.localId] = _runs[key]?[run.localId]?.mergeWith(run) ?? run;
      }
      for (final current in _runs[key]?.values ?? <RemotePipelineRun>[]) {
        if ((_rowVersions[_key(ref, current.localId)] ?? 0) > revision) {
          next[current.localId] = current;
        }
      }
      _runs[key] = next;
      for (final id in next.keys) {
        _rowVersions[_key(ref, id)] = ++_revision;
      }
      _pipelines[key] = [
        for (final raw in pipelines)
          if (RemotePipelineDescriptor.fromJson(raw) case final descriptor?
              when descriptor.isDispatchable)
            descriptor,
      ];
      _errors.remove(key);
    } catch (error) {
      if (generation != _generation || _disposed) return;
      _errors[key] = errorMessage(error);
    }
    _notify();
  }

  Future<RemotePipelineRun?> get(DeviceChatRef ref, String id) {
    final key = _key(ref, id), existing = _pending[_key(ref, id)];
    if (existing != null) return existing;
    final generation = _generation,
        rowVersion = _rowVersions[key] ?? 0,
        eventVersion = _eventVersions[key] ?? 0;
    var superseded = false;
    late final Future<RemotePipelineRun?> pending;
    pending = () async {
      try {
        final row = await _request(ref, 'get', {'executionId': id});
        if (row == null) {
          throw const RemoteControlException(
            'This pipeline run is no longer available.',
          );
        }
        final next = _parse(ref, row, id: id);
        // Pushes invalidate reads but do not install a newer observation.
        // Accept this reply during streaming, then re-read if a push arrived.
        if (rowVersion != (_rowVersions[key] ?? 0)) {
          superseded = true;
          return run(ref, id);
        }
        _put(ref, next);
        _errors.remove(key);
        return next;
      } catch (error) {
        if (generation == _generation &&
            rowVersion == (_rowVersions[key] ?? 0) &&
            eventVersion == (_eventVersions[key] ?? 0) &&
            !_disposed) {
          _errors[key] = errorMessage(error);
        }
        return null;
      } finally {
        if (identical(_pending[key], pending)) _pending.remove(key);
        if (generation == _generation &&
            (superseded || eventVersion != (_eventVersions[key] ?? 0)) &&
            _watching.containsKey(_scope(ref))) {
          _queue(ref, id);
        }
        _notify();
      }
    }();
    _pending[key] = pending;
    _notify();
    return pending;
  }

  void clearLogSelection(DeviceChatRef ref, String id) =>
      _selectedLogs.remove(_key(ref, id));

  Future<void> log(
    DeviceChatRef ref,
    String id,
    String jobId,
    String stepId,
  ) async {
    final key = _key(ref, id),
        rowVersion = _rowVersions[_key(ref, id)] ?? 0,
        eventVersion = _eventVersions[_key(ref, id)] ?? 0;
    _selectedLogs[key] = (job: jobId, step: stepId);
    final value = await _request(ref, 'log', {
      'executionId': id,
      'jobId': jobId,
      'stepId': stepId,
    });
    if (rowVersion != (_rowVersions[key] ?? 0) ||
        eventVersion != (_eventVersions[key] ?? 0)) {
      return;
    }
    if (value?['run'] case final Map<String, dynamic> row) {
      _put(ref, _parse(ref, row, id: id));
      _notify();
    }
  }

  Future<void> control(
    DeviceChatRef ref,
    String id,
    RemotePipelineRunAction action,
  ) async {
    final key = _key(ref, id);
    if (_actions.containsKey(key)) return;
    final generation = _generation,
        rowVersion = _rowVersions[key] ?? 0,
        eventVersion = _eventVersions[key] ?? 0;
    _actions[key] = action;
    _notify();
    try {
      final value = await _request(ref, action.name, {
        'executionId': id,
        'commandId': chatId(),
      });
      if (value != null) {
        final next = _parse(ref, value, id: id);
        if (rowVersion == (_rowVersions[key] ?? 0)) {
          _put(ref, next);
          if (eventVersion != (_eventVersions[key] ?? 0)) _queue(ref, id);
        } else {
          // The mutation was sent once. Reconcile its outcome by reading,
          // without letting its late reply replace a newer observation.
          _queue(ref, id);
        }
      }
      _actionErrors.remove(key);
    } catch (error) {
      if (generation == _generation && !_disposed) {
        _actionErrors[key] = errorMessage(error);
      }
    } finally {
      if (generation == _generation) _actions.remove(key);
      _notify();
    }
  }

  Future<RemotePipelineDispatchForm> form(
    DeviceChatRef ref,
    String pipelineId, {
    required RemotePipelineOrigin origin,
  }) async => RemotePipelineDispatchForm.fromGetResult(
    (await _request(ref, 'definition', {
      'pipelineId': pipelineId,
      'origin': origin.name,
    }))!,
  );
  Future<String> start(
    DeviceChatRef ref,
    String pipelineId,
    Map<String, String> inputs, {
    Map<String, Object?>? modelConfig,
    required RemotePipelineOrigin origin,
  }) async {
    final key = '${_scope(ref)}/${origin.name}/$pipelineId';
    if (_starts.containsKey(key)) {
      throw const RemoteControlException(
        'The previous start is unconfirmed. Check pipeline runs before starting another run.',
      );
    }
    final request = (id: chatId(), payload: '');
    _starts[key] = request;
    var mutationSent = false;
    try {
      final result = await _request(ref, 'run', {
        'pipelineId': pipelineId,
        'origin': origin.name,
        'commandId': request.id,
        'inputs': inputs,
        'modelConfig': ?modelConfig,
      }, () => mutationSent = true);
      final id = deviceLinkString(result!, 'executionId');
      _starts.remove(key);
      await get(ref, id);
      return id;
    } on DesktopIpcNotSent {
      _starts.remove(key);
      rethrow;
    } on _PipelineRefusal {
      _starts.remove(key);
      rethrow;
    } catch (_) {
      if (!mutationSent) _starts.remove(key);
      rethrow;
    }
  }

  Future<RemotePipelineContentDocument> content(
    DeviceChatRef ref,
    String id,
    RemotePipelineContentSource source,
  ) async {
    if (!_connected || _disposed) {
      throw const RemoteControlException('Connect to a computer first.');
    }
    final generation = _generation;
    final document = await _existing.content(ref, id, source.toJson());
    if (_disposed || !_connected || generation != _generation) {
      throw const RemoteControlException(
        'The computer connection changed. Refresh to retry.',
      );
    }
    return document;
  }

  void _event(Map<String, dynamic> event) {
    if (!_connected || event['name'] != 'ipc.push') return;
    final push = event['payload'];
    if (push is! Map ||
        !const [
          'pipelines:execution-event',
          'pipelines:step-output-event',
        ].contains(push['channel'])) {
      return;
    }
    final args = push['args'];
    if (args is! List || args.isEmpty || args.first is! Map) return;
    final row = args.first as Map,
        id = row['executionId'],
        state = row['state'];
    if (id is! String) return;
    for (final entry in _watching.values) {
      final ref = entry.ref;
      if (state is Map
          ? state['project_id'] != ref.projectId ||
                state['worktree_id'] != ref.worktreeId
          : run(ref, id) == null) {
        continue;
      }
      final key = _key(ref, id);
      _eventVersions[key] = (_eventVersions[key] ?? 0) + 1;
      _queue(ref, id);
    }
  }

  void _queue(DeviceChatRef ref, String id) {
    _dirty[_key(ref, id)] = (ref: ref, id: id);
    _refresh ??= createTimer(const Duration(milliseconds: 500), () {
      _refresh = null;
      final targets = _dirty.values.toList();
      _dirty.clear();
      for (final target in targets) {
        unawaited(
          get(target.ref, target.id)
              .then((run) async {
                final selection = _selectedLogs[_key(target.ref, target.id)];
                if (run != null && selection != null) {
                  await log(
                    target.ref,
                    target.id,
                    selection.job,
                    selection.step,
                  );
                }
              })
              .catchError((Object _) {}),
        );
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
