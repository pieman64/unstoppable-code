import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/services/analytics/app_rating_events.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/store_review_launcher.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_sheet.dart';
import 'package:mobile/ui/features/settings/views/widgets/feedback_report_sheet.dart';

import '../../../../support/recording_product_analytics.dart';

final class _FakeLauncher implements StoreReviewLauncher {
  _FakeLauncher(this.store, {this.result = StoreReviewRequestResult.requested});
  final InMemorySatisfactionPromptStore store;
  final StoreReviewRequestResult result;
  SatisfactionOutcome? outcomeAtRequest;
  int calls = 0;

  @override
  Future<StoreReviewRequestResult> request() async {
    calls++;
    outcomeAtRequest = store.current.outcome;
    return result;
  }
}

/// Five turns across two days: eligible under production thresholds.
final _eligible = SatisfactionState(
  successfulTurnCount: 4,
  successDays: const ['2026-09-01', '2026-09-02'],
);

class _Harness {
  _Harness({
    SatisfactionState? initial,
    this.choice = SatisfactionPromptChoice.yes,
    this.feedback = FeedbackSheetOutcome.submitted,
    StoreReviewRequestResult review = StoreReviewRequestResult.requested,
  }) : store = InMemorySatisfactionPromptStore(
         initial: initial ?? SatisfactionState.initial,
       ) {
    launcher = _FakeLauncher(store, result: review);
    controller = SatisfactionPromptController(
      store: store,
      analytics: analytics,
      reviewLauncher: launcher,
      isActive: () => active,
      clock: () => now,
      showPrompt: (_) async {
        promptShows++;
        if (promptError case final error?) throw error;
        return choice;
      },
      showFeedback: (_) async {
        feedbackShows++;
        if (feedbackError case final error?) throw error;
        return feedback;
      },
    );
  }

  final InMemorySatisfactionPromptStore store;
  final analytics = RecordingProductAnalytics();
  late final _FakeLauncher launcher;
  late final SatisfactionPromptController controller;
  SatisfactionPromptChoice choice;
  FeedbackSheetOutcome feedback;
  bool active = true;
  DateTime now = DateTime(2026, 9, 2, 12);
  int promptShows = 0;
  int feedbackShows = 0;
  Object? promptError;
  Object? feedbackError;
}

/// Runs [body] with [debugPrint] captured, keeping the run output clean.
/// Restored before the test ends: the binding rejects a changed debugPrint.
Future<List<String>> _logsDuring(Future<void> Function() body) async {
  final lines = <String>[];
  final original = debugPrint;
  debugPrint = (String? message, {int? wrapWidth}) => lines.add('$message');
  try {
    await body();
  } finally {
    debugPrint = original;
  }
  return lines;
}

Future<BuildContext> _context(WidgetTester tester) async {
  late BuildContext captured;
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) {
          captured = context;
          return const SizedBox();
        },
      ),
    ),
  );
  return captured;
}

Map<String, Object> _surface() => {
  AppRatingProperties.triggerSurface: SatisfactionSurface.remoteChat.wire,
};

