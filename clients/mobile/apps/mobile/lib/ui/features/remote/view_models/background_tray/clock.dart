import 'dart:async';

/// One clock per tray, independent of Flutter. The shell supplies expansion
/// state and disposes it when leaving; no timer is kept while collapsed.
final class BackgroundTrayClock {
  BackgroundTrayClock({
    required this.onTick,
    int Function()? nowMs,
    this.periodicTimer = Timer.periodic,
  }) : _nowMs = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch) {
    now = _nowMs();
  }

  final void Function() onTick;
  final int Function() _nowMs;
  final Timer Function(Duration, void Function(Timer)) periodicTimer;
  late int now;
  Timer? _timer;
  bool _disposed = false;

  void setExpanded(bool expanded) {
    if (_disposed) return;
    if (!expanded) {
      _timer?.cancel();
      _timer = null;
      return;
    }
    if (_timer != null) return;
    now = _nowMs();
    _timer = periodicTimer(const Duration(seconds: 1), (_) {
      now = _nowMs();
      onTick();
    });
    onTick();
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
  }
}

/// Port of ui-shared's `formatElapsed`, including its zero minutes when an
/// hour has seconds: 1h 0m 1s. Existing pipeline row timing omits seconds.
String formatBackgroundTrayElapsed(num? ms) {
  if (ms == null || !ms.isFinite || ms < 0) return 'Not available';
  final totalSeconds = (ms / 1000).floor();
  if (totalSeconds < 60) return '${totalSeconds}s';
  final totalMinutes = totalSeconds ~/ 60;
  final seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? '${totalMinutes}m ${seconds}s' : '${totalMinutes}m';
  }
  final hours = totalMinutes ~/ 60;
  final minutes = totalMinutes % 60;
  if (seconds > 0) return '${hours}h ${minutes}m ${seconds}s';
  if (minutes > 0) return '${hours}h ${minutes}m';
  return '${hours}h';
}
