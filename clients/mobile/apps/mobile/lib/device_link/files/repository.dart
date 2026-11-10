import 'dart:async';
import 'package:mobile/data/models/changed_file.dart';
import 'package:mobile/data/models/file_diff.dart';
import 'package:mobile/data/models/text_diff.dart';
import '../cache/observable_lru.dart';
import '../dto.dart';
import '../worktree_ref.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';

typedef DeviceFileDiffKey = ({
  String projectId,
  String worktreeId,
  String? repoId,
  String path,
  bool committed,
});

final class DeviceFileDiffState {
  const DeviceFileDiffState({
    this.diff,
    this.error,
    this.refreshing = false,
    this.stale = true,
    this.truncated = false,
  });
  final RemoteFileDiff? diff;
  final String? error;
  final bool refreshing, stale, truncated;

  DeviceFileDiffState pending({String? error, bool refreshing = false}) =>
      DeviceFileDiffState(
        diff: diff,
        error: error,
        refreshing: refreshing,
        truncated: truncated,
      );
}

/// Read-through observable diff data for exactly one computer. The owning
/// account/computer repository controls connection lifetime. No UI dependency,
/// process-wide cache, disk storage, or additional socket interest is used.
final class DeviceFileDiffRepository {
  DeviceFileDiffRepository(
    this.ipc, {
    int maxEntries = 30,
    int maxWeight = 4 * 1024 * 1024,
    this.createTimer = Timer.new,
  }) : _cache = ObservableLru<DeviceFileDiffKey, DeviceFileDiffState>(
         maxEntries: maxEntries,
         maxWeight: maxWeight,
         weigh: (state) =>
             256 +
             payloadWeight(state.diff?.patch) +
             payloadWeight(state.error),
       ) {
    _subscription = ipc.events.listen(_event);
  }

  final DesktopIpc ipc;
  final Timer Function(Duration, void Function()) createTimer;
  final ObservableLru<DeviceFileDiffKey, DeviceFileDiffState> _cache;
  final _reads = <DeviceFileDiffKey, Future<void>>{};
  final _watching =
      <
        DeviceFileDiffKey,
        ({DeviceWorktreeRef ref, RemoteChangedFile file, int count})
      >{};
  late final StreamSubscription<Map<String, dynamic>> _subscription;
  bool _connected = false, _disposed = false;
  int _generation = 0, _invalidation = 0;
  Timer? _refresh;

  Stream<DeviceFileDiffKey> get updates => _cache.updates;

  /// Files whose fresh read found no changes. The computer sends no push when
  /// a change is committed or discarded, so the list that offered the file is
  /// out of date.
  Stream<DeviceFileDiffKey> get unchanged => _unchanged.stream;
  final _unchanged = StreamController<DeviceFileDiffKey>.broadcast();
  DeviceFileDiffKey key(DeviceWorktreeRef ref, RemoteChangedFile file) => (
    projectId: ref.projectId,
    worktreeId: ref.worktreeId,
    repoId: file.repoId,
    path: file.filePath,
    committed: file.committed,
  );
  DeviceFileDiffState state(DeviceWorktreeRef ref, RemoteChangedFile file) =>
      _cache.peek(key(ref, file)) ?? const DeviceFileDiffState();

  void Function() watch(DeviceWorktreeRef ref, RemoteChangedFile file) {
    if (_disposed) return () {};
    final target = key(ref, file);
    final release = _cache.retain(target);
    _watching[target] = (
      ref: ref,
      file: file,
      count: (_watching[target]?.count ?? 0) + 1,
    );
    unawaited(refresh(ref, file));
    var released = false;
    return () {
      if (released || _disposed) return;
      released = true;
      final current = _watching[target]!;
      if (current.count == 1) {
        _watching.remove(target);
      } else {
        _watching[target] = (
          ref: current.ref,
          file: current.file,
          count: current.count - 1,
        );
      }
      release();
    };
  }

