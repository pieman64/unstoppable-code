import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/apple_credential_provider.dart';

class _StubProvider implements AppleCredentialProvider {
  @override
  Future<AppleCredential?> getCredential({required String nonce}) async =>
      const AppleCredential(
        identityToken: 'tok',
        fullName: 'Jane Doe',
        email: 'j@example.com',
      );
}

void main() {
  test(
    'AppleCredential exposes the identity token + optional name/email',
    () async {
      final c = await _StubProvider().getCredential(nonce: 'n');
      expect(c!.identityToken, 'tok');
      expect(c.fullName, 'Jane Doe');
    },
  );
}
