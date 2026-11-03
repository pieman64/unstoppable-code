import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/analytics/app_rating_events.dart';
import 'package:mobile/services/analytics/posthog_product_analytics.dart';
import 'package:mobile/services/analytics/product_analytics.dart';
import 'package:mobile/services/app_build_info.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

import '../../support/recording_product_analytics.dart';

void main() {
  group('ProductAnalyticsConfig.canStart', () {
    const usable = ProductAnalyticsConfig(
      enabled: true,
      projectKey: 'phc_live',
      host: 'https://us.i.posthog.com',
    );

    test('starts only when enabled, keyed and API-configured', () {
      expect(usable.canStart(hasAuthApiConfig: true), isTrue);
      expect(usable.canStart(hasAuthApiConfig: false), isFalse);
      expect(
        const ProductAnalyticsConfig(
          enabled: false,
          projectKey: 'phc_live',
          host: '',
        ).canStart(hasAuthApiConfig: true),
        isFalse,
      );
      expect(
        const ProductAnalyticsConfig(
          enabled: true,
          projectKey: '  ',
          host: '',
        ).canStart(hasAuthApiConfig: true),
        isFalse,
      );
    });

    test('an empty host falls back to the US cloud host', () {
      const config = ProductAnalyticsConfig(
        enabled: true,
        projectKey: 'phc_live',
        host: '',
      );
      expect(config.resolvedHost, 'https://us.i.posthog.com');
    });
  });

  group('AppProductAnalytics', () {
    test('forwards only while allowed', () {
      var allowed = true;
      final recorder = RecordingProductAnalytics();
      final analytics = AppProductAnalytics(isAllowed: () => allowed)
        ..delegate = recorder;

      analytics.capture(AppRatingEvents.promptView, const {'a': 1});
      allowed = false; // e.g. reviewer demo mode entered after launch
      analytics.capture(AppRatingEvents.yesButtonClick, const {'a': 1});

      expect(recorder.names, [AppRatingEvents.promptView]);
    });

    test('defaults to a no-op delegate', () {
      expect(
        () => AppProductAnalytics(
          isAllowed: () => true,
        ).capture(AppRatingEvents.promptView, const {}),
        returnsNormally,
      );
    });
  });

  test('event names follow category:object_action and never change', () {
    expect(AppRatingEvents.all, [
      'app_rating:prompt_view',
      'app_rating:prompt_cancel',
      'app_rating:yes_button_click',
      'app_rating:no_button_click',
      'app_rating:store_review_start',
      'app_rating:feedback_form_view',
      'app_rating:feedback_form_submit',
      'app_rating:feedback_form_cancel',
    ]);
  });

  test('SDK config disables everything but explicit capture', () {
    final config = PostHogProductAnalytics.sdkConfig(
      const ProductAnalyticsConfig(
        enabled: true,
        projectKey: 'phc_live',
        host: 'https://us.i.posthog.com',
      ),
    );
    expect(config.projectToken, 'phc_live');
    expect(config.host, 'https://us.i.posthog.com');
    expect(config.captureApplicationLifecycleEvents, isFalse);
    expect(config.sessionReplay, isFalse);
    expect(config.surveys, isFalse);
    expect(config.preloadFeatureFlags, isFalse);
    expect(config.sendFeatureFlagEvents, isFalse);
    expect(config.capturePushNotificationSubscriptions, isFalse);
    expect(config.capturePushNotificationOpened, isFalse);
    expect(config.personProfiles, PostHogPersonProfiles.never);
    expect(config.rageClickConfig.enabled, isFalse);
  });

  group('PostHogProductAnalytics.eventProperties', () {
    const info = AppBuildInfo(
      version: '1.4.0',
      buildNumber: '42',
      platform: 'ios',
      osVersion: 'Version 26.0',
    );

    test('adds build context, disables GeoIP and tags the environment', () {
      final properties = PostHogProductAnalytics.eventProperties(
        const {AppRatingProperties.triggerSurface: 'remote_chat'},
        info,
        isStaging: false,
      );

      expect(properties, {
        AppRatingProperties.triggerSurface: 'remote_chat',
        AppRatingProperties.platformName: 'ios',
        AppRatingProperties.appVersion: '1.4.0',
        AppRatingProperties.appBuildNumber: '42',
        r'$geoip_disable': true,
        'is_staging': false,
      });
      // Never the OS version string: it is not part of the funnel contract.
      expect(properties.values, isNot(contains('Version 26.0')));
    });

    test('still disables GeoIP and tags staging without build info', () {
      final properties = PostHogProductAnalytics.eventProperties(
        const {AppRatingProperties.dismissMethod: 'swipe'},
        null,
        isStaging: true,
      );

      expect(properties, {
        AppRatingProperties.dismissMethod: 'swipe',
        r'$geoip_disable': true,
        'is_staging': true,
      });
    });

    test('callers cannot re-enable GeoIP or mislabel the environment', () {
      final properties = PostHogProductAnalytics.eventProperties(
        const {r'$geoip_disable': false, 'is_staging': true},
        null,
        isStaging: false,
      );

      expect(properties[AppRatingProperties.geoipDisable], isTrue);
      expect(properties[AppRatingProperties.isStaging], isFalse);
    });
  });
}
