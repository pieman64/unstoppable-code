import 'package:mobile/data/models/social_sign_in_result.dart';

sealed class EmailSignInResult {
  const EmailSignInResult();
}

final class EmailSignInVerification extends EmailSignInResult {
  const EmailSignInVerification();
}

/// Reuses the existing auth lifecycle and factor screen after password proof.
final class EmailSignInComplete extends EmailSignInResult {
  const EmailSignInComplete(this.result);
  final SocialSignInResult result;
}

abstract interface class EmailAuthRepository {
  Future<bool> emailAuthAvailable();
  Future<void> signUpWithEmail(String email, String password);
  Future<void> verifyEmailCode(String email, String code);
  Future<void> requestEmailPasswordReset(String email);
  Future<void> resetEmailPassword(String email, String code, String password);
  Future<EmailSignInResult> signInWithEmail({
    required String email,
    required String password,
  });
  void cancelEmailSignIn();
}
