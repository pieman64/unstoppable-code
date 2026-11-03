import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';

void main() {
  const policy = SatisfactionPolicy(SatisfactionThresholds.production);
  final day1 = DateTime(2026, 9, 1, 10);
  final day2 = DateTime(2026, 9, 2, 10);

  SatisfactionState turns(int count, List<DateTime> at) {
    var state = SatisfactionState.initial;
    for (var i = 0; i < count; i++) {
      state = policy.recordTurn(state, at[i % at.length]);
    }
    return state;
  }

  test('four turns across two days are not enough', () {
    expect(policy.isEligible(turns(4, [day1, day2]), day2), isFalse);
  });

  test('five turns on a single day are not enough', () {
    expect(policy.isEligible(turns(5, [day1]), day1), isFalse);
  });

  test('five turns across two days are eligible', () {
    final state = turns(5, [day1, day2]);
    expect(state.successfulTurnCount, 5);
    expect(state.successDays, ['2026-09-01', '2026-09-02']);
    expect(policy.isEligible(state, day2), isTrue);
  });

  test('only the first two distinct days are kept', () {
    final state = turns(3, [day1, day2, DateTime(2026, 9, 3)]);
    expect(state.successDays, ['2026-09-01', '2026-09-02']);
  });

  test('a snooze blocks until it expires and keeps the counters', () {
    final eligible = turns(5, [day1, day2]);
    final snoozed = policy.onSnoozed(eligible, day2);
    expect(snoozed.successfulTurnCount, 5);
    expect(snoozed.snoozedUntil, day2.add(const Duration(days: 30)));
    expect(
      policy.isEligible(snoozed, day2.add(const Duration(days: 29))),
      isFalse,
    );
    expect(
      policy.isEligible(snoozed, day2.add(const Duration(days: 30))),
      isTrue,
    );
  });

  test('terminal outcomes are never eligible and stop counting', () {
    final eligible = turns(5, [day1, day2]);
    for (final terminal in [
      policy.onRated(eligible),
      policy.onFeedbackSubmitted(eligible),
    ]) {
      expect(policy.isEligible(terminal, day2), isFalse);
      expect(policy.recordTurn(terminal, day2), terminal);
    }
  });

  test('day keys use the local calendar date', () {
    expect(localDayKey(DateTime(2026, 9, 1, 23, 59)), '2026-09-01');
    expect(localDayKey(DateTime(2026, 9, 2, 0, 0)), '2026-09-02');
  });

  test('verification thresholds need one turn on one day', () {
    const verify = SatisfactionPolicy(SatisfactionThresholds.verification);
    final state = verify.recordTurn(SatisfactionState.initial, day1);
    expect(verify.isEligible(state, day1), isTrue);
    expect(
      SatisfactionThresholds.verification.snoozeDuration,
      const Duration(minutes: 2),
    );
  });

  group('json', () {
    test('round-trips', () {
      final state = policy.onSnoozed(turns(5, [day1, day2]), day2.toUtc());
      expect(SatisfactionState.fromJson(state.toJson()), state);
    });

    test('rejects malformed and unknown-version values', () {
      expect(SatisfactionState.fromJson('nope'), isNull);
      expect(SatisfactionState.fromJson({'version': 2}), isNull);
      expect(
        SatisfactionState.fromJson({
          'version': 1,
          'successfulTurnCount': 'x',
          'successDays': <String>[],
          'outcome': 'none',
        }),
        isNull,
      );
      expect(
        SatisfactionState.fromJson({
          'version': 1,
          'successfulTurnCount': 1,
          'successDays': <String>[],
          'outcome': 'mystery',
        }),
        isNull,
      );
    });
  });
}
