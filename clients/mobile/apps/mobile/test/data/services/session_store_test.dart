import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/session_store.dart';

void main() {
  group('SecureSessionStore hardening', () {
    test('uses the v9 encrypted-preferences migration path', () {
      final options = SecureSessionStore.androidOptions.params;
      expect(options['migrateOnAlgorithmChange'], 'true');
      expect(options['migrateWithBackup'], 'false');
      expect(options['resetOnError'], 'false');
      expect(options['storageCipherAlgorithm'], 'AES_GCM_NoPadding');
    });

    test(
      'restricts iOS keychain accessibility to first-unlock-this-device',
      () {
        expect(
          SecureSessionStore.iosOptions.params['accessibility'],
          'first_unlock_this_device',
        );
      },
    );
  });

  group('InMemorySessionStore', () {
    test('save then read returns the token and caches it', () async {
      final store = InMemorySessionStore();
      expect(store.currentToken, isNull);

      await store.save('tok-123');

      expect(store.currentToken, 'tok-123');
      expect(await store.read(), 'tok-123');
    });

    test('clear removes the token', () async {
      final store = InMemorySessionStore(initialToken: 'tok-123');
      expect(store.currentToken, 'tok-123');

      await store.clear();

      expect(store.currentToken, isNull);
      expect(await store.read(), isNull);
    });

    test(
      'save stores an optional two-factor proof; clear removes both',
      () async {
        final store = InMemorySessionStore();
        await store.save('tok', twoFactorProof: 'proof-1');
        expect(store.currentToken, 'tok');
        expect(store.currentTwoFactorProof, 'proof-1');

        await store.clear();
        expect(store.currentToken, isNull);
        expect(store.currentTwoFactorProof, isNull);
      },
    );

    test('save without a proof clears any prior proof', () async {
      final store = InMemorySessionStore();
      await store.save('tok', twoFactorProof: 'proof-1');
      await store.save('tok2');
      expect(store.currentTwoFactorProof, isNull);
    });
  });
}
