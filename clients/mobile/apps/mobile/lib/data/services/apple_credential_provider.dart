import 'package:sign_in_with_apple/sign_in_with_apple.dart';

/// The result of a successful native Sign in with Apple authorization.
///
/// [identityToken] is the JWT Better Auth verifies server-side.
/// [fullName] and [email] are only populated on the user's first
/// authorization with this app — see [AppleCredentialProvider].
class AppleCredential {
  const AppleCredential({
    required this.identityToken,
    this.fullName,
    this.email,
  });

  final String identityToken;
  final String? fullName;
  final String? email;
}

/// Requests an Apple ID credential from the native Sign in with Apple flow.
///
/// Mirrors the [`OAuthAuthenticator`] pattern used for the browser-based
/// social flow: a mockable seam around the native/platform call so callers
/// (the auth repository) can be unit-tested without the real native channel.
abstract class AppleCredentialProvider {
  /// Returns the Apple ID credential for [nonce], or `null` if the user
  /// cancels the native authorization sheet.
  Future<AppleCredential?> getCredential({required String nonce});
}

/// [AppleCredentialProvider] backed by `sign_in_with_apple`
/// (native ASAuthorizationController on iOS).
class SignInWithAppleCredentialProvider implements AppleCredentialProvider {
  const SignInWithAppleCredentialProvider();

  @override
  Future<AppleCredential?> getCredential({required String nonce}) async {
    try {
      final cred = await SignInWithApple.getAppleIDCredential(
        scopes: const [
          AppleIDAuthorizationScopes.email,
          AppleIDAuthorizationScopes.fullName,
        ],
        nonce: nonce,
      );
      final token = cred.identityToken;
      if (token == null) return null;
      final name = [
        cred.givenName,
        cred.familyName,
      ].where((p) => p != null && p.isNotEmpty).join(' ').trim();
      return AppleCredential(
        identityToken: token,
        fullName: name.isEmpty ? null : name,
        email: cred.email,
      );
    } on SignInWithAppleAuthorizationException catch (e) {
      if (e.code == AuthorizationErrorCode.canceled) return null;
      rethrow;
    }
  }
}
