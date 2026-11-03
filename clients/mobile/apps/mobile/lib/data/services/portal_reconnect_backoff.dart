import 'dart:math' as math;

/// Jittered exponential backoff for one retry streak of the Portal event
/// stream (`portal_event_stream.dart`).
///
/// Each [next] doubles the nominal delay from [base] up to [cap], then scales
/// it by a jitter factor between [jitterFloor] and 1, so phones that lost the
/// same desktop do not reconnect in lockstep. [reset] starts the streak over.
final class PortalReconnectBackoff {
  PortalReconnectBackoff({
    required this.base,
    required this.cap,
    required this._random,
    this.jitterFloor = 0.8,
  });

  final Duration base;
  final Duration cap;

  /// Smallest share of the nominal delay a jittered delay can take.
  final double jitterFloor;

  final double Function() _random;
  int _streak = 0;

  /// The delay before the next attempt; extends the streak.
  Duration next() {
    _streak += 1;
    // Clamp the exponent so the cap, not integer growth, bounds the delay.
    final nominal = math.min(
      cap.inMicroseconds,
      base.inMicroseconds * (1 << math.min(_streak - 1, 20)),
    );
    final jitter = jitterFloor + _random() * (1 - jitterFloor);
    return Duration(microseconds: (nominal * jitter).round());
  }

  void reset() => _streak = 0;
}
