import 'package:flutter/services.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/apple_native_result.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/apple_credential_provider.dart';
import 'package:mobile/data/services/auth_api_service.dart';
import 'package:mobile/data/services/browser_capabilities.dart';
import 'package:mobile/data/services/oauth_authenticator.dart';
import 'package:mobile/data/services/pkce.dart';
import 'package:mobile/data/services/session_store.dart';

/// Thrown by [AuthRepository.signIn] when authentication fails
/// (bad credentials, network error, etc.).
class AuthException implements Exception {
  const AuthException(this.message);

  final String message;

  @override
  String toString() => 'AuthException: $message';
}

/// Credentials exist, but validation could not finish. Retry restoration;
/// never repeat the consumed OAuth exchange or enter the authenticated app.
class SessionValidationException extends AuthException {
  const SessionValidationException()
    : super('Couldn’t verify your session. Please try again.');
}

/// Abstraction over the authentication backend.
///
/// [MockAuthRepository] backs the walking-skeleton UI today; a real
/// Better-Auth-backed implementation (hitting `POST /api/auth/sign-in/email`
/// and persisting the bearer token) will implement this same interface once
/// the server enables the `bearer()` plugin.
abstract interface class AuthRepository {
  /// Returns a previously persisted session, or `null` when there is none.
  Future<AuthSession?> restoreSession();

  /// Authenticates with email + password.  Throws [AuthException] on failure.
  Future<AuthSession> signIn({required String email, required String password});

  /// Clears the current session.
  Future<void> signOut();

  /// Runs the OAuth flow for [provider].  Returns a [SocialSignInResult]
  /// (a completed session or a 2FA challenge), or `null` if the user cancelled.
  /// Throws [AuthException] on failure.
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider);

  /// Runs the native "Sign in with Apple" flow (on-device authorization
  /// sheet, no browser redirect). Returns a [SocialSignInResult] (a completed
  /// session or a 2FA challenge), or `null` if the user cancelled. Throws
  /// [AuthException] on failure.
  Future<SocialSignInResult?> signInWithApple();

  /// Completes a [SocialSignInTwoFactorRequired] flow by verifying a TOTP or
  /// backup [code] and exchanging the resulting one-time code for a session.
  /// Throws [AuthException] on an invalid code or failure.
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  });
}

/// Guest sessions (CAN-2872): a session with no sign-in method. Signing in
/// while one is stored merges the guest into the real account server-side,
/// because the code exchange carries the guest's bearer token.
abstract interface class GuestSessionRepository {
  /// Whether the server lets the app start a guest session now.
  Future<bool> guestSessionAvailable();

  /// Starts and persists a guest session. Throws [AuthException] on failure.
  Future<AuthSession> continueAsGuest();
}

/// In-memory [AuthRepository] used until the real backend is wired.
///
/// Accepts any non-empty email whose password equals [validPassword]; every
/// other attempt throws [AuthException] so the error path stays exercisable.
/// The session lives only in memory, so a cold start always begins signed out
/// ([restoreSession] returns `null` until a successful [signIn]).
final class MockAuthRepository implements AuthRepository {
  MockAuthRepository({
    this.validPassword = 'password',
    this.latency = const Duration(milliseconds: 600),
  });

  final String validPassword;
  final Duration latency;

  AuthSession? _session;

  @override
  Future<AuthSession?> restoreSession() async {
    await Future<void>.delayed(latency);
    return _session;
  }

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async {
    await Future<void>.delayed(latency);
    final trimmedEmail = email.trim();
    if (trimmedEmail.isEmpty || password != validPassword) {
      throw const AuthException('Invalid email or password');
    }
    final session = AuthSession(
      token: 'mock-session-token',
      user: AuthUser(
        id: 'mock-user',
        email: trimmedEmail,
        emailVerified: true,
        name: _nameFromEmail(trimmedEmail),
        image: null,
        role: 'DEVELOPER',
        status: 'ACTIVE',
        twoFactorEnabled: false,
        createdAt: '',
        updatedAt: '',
      ),
    );
    _session = session;
    return session;
  }

  @override
  Future<void> signOut() async {
    await Future<void>.delayed(const Duration(milliseconds: 100));
    _session = null;
  }

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async {
    await Future<void>.delayed(latency);
    final session = AuthSession(
      token: 'mock-${provider.wire}-token',
      user: AuthUser(
        id: 'mock-user',
        email: '${provider.wire}.user@example.com',
        emailVerified: true,
        name: provider.label,
        image: null,
        role: 'DEVELOPER',
        status: 'ACTIVE',
        twoFactorEnabled: false,
        createdAt: '',
        updatedAt: '',
      ),
    );
    _session = session;
    return SocialSignInSuccess(session);
  }

