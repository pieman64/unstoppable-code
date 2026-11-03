/// Product analytics sink. Fire-and-forget: implementations never throw and
/// never block the caller.
abstract interface class ProductAnalytics {
  void capture(String event, Map<String, Object> properties);
}

final class NoopProductAnalytics implements ProductAnalytics {
  const NoopProductAnalytics();

  @override
  void capture(String event, Map<String, Object> properties) {}
}

/// The app-lifetime analytics handle. Starts as a no-op; `main()` swaps in
/// the PostHog [delegate] once the SDK is set up. [isAllowed] is checked on
/// every capture so reviewer demo mode, which can be entered after launch,
/// silences capture immediately.
final class AppProductAnalytics implements ProductAnalytics {
  AppProductAnalytics({required this._isAllowed});

  final bool Function() _isAllowed;

  ProductAnalytics delegate = const NoopProductAnalytics();

  @override
  void capture(String event, Map<String, Object> properties) {
    if (!_isAllowed()) return;
    delegate.capture(event, properties);
  }
}

/// Build-time PostHog configuration from the brand dart-defines.
final class ProductAnalyticsConfig {
  const ProductAnalyticsConfig({
    required this.enabled,
    required this.projectKey,
    required this.host,
  });

  static const String defaultHost = 'https://us.i.posthog.com';

  final bool enabled;
  final String projectKey;
  final String host;

  /// A defined-but-empty dart-define yields '' rather than the default.
  String get resolvedHost => host.trim().isEmpty ? defaultHost : host.trim();

  bool canStart({required bool hasAuthApiConfig}) =>
      enabled && projectKey.trim().isNotEmpty && hasAuthApiConfig;
}
