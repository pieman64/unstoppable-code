import 'dart:async';
import '../chats/dto.dart';
import '../chats/state.dart';
import '../chats/settings.dart';
import '../desktop/ipc.dart';
import '../pipelines/repository.dart';
import '../protocol.dart';
import 'package:mobile/data/models/composer_work.dart';
import 'projection.dart';

/// Reads fail transiently while chat hydration fills the session's request
/// slots or the computer is slow to answer. Retry quietly before reporting.
const _retryDelays = [
  Duration(seconds: 1),
  Duration(seconds: 2),
  Duration(seconds: 4),
];
const _failedMessage =
    "Couldn't load some background work. The rest is listed.";
const _unavailableMessage = 'Update your computer to show all background work.';

/// One mounted chat on one peer. Events invalidate reads; generations prevent
/// disconnected or superseded responses from replacing a newer observation.
final class DeviceWorkDrawerRepository {
  DeviceWorkDrawerRepository(
    this.ipc,
    this.pipelines, {
    this.createTimer = Timer.new,
  }) {
    _events = ipc.events.listen(_event);
    _pipelineEvents = pipelines.updates.listen((_) => _notify());
  }
  final DesktopIpc ipc;
  final DevicePipelineRepository pipelines;
  final Timer Function(Duration, void Function()) createTimer;
  final _updates = StreamController<void>.broadcast();
  Stream<void> get updates => _updates.stream;
  late final StreamSubscription<Map<String, dynamic>> _events;
  late final StreamSubscription<void> _pipelineEvents;
  void Function()? _releasePipelines;
  DeviceChatState? _chat;
  bool _online = false, _ready = false, _disposed = false;
  int _generation = 0, _attempt = 0;
  Timer? _retry;
  Future<void>? _read;
  bool _dirty = false;
  List<Map<String, dynamic>> _tasks = [], _watchers = [], _delegations = [];
  List<Map<String, dynamic>> _agents = [], _queue = [];
  List<String> _errors = [];
  final _actionErrors = <String, String>{};
  final _seen = <String>{};
  final _observations = <String, WorkItem>{};
  final _busy = <String>{};
  bool busy(String id) => _busy.contains(id);

  void update(DeviceChatState chat, {required bool online, bool ready = true}) {
    final changed = _chat?.ref.key != chat.ref.key;
    final reconnect = online && !_online;
    final disconnected = !online && _online;
    final becameReady = online && ready && !_ready;
    _chat = chat;
    _online = online;
    _ready = ready;
    if (changed || disconnected || reconnect) {
      _generation++;
      _read = null;
      _dirty = false;
      _busy.clear();
      _cancelRetry();
    }
    if (changed) {
      _tasks = [];
      _watchers = [];
      _delegations = [];
      _agents = [];
      _queue = [];
      _errors = [];
      _actionErrors.clear();
      _seen.clear();
      _observations.clear();
      _releasePipelines?.call();
      _releasePipelines = null;
    }
    // Same-chat transcript recovery pauses reads without invalidating actions
    // already sent to this connection or clearing their single-flight guards.
    if (online && !ready && _read != null) _dirty = true;
    if (online && ready && (changed || reconnect || becameReady)) {
      _releasePipelines ??= pipelines.watch(chat.ref);
      unawaited(refresh());
    }
  }

  WorkDrawerState get state {
    final chat = _chat;
    if (chat == null) return const WorkDrawerState();
    final projected = projectWork(
      chat: chat,
      tasks: _tasks,
      watchers: _watchers,
      delegations: _delegations,
      pipelines: pipelines.runs(chat.ref),
      agents: _agents,
      queue: _queue,
    );
    for (final item in projected) {
      if (item.group == WorkGroup.pullRequests) _observations[item.id] = item;
      if ((item.kind == WorkKind.pipeline || item.kind == WorkKind.github) &&
          !item.finished) {
        _seen.add(item.id);
      }
      if (item.finished && _seen.contains(item.id)) {
        _observations[item.id] = item;
      }
    }
    final ids = projected.map((i) => i.id).toSet();
    return WorkDrawerState(
      items: [
        for (final item in projected)
          if (!item.finished || _seen.contains(item.id)) item,
        for (final item in _observations.values)
          if (!ids.contains(item.id)) item.withWatcherCount(0),
      ],
      errors: [
        ..._errors,
        ..._actionErrors.values,
        ?pipelines.error(chat.ref),
        if (!_online && projected.isNotEmpty)
          'Reconnect to update background work.',
      ],
    );
  }

