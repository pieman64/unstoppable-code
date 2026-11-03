import 'package:mobile/data/models/two_factor.dart';
import 'package:mobile/data/services/api_client.dart';

/// Distinct failure modes for the 2FA management endpoints, so the view model
/// can message each precisely (an invalid code differs from a re-auth wall).
enum TwoFactorFailure {
  /// The submitted TOTP/backup code was rejected by verify (HTTP 400/401).
  invalidCode,

  /// Too many attempts in the rate-limit window (HTTP 429).
  rateLimited,

  /// The 2FA gate rejected a bearer request that lacks a session-bound proof
  /// (HTTP 403). This happens when disabling 2FA that was enrolled in the
  /// current app session: the app only holds a valid `x-two-factor-verified`
  /// proof when the user signed in with 2FA. The fix is to sign out and back
  /// in, which re-mints the proof at OAuth token exchange.
  needsReauth,

  /// Any other server/network failure.
  unknown,
}

/// Thrown by [TwoFactorApiService] when a 2FA management call fails, tagged
/// with a [TwoFactorFailure] so callers can render a specific message without
/// re-inspecting HTTP status codes.
final class TwoFactorException implements Exception {
  const TwoFactorException(this.failure);

  final TwoFactorFailure failure;

  @override
  String toString() => 'TwoFactorException($failure)';
}

/// Wraps the TOTP two-factor management endpoints.
///
/// Status is read from the account API (`/api/account/auth-sources`), while
/// enroll/verify/disable go through the Better Auth handler
/// (`/api/auth/two-factor/*`) exactly as the web account settings screen does.
/// The mobile client authenticates with a bearer token; the shared [ApiClient]
/// attaches the `Authorization` and (for already-2FA-verified sessions)
/// `x-two-factor-verified` headers automatically.
///
/// SECURITY NOTE — deliberately NOT using `/api/account/two-factor/session`:
/// that route is cookie-based (it verifies via the temporary two-factor cookie
/// and sets a completion cookie), which a bearer/keychain client never
/// receives. Better Auth's `verify-totp` resolves the user from the bearer
/// token, so it is the correct activation call for mobile — the same call the
/// mobile OAuth 2FA challenge flow uses server-side.
final class TwoFactorApiService {
  const TwoFactorApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Reads whether 2FA is currently enabled for the signed-in account.
  Future<TwoFactorStatus> fetchStatus() async {
    final json = await apiClient.getJson('/api/account/auth-sources');
    return TwoFactorStatus.fromAuthSourcesJson(json);
  }

  /// Begins enrollment: provisions the TOTP secret and returns the otpauth URI
  /// plus one-time backup codes. 2FA is not yet enforced until [verifyEnrollment]
  /// confirms a code. [issuer] labels the entry in the user's authenticator app.
  /// [password] is required by Better Auth when the account has a credential
  /// login source.
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) async {
    try {
      final json = await apiClient.postJson(
        '/api/auth/two-factor/enable',
        body: {'issuer': issuer, 'password': ?password},
      );
      return TwoFactorEnrollment.fromJson(json);
    } on ApiException catch (e) {
      throw TwoFactorException(_failureForStatus(e.statusCode));
    }
  }

  /// Confirms enrollment by verifying the first TOTP [code]. On success the
  /// account is 2FA-enabled server-side. Throws [TwoFactorException] with
  /// [TwoFactorFailure.invalidCode] when the code is wrong.
  Future<void> verifyEnrollment({required String code}) async {
    try {
      await apiClient.postJson(
        '/api/auth/two-factor/verify-totp',
        body: {'code': code, 'trustDevice': false},
      );
    } on ApiException catch (e) {
      final failure = e.statusCode == 400 || e.statusCode == 401
          ? TwoFactorFailure.invalidCode
          : _failureForStatus(e.statusCode);
      throw TwoFactorException(failure);
    }
  }

  /// Disables 2FA for the account. Requires a session-bound 2FA proof on the
  /// bearer path; a 401/403 surfaces as [TwoFactorFailure.needsReauth] (see
  /// the enum doc). [password] is required by Better Auth when the account has
  /// a credential login source; OAuth-only accounts send an empty body.
  Future<void> disable({String? password}) async {
    try {
      await apiClient.postJson(
        '/api/auth/two-factor/disable',
        body: {'password': ?password},
      );
    } on ApiException catch (e) {
      throw TwoFactorException(_failureForStatus(e.statusCode));
    }
  }

  static TwoFactorFailure _failureForStatus(int statusCode) {
    if (statusCode == 429) return TwoFactorFailure.rateLimited;
    if (statusCode == 401 || statusCode == 403) {
      return TwoFactorFailure.needsReauth;
    }
    return TwoFactorFailure.unknown;
  }
}
