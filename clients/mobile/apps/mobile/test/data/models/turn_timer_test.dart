import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';

void main() {
  final now = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);
  int msAgo(int ms) => now.millisecondsSinceEpoch - ms;

  group('TurnTimer.fromPart', () {
    test('parses a live turn_timer part', () {
      final timer = TurnTimer.fromPart(
        ChatPart(
          kind: 'turn_timer',
          data: {'startedAt': msAgo(5000), 'completedAt': null},
        ),
      );
      expect(timer, isNotNull);
      expect(timer?.startedAt, msAgo(5000));
      expect(timer?.completedAt, isNull);
      expect(timer?.isLive, isTrue);
    });

    test('parses a paused producer update from the portal wire', () {
      final timer = TurnTimer.fromPart(
        ChatPart(
          kind: 'turn_timer',
          data: {
            'startedAt': msAgo(10_000),
            'pausedAt': msAgo(3_000),
            'resumedAt': null,
            'accumulatedPausedDurationMs': 2_000,
            'completedAt': null,
          },
        ),
      );

      if (timer == null) fail('Expected a parsed turn timer');
      expect(timer.isPaused, isTrue);
      expect(timer.accumulatedPausedDurationMs, 2_000);
      expect(turnTimerLabel(timer, now), 'Paused at 0:05');
    });

    test('parses the optional endReason', () {
      TurnTimer? parse(Object? endReason) => TurnTimer.fromPart(
        ChatPart(
          kind: 'turn_timer',
          data: {'startedAt': 1, 'completedAt': 2, 'endReason': ?endReason},
        ),
      );

      expect(parse('cancelled')?.endReason, 'cancelled');
      expect(parse(null)?.endReason, isNull);
      expect(parse(7)?.endReason, isNull);
    });

    test('returns null for non-timer parts and missing data', () {
      expect(TurnTimer.fromPart(const ChatPart(kind: 'thinking')), isNull);
      expect(TurnTimer.fromPart(const ChatPart(kind: 'turn_timer')), isNull);
    });
  });

  group('elapsedSeconds', () {
    test('counts whole seconds since start while live', () {
      final timer = TurnTimer(startedAt: msAgo(65_400));
      expect(timer.elapsedSeconds(now), 65);
    });

    test('freezes at completion', () {
      final timer = TurnTimer(
        startedAt: msAgo(90_000),
        completedAt: msAgo(30_000),
      );
      expect(timer.elapsedSeconds(now), 60);
    });

    test('excludes completed and active pause windows', () {
      // Paused for 10s earlier (accumulated), paused again 5s ago and not
      // resumed: 60s wall clock - 10s - 5s = 45s.
      final timer = TurnTimer(
        startedAt: msAgo(60_000),
        accumulatedPausedDurationMs: 10_000,
        pausedAt: msAgo(5_000),
      );
      expect(timer.elapsedSeconds(now), 45);
      expect(timer.isPaused, isTrue);
    });

    test('clamps clock skew to zero and needs a start timestamp', () {
      final timer = TurnTimer(startedAt: now.millisecondsSinceEpoch + 10_000);
      expect(timer.elapsedSeconds(now), 0);
      expect(const TurnTimer().elapsedSeconds(now), isNull);
    });
  });

  group('formatElapsedSeconds', () {
    test('formats M:SS and H:MM:SS', () {
      expect(formatElapsedSeconds(0), '0:00');
      expect(formatElapsedSeconds(65), '1:05');
      expect(formatElapsedSeconds(3_725), '1:02:05');
    });
  });

  group('turnTimerLabel', () {
    test('live, paused, and completed labels with elapsed time', () {
      expect(
        turnTimerLabel(TurnTimer(startedAt: msAgo(83_000)), now),
        'Working... 1:23',
      );
      expect(
        turnTimerLabel(
          TurnTimer(startedAt: msAgo(83_000), pausedAt: msAgo(3_000)),
          now,
        ),
        'Paused at 1:20',
      );
      expect(
        turnTimerLabel(
          TurnTimer(startedAt: msAgo(83_000), completedAt: msAgo(23_000)),
          now,
        ),
        'Completed in 1:00',
      );
    });

    test('falls back to plain labels without a start timestamp', () {
      expect(turnTimerLabel(const TurnTimer(), now), 'Working...');
    });
  });

  group('findNewestTurnTimer', () {
    ChatMessage timerMessage(String id, {int? completedAt}) => ChatMessage(
      messageId: id,
      chatId: 'chat',
      role: ChatRole.system,
      status: completedAt == null
          ? ChatMessageStatus.streaming
          : ChatMessageStatus.complete,
      text: '',
      parts: [
        ChatPart(
          kind: 'turn_timer',
          data: {'startedAt': msAgo(10_000), 'completedAt': completedAt},
        ),
      ],
    );

    test('returns the newest timer in the transcript', () {
      final timer = findNewestTurnTimer([
        timerMessage('t-1', completedAt: msAgo(60_000)),
        timerMessage('t-2'),
      ]);
      expect(timer, isNotNull);
      expect(timer?.isLive, isTrue);
    });

    test('newest completed timer wins over older live ones', () {
      final timer = findNewestTurnTimer([
        timerMessage('t-1'),
        timerMessage('t-2', completedAt: msAgo(1_000)),
      ]);
      expect(timer?.isLive, isFalse);
    });

    test('returns null without timer parts', () {
      expect(findNewestTurnTimer(const []), isNull);
    });
  });

  group('clock-skew-proof anchoring', () {
    test('findNewestTurnTimer carries the desktop send time', () {
      final timer = findNewestTurnTimer([
        ChatMessage(
          messageId: 'u-1:turn-timer',
          chatId: 'chat-1',
          role: ChatRole.system,
          status: ChatMessageStatus.streaming,
          text: '',
          occurredAt: now,
          parts: [
            ChatPart(
              kind: 'turn_timer',
              data: {'startedAt': msAgo(4_000), 'completedAt': null},
            ),
          ],
        ),
      ]);
      expect(timer?.updatedAt, now.millisecondsSinceEpoch);
    });

    test('elapsedMs at the desktop reference ignores the phone clock', () {
      final timer = TurnTimer(
        startedAt: msAgo(4_000),
        accumulatedPausedDurationMs: 1_000,
        updatedAt: now.millisecondsSinceEpoch,
      );
      expect(timer.elapsedMs(now.millisecondsSinceEpoch), 3_000);
    });
  });
}
