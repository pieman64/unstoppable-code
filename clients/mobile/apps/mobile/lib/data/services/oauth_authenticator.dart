import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';

/// Runs the browser-based OAuth flow and returns the deep-link callback URL
/// delivered to the app.
abstract interface class OAuthAuthenticator {
  /// Opens [authorizeUrl] in an in-app browser session that intercepts the
  /// [callbackUrl], and returns the full callback URL string —
  /// or null if the user cancels. Callers parse `code`/`error` from it.
  Future<String?> authenticate({
    required String authorizeUrl,
    required String callbackUrl,
  });
}

/// [OAuthAuthenticator] backed by `flutter_web_auth_2`
/// (ASWebAuthenticationSession on iOS, Auth Tab on Android).
final class WebAuthOAuthenticator implements OAuthAuthenticator {
  const WebAuthOAuthenticator();

  @override
  Future<String?> authenticate({
    required String authorizeUrl,
    required String callbackUrl,
  }) async {
    final callback = Uri.parse(callbackUrl);
    final options = callback.scheme == 'https'
        ? FlutterWebAuth2Options(
            httpsHost: callback.host,
            httpsPath: callback.path,
          )
        : const FlutterWebAuth2Options();
    try {
      return await FlutterWebAuth2.authenticate(
        url: authorizeUrl,
        callbackUrlScheme: callback.scheme,
        options: options,
      );
    } on PlatformException catch (error) {
      if (error.code == 'CANCELED') {
        return null;
      }
      rethrow;
    }
  }
}
