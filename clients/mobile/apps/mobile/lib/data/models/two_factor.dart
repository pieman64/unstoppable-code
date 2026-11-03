/// Hand-written models for TOTP two-factor management.
///
/// These are intentionally NOT code-generated: the protocol codegen cannot
/// emit the small, mixed-shape Better Auth 2FA payloads cleanly (branded
/// string unions render as broken empty classes), and these bodies are tiny.
/// Fields are plain [String]s with defensive `fromJson` parsing so a malformed
/// or partial server response degrades gracefully instead of throwing deep in
/// the UI.
///
/// SECURITY: none of these values are ever logged. The [otpauthUri] embeds the
/// shared TOTP secret and the [backupCodes] are shown once; callers must treat
/// both as sensitive and must not persist them to disk.
library;

/// Whether two-factor authentication is currently active for the account and
/// whether a linked credential login requires password confirmation for 2FA
/// management calls.
///
/// Read from `GET /api/account/auth-sources` (`user.twoFactorEnabled` and
/// `sources[].providerId`), the same source the web account settings screen
/// uses.
final class TwoFactorStatus {
  const TwoFactorStatus({
    required this.enabled,
    this.hasCredentialAuthSource = false,
  });

  /// True when the account requires a second factor at sign-in.
  final bool enabled;

  /// True when the account has an email/password credential source. Better
  /// Auth requires that password when enabling or disabling 2FA.
  final bool hasCredentialAuthSource;

  factory TwoFactorStatus.fromAuthSourcesJson(Map<String, dynamic> json) {
    final user = json['user'];
    final enabled = user is Map<String, dynamic>
        ? user['twoFactorEnabled']
        : null;
    final sources = json['sources'];
    final hasCredentialAuthSource =
        sources is List &&
        sources.whereType<Map<String, dynamic>>().any(
          (source) => source['providerId'] == 'credential',
        );
    return TwoFactorStatus(
      enabled: enabled is bool ? enabled : false,
      hasCredentialAuthSource: hasCredentialAuthSource,
    );
  }
}

/// Result of beginning enrollment via `POST /api/auth/two-factor/enable`.
///
/// The server provisions the encrypted TOTP material and returns the
/// [otpauthUri] (for an authenticator app or manual entry) plus the one-time
/// [backupCodes]. Enrollment is not yet active: the user must confirm a code
/// via [TwoFactorRepository.verifyEnrollment] before 2FA is enforced.
final class TwoFactorEnrollment {
  const TwoFactorEnrollment({
    required this.otpauthUri,
    required this.backupCodes,
  });

  /// The `otpauth://totp/...?secret=...` URI. Carries the shared secret.
  final String otpauthUri;

  /// One-time recovery codes, shown once. Empty when the server returned none.
  final List<String> backupCodes;

  /// The base32 `secret` parameter parsed out of [otpauthUri], or `null` when
  /// the URI has no secret. Surfaced so the user can hand-enter the key when
  /// they cannot scan a QR code.
  String? get secret => Uri.tryParse(otpauthUri)?.queryParameters['secret'];

  factory TwoFactorEnrollment.fromJson(Map<String, dynamic> json) {
    final uri = json['totpURI'];
    if (uri is! String || uri.isEmpty) {
      throw const FormatException('Missing totpURI in enable response');
    }
    final rawCodes = json['backupCodes'];
    final codes = rawCodes is List
        ? rawCodes.whereType<String>().toList(growable: false)
        : const <String>[];
    return TwoFactorEnrollment(otpauthUri: uri, backupCodes: codes);
  }
}
