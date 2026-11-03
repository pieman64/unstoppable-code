import 'package:mobile/data/models/auth_user.dart';

/// The client-held result of a successful sign-in: the session bearer [token]
/// plus the authenticated [user].
///
/// The `POST /api/auth/sign-in/email` response is `{ token, user, redirect }`;
/// the server-side session row (`expiresAt`, `ipAddress`, …) is never sent to
/// the client, so this deliberately models only what the client receives.
final class AuthSession {
  const AuthSession({required this.token, required this.user});

  final String token;
  final AuthUser user;

  factory AuthSession.fromSignInJson(Map<String, dynamic> json) {
    // Validate before casting so a malformed server response surfaces a
    // descriptive [FormatException] instead of an opaque runtime `TypeError`
    // that upstream error handling can only report as a generic failure.
    final Object? token = json['token'];
    if (token is! String) {
      throw const FormatException(
        'Sign-in response is missing a valid "token" string.',
      );
    }
    final Object? user = json['user'];
    if (user is! Map<String, dynamic>) {
      throw const FormatException(
        'Sign-in response is missing a valid "user" object.',
      );
    }
    return AuthSession(token: token, user: AuthUser.fromJson(user));
  }
}
