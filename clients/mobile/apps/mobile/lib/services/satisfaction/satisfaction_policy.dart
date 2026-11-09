import 'package:flutter/foundation.dart';

/// Chat surface a satisfaction prompt was shown from. [wire] is the
/// `trigger_surface` analytics value, so it must never change.
enum SatisfactionSurface {
  remoteChat('remote_chat');

  const SatisfactionSurface(this.wire);

  final String wire;
}

/// Terminal answer to the prompt. [none] means the user may be asked again.
enum SatisfactionOutcome {
  none('none'),
  rated('rated'),
  feedbackSubmitted('feedback_submitted');

  const SatisfactionOutcome(this.wire);

  final String wire;

  static SatisfactionOutcome? fromWire(Object? wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// Everything the prompt policy remembers across launches.
@immutable
final class SatisfactionState {
  const SatisfactionState({
    this.successfulTurnCount = 0,
    this.successDays = const [],
    this.snoozedUntil,
    this.outcome = SatisfactionOutcome.none,
  });

  static const SatisfactionState initial = SatisfactionState();

  static const int _version = 1;

  final int successfulTurnCount;

  /// Local calendar dates (`yyyy-MM-dd`) with a successful turn. Only the
  /// first [SatisfactionThresholds.minDistinctDays] are retained.
  final List<String> successDays;
  final DateTime? snoozedUntil;
  final SatisfactionOutcome outcome;

  SatisfactionState copyWith({
    int? successfulTurnCount,
    List<String>? successDays,
    DateTime? snoozedUntil,
    SatisfactionOutcome? outcome,
  }) => SatisfactionState(
    successfulTurnCount: successfulTurnCount ?? this.successfulTurnCount,
    successDays: successDays ?? this.successDays,
    snoozedUntil: snoozedUntil ?? this.snoozedUntil,
    outcome: outcome ?? this.outcome,
  );

  Map<String, Object?> toJson() => {
    'version': _version,
    'successfulTurnCount': successfulTurnCount,
    'successDays': successDays,
    'snoozedUntil': snoozedUntil?.toUtc().toIso8601String(),
    'outcome': outcome.wire,
  };

  /// Null for anything that is not a well-formed version-1 value, so callers
  /// can fall back to [initial] instead of throwing.
  static SatisfactionState? fromJson(Object? json) {
    if (json is! Map) return null;
    if (json['version'] != _version) return null;
    final count = json['successfulTurnCount'];
    final days = json['successDays'];
    final outcome = SatisfactionOutcome.fromWire(json['outcome']);
    final snoozed = json['snoozedUntil'];
    if (count is! int || count < 0) return null;
    if (days is! List || days.any((d) => d is! String)) return null;
    if (outcome == null) return null;
    if (snoozed != null && snoozed is! String) return null;
    final snoozedUntil = snoozed is String ? DateTime.tryParse(snoozed) : null;
    if (snoozed is String && snoozedUntil == null) return null;
    return SatisfactionState(
      successfulTurnCount: count,
      successDays: List.unmodifiable(days.cast<String>()),
      snoozedUntil: snoozedUntil,
      outcome: outcome,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is SatisfactionState &&
      other.successfulTurnCount == successfulTurnCount &&
      listEquals(other.successDays, successDays) &&
      other.snoozedUntil == snoozedUntil &&
      other.outcome == outcome;

  @override
  int get hashCode => Object.hash(
    successfulTurnCount,
    Object.hashAll(successDays),
    snoozedUntil,
    outcome,
  );
}

/// The numbers the policy runs on. Centralized so no UI code hard-codes them.
@immutable
final class SatisfactionThresholds {
  const SatisfactionThresholds({
    required this.minSuccessfulTurns,
    required this.minDistinctDays,
    required this.snoozeDuration,
  });

  /// What every production user gets.
  static const SatisfactionThresholds production = SatisfactionThresholds(
    minSuccessfulTurns: 5,
    minDistinctDays: 2,
    snoozeDuration: Duration(days: 30),
  );

  /// Used only while the app talks to the staging API, which is reachable by
  /// internal testers alone, so the native review flow can be checked on
  /// TestFlight / Play internal builds without waiting two days.
  static const SatisfactionThresholds verification = SatisfactionThresholds(
    minSuccessfulTurns: 1,
    minDistinctDays: 1,
    snoozeDuration: Duration(minutes: 2),
  );

  final int minSuccessfulTurns;
  final int minDistinctDays;
  final Duration snoozeDuration;
}

/// Pure eligibility and transition rules for the satisfaction prompt.
final class SatisfactionPolicy {
  const SatisfactionPolicy(this.thresholds);

  final SatisfactionThresholds thresholds;

  bool isEligible(SatisfactionState state, DateTime now) {
    if (state.outcome != SatisfactionOutcome.none) return false;
    if (state.successfulTurnCount < thresholds.minSuccessfulTurns) return false;
    if (state.successDays.length < thresholds.minDistinctDays) return false;
    final until = state.snoozedUntil;
    return until == null || !now.isBefore(until);
  }

  SatisfactionState recordTurn(SatisfactionState state, DateTime now) {
    if (state.outcome != SatisfactionOutcome.none) return state;
    final day = localDayKey(now);
    final keepDays =
        state.successDays.contains(day) ||
        state.successDays.length >= thresholds.minDistinctDays;
    return state.copyWith(
      successfulTurnCount: state.successfulTurnCount + 1,
      successDays: keepDays
          ? state.successDays
          : List.unmodifiable([...state.successDays, day]),
    );
  }

  SatisfactionState onRated(SatisfactionState state) =>
      state.copyWith(outcome: SatisfactionOutcome.rated);

  SatisfactionState onFeedbackSubmitted(SatisfactionState state) =>
      state.copyWith(outcome: SatisfactionOutcome.feedbackSubmitted);

  SatisfactionState onSnoozed(SatisfactionState state, DateTime now) =>
      state.copyWith(snoozedUntil: now.add(thresholds.snoozeDuration));
}

/// Local calendar date as `yyyy-MM-dd`.
String localDayKey(DateTime at) {
  final local = at.toLocal();
  String two(int value) => value.toString().padLeft(2, '0');
  return '${local.year.toString().padLeft(4, '0')}-${two(local.month)}-'
      '${two(local.day)}';
}
