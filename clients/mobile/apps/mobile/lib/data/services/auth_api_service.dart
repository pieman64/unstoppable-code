import 'package:mobile/data/models/apple_native_result.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/services/api_client.dart';

/// Result of exchanging a mobile OAuth code for a Better Auth bearer token.
///
/// [twoFactorProof] is present only for 2FA-enabled users; the client stores it
/// and sends it back as the `x-two-factor-verified` header on API calls.
final class MobileOAuthTokenResult {
  const MobileOAuthTokenResult({required this.token, this.twoFactorProof});

  final String token;
  final String? twoFactorProof;
}

/// Wraps the Better Auth REST endpoints used by the real auth repository.
///
/// Base path `/api/auth`:
///   GET  /get-session    → `{ session, user }` or `null` (needs bearer token)
///   POST /sign-out       → `{}` (needs bearer token)
final class AuthApiService {
  const AuthApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Returns the user for the current bearer token, or `null` when there is no
  /// valid session.
  Future<AuthUser?> currentUser() async {
    // Session restoration owns its confirmation policy. A hidden transport
    // retry here would multiply those probes and blur the distinction between
    // an authoritative invalidation and an inconclusive transient failure.
    final json = await apiClient.getNullableJson(
      '/api/auth/get-session',
      retryTransient: false,
    );
    if (json == null) return null;
    final user = json['user'];
    if (user is! Map<String, dynamic> ||
        user['id'] is! String ||
        (user['id'] as String).isEmpty) {
      throw const FormatException('Malformed session response');
    }
    return AuthUser.fromJson(user);
  }

  /// Invalidates the current session server-side.
  Future<void> signOut() async {
    await apiClient.postJson('/api/auth/sign-out');
  }

  /// Whether the server currently lets the app start a guest session. See web
  /// `GET /api/mobile/guest-session`.
  Future<bool> guestSessionAvailable() async {
    final json = await apiClient.getJson('/api/mobile/guest-session');
    return json['enabled'] == true;
  }

  /// Starts a guest session and returns its bearer token. [clientDeviceId]
  /// only keys the server's rate limit. See web `POST /api/mobile/guest-session`.
  Future<String> mintGuestSession({required String clientDeviceId}) async {
    final json = await apiClient.postJson(
      '/api/mobile/guest-session',
      body: {'clientDeviceId': clientDeviceId},
    );
    final token = json['token'];
    if (token is! String || token.isEmpty) {
      throw const ApiException(
        statusCode: 500,
        body: 'Malformed guest-session response: missing token',
      );
    }
    return token;
  }

  /// Exchanges the one-time OAuth [code] (plus the PKCE [codeVerifier]) for the
  /// Better Auth bearer token. See web `POST /api/mobile/oauth-token`.
  Future<MobileOAuthTokenResult> exchangeOAuthCode({
    required String code,
    required String codeVerifier,
  }) async {
    final json = await apiClient.postJson(
      '/api/mobile/oauth-token',
      body: {'code': code, 'code_verifier': codeVerifier},
    );
    final token = json['token'];
    if (token is! String || token.isEmpty) {
      throw const ApiException(
        statusCode: 500,
        body: 'Malformed oauth-token response: missing token',
      );
    }
    final proof = json['twoFactorProof'];
    return MobileOAuthTokenResult(
      token: token,
      twoFactorProof: proof is String && proof.isNotEmpty ? proof : null,
    );
  }

  /// Verifies a TOTP or backup [code] against the 2FA [challenge] (bound to the
  /// PKCE [verifier]) and returns a fresh one-time exchange code to feed into
  /// [exchangeOAuthCode]. See web `POST /api/mobile/two-factor/verify`.
  Future<String> verifyTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async {
    final json = await apiClient.postJson(
      '/api/mobile/two-factor/verify',
      body: {'challenge': challenge, 'code': code, 'code_verifier': verifier},
    );
    final exchangeCode = json['code'];
    if (exchangeCode is! String || exchangeCode.isEmpty) {
      throw const ApiException(
        statusCode: 500,
        body: 'Malformed two-factor verify response: missing code',
      );
    }
    return exchangeCode;
  }

  /// Completes native "Sign in with Apple" by POSTing the Apple
  /// [identityToken] (verified server-side against Apple's JWKS), the RAW SIWA
  /// [nonce] (the client sends Apple its SHA-256 hash and forwards the raw value
  /// here; the server re-hashes before Better Auth's claim compare), and the
  /// PKCE [codeChallenge] bound to this attempt. [name] is Apple's one-time
  /// full-name consent and is only sent when present.
  ///
  /// Returns a single-use [AppleNativeCode] to feed into [exchangeOAuthCode],
  /// or an [AppleNativeTwoFactor] challenge for 2FA-enabled accounts (to feed
  /// into [verifyTwoFactor]). See web `POST /api/mobile/oauth-apple-native`.
  Future<AppleNativeResult> appleNativeSignIn({
    required String identityToken,
    required String nonce,
    required String codeChallenge,
    String? name,
  }) async {
    final json = await apiClient.postJson(
      '/api/mobile/oauth-apple-native',
      body: {
        'identity_token': identityToken,
        'nonce': nonce,
        'code_challenge': codeChallenge,
        'name': ?name,
      },
    );
    final code = json['code'];
    if (code is String && code.isNotEmpty) {
      return AppleNativeCode(code);
    }
    final challenge = json['challenge'];
    if (json['two_factor_required'] == true &&
        challenge is String &&
        challenge.isNotEmpty) {
      return AppleNativeTwoFactor(challenge);
    }
    throw const ApiException(
      statusCode: 500,
      body: 'Malformed oauth-apple-native response: missing code/challenge',
    );
  }
}