void main() {
  test('becomes pending only once the thresholds are met', () async {
    final h = _Harness();
    for (var i = 0; i < 4; i++) {
      await h.controller.recordSuccessfulTurn('remote:c:$i');
    }
    expect(h.controller.pendingPrompt, isFalse); // one day only
    h.now = DateTime(2026, 9, 3, 9);
    await h.controller.recordSuccessfulTurn('remote:c:4');
    expect(h.controller.pendingPrompt, isTrue);
  });

  test('ignores a repeated turn key', () async {
    final h = _Harness(initial: _eligible.copyWith(successfulTurnCount: 3));
    await h.controller.recordSuccessfulTurn('remote:c:t1');
    await h.controller.recordSuccessfulTurn('remote:c:t1');
    expect(h.store.current.successfulTurnCount, 4);
    expect(h.controller.pendingPrompt, isFalse);
  });

  test('a deferred prompt waits for the next eligible turn', () async {
    final h = _Harness(initial: _eligible);
    await h.controller.recordSuccessfulTurn('cloud:c:t1');
    expect(h.controller.pendingPrompt, isTrue);

    h.controller.deferPrompt();
    expect(h.controller.pendingPrompt, isFalse);
    // The deferred turn still counted.
    expect(h.store.current.successfulTurnCount, 5);

    await h.controller.recordSuccessfulTurn('cloud:c:t2');
    expect(h.controller.pendingPrompt, isTrue);
  });

  test('records nothing while inactive (demo mode, unconfigured)', () async {
    final h = _Harness(initial: _eligible)..active = false;
    await h.controller.recordSuccessfulTurn('remote:c:t1');
    expect(h.store.current, _eligible);
    expect(h.controller.pendingPrompt, isFalse);
  });

  test('uses verification thresholds when provided', () async {
    final store = InMemorySatisfactionPromptStore();
    final controller = SatisfactionPromptController(
      store: store,
      analytics: RecordingProductAnalytics(),
      reviewLauncher: _FakeLauncher(store),
      isActive: () => true,
      thresholds: () => SatisfactionThresholds.verification,
    );
    await controller.recordSuccessfulTurn('remote:c:t1');
    expect(controller.pendingPrompt, isTrue);
  });

  testWidgets('Yes persists rated before requesting the review', (
    tester,
  ) async {
    final h = _Harness(initial: _eligible);
    await h.controller.recordSuccessfulTurn('remote:c:t1');
    await h.controller.present(
      await _context(tester),
      SatisfactionSurface.remoteChat,
    );

    expect(h.launcher.calls, 1);
    expect(h.launcher.outcomeAtRequest, SatisfactionOutcome.rated);
    expect(h.store.current.outcome, SatisfactionOutcome.rated);
    expect(h.analytics.names, [
      AppRatingEvents.promptView,
      AppRatingEvents.yesButtonClick,
      AppRatingEvents.storeReviewStart,
    ]);
    expect(h.analytics.events.first.properties, _surface());
    expect(h.analytics.events.last.properties, {
      ..._surface(),
      AppRatingProperties.isReviewAvailable: true,
    });
    expect(h.controller.pendingPrompt, isFalse);
  });

  testWidgets('an unavailable review is recorded, not retried', (tester) async {
    final h = _Harness(
      initial: _eligible,
      review: StoreReviewRequestResult.unavailable,
    );
    await h.controller.recordSuccessfulTurn('remote:c:t1');
    await h.controller.present(
      await _context(tester),
      SatisfactionSurface.remoteChat,
    );
    expect(
      h.analytics.events.last.properties[AppRatingProperties.isReviewAvailable],
      false,
    );
    expect(h.store.current.outcome, SatisfactionOutcome.rated);
  });

  testWidgets('Not really then submit is terminal', (tester) async {
    final h = _Harness(initial: _eligible, choice: SatisfactionPromptChoice.no);
    await h.controller.recordSuccessfulTurn('remote:c:t1');
    await h.controller.present(
      await _context(tester),
      SatisfactionSurface.cloudChat,
    );
    expect(h.feedbackShows, 1);
    expect(h.launcher.calls, 0);
    expect(h.store.current.outcome, SatisfactionOutcome.feedbackSubmitted);
    expect(h.analytics.names, [
      AppRatingEvents.promptView,
      AppRatingEvents.noButtonClick,
      AppRatingEvents.feedbackFormView,
      AppRatingEvents.feedbackFormSubmit,
    ]);
    expect(
      h.analytics.events.every(
        (e) => e.properties[AppRatingProperties.triggerSurface] == 'cloud_chat',
      ),
      isTrue,
    );
  });

  testWidgets('Not really then close snoozes 30 days', (tester) async {
    final h = _Harness(
      initial: _eligible,
      choice: SatisfactionPromptChoice.no,
      feedback: FeedbackSheetOutcome.dismissed,
    );
    await h.controller.recordSuccessfulTurn('remote:c:t1');
    await h.controller.present(
      await _context(tester),
      SatisfactionSurface.remoteChat,
    );
    expect(h.store.current.outcome, SatisfactionOutcome.none);
    expect(h.store.current.snoozedUntil, h.now.add(const Duration(days: 30)));
    expect(h.analytics.names.last, AppRatingEvents.feedbackFormCancel);
  });

  for (final (choice, method) in [
    (SatisfactionPromptChoice.notNow, 'not_now_button'),
    (SatisfactionPromptChoice.dismissed, 'swipe'),
  ]) {
    testWidgets('$choice snoozes and reports $method', (tester) async {
      final h = _Harness(initial: _eligible, choice: choice);
      await h.controller.recordSuccessfulTurn('remote:c:t1');
      await h.controller.present(
        await _context(tester),
        SatisfactionSurface.remoteChat,
      );
      expect(h.analytics.names, [
        AppRatingEvents.promptView,
        AppRatingEvents.promptCancel,
      ]);
      expect(h.analytics.events.last.properties, {
        ..._surface(),
        AppRatingProperties.dismissMethod: method,
      });
      expect(h.store.current.snoozedUntil, h.now.add(const Duration(days: 30)));
    });
  }

  testWidgets('prompts at most once per launch', (tester) async {
    final h = _Harness(
      initial: _eligible,
      choice: SatisfactionPromptChoice.notNow,
    );
    final context = await _context(tester);
    await h.controller.recordSuccessfulTurn('remote:c:t1');
    await h.controller.present(context, SatisfactionSurface.remoteChat);
    h.now = h.now.add(const Duration(days: 31));
    await h.controller.recordSuccessfulTurn('remote:c:t2');
    expect(h.controller.pendingPrompt, isFalse);
    await h.controller.present(context, SatisfactionSurface.remoteChat);
    expect(h.promptShows, 1);
  });

  testWidgets('a failing store neither crashes nor re-prompts', (tester) async {
    final h = _Harness(initial: _eligible);
    h.store.failWritesWith = StateError('disk full');
    final context = await _context(tester);
    final logs = await _logsDuring(() async {
      await h.controller.recordSuccessfulTurn('remote:c:t1');
      expect(h.controller.pendingPrompt, isTrue);
      await h.controller.present(context, SatisfactionSurface.remoteChat);
      expect(h.launcher.calls, 1);
      await h.controller.present(context, SatisfactionSurface.remoteChat);
    });
    expect(h.promptShows, 1);
    expect(logs, everyElement(contains('disk full')));
  });

  testWidgets('a prompt sheet that throws closes the funnel and snoozes', (
    tester,
  ) async {
    final h = _Harness(initial: _eligible)
      ..promptError = StateError('no overlay');
    final context = await _context(tester);
    await h.controller.recordSuccessfulTurn('remote:c:t1');

    final logs = await _logsDuring(
      () => h.controller.present(context, SatisfactionSurface.remoteChat),
    );

    expect(h.analytics.names, [
      AppRatingEvents.promptView,
      AppRatingEvents.promptCancel,
    ]);
    expect(h.analytics.events.last.properties, {
      ..._surface(),
      AppRatingProperties.dismissMethod: AppRatingProperties.dismissSwipe,
    });
    expect(h.store.current.snoozedUntil, h.now.add(const Duration(days: 30)));
    expect(h.launcher.calls, 0);
    expect(logs.single, contains('no overlay'));
    expect(h.controller.pendingPrompt, isFalse);
  });

  testWidgets('a feedback sheet that throws closes the funnel and snoozes', (
    tester,
  ) async {
    final h = _Harness(initial: _eligible, choice: SatisfactionPromptChoice.no)
      ..feedbackError = StateError('no repository');
    final context = await _context(tester);
    await h.controller.recordSuccessfulTurn('remote:c:t1');

    final logs = await _logsDuring(
      () => h.controller.present(context, SatisfactionSurface.remoteChat),
    );

    expect(h.analytics.names, [
      AppRatingEvents.promptView,
      AppRatingEvents.noButtonClick,
      AppRatingEvents.feedbackFormView,
      AppRatingEvents.feedbackFormCancel,
    ]);
    expect(h.store.current.outcome, SatisfactionOutcome.none);
    expect(h.store.current.snoozedUntil, h.now.add(const Duration(days: 30)));
    expect(logs.single, contains('no repository'));
    expect(h.controller.pendingPrompt, isFalse);
  });

  testWidgets('present is a no-op when nothing is pending', (tester) async {
    final h = _Harness();
    await h.controller.present(
      await _context(tester),
      SatisfactionSurface.remoteChat,
    );
    expect(h.promptShows, 0);
    expect(h.analytics.events, isEmpty);
  });
}