  void setConnected(bool connected) {
    if (_disposed) return;
    _connected = connected;
    _generation++;
    _reads.clear();
    _refresh?.cancel();
    for (final key in _cache.keys) {
      final cached = _cache.peek(key);
      if (cached == null) continue;
      _cache.put(
        key,
        cached.pending(
          error: connected
              ? null
              : 'Reconnect to your computer to update this diff.',
        ),
      );
    }
    if (connected) _refreshWatched();
  }

  Future<void> refresh(DeviceWorktreeRef ref, RemoteChangedFile file) {
    if (_disposed) return Future.value();
    final target = key(ref, file);
    final pending = _reads[target];
    if (pending != null) return pending;
    final previous = _cache.read(target) ?? const DeviceFileDiffState();
    if (!_connected) {
      _cache.put(
        target,
        previous.pending(
          error: 'Reconnect to your computer to update this diff.',
        ),
      );
      return Future.value();
    }
    final generation = _generation, invalidation = _invalidation;
    _cache.put(target, previous.pending(refreshing: true));
    late final Future<void> read;
    read = _load(ref, file, generation, invalidation).whenComplete(() {
      if (!identical(_reads[target], read)) return;
      _reads.remove(target);
      if (generation == _generation &&
          invalidation != _invalidation &&
          _connected &&
          _refresh?.isActive != true) {
        final watched = _watching[target];
        if (watched != null) unawaited(refresh(watched.ref, watched.file));
      }
    });
    _reads[target] = read;
    return read;
  }

  Future<void> _load(
    DeviceWorktreeRef ref,
    RemoteChangedFile file,
    int generation,
    int invalidation,
  ) async {
    final target = key(ref, file);
    bool current() => !_disposed && generation == _generation;
    try {
      final raw = deviceLinkObject(
        deviceChatDto(
          await ipc.invoke('activity:file-diff', [
            {
              'projectId': ref.projectId,
              'worktreeId': ref.worktreeId,
              'filePath': file.filePath,
              if (file.repoId != null) 'repoId': file.repoId,
              'source': file.committed ? 'committed' : 'uncommitted',
            },
          ]),
        ),
      );
      if (!current()) return;
      if (invalidation != _invalidation) {
        _cache.put(
          target,
          state(ref, file).pending(refreshing: _watching.containsKey(target)),
        );
        return;
      }
      final patch = raw['binary'] == true
          ? 'Binary files differ\n'
          : displayTextDiff(
              raw['oldValue'] as String? ?? '',
              raw['newValue'] as String? ?? '',
              context: 3,
            );
      _cache.put(
        target,
        DeviceFileDiffState(
          diff: RemoteFileDiff(
            filePath: file.filePath,
            patch: patch,
            repoId: file.repoId,
            insertions: file.insertions,
            deletions: file.deletions,
          ),
          stale: false,
          truncated: raw['truncated'] == true,
        ),
      );
      if (patch.isEmpty) _unchanged.add(target);
    } catch (cause) {
      if (!current()) return;
      _cache.put(
        target,
        state(ref, file).pending(
          error: cause is DeviceLinkException
              ? cause.message
              : cause is FormatException
              ? cause.message
              : 'Could not load the diff.',
        ),
      );
    }
  }

  void _event(Map<String, dynamic> event) {
    final push = event['payload'];
    if (_disposed ||
        !_connected ||
        event['name'] != 'ipc.push' ||
        push is! Map ||
        !const [
          'worktrees:file-changed',
          'workspace:worktrees-updated',
        ].contains(push['channel'])) {
      return;
    }
    _invalidation++;
    for (final key in _cache.keys) {
      final cached = _cache.peek(key);
      if (cached == null) continue;
      _cache.put(
        key,
        cached.pending(
          refreshing: _reads.containsKey(key) || _watching.containsKey(key),
        ),
      );
    }
    _refresh?.cancel();
    _refresh = createTimer(const Duration(milliseconds: 150), _refreshWatched);
  }

  void _refreshWatched() {
    for (final watched in _watching.values.toList()) {
      unawaited(refresh(watched.ref, watched.file));
    }
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    _refresh?.cancel();
    _reads.clear();
    _watching.clear();
    await _subscription.cancel();
    await _unchanged.close();
    await _cache.close();
  }
}
