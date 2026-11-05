import 'dart:async';
import 'package:mobile/data/models/computer_activity/activity.dart';
import '../chats/dto.dart';
import '../chats/models.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'workspace.dart';

final class DeviceHookState {
  const DeviceHookState({this.hooks, this.error});
  final List<RemoteHookDescriptor>? hooks;
  final String? error;
}

/// One peer's configured hooks. Writes serialize per worktree and send desired
/// pause state using a fresh full-key read before the existing replace call.
final class DeviceHookRepository {
  DeviceHookRepository(this.ipc);
  final DesktopIpc ipc;
  final _updates = StreamController<void>.broadcast();
  Stream<void> get updates => _updates.stream;
  final _states = <String, DeviceHookState>{};
  final _reads = <String, Future<void>>{}, _writes = <String, Future<void>>{};
  final _versions = <String, int>{};
  bool _connected = false, _disposed = false;
  int _generation = 0;
  String _key(DeviceChatRef ref) => '${ref.projectId}/${ref.worktreeId}';
  DeviceHookState state(DeviceChatRef ref) =>
      _states[_key(ref)] ?? const DeviceHookState();
  void _notify() {
    if (!_disposed) _updates.add(null);
  }

  void setConnected(bool value) {
    _connected = value;
    _generation++;
    _reads.clear();
    _writes.clear();
  }

  Future<List<RemoteHookDescriptor>> _request(
    DeviceChatRef ref,
    Map<String, Object?> action,
  ) async {
    if (!_connected || _disposed) {
      throw const DeviceLinkException('Connect to a computer first.');
    }
    final generation = _generation;
    final workspace = await readDeviceWorkspace(ipc, ref);
    final paused = {
      ...(workspace.worktree['pausedHookKeys'] as List? ?? const [])
          .whereType<String>(),
    };
    final rows = <Map<String, dynamic>>[];
    for (final source in deviceEffectiveSources(
      workspace.project,
      ref.worktreeId,
      'effectiveHooks',
    )) {
      for (final entry in source.values.entries) {
        if (entry.value is! List || (entry.value as List).isEmpty) continue;
        final key = source.repoId == null
            ? '${source.target}:${entry.key}'
            : '${source.target}:${source.repoId}:${entry.key}';
        final info = deviceLinkObject(
          deviceChatDto(
            await ipc.invoke('hook:source-info', [
              {
                'target': source.target,
                if (source.target == 'project')
                  'projectId': ref.projectId
                else
                  'workspaceId': ref.projectId,
                'worktreeId': ref.worktreeId,
                'repoId': ?source.repoId,
                'triggerName': entry.key,
              },
            ]),
          ),
        );
        final label = info['triggerDisplayName'] as String? ?? entry.key;
        rows.add({
          'workspaceLocalId': ref.projectId,
          'worktreeLocalId': ref.worktreeId,
          'name': source.target == 'project'
              ? label
              : '${source.repoName ?? 'Workspace root'} — $label',
          'hookKey': key,
          'triggerName': entry.key,
          'paused': paused.contains(key),
        });
      }
    }
    if (_disposed || generation != _generation || !_connected) {
      throw const DeviceLinkException(
        'The computer connection changed. Refresh to retry.',
      );
    }
    if (action['action'] == 'set_paused') {
      final key = action['hookKey'];
      if (!rows.any((row) => row['hookKey'] == key)) {
        throw const DeviceLinkException(
          'Refresh hooks before changing this hook.',
        );
      }
      if (action['paused'] == true) {
        paused.add(key as String);
      } else {
        paused.remove(key);
      }
      await ipc.invoke('worktree:set-paused-hooks', [
        {...ref.scope, 'pausedHookKeys': paused.toList()},
      ]);
      return _request(ref, {'action': 'list'});
    }
    if (_disposed || generation != _generation || !_connected) {
      throw const DeviceLinkException(
        'The computer connection changed. Refresh to retry.',
      );
    }
    return List.unmodifiable([
      for (final raw in rows) _descriptor(ref, deviceLinkObject(raw)),
    ]);
  }

  RemoteHookDescriptor _descriptor(
    DeviceChatRef ref,
    Map<String, dynamic> row,
  ) {
    if (row['workspaceLocalId'] != ref.projectId ||
        row['worktreeLocalId'] != ref.worktreeId) {
      throw const DeviceLinkException(
        'The computer sent hooks for a different worktree.',
      );
    }
    deviceLinkString(row, 'name');
    deviceLinkString(row, 'hookKey');
    return RemoteHookDescriptor.fromJson(row);
  }

  Future<void> load(DeviceChatRef ref) {
    final key = _key(ref), existing = _reads[_key(ref)];
    if (existing != null) return existing;
    final generation = _generation, version = _versions[key] ?? 0;
    late final Future<void> pending;
    pending = () async {
      try {
        final hooks = await _request(ref, {'action': 'list'});
        if (version == (_versions[key] ?? 0)) {
          _states[key] = DeviceHookState(hooks: hooks);
        }
      } catch (error) {
        if (generation == _generation &&
            !_disposed &&
            version == (_versions[key] ?? 0)) {
          _states[key] = DeviceHookState(
            hooks: state(ref).hooks,
            error: error is DeviceLinkException
                ? error.message
                : 'Could not load configured hooks. Refresh to retry.',
          );
        }
      } finally {
        if (identical(_reads[key], pending)) _reads.remove(key);
        _notify();
      }
    }();
    _reads[key] = pending;
    return pending;
  }

  Future<void> setPaused(DeviceChatRef ref, String hookKey, bool paused) {
    final key = _key(ref), generation = _generation;
    final previous = _writes[key] ?? Future<void>.value();
    late final Future<void> next;
    next = previous
        .catchError((Object _) {})
        .then((_) async {
          if (generation != _generation || _disposed) return;
          _versions[key] = (_versions[key] ?? 0) + 1;
          try {
            final hooks = await _request(ref, {
              'action': 'set_paused',
              'hookKey': hookKey,
              'paused': paused,
            });
            _states[key] = DeviceHookState(hooks: hooks);
          } catch (error) {
            if (generation == _generation && !_disposed) {
              _states[key] = DeviceHookState(
                hooks: state(ref).hooks,
                error: error is DeviceLinkException
                    ? error.message
                    : 'Could not change this hook. Refresh to check its state.',
              );
            }
          } finally {
            _notify();
          }
        })
        .whenComplete(() {
          if (identical(_writes[key], next)) _writes.remove(key);
        });
    _writes[key] = next;
    return next;
  }

  Future<void> dispose() async {
    _disposed = true;
    _generation++;
    await _updates.close();
  }
}
