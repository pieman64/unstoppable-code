import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/pkce.dart';

void main() {
  group('Pkce', () {
    test('generateCodeVerifier returns 43-128 unreserved-charset chars', () {
      final verifier = Pkce.generateCodeVerifier();
      expect(verifier, matches(r'^[A-Za-z0-9._~-]{43,128}$'));
    });

    test('generateCodeVerifier is random per call', () {
      expect(Pkce.generateCodeVerifier(), isNot(Pkce.generateCodeVerifier()));
    });

    test('deriveCodeChallenge is the base64url S256 of the verifier', () {
      const verifier = 'test_verifier_value_used_for_the_challenge_1';
      final expected = base64Url
          .encode(sha256.convert(utf8.encode(verifier)).bytes)
          .replaceAll('=', '');
      expect(Pkce.deriveCodeChallenge(verifier), expected);
      expect(
        Pkce.deriveCodeChallenge(verifier),
        matches(r'^[A-Za-z0-9_-]{43}$'),
      );
    });
  });
}