  void _cancelRetry() {
    _retry?.cancel();
    _retry = null;
    _attempt = 0;
  }

  void _notify() {
    if (!_disposed) _updates.add(null);
  }

  Future<void> retry() {
    if (_disposed || !_online || !_ready) return Future.value();
    _actionErrors.clear();
    _cancelRetry();
    return refresh();
  }

  Future<void> refresh() {
    if (_disposed || !_online || !_ready || _chat == null) {
      return Future.value();
    }
    if (_read case final pending?) return pending;
    // A fresh read supersedes a scheduled retry; its own failure reschedules.
    _retry?.cancel();
    _retry = null;
    final generation = _generation, chat = _chat!;
    var failed = false, unavailable = false;
    Duration? retryAfter;
    Future<Object?> read(
      String channel, [
      List<Object?> args = const [],
    ]) async {
      if (_disposed || generation != _generation || !_online || !_ready) {
        return null;
      }
      try {
        final value = deviceChatDto(await ipc.invoke(channel, args));
        final valid = switch (channel) {
          'activity:list-live-bg-tasks' => workObject(value)['chats'] is Map,
          'managed-delegation:tree' =>
            workObject(value)['ok'] == true &&
                workObject(value)['entries'] is List,
          _ => value is List,
        };
        if (!valid) throw const FormatException('Invalid work observation');
        return value;
      } catch (error) {
        if (error is DesktopIpcRefusal &&
            error.code == 'remote_channel_unavailable') {
          unavailable = true;
        } else {
          failed = true;
        }
        return null;
      }
    }

    // The encrypted desktop session admits eight outstanding RPCs total.
    // Keep one drawer read in flight so chat hydration, streaming controls and
    // model discovery retain capacity on the same connection.
    Future<List<Object?>> readSnapshot() async => [
      await read('activity:list-live-bg-tasks', [chat.ref.scope]),
      await read('app-advisor:watchers-list', [
        {'destination': chat.ref.target},
      ]),
      await read('app-advisor:watchers-completed-list'),
      await read('managed-delegation:activity-list'),
      await read('managed-delegation:tree', [chat.ref.target]),
      await read('chat:queue-get-snapshot', [chat.ref.scope]),
    ];
    late final Future<void> pending;
    pending = readSnapshot()
        .then((values) async {
          if (_disposed || generation != _generation) return;
          if (!_ready) {
            _dirty = true;
            return;
          }
          // Commit each observation even while pushes arrive. The coalesced
          // dirty pass catches newer changes without starving streaming chats.
          if (values[0] is Map) {
            _tasks = workRows(
              workObject(
                workObject(workObject(values[0])['chats'])[chat.ref.id],
              )['liveTasks'],
            );
          }
          if (values[1] is List) {
            _watchers = [
              ...workRows(values[1]),
              ...workRows(values[2]),
            ].where((w) => watcherMatches(w, chat)).toList();
          }
          if (values[3] is List) _delegations = workRows(values[3]);
          if (workObject(values[4])['ok'] == true) {
            _agents = workRows(workObject(values[4])['entries']);
          }
          if (values[5] is List) {
            _queue = workRows(
              workRows(values[5])
                  .where(
                    (row) =>
                        chat.ref.matchesScope(row) &&
                        row['chatId'] == chat.ref.id,
                  )
                  .firstOrNull?['queue'],
            );
          }
          // Unavailable channels need a desktop update, so retrying can't
          // help. Other failures report once their retries run out, and a
          // failure already shown stays until a read settles it.
          final retrying = failed && _attempt < _retryDelays.length;
          final shown = _errors.contains(_failedMessage);
          if (retrying) retryAfter = _retryDelays[_attempt++];
          if (!failed) _attempt = 0;
          _errors = [
            if (failed && (!retrying || shown)) _failedMessage,
            if (unavailable) _unavailableMessage,
          ];
          // The drawer combines pipeline errors with its own observations.
          // Retry a failed pipeline read too, after releasing the drawer RPC.
          if (pipelines.error(chat.ref) != null) {
            await pipelines.load(chat.ref);
          }
        })
        .whenComplete(() {
          if (_disposed || generation != _generation) return;
          if (identical(_read, pending)) _read = null;
          _notify();
          if (_dirty) {
            _dirty = false;
            unawaited(refresh());
          } else if (retryAfter case final delay?) {
            _retry = createTimer(delay, () {
              _retry = null;
              if (!_disposed && generation == _generation) unawaited(refresh());
            });
          }
        });
    _read = pending;
    return pending;
  }

