/// Outcome of `AuthApiService.appleNativeSignIn`.
///
/// A completed native "Sign in with Apple" attempt yields a single-use
/// [AppleNativeCode] that the client feeds into
/// `AuthApiService.exchangeOAuthCode`, reusing the same exchange machinery the
/// web-redirect OAuth flow uses. A 2FA-enabled account instead yields an
/// [AppleNativeTwoFactor] challenge that must be verified via
/// `AuthApiService.verifyTwoFactor` before a fresh exchange code is minted.
sealed class AppleNativeResult {
  const AppleNativeResult();
}

/// The native Apple sign-in completed and produced a single-use exchange
/// [code].
final class AppleNativeCode extends AppleNativeResult {
  const AppleNativeCode(this.code);

  final String code;
}

/// The account has 2FA enabled; [challenge] must be verified before a fresh
/// exchange code can be minted.
final class AppleNativeTwoFactor extends AppleNativeResult {
  const AppleNativeTwoFactor(this.challenge);

  final String challenge;
}
