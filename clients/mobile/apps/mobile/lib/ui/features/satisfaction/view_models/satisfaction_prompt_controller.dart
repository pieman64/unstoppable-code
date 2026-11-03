import 'dart:collection';

import 'package:flutter/widgets.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/services/analytics/app_rating_events.dart';
import 'package:mobile/services/analytics/product_analytics.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/store_review_launcher.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_sheet.dart';
import 'package:mobile/ui/features/settings/views/widgets/feedback_report_sheet.dart';

typedef SatisfactionPromptPresenter =
    Future<SatisfactionPromptChoice> Function(BuildContext context);
typedef SatisfactionFeedbackPresenter =
    Future<FeedbackSheetOutcome> Function(BuildContext context);

/// Owns the "Are you enjoying the app?" flow: counts successful turns,
/// decides when a prompt is due, and runs the prompt → native review or
/// private feedback path. App-lifetime singleton provided from
/// `buildRootProviders()`; chat view models report turns through a plain
/// callback and `SatisfactionPromptHost` decides *when* to [present].
class SatisfactionPromptController extends ChangeNotifier
    with DisposeSafeNotifier {
  SatisfactionPromptController({
    required this._store,
    required this._analytics,
    required this._reviewLauncher,
    required this._isActive,
    SatisfactionThresholds Function()? thresholds,
    DateTime Function()? clock,
    SatisfactionPromptPresenter? showPrompt,
    SatisfactionFeedbackPresenter? showFeedback,
  }) : _thresholds = thresholds ?? (() => SatisfactionThresholds.production),
       _clock = clock ?? DateTime.now,
       _showPrompt = showPrompt ?? showSatisfactionPromptSheet,
       _showFeedback =
           showFeedback ??
           ((context) => showFeedbackReportSheet(
             context,
             source: SatisfactionPromptController.feedbackSource,
           ));

  /// `source` value on feedback reports filed from this prompt.
  static const String feedbackSource = 'satisfaction_prompt';

  static const int _maxRememberedTurnKeys = 256;

  final SatisfactionPromptStore _store;
  final ProductAnalytics _analytics;
  final StoreReviewLauncher _reviewLauncher;
  final bool Function() _isActive;
  final SatisfactionThresholds Function() _thresholds;
  final DateTime Function() _clock;
  final SatisfactionPromptPresenter _showPrompt;
  final SatisfactionFeedbackPresenter _showFeedback;

  SatisfactionState _state = SatisfactionState.initial;
  Future<void>? _loading;
  final LinkedHashSet<String> _seenTurnKeys = LinkedHashSet<String>();
  bool _pending = false;
  bool _promptedThisLaunch = false;
  bool _presenting = false;

  SatisfactionPolicy get _policy => SatisfactionPolicy(_thresholds());

  /// True when a prompt is due and none has been shown this launch.
  bool get pendingPrompt => _pending && !_promptedThisLaunch && !_presenting;

  /// Reports one successfully completed agent turn. [turnKey] is unique per
  /// turn so a replayed completion is counted once.
  Future<void> recordSuccessfulTurn(String turnKey) async {
    if (!_isActive()) return;
    if (!_seenTurnKeys.add(turnKey)) return;
    if (_seenTurnKeys.length > _maxRememberedTurnKeys) {
      _seenTurnKeys.remove(_seenTurnKeys.first);
    }
    await _ensureLoaded();
    final now = _clock();
    final policy = _policy;
    final next = policy.recordTurn(_state, now);
    if (next != _state) await _save(next);
    if (!_pending && policy.isEligible(_state, now)) {
      _pending = true;
      notifyListenersSafe();
    }
  }

  /// Holds back a due prompt so another prompt can have this turn; the next
  /// eligible turn raises it again.
  void deferPrompt() {
    if (!_pending) return;
    _pending = false;
    notifyListenersSafe();
  }

  /// Runs the prompt flow once. A no-op unless [pendingPrompt].
  Future<void> present(
    BuildContext context,
    SatisfactionSurface surface,
  ) async {
    if (!pendingPrompt || !_isActive()) return;
    _presenting = true;
    _promptedThisLaunch = true;
    _pending = false;
    notifyListenersSafe();
    final base = <String, Object>{
      AppRatingProperties.triggerSurface: surface.wire,
    };
    try {
      _analytics.capture(AppRatingEvents.promptView, base);
      final choice = await _guarded(
        () => _showPrompt(context),
        fallback: SatisfactionPromptChoice.dismissed,
        what: 'Satisfaction prompt',
      );
      switch (choice) {
        case SatisfactionPromptChoice.yes:
          _analytics.capture(AppRatingEvents.yesButtonClick, base);
          // Persist before the native call so a crash cannot re-prompt.
          await _save(_policy.onRated(_state));
          final result = await _reviewLauncher.request();
          _analytics.capture(AppRatingEvents.storeReviewStart, {
            ...base,
            AppRatingProperties.isReviewAvailable:
                result == StoreReviewRequestResult.requested,
          });
        case SatisfactionPromptChoice.no:
          _analytics.capture(AppRatingEvents.noButtonClick, base);
          if (!context.mounted) {
            await _save(_policy.onSnoozed(_state, _clock()));
            return;
          }
          _analytics.capture(AppRatingEvents.feedbackFormView, base);
          final outcome = await _guarded(
            () => _showFeedback(context),
            fallback: FeedbackSheetOutcome.dismissed,
            what: 'Satisfaction feedback form',
          );
          if (outcome == FeedbackSheetOutcome.submitted) {
            _analytics.capture(AppRatingEvents.feedbackFormSubmit, base);
            await _save(_policy.onFeedbackSubmitted(_state));
          } else {
            _analytics.capture(AppRatingEvents.feedbackFormCancel, base);
            await _save(_policy.onSnoozed(_state, _clock()));
          }
        case SatisfactionPromptChoice.notNow:
        case SatisfactionPromptChoice.dismissed:
          _analytics.capture(AppRatingEvents.promptCancel, {
            ...base,
            AppRatingProperties.dismissMethod:
                choice == SatisfactionPromptChoice.notNow
                ? AppRatingProperties.dismissNotNowButton
                : AppRatingProperties.dismissSwipe,
          });
          await _save(_policy.onSnoozed(_state, _clock()));
      }
    } finally {
      _presenting = false;
      notifyListenersSafe();
    }
  }

  /// Runs a sheet presenter; a presenter that throws counts as a dismissal
  /// so the funnel still closes with a cancel event and a snooze instead of
  /// leaving a dangling view event or re-prompting.
  Future<T> _guarded<T>(
    Future<T> Function() show, {
    required T fallback,
    required String what,
  }) async {
    try {
      return await show();
    } catch (error) {
      debugPrint('$what failed to show: $error');
      return fallback;
    }
  }

  Future<void> _ensureLoaded() => _loading ??= _store.read().then(
    (state) => _state = state,
    onError: (Object _) {},
  );

  /// Updates memory first so the in-launch rules hold even if disk fails.
  Future<void> _save(SatisfactionState next) async {
    _state = next;
    try {
      await _store.write(next);
    } catch (error) {
      debugPrint('Satisfaction prompt state not saved: $error');
    }
  }
}