  Future<void> act(
    WorkItem item, {
    WorkAction? action,
    bool notifySubscriber = false,
  }) async {
    action ??= item.action;
    final chat = _chat;
    if (!_online ||
        !_ready ||
        chat == null ||
        action == null ||
        !_busy.add(item.id)) {
      return;
    }
    final generation = _generation;
    _actionErrors.remove(item.id);
    _notify();
    try {
      final result = deviceChatDto(await switch (action) {
        WorkAction.stopTask => ipc.invoke('activity:stop-bg-process', [
          {...chat.ref.target, 'taskId': item.actionId},
        ]),
        WorkAction.stopDelegates => ipc.invoke('managed-delegation:stop-all', [
          chat.ref.target,
        ]),
        WorkAction.stopDelegate => ipc.invoke('managed-delegation:stop', [
          {...chat.ref.target, 'delegationId': item.actionId},
        ]),
        WorkAction.cancelQueued ||
        WorkAction.forceQueued ||
        WorkAction.steerQueued =>
          DeviceChatSettings(ipc)
              .command(chat.ref, {
                'type': switch (action) {
                  WorkAction.cancelQueued => 'chat.cancel_queued_message',
                  WorkAction.forceQueued => 'chat.force_queued_message',
                  _ => 'chat.steer_queued_message',
                },
                'chatId': chat.ref.id,
                'queuedMessageId': item.actionId,
              })
              .then((_) => {'ok': true}),
        WorkAction.deleteWatcher => ipc.invoke('app-advisor:watcher-delete', [
          {'watcherId': item.actionId, 'notifySubscriber': notifySubscriber},
        ]),
      });
      if (_disposed || generation != _generation) return;
      if (result is Map && result['ok'] == false) {
        throw DeviceLinkException(
          workText(result['error']) ?? 'The computer refused this action.',
        );
      }
      if (action == WorkAction.stopTask &&
          !const [
            'stopped',
            'already-finished',
            'session-ended',
          ].contains(result)) {
        throw const DeviceLinkException(
          'Could not confirm that this task stopped. Refresh to check its state.',
        );
      }
      if ((action == WorkAction.stopDelegate ||
              action == WorkAction.stopDelegates) &&
          workObject(result)['ok'] != true) {
        throw const DeviceLinkException(
          'Could not confirm that the delegates stopped. Refresh to check their state.',
        );
      }
      if (action == WorkAction.deleteWatcher &&
          workObject(result)['ok'] != true) {
        throw const DeviceLinkException(
          'Could not confirm watcher deletion. Refresh to check its state.',
        );
      }
      await refresh();
    } catch (error) {
      if (!_disposed && generation == _generation) {
        _actionErrors[item.id] = error is DeviceLinkException
            ? error.message
            : 'Could not confirm the action. Refresh to check its state.';
      }
    } finally {
      if (!_disposed && generation == _generation) {
        _busy.remove(item.id);
        _notify();
      }
    }
  }

  void _event(Map<String, dynamic> event) {
    if (_disposed || !_online || !_ready || event['name'] != 'ipc.push') return;
    final push = workObject(event['payload']);
    final args = push['args'];
    final payload = args is List && args.isNotEmpty
        ? workObject(deviceChatDto(args.first))
        : const <String, dynamic>{};
    if (push['channel'] == 'chat:state-changed') {
      if (_chat?.ref.matchesScope(payload) != true ||
          !workRows(payload['changes']).any(
            (c) =>
                c['chatId'] == _chat?.ref.id &&
                c['type'] == 'delegation.card_state_updated',
          )) {
        return;
      }
    } else if (!const [
      'activity:live-bg-tasks-changed',
      'managed-delegation:activity-changed',
      'app-advisor:watchers-changed',
      'chat:queue-updated',
    ].contains(push['channel'])) {
      return;
    }
    if (const [
          'activity:live-bg-tasks-changed',
          'managed-delegation:activity-changed',
          'chat:queue-updated',
        ].contains(push['channel']) &&
        (_chat?.ref.matchesScope(payload) != true ||
            payload['chatId'] != _chat?.ref.id)) {
      return;
    }
    if (_read != null) {
      _dirty = true;
    } else {
      unawaited(refresh());
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    _generation++;
    _cancelRetry();
    _releasePipelines?.call();
    await _events.cancel();
    await _pipelineEvents.cancel();
    await _updates.close();
  }
}
