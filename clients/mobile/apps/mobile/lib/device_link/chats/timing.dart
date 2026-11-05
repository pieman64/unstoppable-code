import 'dart:async';
import '../desktop/ipc.dart';
import 'dto.dart';
import 'state.dart';
import '../protocol.dart';

/// A peer's read-only processing clock. The desktop excludes input pauses;
/// reopening a route must not create a new time origin on the phone.
final class DeviceChatTiming {
  DeviceChatTiming(this.ipc, {required this.onChanged, int Function()? now})
    : _now = now ?? (() => DateTime.now().millisecondsSinceEpoch);
  final DesktopIpc ipc;
  final void Function() onChanged;
  final int Function() _now;
  String? _key, _scope;
  int? _elapsed, _observedAt;
  int _generation = 0;
  bool _paused = false, _disposed = false;

  void observe(DeviceChatState? state, {required bool enabled}) {
    final active = state?.runtime['activeTurn'];
    final key = enabled && state != null && state.running
        ? '${state.ref.key}/${active is Map ? active['userMessageId'] : ''}/${active is Map ? active['startedAt'] : ''}/${state.awaitingInput}'
        : null;
    if (key == _key) return;
    _key = key;
    _scope = state?.ref.key;
    _elapsed = _observedAt = null;
    final generation = ++_generation;
    if (key == null || state == null) return;
    final ref = state.ref;
    _paused = state.awaitingInput;
    unawaited(() async {
      try {
        final value = deviceLinkObject(
          deviceChatDto(await ipc.invoke('chat:active-sessions', [ref.scope])),
        );
        final sessions = value['sessions'];
        final session = sessions is List
            ? sessions
                  .whereType<Map>()
                  .where(
                    (row) =>
                        row['projectId'] == ref.projectId &&
                        row['worktreeId'] == ref.worktreeId &&
                        row['chatId'] == ref.id &&
                        row['turnActive'] == true,
                  )
                  .firstOrNull
            : null;
        if (_disposed || generation != _generation || session == null) return;
        final elapsed = session['turnElapsedMs'];
        final started = session['turnStartedAt'];
        _elapsed = elapsed is num && elapsed.isFinite && elapsed >= 0
            ? elapsed.toInt()
            : started is num && started.isFinite
            ? (_now() - started.toInt()).clamp(0, 1 << 53)
            : null;
        _observedAt = _now();
        onChanged();
      } catch (_) {
        // Older/unavailable session diagnostics do not break the transcript.
        // A canonical activeTurn timestamp remains the display fallback.
      }
    }());
  }

  int? elapsedMs(DeviceChatState state) {
    if (!state.running || _disposed) return null;
    if (_scope == state.ref.key && _elapsed != null && _observedAt != null) {
      return _elapsed! +
          (_paused ? 0 : (_now() - _observedAt!).clamp(0, 1 << 53));
    }
    final active = state.runtime['activeTurn'];
    final started = active is Map ? active['startedAt'] : null;
    return started is num && started.isFinite
        ? (_now() - started.toInt()).clamp(0, 1 << 53)
        : null;
  }

  void dispose() {
    _disposed = true;
    _generation++;
  }
}
