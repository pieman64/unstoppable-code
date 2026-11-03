/// Pure turn-timer logic for the mobile chat transcript. Dart port
/// of the shared desktop/web `TurnTimer` rules
/// (`packages/ui-shared/src/components/TurnTimer.tsx`): elapsed time excludes
/// completed and active pause windows, clamps at zero against desktop/phone
/// clock skew, and formats as `M:SS` (or `H:MM:SS` past an hour).
library;

import 'dart:math' as math;

import 'package:mobile/data/models/chat_message.dart';

/// Parsed `turn_timer` part payload (`createPortalTurnTimer` /
/// `persistedParts` on the desktop). All fields are epoch milliseconds from
/// the desktop's clock.
class TurnTimer {
  const TurnTimer({
    this.startedAt,
    this.pausedAt,
    this.resumedAt,
    this.accumulatedPausedDurationMs,
    this.completedAt,
    this.updatedAt,
    this.endReason,
  });

  final int? startedAt;
  final int? pausedAt;
  final int? resumedAt;
  final int? accumulatedPausedDurationMs;
  final int? completedAt;

  /// Desktop epoch ms at which the carrying message was emitted
  /// (`createdAtMs`), i.e. "desktop now" for this frame. Lets a live count
  /// be anchored on the phone clock from receipt instead of subtracting the
  /// desktop's [startedAt] from the phone's `DateTime.now()` — which clamps
  /// at 0:00 for as long as the phone clock trails the desktop's.
  final int? updatedAt;

  /// Why the turn ended abnormally (`cancelled` or `failed`), stamped by the
  /// desktop on the completed timer. Null for a normal completion and for
  /// producers that predate the field.
  final String? endReason;

  /// Waiting on user input mid-turn: paused and never resumed.
  bool get isPaused =>
      completedAt == null && pausedAt != null && resumedAt == null;

  /// Actively running: not finished, not paused.
  bool get isLive => completedAt == null && !isPaused;

  /// Parses a `turn_timer` chat part; null for other kinds or missing data.
  /// [updatedAt] is the carrying message's desktop send time, when known.
  static TurnTimer? fromPart(ChatPart part, {int? updatedAt}) {
    if (part.kind != 'turn_timer') return null;
    final data = part.data;
    if (data == null) return null;
    int? epoch(String key) {
      final value = data[key];
      return value is num ? value.toInt() : null;
    }

    final endReason = data['endReason'];
    return TurnTimer(
      startedAt: epoch('startedAt'),
      pausedAt: epoch('pausedAt'),
      resumedAt: epoch('resumedAt'),
      accumulatedPausedDurationMs: epoch('accumulatedPausedDurationMs'),
      completedAt: epoch('completedAt'),
      updatedAt: updatedAt,
      endReason: endReason is String ? endReason : null,
    );
  }

  /// Whole elapsed seconds at [now], excluding pause time. Null when the
  /// timer never carried a start timestamp.
  int? elapsedSeconds(DateTime now) {
    if (startedAt == null) return null;
    return elapsedMs(now.millisecondsSinceEpoch) ~/ 1000;
  }

  /// Elapsed milliseconds at desktop-clock instant [nowMs], excluding pause
  /// time and clamped at zero. Zero without a start timestamp.
  int elapsedMs(int nowMs) {
    final startedAt = this.startedAt;
    if (startedAt == null) return 0;
    final endAt = completedAt ?? nowMs;
    final accumulated = accumulatedPausedDurationMs;
    final pausedAt = this.pausedAt;
    final resumedAt = this.resumedAt;
    final int completedPauseMs = accumulated != null
        ? math.max(0, accumulated)
        : pausedAt != null && resumedAt != null
        ? math.max(0, resumedAt - math.max(startedAt, pausedAt))
        : 0;
    final int activePauseMs = pausedAt == null || resumedAt != null
        ? 0
        : math.max(0, endAt - math.max(startedAt, pausedAt));
    final elapsed = endAt - startedAt - completedPauseMs - activePauseMs;
    return elapsed < 0 ? 0 : elapsed;
  }

  /// Field-wise identity, so a re-pushed identical frame does not re-anchor
  /// a phone-clock count.
  bool sameFrameAs(TurnTimer other) =>
      startedAt == other.startedAt &&
      pausedAt == other.pausedAt &&
      resumedAt == other.resumedAt &&
      accumulatedPausedDurationMs == other.accumulatedPausedDurationMs &&
      completedAt == other.completedAt &&
      updatedAt == other.updatedAt;
}

/// `M:SS`, or `H:MM:SS` once the turn passes an hour (desktop parity).
String formatElapsedSeconds(int seconds) {
  final hours = seconds ~/ 3600;
  final minutes = (seconds % 3600) ~/ 60;
  final remaining = seconds % 60;
  final paddedSeconds = remaining.toString().padLeft(2, '0');
  if (hours > 0) {
    return '$hours:${minutes.toString().padLeft(2, '0')}:$paddedSeconds';
  }
  return '$minutes:$paddedSeconds';
}

/// Status label matching the shared `TurnTimer` copy: `Working... 1:23`,
/// `Paused at 1:20`, `Completed in 1:00` — or the bare state when the timer
/// has no start timestamp.
String turnTimerLabel(TurnTimer timer, DateTime now) {
  final seconds = timer.elapsedSeconds(now);
  if (seconds == null) {
    return timer.isLive
        ? 'Working...'
        : timer.isPaused
        ? 'Paused'
        : 'Completed';
  }
  final formatted = formatElapsedSeconds(seconds);
  return timer.isLive
      ? 'Working... $formatted'
      : timer.isPaused
      ? 'Paused at $formatted'
      : 'Completed in $formatted';
}

/// The transcript's newest turn-timer part, parsed. Only the newest matters:
/// at most one turn is ever live, and a completed newest timer means the last
/// turn settled.
TurnTimer? findNewestTurnTimer(List<ChatMessage> messages) {
  for (var i = messages.length - 1; i >= 0; i -= 1) {
    final message = messages[i];
    for (final part in message.parts) {
      final timer = TurnTimer.fromPart(
        part,
        updatedAt: message.occurredAt?.millisecondsSinceEpoch,
      );
      if (timer != null) return timer;
    }
  }
  return null;
}
