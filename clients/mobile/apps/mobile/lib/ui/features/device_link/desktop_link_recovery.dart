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

  void _schedule(int generation) {
    const delays = [2, 5, 10];
    final delay = delays[_attempt.clamp(0, delays.length - 1)];
    _attempt++;
    _retry = createTimer(Duration(seconds: delay), () async {
      _retry = null;
      final restored = await attempt();
      if (generation != _generation) return;
      if (restored) {
        cancel();
      } else {
        _schedule(generation);
      }
    });
  }

  void cancel() {
    _generation++;
    _deadline?.cancel();
    _deadline = null;
    _retry?.cancel();
    _retry = null;
  }
}
