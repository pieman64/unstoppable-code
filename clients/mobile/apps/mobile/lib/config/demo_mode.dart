import 'package:flutter/foundation.dart';

/// Runtime flag that puts the app into a self-contained **reviewer demo mode**
/// backed entirely by the in-app `Mock*` repositories, with no network calls.
///
/// This exists solely so an App Store / Google Play reviewer can exercise the
/// app without completing the org-gated OAuth + 2FA sign-in (which they cannot
/// do with static credentials). It is intentionally **not** a user-facing
/// feature: it is reached only through a deliberately obscure gesture on the
/// sign-in screen (tap the brand logo [activationTapCount] times) and is
/// disclosed to reviewers in the store "App access" / review notes — which is
/// what satisfies App Store Guideline 2.3.1 (no *undisclosed* hidden features).
///
/// When [enabled] is `true`, [AppConfig.hasAuthApiConfig] reports `false`, so
/// every repository builder in `main.dart` resolves to its `Mock*`
/// implementation and the auth gate uses `MockAuthRepository` — i.e. the exact
/// same state the app runs in locally with no brand-prefixed API base URLs
/// configured. It always starts `false` on launch (never persisted), so real
/// users never land in it.
abstract final class DemoMode {
  /// Whether reviewer demo mode is currently active. Defaults to `false`.
  static final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);

  /// Number of sign-in-logo taps required to enter reviewer demo mode.
  static const int activationTapCount = 5;
}