  @override
  Future<SocialSignInResult?> signInWithApple() async {
    await Future<void>.delayed(latency);
    final session = AuthSession(
      token: 'mock-${SocialProvider.apple.wire}-token',
      user: AuthUser(
        id: 'mock-user',
        email: '${SocialProvider.apple.wire}.user@example.com',
        emailVerified: true,
        name: SocialProvider.apple.label,
        image: null,
        role: 'DEVELOPER',
        status: 'ACTIVE',
        twoFactorEnabled: false,
        createdAt: '',
        updatedAt: '',
      ),
    );
    _session = session;
    return SocialSignInSuccess(session);
  }

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async {
    // The mock backend has no 2FA accounts, so this is never reached from the
    // mock sign-in flow; return the current session if one exists.
    await Future<void>.delayed(latency);
    final session = _session;
    if (session == null) {
      throw const AuthException('Sign-in did not complete. Please try again.');
    }
    return session;
  }

  static String _nameFromEmail(String email) {
    final local = email.split('@').first;
    if (local.isEmpty) return 'User';
    return local[0].toUpperCase() + local.substring(1);
  }
}

/// Live [AuthRepository] backed by Better Auth via [AuthApiService], persisting
/// the bearer token in [SessionStore].
final class HttpAuthRepository
    implements AuthRepository, GuestSessionRepository {
  HttpAuthRepository({
    required this.service,
    required this.sessionStore,
    this.oauthAuthenticator,
    this.validationTimeout = const Duration(seconds: 30),
    this.appleCredentialProvider = const SignInWithAppleCredentialProvider(),
    this.browserCapabilities = const PlatformBrowserCapabilities(),
  });

  final Duration validationTimeout;
  int _generation = 0;

  final AuthApiService service;
  final SessionStore sessionStore;
  final OAuthAuthenticator? oauthAuthenticator;
  final BrowserCapabilities browserCapabilities;
  final AppleCredentialProvider appleCredentialProvider;

  @override
  Future<AuthSession?> restoreSession() async {
    final generation = ++_generation;
    final token = await sessionStore.read();
    if (generation != _generation) throw const SessionValidationException();
    if (token == null || token.isEmpty) return null;
    return _validate(token, generation);
  }

  Future<AuthSession?> _validate(String token, int generation) async {
    bool isCurrent() =>
        generation == _generation && sessionStore.currentToken == token;
    try {
      AuthUser? user;
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          user = await service.currentUser().timeout(validationTimeout);
        } on ApiException catch (error) {
          if (error.statusCode != 401) rethrow;
          user = null;
        }
        if (!isCurrent()) throw const SessionValidationException();
        if (user != null) break;

        // A single edge/proxy anomaly must not erase the only persisted copy
        // of a mobile bearer token. Confirm an apparently missing/unauthorized
        // session once; a failed confirmation is inconclusive and preserves
        // the credentials for Session Recovery.
        if (attempt == 0) continue;
        await sessionStore.clear();
        return null;
      }
      if (user == null) {
        throw const SessionValidationException();
      }
      if (user.twoFactorEnabled && sessionStore.currentTwoFactorProof == null) {
        await sessionStore.clear();
        return null;
      }
      return AuthSession(token: token, user: user);
    } catch (_) {
      throw const SessionValidationException();
    }
  }

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async {
    final generation = ++_generation;
    final AuthSession session;
    try {
      session = await service.signInWithEmail(email: email, password: password);
    } on ApiException catch (e) {
      throw AuthException(_messageForStatus(e.statusCode));
    }
    if (generation != _generation) throw const SessionValidationException();
    await sessionStore.save(session.token);
    return session;
  }

  @override
  Future<void> signOut() async {
    ++_generation;
    try {
      await service.signOut();
    } catch (_) {
      // Best-effort server sign-out; always clear the local token below.
    }
    await sessionStore.clear();
  }

  @override
  Future<bool> guestSessionAvailable() async {
    try {
      return await service.guestSessionAvailable();
    } catch (_) {
      // An older server without the route, or no network: offer sign-in only.
      return false;
    }
  }

  @override
  Future<AuthSession> continueAsGuest() async {
    final generation = ++_generation;
    final String token;
    try {
      // A fresh id per mint rather than a stored one: the server uses it only
      // to key its rate limit, and a persistent identifier would be a device
      // id the app does not otherwise collect.
      token = await service.mintGuestSession(
        clientDeviceId: Pkce.generateCodeVerifier(),
      );
    } on ApiException catch (e) {
      throw AuthException(
        e.statusCode == 429
            ? 'Too many attempts. Please wait a moment and try again.'
            : 'Could not start a guest session. Try again in a moment, or sign in.',
      );
    }
    if (generation != _generation) throw const SessionValidationException();
    await sessionStore.save(token);
    final session = await _validate(token, generation);
    if (session == null) {
      throw const AuthException(
        'Could not start a guest session. Try again in a moment, or sign in.',
      );
    }
    return session;
  }

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async {
    final generation = ++_generation;
    final authenticator = oauthAuthenticator;
    if (authenticator == null) {
      throw const AuthException('Social sign-in is not available.');
    }
    final verifier = Pkce.generateCodeVerifier();
    final challenge = Pkce.deriveCodeChallenge(verifier);
    // Resolved once per attempt: the redirect registered with the server and the
    // callback the browser session intercepts must be the same URL, and the
    // answer depends on a browser the user can update between attempts.
    final callbackUrl = await AppConfig.resolveOauthCallbackUrl(
      browserCapabilities,
    );
    final String? callback;
    try {
      callback = await authenticator.authenticate(
        authorizeUrl: _oauthStartUrl(provider, challenge, callbackUrl),
        callbackUrl: callbackUrl,
      );
    } on PlatformException catch (e) {
      // The browser could not hand the callback back. Without this the raw
      // platform error escaped and the sign-in screen showed nothing
      // actionable, which is how an unsupported browser looked like a hang.
      throw AuthException(_messageForBrowserFailure(e));
    }
    try {
      if (callback == null) return null; // user cancelled the browser flow
      final params = Uri.parse(callback).queryParameters;
      final error = params['error'];
      if (error != null) {
        // The user backed out at the provider's consent screen. That is the
        // same intent as dismissing the browser tab, which returns null above,
        // so it must not surface as an error the way a real failure does.
        //
        // Caveat for triage: OAuth spells this "the resource owner *or
        // authorization server* denied the request", and the second case is not
        // a cancellation — Google returns it for an app in Testing status when
        // the signer is not a listed tester, GitHub for org-restricted OAuth
        // apps. Those users get a silent no-op here, so a "the button does
        // nothing" report is most likely this. Telling them apart needs the
        // server to forward a sanitized `error_description`, which it does not.
        if (error == 'access_denied') return null;
        // A 2FA-enabled account is not a failure: the server issues a challenge
        // token so the user can submit a TOTP/backup code via completeTwoFactor.
        if (error == 'two_factor_required') {
          final challengeToken = params['challenge'];
          if (challengeToken != null && challengeToken.isNotEmpty) {
            return SocialSignInTwoFactorRequired(
              challenge: challengeToken,
              verifier: verifier,
            );
          }
        }
        throw AuthException(_messageForOAuthError(error));
      }
      final code = params['code'];
      if (code == null || code.isEmpty) {
        throw const AuthException(
          'Sign-in did not complete. Please try again.',
        );
      }
      // Exchange the one-time code (bound to our PKCE verifier) for the bearer
      // token. An intercepted deep-link code is useless without the verifier.
      final session = await _exchangeAndPersist(code, verifier, generation);
      return SocialSignInSuccess(session);
    } on ApiException catch (e) {
      throw AuthException(_messageForStatus(e.statusCode));
    }
  }

  @override
  Future<SocialSignInResult?> signInWithApple() async {
    final generation = ++_generation;
    final verifier = Pkce.generateCodeVerifier();
    final challenge = Pkce.deriveCodeChallenge(verifier);
    // Replay protection binds the Apple identity token to a nonce we keep
    // secret. Apple echoes whatever we pass as its `nonce` into the token's
    // readable `nonce` claim verbatim, so we send it the SHA-256 HASH of a
    // random raw nonce and forward the RAW nonce to the backend, which re-hashes
    // it before Better Auth's direct claim compare. Because only the hash rides
    // inside the token, an attacker who captures the identity token cannot
    // recover the raw nonce to replay it. (See design.md nonce note.)
    final rawNonce = Pkce.generateCodeVerifier();
    final hashedNonce = Pkce.sha256Hex(rawNonce);
    try {
      final credential = await appleCredentialProvider.getCredential(
        nonce: hashedNonce,
      );
      if (credential == null) return null; // user cancelled the native sheet
      final result = await service.appleNativeSignIn(
        identityToken: credential.identityToken,
        nonce: rawNonce,
        codeChallenge: challenge,
        name: credential.fullName,
      );
      return switch (result) {
        AppleNativeTwoFactor(:final challenge) => SocialSignInTwoFactorRequired(
          challenge: challenge,
          verifier: verifier,
        ),
        AppleNativeCode(:final code) => SocialSignInSuccess(
          await _exchangeAndPersist(code, verifier, generation),
        ),
      };
    } on ApiException catch (e) {
      throw AuthException(_messageForStatus(e.statusCode));
    }
  }

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async {
    final generation = ++_generation;
    try {
      // Verify the TOTP/backup code (bound to our PKCE verifier), then feed the
      // returned one-time code into the same exchange path as a direct sign-in.
      final exchangeCode = await service.verifyTwoFactor(
        challenge: challenge,
        verifier: verifier,
        code: code,
      );
      return await _exchangeAndPersist(exchangeCode, verifier, generation);
    } on ApiException catch (e) {
      throw AuthException(_messageForTwoFactorStatus(e.statusCode));
    }
  }

  /// Exchanges the one-time [code] (bound to the PKCE [verifier]) for the bearer
  /// token, persists it (plus any 2FA proof) so the [ApiClient]'s bearer
  /// provider can authenticate [AuthApiService.currentUser], and validates the
  /// session. Temporary validation failures retain credentials for restoration;
  /// only a validated session may be returned to the caller.
  Future<AuthSession> _exchangeAndPersist(
    String code,
    String verifier,
    int generation,
  ) async {
    if (generation != _generation) throw const SessionValidationException();
    final exchange = await service.exchangeOAuthCode(
      code: code,
      codeVerifier: verifier,
    );
    if (generation != _generation) throw const SessionValidationException();
    await sessionStore.save(
      exchange.token,
      twoFactorProof: exchange.twoFactorProof,
    );
    final session = await _validate(exchange.token, generation);
    if (session == null) {
      throw const AuthException('Sign-in did not complete. Please try again.');
    }
    return session;
  }

  /// The server route that starts the OAuth flow inside the in-app browser, so
  /// the CSRF state cookie is set in the same session that completes it. The
  /// PKCE [codeChallenge] binds the resulting exchange code to this app.
  static String _oauthStartUrl(
    SocialProvider provider,
    String codeChallenge,
    String callbackUrl,
  ) =>
      '${AppConfig.apiBaseUrl}/api/mobile/oauth-start'
      '?provider=${provider.wire}'
      '&redirect=${Uri.encodeComponent(callbackUrl)}'
      '&code_challenge=$codeChallenge';

  static String _messageForBrowserFailure(PlatformException error) {
    if (error.code == 'NO_BROWSER') {
      return 'No browser is available to complete sign-in. Please install a '
          'browser and try again.';
    }
    return 'Your browser could not complete sign-in. Please make sure it is '
        'up to date, then try again.';
  }

  /// Turns the server's `?error=<code>` deep-link result into something the
  /// user can act on.
  ///
  /// Every code used to collapse into "Could not sign in", which is the least
  /// useful thing to tell someone whose sign-in was simply too slow — they had
  /// no way to know retrying would work. The server deliberately keeps
  /// `invalid_flow` opaque about *which* check rejected the flow (expired,
  /// already completed, nonce mismatch), so this message names the causes a
  /// user can do something about rather than claiming a specific one.
  static String _messageForOAuthError(String error) {
    switch (error) {
      case 'two_factor_required':
        // Reached only if the server omitted a challenge token (older backend);
        // the interactive TOTP flow handles the normal case upstream.
        return 'Two-factor authentication is not yet supported in the app. '
            'Please sign in on the web for now.';
      case 'provider_unavailable':
        return 'This sign-in method is currently unavailable. Please try another method.';
      case 'invalid_flow':
        return 'Sign-in timed out or was interrupted. Please try again.';
      case 'no_session':
        return 'Sign-in did not complete. Please try again.';
      // `access_denied` never reaches here — signInWithSocial returns null for
      // it, because a deliberate cancellation is not a failure.
      //
      // `invalid_redirect` is also server-originated, but it means the callback
      // target failed re-validation — misconfiguration or tampering, not
      // something the user can act on — so it deliberately falls through.
      //
      // This default is load-bearing and must stay: the server passes through
      // any `[a-z0-9_]{1,64}` provider slug, so the switch can never be
      // exhaustive over `server_error`, `temporarily_unavailable`,
      // `consent_required`, and friends.
      default:
        return 'Could not sign in. Please try again.';
    }
  }

  static String _messageForStatus(int statusCode) {
    if (statusCode == 401 || statusCode == 403) {
      return 'Invalid email or password';
    }
    return 'Could not sign in. Please try again.';
  }

  static String _messageForTwoFactorStatus(int statusCode) {
    if (statusCode == 429) {
      return 'Too many attempts. Please wait a moment and try again.';
    }
    if (statusCode == 400 || statusCode == 401) {
      return 'That code was not valid. Please try again.';
    }
    return 'Could not verify the code. Please try again.';
  }
}
