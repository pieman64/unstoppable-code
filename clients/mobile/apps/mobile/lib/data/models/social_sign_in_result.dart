import 'package:mobile/data/models/auth_session.dart';

/// Outcome of `AuthRepository.signInWithSocial`.
///
/// A cancelled browser flow is reported as a `null` return (matching the prior
/// `Future<AuthSession?>` contract). A completed flow is [SocialSignInSuccess];
/// a 2FA-gated account is [SocialSignInTwoFactorRequired].
sealed class SocialSignInResult {
  const SocialSignInResult();
}

/// The provider flow completed and produced a live session.
final class SocialSignInSuccess extends SocialSignInResult {
  const SocialSignInSuccess(this.session);

  final AuthSession session;
}

/// The account has 2FA enabled and must submit a TOTP or backup code before a
/// session is issued.
///
/// [challenge] is the server-issued single-use challenge token; [verifier] is
/// the PKCE verifier from this sign-in attempt, replayed at both the verify and
/// exchange steps.
final class SocialSignInTwoFactorRequired extends SocialSignInResult {
  const SocialSignInTwoFactorRequired({
    required this.challenge,
    required this.verifier,
  });

  final String challenge;
  final String verifier;
}
