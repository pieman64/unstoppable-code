import 'package:flutter/foundation.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/data/services/browser_capabilities.dart';

/// Runtime configuration for the app, sourced from the active [Brand]
/// (generated from `brands/<id>/brand.json`).
///
/// The production and staging API base URLs are injected at build time via
/// brand-prefixed dart-defines, e.g. for the `unstoppable-code` brand:
///   flutter run \
///     --dart-define=UNSTOPPABLE_CODE_API_BASE_URL_PRODUCTION=https://code.example.com \
///     --dart-define=UNSTOPPABLE_CODE_API_BASE_URL_STAGING=https://staging.example.com
///
/// When it is not set the app falls back to mock repositories automatically,
/// keeping `flutter test` and CI green without any live config.
abstract final class AppConfig {
  static const String mobileOAuthAppLinkPath = '/api/mobile/oauth-app-callback';
  static const Set<String> _mobileOAuthAppLinkHosts = {
    'app.unstoppable.ai',
    'code.ud-staging.com',
  };

  static ApiEnvironmentController _environmentController =
      ApiEnvironmentController(
        productionBaseUrl: Brand.productionApiBaseUrl,
        stagingBaseUrl: Brand.stagingApiBaseUrl,
        initialEnvironment: kDebugMode
            ? ApiEnvironment.staging
            : ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      );

  /// Loads the persisted selection before the app creates its HTTP services.
  static Future<void> initialize() async {
    try {
      _environmentController = await ApiEnvironmentController.load(
        productionBaseUrl: Brand.productionApiBaseUrl,
        stagingBaseUrl: Brand.stagingApiBaseUrl,
        defaultEnvironment: kDebugMode
            ? ApiEnvironment.staging
            : ApiEnvironment.production,
      );
    } catch (_) {
      // A corrupt/unavailable preferences store must never prevent startup.
      // Debug builds retain their staging-first safety default; distributed
      // profile/release builds fall back to production.
      _environmentController = ApiEnvironmentController(
        productionBaseUrl: Brand.productionApiBaseUrl,
        stagingBaseUrl: Brand.stagingApiBaseUrl,
        initialEnvironment: kDebugMode
            ? ApiEnvironment.staging
            : ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      );
    }
  }

  /// Replaces the controller before a widget test pumps the app.
  @visibleForTesting
  static void configureEnvironmentController(
    ApiEnvironmentController controller,
  ) {
    _environmentController = controller;
  }

  static ValueListenable<ApiEnvironment> get environmentListenable =>
      _environmentController;

  static ApiEnvironment get environment => _environmentController.value;

  static bool get isStaging => environment == ApiEnvironment.staging;

  static bool isEnvironmentAvailable(ApiEnvironment environment) =>
      _environmentController.isAvailable(environment);

  /// Whether the app is talking to the staging server. Reviewer demo mode
  /// makes no network calls, so it never is.
  static bool get usesStagingServer => !DemoMode.enabled.value && isStaging;

  static Future<void> selectEnvironment(ApiEnvironment environment) =>
      _environmentController.select(environment);

  /// Base URL of the web API. Empty string when not provided or in demo mode.
  static String get apiBaseUrl =>
      DemoMode.enabled.value ? '' : _environmentController.activeBaseUrl;

  /// True when an API base URL was provided, enabling the real Better
  /// Auth-backed flow. The bearer token comes from sign-in and the active org
  /// id is resolved from the API, so no other dart-defines are needed.
  ///
  /// Reports `false` while [DemoMode] is active, so every repository builder in
  /// `main.dart` and the auth gate fall back to their `Mock*` implementations
  /// for the reviewer demo path — even in a release build that has a real API
  /// base URL configured.
  static bool get hasAuthApiConfig =>
      apiBaseUrl.isNotEmpty && !DemoMode.enabled.value;

  /// App callback the mobile OAuth completion endpoint redirects back to,
  /// carrying the one-time exchange `code` (see web
  /// `/api/mobile/oauth-complete`).
  ///
  /// Play-distributed Android release builds use a verified HTTPS App Link.
  /// Debug/profile Android builds retain the custom scheme because their
  /// signing certificate cannot verify against the production association.
  /// Apple builds continue to use the brand-driven custom scheme until their
  /// Universal Link association is configured separately.
  ///
  /// The HTTPS App Link additionally requires a browser that implements Chrome's
  /// Auth Tab contract, so [capabilities] is consulted before claiming it — a
  /// browser without Auth Tab keeps the final redirect and dead-ends sign-in on
  /// the server's fallback page. [platform] and [releaseMode] exist so tests can
  /// exercise the matrix that `defaultTargetPlatform`/`kReleaseMode` pin.
  static Future<String> resolveOauthCallbackUrl(
    BrowserCapabilities capabilities, {
    TargetPlatform? platform,
    bool? releaseMode,
  }) async {
    final resolvedPlatform = platform ?? defaultTargetPlatform;
    final resolvedReleaseMode = releaseMode ?? kReleaseMode;
    // Short-circuits the platform round-trip on every build that could not use
    // an HTTPS callback regardless of what the browser supports.
    final couldClaimAppLink =
        resolvedPlatform == TargetPlatform.android && resolvedReleaseMode;
    return oauthCallbackUrlFor(
      platform: resolvedPlatform,
      releaseMode: resolvedReleaseMode,
      authTabSupported:
          couldClaimAppLink &&
          await capabilities.supportsHttpsAuthTabRedirect(),
    );
  }

  @visibleForTesting
  static String oauthCallbackUrlFor({
    required TargetPlatform platform,
    required bool releaseMode,
    required bool authTabSupported,
    String? apiBaseUrlOverride,
  }) {
    final baseUrl = apiBaseUrlOverride ?? apiBaseUrl;
    final baseUri = Uri.tryParse(baseUrl);
    if (platform == TargetPlatform.android &&
        releaseMode &&
        authTabSupported &&
        baseUri != null &&
        baseUri.scheme == 'https' &&
        !baseUri.hasPort &&
        _mobileOAuthAppLinkHosts.contains(baseUri.host)) {
      return Uri.https(baseUri.host, mobileOAuthAppLinkPath).toString();
    }
    return Brand.oauthCallbackUrl;
  }
}
