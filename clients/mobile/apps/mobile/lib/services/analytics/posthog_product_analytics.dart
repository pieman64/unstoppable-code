import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/services/analytics/app_rating_events.dart';
import 'package:mobile/services/analytics/product_analytics.dart';
import 'package:mobile/services/app_build_info.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

/// PostHog-backed [ProductAnalytics]. Anonymous only: the SDK's own anonymous
/// distinct id, never `identify()`, no person profiles, no GeoIP.
final class PostHogProductAnalytics implements ProductAnalytics {
  PostHogProductAnalytics._(this._buildInfo, this._isStaging);

  final Future<AppBuildInfo?> _buildInfo;

  /// Read at capture time: the API environment can change after launch.
  final bool Function() _isStaging;

  /// Everything except explicit [capture] calls is switched off.
  static PostHogConfig sdkConfig(ProductAnalyticsConfig config) =>
      PostHogConfig(config.projectKey)
        ..host = config.resolvedHost
        ..captureApplicationLifecycleEvents = false
        ..sessionReplay = false
        ..surveys = false
        ..preloadFeatureFlags = false
        ..sendFeatureFlagEvents = false
        ..capturePushNotificationSubscriptions = false
        ..capturePushNotificationOpened = false
        ..personProfiles = PostHogPersonProfiles.never
        ..rageClickConfig.enabled = false;

  static Future<PostHogProductAnalytics> start(
    ProductAnalyticsConfig config, {
    required bool Function() isStaging,
  }) async {
    await Posthog().setup(sdkConfig(config));
    return PostHogProductAnalytics._(
      AppBuildInfo.load().then<AppBuildInfo?>(
        (info) => info,
        onError: (Object _) => null,
      ),
      isStaging,
    );
  }

  /// The final property map for one event: the caller's [properties], build
  /// context when [info] loaded, then the fixed GeoIP opt-out and environment
  /// tag. The last two are applied after the caller's values so they cannot
  /// be overridden.
  @visibleForTesting
  static Map<String, Object> eventProperties(
    Map<String, Object> properties,
    AppBuildInfo? info, {
    required bool isStaging,
  }) => {
    ...properties,
    if (info != null) ...{
      AppRatingProperties.platformName: info.platform,
      AppRatingProperties.appVersion: info.version,
      AppRatingProperties.appBuildNumber: info.buildNumber,
    },
    AppRatingProperties.geoipDisable: true,
    AppRatingProperties.isStaging: isStaging,
  };

  @override
  void capture(String event, Map<String, Object> properties) {
    unawaited(_send(event, properties));
  }

  /// Turns the SDK on or off for the Usage analytics choice in Settings.
  /// Events the SDK queued before [enabled] went false may still flush.
  Future<void> setEnabled(bool enabled) async {
    try {
      if (enabled) {
        await Posthog().enable();
      } else {
        await Posthog().disable();
      }
    } catch (error) {
      debugPrint('PostHog enable/disable failed: $error');
    }
  }

  Future<void> _send(String event, Map<String, Object> properties) async {
    try {
      final info = await _buildInfo;
      await Posthog().capture(
        eventName: event,
        properties: eventProperties(properties, info, isStaging: _isStaging()),
      );
    } catch (error) {
      debugPrint('PostHog capture failed: $error');
    }
  }
}
