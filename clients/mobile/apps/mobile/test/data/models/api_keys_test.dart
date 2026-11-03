import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/api_keys.dart';

void main() {
  group('UserApiKeyListItem.fromJson', () {
    test('parses metadata, the source enum, and nullable fields', () {
      final item = UserApiKeyListItem.fromJson(<String, dynamic>{
        'id': 'key-1',
        'name': 'CI token',
        'source': 'MANUAL',
        'createdIp': '203.0.113.7',
        'createdAt': '2026-06-01T00:00:00.000Z',
        'lastUsedAt': null,
      });

      expect(item.id, 'key-1');
      expect(item.name, 'CI token');
      expect(item.source, UserApiKeySource.manual);
      expect(item.createdIp, '203.0.113.7');
      expect(item.lastUsedAt, isNull);
    });

    test('parses the OAUTH_DESKTOP source', () {
      final item = UserApiKeyListItem.fromJson(<String, dynamic>{
        'id': 'key-2',
        'name': 'Desktop',
        'source': 'OAUTH_DESKTOP',
        'createdIp': null,
        'createdAt': '2026-06-01T00:00:00.000Z',
        'lastUsedAt': '2026-06-02T00:00:00.000Z',
      });

      expect(item.source, UserApiKeySource.oauthDesktop);
    });

    // Regression guard for protocol drift: the server added the GUEST source
    // (apps/web/src/lib/api-keys.ts) — the generated enum and the account
    // screen's exhaustive label switch must both know about it, or a
    // guest-minted key throws FormatException and blanks the API-keys list.
    test('parses the GUEST source', () {
      final item = UserApiKeyListItem.fromJson(<String, dynamic>{
        'id': 'key-4',
        'name': 'Guest session',
        'source': 'GUEST',
        'createdIp': null,
        'createdAt': '2026-06-01T00:00:00.000Z',
        'lastUsedAt': null,
      });

      expect(item.source, UserApiKeySource.guest);
    });
  });

  group('UserApiKeyCreateResponse.fromJson', () {
    test('parses the one-time token and the nested key', () {
      final resp = UserApiKeyCreateResponse.fromJson(<String, dynamic>{
        'token': 'secret-token-value',
        'userApiKey': <String, dynamic>{
          'id': 'key-3',
          'name': 'New key',
          'source': 'MANUAL',
          'createdIp': null,
          'createdAt': '2026-06-01T00:00:00.000Z',
          'lastUsedAt': null,
        },
      });

      expect(resp.token, 'secret-token-value');
      expect(resp.userApiKey.id, 'key-3');
      expect(resp.userApiKey.source, UserApiKeySource.manual);
    });
  });
}
