import 'package:flutter/services.dart';

/// What the device's browser can do on the way back from a browser OAuth flow.
abstract interface class BrowserCapabilities {
  /// True when the browser that will host the OAuth flow implements Chrome's
  /// Auth Tab contract, and can therefore return an **HTTPS** redirect to the
  /// app.
  ///
  /// This is the deciding factor for whether the claimed HTTPS App Link is a
  /// usable OAuth callback. Without Auth Tab the browser keeps the final
  /// navigation and simply renders it, so sign-in dead-ends on the server's
  /// fallback page. Callers must fall back to the custom scheme, which any
  /// browser hands back because it cannot resolve the scheme itself.
  Future<bool> supportsHttpsAuthTabRedirect();
}

/// [BrowserCapabilities] backed by the host platform.
///
/// Android answers from `androidx.browser`'s
/// `CustomTabsClient.isAuthTabSupported`, which asks the resolved Custom Tabs
/// provider directly instead of guessing from a browser version number. Every
/// other platform has no handler registered and reports no support, which is
/// correct: iOS returns through `ASWebAuthenticationSession` and the custom
/// scheme.
final class PlatformBrowserCapabilities implements BrowserCapabilities {
  const PlatformBrowserCapabilities();

  static const String channelName =
      'com.unstoppabledomains.canopy/browser_capabilities';

  static const MethodChannel _channel = MethodChannel(channelName);

  @override
  Future<bool> supportsHttpsAuthTabRedirect() async {
    try {
      return await _channel.invokeMethod<bool>(
            'supportsHttpsAuthTabRedirect',
          ) ??
          false;
    } on Object {
      return false;
    }
  }
}
