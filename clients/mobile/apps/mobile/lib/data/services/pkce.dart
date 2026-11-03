import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

/// PKCE (RFC 7636, S256) helpers for the mobile OAuth handoff.
abstract final class Pkce {
  static final Random _random = Random.secure();

  /// A cryptographically random `code_verifier`: 32 random bytes as unpadded
  /// base64url (43 chars of the unreserved set).
  static String generateCodeVerifier() {
    final bytes = List<int>.generate(32, (_) => _random.nextInt(256));
    return base64Url.encode(bytes).replaceAll('=', '');
  }

  /// The `code_challenge` = unpadded base64url of SHA-256(ascii(verifier)).
  static String deriveCodeChallenge(String verifier) {
    final digest = sha256.convert(utf8.encode(verifier));
    return base64Url.encode(digest.bytes).replaceAll('=', '');
  }

  /// Lowercase hex SHA-256 of [input].
  ///
  /// Used to bind the native Sign in with Apple identity token to a nonce the
  /// client keeps secret: the app sends Apple `sha256Hex(rawNonce)` (Apple
  /// echoes it verbatim into the token's `nonce` claim) and forwards the RAW
  /// nonce to the backend, which re-hashes it with the same lowercase-hex
  /// SHA-256 before Better Auth compares it to the claim. Because only the hash
  /// ever appears in the token, an attacker who captures the identity token
  /// cannot recover the raw nonce to replay it.
  static String sha256Hex(String input) =>
      sha256.convert(utf8.encode(input)).toString();
}
