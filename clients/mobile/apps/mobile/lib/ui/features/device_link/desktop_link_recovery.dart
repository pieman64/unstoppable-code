import 'dart:async';

/// One outage has one deadline, even when an attempt never finishes.
final class DesktopLinkRecovery {
  DesktopLinkRecovery({
    required this.attempt,
    required this.onExpired,
    this.createTimer = Timer.new,
  });

  final Future<bool> Function() attempt;
  final void Function() onExpired;
  final Timer Function(Duration, void Function()) createTimer;
  Timer? _deadline, _retry;
  int _generation = 0, _attempt = 0;
  bool _attempting = false, _again = false;
  bool get active => _deadline != null;

  void start() {
    if (active) return;
    final generation = ++_generation;
    _attempt = 0;
    _deadline = createTimer(const Duration(minutes: 1), () {
      if (generation != _generation) return;
      cancel();
      onExpired();
    });
    _schedule(generation);
  }

  /// Tries again now, for example when the computer comes back online. An
  /// attempt already in flight is followed at once if it fails.
  void retryNow() {
    if (!active) return;
    if (_attempting) {
      _again = true;
      return;
    }
    _retry?.cancel();
    _retry = null;
    unawaited(_run(_generation));
  }

  void _schedule(int generation) {
    // The first attempt is immediate: most drops are recovered by one.
    const delays = [0, 2, 5, 10];
    final delay = _again ? 0 : delays[_attempt.clamp(0, delays.length - 1)];
    _again = false;
    _attempt++;
    _retry = createTimer(Duration(seconds: delay), () {
      _retry = null;
      unawaited(_run(generation));
    });
  }

  Future<void> _run(int generation) async {
    _attempting = true;
    final bool restored;
    try {
      restored = await attempt();
    } finally {
      if (generation == _generation) _attempting = false;
    }
    if (generation != _generation) return;
    if (restored) {
      cancel();
    } else {
      _schedule(generation);
    }
  }

  void cancel() {
    _generation++;
    _attempting = false;
    _again = false;
    _deadline?.cancel();
    _deadline = null;
    _retry?.cancel();
    _retry = null;
  }
}
