import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/turn_feedback.dart';

void main() {
  test('rating wire values match the protocol', () {
    expect(turnFeedbackRatingWire(TurnFeedbackRating.up), 'up');
    expect(turnFeedbackRatingWire(TurnFeedbackRating.down), 'down');
    expect(turnFeedbackRatingFromWire('down'), TurnFeedbackRating.down);
    expect(turnFeedbackRatingFromWire('sideways'), isNull);
  });

  test('every reason maps to its kebab-case wire value', () {
    // These strings are the server's stored enum. A typo here silently files
    // the rating under a reason nobody queries for.
    expect(
      TurnFeedbackReason.values.map(turnFeedbackReasonWire).toList(),
      <String>[
        'incorrect-or-didnt-work',
        'ignored-instructions',
        'changed-more-than-asked',
        'broke-something',
        'got-stuck',
        'missed-context',
        'unsafe-action',
        'other',
      ],
    );
  });

  test('reason round-trips through the wire and rejects unknowns', () {
    for (final reason in TurnFeedbackReason.values) {
      expect(
        turnFeedbackReasonFromWire(turnFeedbackReasonWire(reason)),
        reason,
      );
    }
    expect(turnFeedbackReasonFromWire('too-slow'), isNull);
    expect(turnFeedbackReasonFromWire(null), isNull);
  });

  test('summary parses the server payload', () {
    final summary = TurnFeedbackSummary.fromJson(<String, dynamic>{
      'feedbackId': 'fb-1',
      'clientUserMessageId': 'msg-3-1757000000000',
      'rating': 'down',
      'reason': 'got-stuck',
      'hasComment': true,
      'createdAt': '2026-09-01T00:00:00.000Z',
      'updatedAt': '2026-09-01T00:00:00.000Z',
    });

    expect(summary.feedbackId, 'fb-1');
    expect(summary.rating, TurnFeedbackRating.down);
    expect(summary.reason, TurnFeedbackReason.gotStuck);
    expect(summary.hasComment, isTrue);
  });

  test('summary tolerates an unknown reason instead of throwing', () {
    // A newer server taxonomy must degrade to "no reason shown", never crash
    // the transcript.
    final summary = TurnFeedbackSummary.fromJson(<String, dynamic>{
      'feedbackId': 'fb-2',
      'clientUserMessageId': 'msg-4-1757000000001',
      'rating': 'up',
      'reason': 'brand-new-category',
      'hasComment': false,
      'createdAt': '2026-09-01T00:00:00.000Z',
      'updatedAt': '2026-09-01T00:00:00.000Z',
    });

    expect(summary.reason, isNull);
  });

  test(
    'summary throws on an unrecognized rating instead of decoding to null',
    () {
      // Unlike `reason`, `rating` is a mandatory closed two-value axis the row
      // cannot exist without, so an unrecognized value means the payload is
      // corrupt, not "a newer kind we don't render yet" -- it must throw rather
      // than silently produce a summary with no rating.
      expect(
        () => TurnFeedbackSummary.fromJson(<String, dynamic>{
          'feedbackId': 'fb-3',
          'clientUserMessageId': 'msg-5-1757000000002',
          'rating': 'sideways',
          'hasComment': false,
          'createdAt': '2026-09-01T00:00:00.000Z',
          'updatedAt': '2026-09-01T00:00:00.000Z',
        }),
        throwsA(isA<FormatException>()),
      );
    },
  );
}
