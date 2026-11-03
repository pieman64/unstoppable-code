/// PostHog event names for the satisfaction-prompt funnel. Fixed constants:
/// renaming one splits historical analytics (see the
/// `posthog-event-naming` skill).
abstract final class AppRatingEvents {
  static const String promptView = 'app_rating:prompt_view';
  static const String promptCancel = 'app_rating:prompt_cancel';
  static const String yesButtonClick = 'app_rating:yes_button_click';
  static const String noButtonClick = 'app_rating:no_button_click';
  static const String storeReviewStart = 'app_rating:store_review_start';
  static const String feedbackFormView = 'app_rating:feedback_form_view';
  static const String feedbackFormSubmit = 'app_rating:feedback_form_submit';
  static const String feedbackFormCancel = 'app_rating:feedback_form_cancel';

  static const List<String> all = [
    promptView,
    promptCancel,
    yesButtonClick,
    noButtonClick,
    storeReviewStart,
    feedbackFormView,
    feedbackFormSubmit,
    feedbackFormCancel,
  ];
}

/// Fixed property keys; runtime variation lives only in values.
abstract final class AppRatingProperties {
  static const String triggerSurface = 'trigger_surface';
  static const String dismissMethod = 'dismiss_method';
  static const String isReviewAvailable = 'is_review_available';
  static const String platformName = 'platform_name';
  static const String appVersion = 'app_version';
  static const String appBuildNumber = 'app_build_number';

  /// Whether the event came from an app pointed at the staging API. Internal
  /// testers use staging, so production funnels filter it out.
  static const String isStaging = 'is_staging';

  /// PostHog's reserved per-event switch: no GeoIP lookup, so no location is
  /// ever derived from the sender's IP address.
  static const String geoipDisable = r'$geoip_disable';

  static const String dismissNotNowButton = 'not_now_button';
  static const String dismissSwipe = 'swipe';
}
