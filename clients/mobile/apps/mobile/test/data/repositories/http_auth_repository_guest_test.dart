import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/apple_credential_provider.dart';
import 'package:mobile/data/services/auth_api_service.dart';
import 'package:mobile/data/services/oauth_authenticator.dart';
import 'package:mobile/data/services/session_store.dart';

// Guest sessions (CAN-2872): minting, availability, and the sign-in that
// merges a guest into a real account by carrying the guest's bearer.
void main() {
  HttpAuthRepository build(
    MockClient client,
    SessionStore store, {
    OAuthAuthenticator? oauth,
  }) => HttpAuthRepository(
    service: AuthApiService(
      apiClient: ApiClient(
        baseUrl: 'https://api.test',
        tokenProvider: () => store.currentToken,
        httpClient: client,
      ),
    ),
    sessionStore: store,
    oauthAuthenticator: oauth,
  );

  http.Response sessionFor(String id, {bool anonymous = false}) =>
      http.Response(
        jsonEncode({
          'user': {
            'id': id,
            'email': 'temp-$id@guest.invalid',
            'name': 'Anonymous',
            'isAnonymous': anonymous,
          },
        }),
        200,
      );

  group('guestSessionAvailable', () {
    test('reports the server flag', () async {
      for (final enabled in [true, false]) {
        final repo = build(
          MockClient(
            (request) async =>
                http.Response(jsonEncode({'enabled': enabled}), 200),
          ),
          InMemorySessionStore(),
        );
        expect(await repo.guestSessionAvailable(), enabled);
      }
    });

    test(
      'is false when the server has no route or cannot be reached',
      () async {
        final missing = build(
          MockClient((request) async => http.Response('{"error":"x"}', 404)),
          InMemorySessionStore(),
        );
        final offline = build(
          MockClient((request) async => throw http.ClientException('offline')),
          InMemorySessionStore(),
        );

        expect(await missing.guestSessionAvailable(), isFalse);
        expect(await offline.guestSessionAvailable(), isFalse);
      },
    );
  });

  group('continueAsGuest', () {
    test('mints, persists and validates a guest session', () async {
      final store = InMemorySessionStore();
      final requests = <http.Request>[];
      final repo = build(
        MockClient((request) async {
          requests.add(request);
          if (request.url.path == '/api/mobile/guest-session') {
            return http.Response(jsonEncode({'token': 'guest-tok'}), 200);
          }
          return sessionFor('9', anonymous: true);
        }),
        store,
      );

      final session = await repo.continueAsGuest();

      expect(session.token, 'guest-tok');
      expect(session.user.isAnonymous, isTrue);
      expect(store.currentToken, 'guest-tok');
      final mint = requests.first;
      expect(mint.method, 'POST');
      expect(mint.headers['Authorization'], isNull);
      final body = jsonDecode(mint.body) as Map<String, dynamic>;
      expect(body['clientDeviceId'], isA<String>());
      expect((body['clientDeviceId'] as String).length, greaterThan(20));
      expect(requests.last.headers['Authorization'], 'Bearer guest-tok');
    });

    test('uses a fresh device id for every mint', () async {
      final ids = <Object?>[];
      final repo = build(
        MockClient((request) async {
          if (request.url.path == '/api/mobile/guest-session') {
            ids.add((jsonDecode(request.body) as Map)['clientDeviceId']);
            return http.Response(jsonEncode({'token': 'guest-tok'}), 200);
          }
          return sessionFor('9', anonymous: true);
        }),
        InMemorySessionStore(),
      );

      await repo.continueAsGuest();
      await repo.continueAsGuest();

      expect(ids.toSet(), hasLength(2));
    });

    for (final (status, message) in [
      (429, 'Too many attempts. Please wait a moment and try again.'),
      (
        404,
        'Could not start a guest session. Try again in a moment, or sign in.',
      ),
      (
        500,
        'Could not start a guest session. Try again in a moment, or sign in.',
      ),
    ]) {
      test('maps a $status mint to an AuthException', () async {
        final store = InMemorySessionStore();
        final repo = build(
          MockClient((request) async => http.Response('{"error":"x"}', status)),
          store,
        );

        await expectLater(
          repo.continueAsGuest(),
          throwsA(
            isA<AuthException>().having((e) => e.message, 'message', message),
          ),
        );
        expect(store.currentToken, isNull);
      });
    }
  });

  test('signing in from a guest session presents the guest bearer to the '
      'code exchange, then replaces it with the account token', () async {
    final store = InMemorySessionStore(initialToken: 'guest-tok');
    final requests = <http.Request>[];
    final repo = build(
      MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/mobile/oauth-token') {
          return http.Response(jsonEncode({'token': 'real-tok'}), 200);
        }
        return sessionFor('42');
      }),
      store,
      oauth: _StubOAuth('canopy://auth?code=code-abc'),
    );

    final result = await repo.signInWithSocial(SocialProvider.google);

    expect(result, isA<SocialSignInSuccess>());
    final exchange = requests.singleWhere(
      (r) => r.url.path == '/api/mobile/oauth-token',
    );
    expect(exchange.headers['Authorization'], 'Bearer guest-tok');
    expect(store.currentToken, 'real-tok');
  });

  // The other two ways a guest signs in end in the same exchange; nothing on
  // the way may drop the guest bearer before it.
  for (final path in ['apple', 'two-factor']) {
    test(
      'the $path sign-in also presents the guest bearer to the exchange',
      () async {
        final store = InMemorySessionStore(initialToken: 'guest-tok');
        final requests = <http.Request>[];
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              tokenProvider: () => store.currentToken,
              httpClient: MockClient((request) async {
                requests.add(request);
                return switch (request.url.path) {
                  '/api/mobile/oauth-apple-native' => http.Response(
                    jsonEncode({'code': 'apple-code'}),
                    200,
                  ),
                  '/api/mobile/two-factor/verify' => http.Response(
                    jsonEncode({'code': 'verified-code'}),
                    200,
                  ),
                  '/api/mobile/oauth-token' => http.Response(
                    jsonEncode({'token': 'real-tok'}),
                    200,
                  ),
                  _ => sessionFor('42'),
                };
              }),
            ),
          ),
          sessionStore: store,
          appleCredentialProvider: const _StubApple(),
        );

        if (path == 'apple') {
          expect(await repo.signInWithApple(), isA<SocialSignInSuccess>());
        } else {
          await repo.completeTwoFactor(
            challenge: 'challenge',
            verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
            code: '123456',
          );
        }

        final exchange = requests.singleWhere(
          (r) => r.url.path == '/api/mobile/oauth-token',
        );
        expect(exchange.headers['Authorization'], 'Bearer guest-tok');
        expect(store.currentToken, 'real-tok');
      },
    );
  }
}

class _StubApple implements AppleCredentialProvider {
  const _StubApple();

  @override
  Future<AppleCredential?> getCredential({required String nonce}) async =>
      const AppleCredential(identityToken: 'apple-id-token');
}

class _StubOAuth implements OAuthAuthenticator {
  _StubOAuth(this.resultUrl);

  final String resultUrl;

  @override
  Future<String?> authenticate({
    required String authorizeUrl,
    required String callbackUrl,
  }) async => resultUrl;
}
