import 'dart:async';

import 'package:mobile/data/models/device_registration.dart';
import 'package:mobile/data/repositories/device_repository.dart';
import 'package:mobile/data/services/push_messaging.dart';

/// Registers this device's push token with the account API in step with the
/// app's authentication lifecycle, and unregisters it on sign-out.
///
/// Every public method here is best-effort and never throws — push
/// registration must not block or fail sign-in/sign-out, so failures are
/// caught and swallowed, mirroring the app's fire-and-forget style elsewhere.
///
/// Message *handling* (foreground/background taps) is wired in a later task
/// once the real messaging plugin lands; this service only owns token
/// registration.
final class PushService {
  PushService({
    required this.messaging,
    required this.deviceRepository,
    required this.platform,
    required this.isPushConfigured,
    this.initialTokenRetryAttempts = 3,
    this.initialTokenRetryDelay = const Duration(seconds: 1),
  });

  final PushMessaging messaging;

  /// Injected directly rather than via a factory: the repository itself is
  /// stable across auth state changes because its underlying API client
  /// reads the bearer token dynamically (via `tokenProvider`) on every
  /// request, so there's nothing auth-scoped to rebuild.
  final DeviceRepository deviceRepository;
  final DevicePlatform platform;

  /// Reports whether the app has a real API configured
  /// (`AppConfig.hasAuthApiConfig`). `false` in demo mode or when no API base
  /// URL is configured, in which case this service is a no-op throughout.
  final bool Function() isPushConfigured;
  final int initialTokenRetryAttempts;
  final Duration initialTokenRetryDelay;

  final Set<String> _registeredTokens = <String>{};
  StreamSubscription<String>? _refreshSubscription;
  Future<void> _registrationQueue = Future<void>.value();
  int _authGeneration = 0;
  bool _authenticated = false;
  bool _activating = false;

  /// Requests notification permission and registers this device's push
  /// token, then listens for token refreshes to keep the registration
  /// current. A no-op when [isPushConfigured] returns `false`, when
  /// permission is not granted, or when no token is available. Never throws.
  Future<void> onAuthenticated() async {
    if (!isPushConfigured()) return;
    _authenticated = true;
    await _activate(++_authGeneration);
  }

  /// Re-attempts registration when the app returns to the foreground.
  ///
  /// [onAuthenticated] runs once per auth transition and gives up silently
  /// when permission is not yet granted or the initial token is unavailable
  /// (on iOS, APNS may not have issued one yet). Neither condition ever
  /// retried, so the single most common recovery — the user enabling
  /// notifications in OS settings, which necessarily backgrounds the app —
  /// left the device permanently unregistered until the next full sign-out
  /// and sign-in. Resuming re-runs the same activation, but only while
  /// signed in and only while nothing is registered, so an already-working
  /// device never re-requests permission or churns its token. Never throws.
  Future<void> onAppResumed() async {
    if (!isPushConfigured()) return;
    if (!_authenticated) return;
    if (_registeredTokens.isNotEmpty) return;
    // A slow first activation is still the authoritative one; bumping the
    // generation underneath it would make its own registration revoke itself.
    if (_activating) return;
    await _activate(++_authGeneration);
  }

  /// Shared activation body for [onAuthenticated] and [onAppResumed].
  /// [generation] fences the work so a concurrent sign-out revokes it.
  Future<void> _activate(int generation) async {
    _activating = true;
    try {
      final status = await messaging.requestPermission();
      if (status != PushPermissionStatus.granted) return;

      await _refreshSubscription?.cancel();
      if (generation != _authGeneration || !isPushConfigured()) return;
      _refreshSubscription = messaging.onTokenRefresh.listen(
        (token) => _onTokenRefresh(token, generation),
      );

      final token = await _getInitialToken();
      if (token != null) {
        if (generation != _authGeneration || !isPushConfigured()) {
          await messaging.deleteToken();
          return;
        }
        await _registerSafely(token, generation);
      }
    } catch (_) {
      // Best-effort: push registration must never block or fail sign-in.
    } finally {
      _activating = false;
    }
  }

  /// Deletes the local push token and unregisters the last-registered token
  /// server-side, if any, and stops listening for token refreshes. Never
  /// throws.
  Future<void> onSignedOut(String? _) async {
    try {
      _authenticated = false;
      _authGeneration++;
      await _refreshSubscription?.cancel();
      _refreshSubscription = null;

      final tokens = Set<String>.of(_registeredTokens);
      _registeredTokens.clear();

      try {
        // Delete even when this process has not observed a token. The
        // platform may still hold a prior user's token after an app restart.
        await messaging.deleteToken();
      } catch (_) {
        // Best-effort: still attempt server-side unregister below.
      }

      // Let any in-flight registration finish. Stale registrations are
      // immediately revoked by _register after they complete.
      await _registrationQueue;

      if (isPushConfigured()) {
        for (final token in tokens) {
          try {
            await deviceRepository.unregister(token: token);
          } catch (_) {
            // Best-effort: try all tracked tokens even if one unregister fails.
          }
        }
      }
    } catch (_) {
      // Best-effort: sign-out must never fail because push cleanup failed.
    }
  }

  /// Stops listening for token refreshes. Distinct from [onSignedOut], which
  /// also unregisters the current token; call this when the service itself
  /// is being torn down. Never throws.
  Future<void> dispose() async {
    try {
      await _refreshSubscription?.cancel();
      _refreshSubscription = null;
    } catch (_) {
      // Best-effort: disposal must never throw.
    }
  }

  Future<String?> _getInitialToken() async {
    final attempts = platform == DevicePlatform.ios
        ? initialTokenRetryAttempts + 1
        : 1;
    for (var attempt = 0; attempt < attempts; attempt++) {
      try {
        return await messaging.getToken();
      } catch (_) {
        if (attempt == attempts - 1) rethrow;
        await Future<void>.delayed(initialTokenRetryDelay);
      }
    }
    return null;
  }

  void _onTokenRefresh(String token, int generation) {
    unawaited(_registerSafely(token, generation));
  }

  Future<void> _registerSafely(String token, int generation) async {
    final registration = _registrationQueue.then(
      (_) => _register(token, generation),
    );
    _registrationQueue = registration.catchError((_) {});

    try {
      await registration;
    } catch (_) {
      // Best-effort: a refresh-triggered re-registration must never crash.
    }
  }

  Future<void> _register(String token, int generation) async {
    if (generation != _authGeneration || !isPushConfigured()) return;
    await deviceRepository.register(token: token, platform: platform);

    if (generation != _authGeneration || !isPushConfigured()) {
      if (isPushConfigured()) {
        await deviceRepository.unregister(token: token);
      }
      return;
    }

    final replacedTokens = Set<String>.of(_registeredTokens)..remove(token);
    _registeredTokens.add(token);
    if (!isPushConfigured()) return;
    for (final replacedToken in replacedTokens) {
      await deviceRepository.unregister(token: replacedToken);
      _registeredTokens.remove(replacedToken);
    }
  }
}
