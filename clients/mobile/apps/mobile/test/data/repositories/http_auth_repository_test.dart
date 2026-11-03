import 'dart:convert';
import 'dart:async';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
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

void main() {
  group('HttpAuthRepository', () {
    HttpAuthRepository build(MockClient client, SessionStore store) {
      return HttpAuthRepository(
        service: AuthApiService(
          apiClient: ApiClient(
            baseUrl: 'https://api.test',
            tokenProvider: () => store.currentToken,
            httpClient: client,
          ),
        ),
        sessionStore: store,
      );
    }

    test('signIn persists the token and returns the session', () async {
      final store = InMemorySessionStore();
      final client = MockClient(
        (request) async => http.Response(
          jsonEncode({
            'token': 'tok-1',
            'user': {'id': '1', 'email': 'a@b.com', 'name': 'A'},
          }),
          200,
        ),
      );

      final session = await build(
        client,
        store,
      ).signIn(email: 'a@b.com', password: 'pw');

      expect(session.token, 'tok-1');
      expect(store.currentToken, 'tok-1');
    });

    test('signIn maps a 401 to an AuthException', () async {
      final store = InMemorySessionStore();
      final client = MockClient(
        (request) async => http.Response('{"message":"bad"}', 401),
      );

      await expectLater(
        build(client, store).signIn(email: 'a@b.com', password: 'wrong'),
        throwsA(isA<AuthException>()),
      );
    });

    test('restoreSession returns null when there is no stored token', () async {
      final store = InMemorySessionStore();
      final client = MockClient((request) async => http.Response('null', 200));

      expect(await build(client, store).restoreSession(), isNull);
    });

    test('restoreSession returns a session for a valid token', () async {
      final store = InMemorySessionStore(initialToken: 'tok-1');
      final client = MockClient(
        (request) async => http.Response(
          jsonEncode({
            'user': {'id': '1', 'email': 'a@b.com', 'name': 'A'},
          }),
          200,
        ),
      );

      final session = await build(client, store).restoreSession();

      expect(session, isNotNull);
      expect(session?.token, 'tok-1');
      expect(session?.user.email, 'a@b.com');
    });

    for (final response in [
      'offline',
      'server',
      '{}',
      '[]',
      '{"user":null}',
      '{"user":{}}',
    ]) {
      test(
        'restore preserves credentials after $response and recovers',
        () async {
          final store = InMemorySessionStore();
          await store.save('tok-1', twoFactorProof: 'proof');
          var recover = false;
          final repo = build(
            MockClient((request) async {
              if (recover) return http.Response('{"user":{"id":"1"}}', 200);
              if (response == 'offline') throw http.ClientException('offline');
              if (response == 'server') return http.Response('{}', 503);
              return http.Response(response, 200);
            }),
            store,
          );
          await expectLater(repo.restoreSession(), throwsA(isA<Exception>()));
          expect(store.currentToken, 'tok-1');
          expect(store.currentTwoFactorProof, 'proof');
          recover = true;
          expect((await repo.restoreSession())?.user.id, '1');
        },
      );
    }

    for (final status in [200, 401]) {
      test('authoritative invalidation ($status) clears credentials', () async {
        final store = InMemorySessionStore();
        await store.save('tok-1', twoFactorProof: 'proof');
        var calls = 0;
        final repo = build(
          MockClient((_) async {
            calls += 1;
            return http.Response('null', status);
          }),
          store,
        );
        expect(await repo.restoreSession(), isNull);
        expect(calls, 2);
        expect(store.currentToken, isNull);
        expect(store.currentTwoFactorProof, isNull);
      });
    }

    for (final firstStatus in [200, 401]) {
      test(
        'one anomalous invalid response ($firstStatus) cannot erase a valid session',
        () async {
          final store = InMemorySessionStore();
          await store.save('tok-1', twoFactorProof: 'proof');
          var calls = 0;
          final repo = build(
            MockClient((_) async {
              calls += 1;
              if (calls == 1) return http.Response('null', firstStatus);
              return http.Response('{"user":{"id":"1"}}', 200);
            }),
            store,
          );

          final session = await repo.restoreSession();

          expect(session?.user.id, '1');
          expect(calls, 2);
          expect(store.currentToken, 'tok-1');
          expect(store.currentTwoFactorProof, 'proof');
        },
      );
    }

    test(
      'inconclusive invalidation confirmation preserves credentials',
      () async {
        final store = InMemorySessionStore();
        await store.save('tok-1', twoFactorProof: 'proof');
        var calls = 0;
        final repo = build(
          MockClient((_) async {
            calls += 1;
            if (calls == 1) return http.Response('null', 401);
            return http.Response('{}', 503);
          }),
          store,
        );

        await expectLater(
          repo.restoreSession(),
          throwsA(isA<SessionValidationException>()),
        );

        expect(calls, 2);
        expect(store.currentToken, 'tok-1');
        expect(store.currentTwoFactorProof, 'proof');
      },
    );

    test('stale invalidation cannot clear a newer validation', () async {
      final pending = Completer<http.Response>();
      var calls = 0;
      final store = InMemorySessionStore(initialToken: 'tok-1');
      final repo = build(
        MockClient((_) async {
          if (calls++ == 0) return pending.future;
          return http.Response('{"user":{"id":"1"}}', 200);
        }),
        store,
      );
      final first = repo.restoreSession();
      final oldResult = expectLater(
        first,
        throwsA(isA<SessionValidationException>()),
      );
      await Future<void>.delayed(Duration.zero);
      expect(await repo.restoreSession(), isNotNull);
      pending.complete(http.Response('null', 200));
      await oldResult;
      expect(store.currentToken, 'tok-1');
    });

    for (final proof in [null, 'verified-proof']) {
      test('2FA session requires persisted proof ($proof)', () async {
        final store = InMemorySessionStore();
        await store.save('tok-1', twoFactorProof: proof);
        final repo = build(
          MockClient(
            (_) async => http.Response(
              '{"user":{"id":"1","twoFactorEnabled":true}}',
              200,
            ),
          ),
          store,
        );
        final session = await repo.restoreSession();
        expect(session, proof == null ? isNull : isNotNull);
        expect(store.currentToken, proof == null ? isNull : 'tok-1');
      });
    }

    test(
      'validation timeout preserves credentials despite a late null response',
      () async {
        final pending = Completer<http.Response>();
        final store = InMemorySessionStore(initialToken: 'tok-1');
        final repo = HttpAuthRepository(
          sessionStore: store,
          validationTimeout: const Duration(milliseconds: 5),
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: MockClient((_) => pending.future),
            ),
          ),
        );
        await expectLater(
          repo.restoreSession(),
          throwsA(isA<SessionValidationException>()),
        );
        pending.complete(http.Response('null', 200));
        await Future<void>.delayed(Duration.zero);
        expect(store.currentToken, 'tok-1');
      },
    );

    test('signOut clears the stored token', () async {
      final store = InMemorySessionStore(initialToken: 'tok-1');
      final client = MockClient((request) async => http.Response('{}', 200));

      await build(client, store).signOut();

      expect(store.currentToken, isNull);
    });

    test(
      'signInWithSocial exchanges the PKCE code for a session token',
      () async {
        final store = InMemorySessionStore();
        String? authorizeUrl;
        final requests = <http.Request>[];
        final client = MockClient((request) async {
          requests.add(request);
          if (request.url.path == '/api/mobile/oauth-token') {
            return http.Response(
              jsonEncode({'token': 'sess-tok', 'twoFactorProof': 'proof-1'}),
              200,
            );
          }
          // get-session
          return http.Response(
            jsonEncode({
              'user': {'id': '1', 'email': 'a@b.com', 'name': 'A'},
            }),
            200,
          );
        });
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              tokenProvider: () => store.currentToken,
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            'unstoppable-code://auth?code=code-abc',
            onAuthorize: (url) => authorizeUrl = url,
          ),
        );

        final result = await repo.signInWithSocial(SocialProvider.google);

        expect(result, isA<SocialSignInSuccess>());
        final session = result is SocialSignInSuccess ? result.session : null;
        expect(session?.token, 'sess-tok');
        expect(session?.user.email, 'a@b.com');
        expect(store.currentToken, 'sess-tok');
        expect(store.currentTwoFactorProof, 'proof-1');

        // The start URL must carry an S256 challenge for the verifier that is
        // then sent to the token exchange.
        expect(authorizeUrl, contains('/api/mobile/oauth-start'));
        final challenge = Uri.parse(
          authorizeUrl!,
        ).queryParameters['code_challenge'];
        final tokenReq = requests.firstWhere(
          (r) => r.url.path == '/api/mobile/oauth-token',
        );
        final body = jsonDecode(tokenReq.body) as Map<String, dynamic>;
        expect(body['code'], 'code-abc');
        final verifier = body['code_verifier'] as String;
        final expectedChallenge = base64Url
            .encode(sha256.convert(utf8.encode(verifier)).bytes)
            .replaceAll('=', '');
        expect(challenge, expectedChallenge);
      },
    );

    test('signInWithSocial returns null when cancelled', () async {
      final store = InMemorySessionStore();
      final client = MockClient((request) async => http.Response('{}', 200));
      final repo = HttpAuthRepository(
        service: AuthApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        ),
        sessionStore: store,
        oauthAuthenticator: _StubOAuth(null),
      );

      expect(await repo.signInWithSocial(SocialProvider.google), isNull);
      expect(store.currentToken, isNull);
    });

    test(
      'signInWithSocial sends the browser the same callback it registered as '
      'the redirect',
      () async {
        final store = InMemorySessionStore();
        final client = MockClient((request) async => http.Response('{}', 200));
        String? authorizeUrl;
        final authenticator = _StubOAuth(
          null,
          onAuthorize: (url) => authorizeUrl = url,
        );
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: authenticator,
        );

        await repo.signInWithSocial(SocialProvider.google);

        // A divergence here silently breaks sign-in: the server would redirect
        // to a callback the browser session was never told to intercept.
        expect(
          Uri.parse(authorizeUrl!).queryParameters['redirect'],
          authenticator.lastCallbackUrl,
        );
      },
    );

    test(
      'signInWithSocial reports a missing browser instead of crashing',
      () async {
        final store = InMemorySessionStore();
        final client = MockClient((request) async => http.Response('{}', 200));
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            null,
            failure: PlatformException(
              code: 'NO_BROWSER',
              message: 'No valid browser available for authentication.',
            ),
          ),
        );

        await expectLater(
          repo.signInWithSocial(SocialProvider.google),
          throwsA(
            isA<AuthException>().having(
              (e) => e.message,
              'message',
              contains('browser'),
            ),
          ),
        );
      },
    );

    test(
      'signInWithSocial reports a browser that could not return the callback',
      () async {
        final store = InMemorySessionStore();
        final client = MockClient((request) async => http.Response('{}', 200));
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            null,
            failure: PlatformException(
              code: 'FAILED',
              message: 'Authentication failed with code: 2',
            ),
          ),
        );

        // Previously this escaped as a raw PlatformException, so the sign-in
        // screen showed nothing actionable.
        await expectLater(
          repo.signInWithSocial(SocialProvider.google),
          throwsA(
            isA<AuthException>().having(
              (e) => e.message,
              'message',
              contains('up to date'),
            ),
          ),
        );
      },
    );

    test(
      'signInWithSocial maps a genuine provider failure to an AuthException',
      () async {
        final store = InMemorySessionStore();
        final client = MockClient((request) async => http.Response('{}', 200));
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            // Not `access_denied` — that is a cancellation and returns null.
            'unstoppable-code://auth?error=server_error',
          ),
        );

        await expectLater(
          repo.signInWithSocial(SocialProvider.google),
          throwsA(isA<AuthException>()),
        );
        expect(store.currentToken, isNull);
      },
    );

    // Every one of these arrives as a bare `?error=<code>` on the callback deep
    // link, and every one used to render the same "Could not sign in" — which
    // told a user who had just been timed out nothing about retrying.
    for (final testCase in const <({String code, String expected})>[
      (
        code: 'invalid_flow',
        expected: 'Sign-in timed out or was interrupted. Please try again.',
      ),
      (
        code: 'no_session',
        expected: 'Sign-in did not complete. Please try again.',
      ),
      (
        code: 'provider_error',
        expected: 'Could not sign in. Please try again.',
      ),
    ]) {
      test(
        'signInWithSocial explains the ${testCase.code} deep-link error',
        () async {
          final store = InMemorySessionStore();
          final client = MockClient(
            (request) async => http.Response('{}', 200),
          );
          final repo = HttpAuthRepository(
            service: AuthApiService(
              apiClient: ApiClient(
                baseUrl: 'https://api.test',
                httpClient: client,
              ),
            ),
            sessionStore: store,
            oauthAuthenticator: _StubOAuth(
              'unstoppable-code://auth?error=${testCase.code}',
            ),
          );

          await expectLater(
            repo.signInWithSocial(SocialProvider.google),
            throwsA(
              isA<AuthException>().having(
                (e) => e.message,
                'message',
                testCase.expected,
              ),
            ),
          );
          expect(store.currentToken, isNull);
        },
      );
    }

    test(
      'signInWithSocial treats a provider-side denial as a cancellation',
      () async {
        // Backing out at the provider consent screen is the same user intent as
        // dismissing the browser tab, which already returns null. Surfacing one
        // as a red error and the other silently is the inconsistency here.
        final store = InMemorySessionStore();
        final client = MockClient((request) async => http.Response('{}', 200));
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            'unstoppable-code://auth?error=access_denied',
          ),
        );

        expect(await repo.signInWithSocial(SocialProvider.google), isNull);
        expect(store.currentToken, isNull);
      },
    );

    test(
      'signInWithSocial does not report persistence failures as browser errors',
      () async {
        final store = _FailingSessionStore();
        final client = MockClient((request) async {
          expect(request.url.path, '/api/mobile/oauth-token');
          return http.Response(jsonEncode({'token': 'sess-tok'}), 200);
        });
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            'unstoppable-code://auth?code=code-abc',
          ),
        );

        await expectLater(
          repo.signInWithSocial(SocialProvider.google),
          throwsA(
            isA<PlatformException>().having(
              (error) => error.code,
              'code',
              'STORAGE_FAILED',
            ),
          ),
        );
      },
    );

    test(
      'signInWithSocial returns a 2FA challenge when the account has 2FA',
      () async {
        final store = InMemorySessionStore();
        final client = MockClient((request) async => http.Response('{}', 200));
        String? authorizeUrl;
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            'unstoppable-code://auth?error=two_factor_required&challenge=chal-xyz',
            onAuthorize: (url) => authorizeUrl = url,
          ),
        );

        final result = await repo.signInWithSocial(SocialProvider.google);

        expect(result, isA<SocialSignInTwoFactorRequired>());
        final challenge = result is SocialSignInTwoFactorRequired
            ? result.challenge
            : null;
        expect(challenge, 'chal-xyz');
        final verifier = result is SocialSignInTwoFactorRequired
            ? result.verifier
            : null;
        expect(verifier, isNotNull);
        // The carried verifier matches the S256 challenge sent to oauth-start,
        // so verify + exchange stay PKCE-bound to this sign-in attempt.
        final sentChallenge = Uri.parse(
          authorizeUrl!,
        ).queryParameters['code_challenge'];
        final expectedChallenge = base64Url
            .encode(sha256.convert(utf8.encode(verifier!)).bytes)
            .replaceAll('=', '');
        expect(sentChallenge, expectedChallenge);
        // No session is minted until the second factor is verified.
        expect(store.currentToken, isNull);
      },
    );

    test(
      'completeTwoFactor verifies a code and persists the exchanged session',
      () async {
        final store = InMemorySessionStore();
        final requests = <http.Request>[];
        final client = MockClient((request) async {
          requests.add(request);
          if (request.url.path == '/api/mobile/two-factor/verify') {
            return http.Response(jsonEncode({'code': 'exch-1'}), 200);
          }
          if (request.url.path == '/api/mobile/oauth-token') {
            return http.Response(
              jsonEncode({'token': 'sess-tok', 'twoFactorProof': 'proof-1'}),
              200,
            );
          }
          // get-session
          return http.Response(
            jsonEncode({
              'user': {'id': '1', 'email': 'a@b.com', 'name': 'A'},
            }),
            200,
          );
        });
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              tokenProvider: () => store.currentToken,
              twoFactorProofProvider: () => store.currentTwoFactorProof,
              httpClient: client,
            ),
          ),
          sessionStore: store,
        );

        final session = await repo.completeTwoFactor(
          challenge: 'chal-xyz',
          verifier: 'verifier-1',
          code: '123456',
        );

        expect(session.token, 'sess-tok');
        expect(store.currentToken, 'sess-tok');
        expect(store.currentTwoFactorProof, 'proof-1');
        final verifyReq = requests.firstWhere(
          (r) => r.url.path == '/api/mobile/two-factor/verify',
        );
        final body = jsonDecode(verifyReq.body) as Map<String, dynamic>;
        expect(body['challenge'], 'chal-xyz');
        expect(body['code'], '123456');
        expect(body['code_verifier'], 'verifier-1');
      },
    );

    test(
      'completeTwoFactor maps an invalid code to an AuthException',
      () async {
        final store = InMemorySessionStore();
        final client = MockClient((request) async {
          if (request.url.path == '/api/mobile/two-factor/verify') {
            return http.Response('{"error":"Invalid verification code"}', 400);
          }
          return http.Response('{}', 200);
        });
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          sessionStore: store,
        );

        await expectLater(
          repo.completeTwoFactor(
            challenge: 'chal-xyz',
            verifier: 'verifier-1',
            code: 'wrong',
          ),
          throwsA(isA<AuthException>()),
        );
        expect(store.currentToken, isNull);
      },
    );

    test(
      'signInWithSocial preserves the persisted token when session validation '
      'fails after the code exchange',
      () async {
        final store = InMemorySessionStore();
        final client = MockClient((request) async {
          if (request.url.path == '/api/mobile/oauth-token') {
            return http.Response(
              jsonEncode({'token': 'sess-tok', 'twoFactorProof': 'proof-1'}),
              200,
            );
          }
          return http.Response('{"message":"boom"}', 500);
        });
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              tokenProvider: () => store.currentToken,
              twoFactorProofProvider: () => store.currentTwoFactorProof,
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            'unstoppable-code://auth?code=code-abc',
          ),
        );

        await expectLater(
          repo.signInWithSocial(SocialProvider.google),
          throwsA(isA<AuthException>()),
        );
        expect(store.currentToken, 'sess-tok');
        expect(store.currentTwoFactorProof, 'proof-1');
      },
    );

    test(
      'signInWithSocial preserves the persisted token when validation throws a '
      'transport error',
      () async {
        final store = InMemorySessionStore();
        final client = MockClient((request) async {
          if (request.url.path == '/api/mobile/oauth-token') {
            return http.Response(
              jsonEncode({'token': 'sess-tok', 'twoFactorProof': 'proof-1'}),
              200,
            );
          }
          throw http.ClientException('network down');
        });
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              tokenProvider: () => store.currentToken,
              twoFactorProofProvider: () => store.currentTwoFactorProof,
              httpClient: client,
            ),
          ),
          sessionStore: store,
          oauthAuthenticator: _StubOAuth(
            'unstoppable-code://auth?code=code-abc',
          ),
        );

        await expectLater(
          repo.signInWithSocial(SocialProvider.google),
          throwsA(isA<Exception>()),
        );
        expect(store.currentToken, 'sess-tok');
        expect(store.currentTwoFactorProof, 'proof-1');
      },
    );

    test(
      'signInWithApple exchanges the native credential for a session, '
      'sending Apple the hash of the raw nonce it forwards to the backend',
      () async {
        final store = InMemorySessionStore();
        final fakeApple = _StubAppleCredential(
          const AppleCredential(identityToken: 'id-tok'),
        );
        String? backendNonce;
        final requests = <http.Request>[];
        final client = MockClient((request) async {
          requests.add(request);
          if (request.url.path == '/api/mobile/oauth-apple-native') {
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            backendNonce = body['nonce'] as String?;
            return http.Response(jsonEncode({'code': 'ex-code'}), 200);
          }
          if (request.url.path == '/api/mobile/oauth-token') {
            return http.Response(jsonEncode({'token': 'bearer'}), 200);
          }
          // get-session
          return http.Response(
            jsonEncode({
              'user': {'id': '1', 'email': 'a@b.com', 'name': 'A'},
            }),
            200,
          );
        });
        final repo = HttpAuthRepository(
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              tokenProvider: () => store.currentToken,
              httpClient: client,
            ),
          ),
          sessionStore: store,
          appleCredentialProvider: fakeApple,
        );

        final result = await repo.signInWithApple();

        expect(result, isA<SocialSignInSuccess>());
        final session = result is SocialSignInSuccess ? result.session : null;
        expect(session?.token, 'bearer');
        expect(store.currentToken, 'bearer');
        // Replay defense: Apple receives the SHA-256 hash (which it echoes into
        // the token's readable `nonce` claim), while the backend receives the
        // RAW nonce and re-hashes it. So the value sent to Apple must equal the
        // hash of the value forwarded to the backend, and must NOT equal it —
        // the raw preimage never rides inside the identity token.
        expect(fakeApple.lastNonce, isNotNull);
        expect(backendNonce, isNotNull);
        expect(
          fakeApple.lastNonce,
          sha256.convert(utf8.encode(backendNonce!)).toString(),
        );
        expect(fakeApple.lastNonce, isNot(backendNonce));
      },
    );

    test('signInWithApple surfaces the 2FA challenge', () async {
      final store = InMemorySessionStore();
      final fakeApple = _StubAppleCredential(
        const AppleCredential(identityToken: 'id-tok'),
      );
      final client = MockClient(
        (request) async => http.Response(
          jsonEncode({'two_factor_required': true, 'challenge': 'ch'}),
          200,
        ),
      );
      final repo = HttpAuthRepository(
        service: AuthApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        ),
        sessionStore: store,
        appleCredentialProvider: fakeApple,
      );

      final result = await repo.signInWithApple();

      expect(result, isA<SocialSignInTwoFactorRequired>());
      final challenge = result is SocialSignInTwoFactorRequired
          ? result.challenge
          : null;
      expect(challenge, 'ch');
      expect(store.currentToken, isNull);
    });

    test('signInWithApple returns null when the user cancels the native '
        'authorization sheet', () async {
      final store = InMemorySessionStore();
      final fakeApple = _StubAppleCredential(null); // cancelled
      final client = MockClient((request) async => http.Response('{}', 200));
      final repo = HttpAuthRepository(
        service: AuthApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        ),
        sessionStore: store,
        appleCredentialProvider: fakeApple,
      );

      expect(await repo.signInWithApple(), isNull);
      expect(store.currentToken, isNull);
    });
  });
}

class _FailingSessionStore implements SessionStore {
  @override
  String? get currentToken => null;

  @override
  String? get currentTwoFactorProof => null;

  @override
  Future<String?> read() async => null;

  @override
  Future<void> save(String token, {String? twoFactorProof}) async {
    throw PlatformException(
      code: 'STORAGE_FAILED',
      message: 'Could not persist credentials.',
    );
  }

  @override
  Future<void> clear() async {}
}

/// Test [OAuthAuthenticator] that returns a fixed callback URL (or null to
/// simulate a cancelled flow) without opening a browser, and optionally
/// captures the authorize URL it was given.
///
/// Pass [failure] to simulate the plugin surfacing a browser-side
/// [PlatformException] instead of returning a callback.
class _StubOAuth implements OAuthAuthenticator {
  _StubOAuth(this.resultUrl, {this.onAuthorize, this.failure});

  final String? resultUrl;
  final void Function(String authorizeUrl)? onAuthorize;
  final PlatformException? failure;
  String? lastCallbackUrl;

  @override
  Future<String?> authenticate({
    required String authorizeUrl,
    required String callbackUrl,
  }) async {
    onAuthorize?.call(authorizeUrl);
    lastCallbackUrl = callbackUrl;
    final error = failure;
    if (error != null) throw error;
    return resultUrl;
  }
}

/// Test [AppleCredentialProvider] that returns a fixed [credential] (or null
/// to simulate a cancelled native authorization sheet) without invoking the
/// real native channel, and captures the nonce it was given so tests can assert
/// it is the SHA-256 hash of the raw nonce forwarded to the backend.
class _StubAppleCredential implements AppleCredentialProvider {
  _StubAppleCredential(this.credential);

  final AppleCredential? credential;
  String? lastNonce;

  @override
  Future<AppleCredential?> getCredential({required String nonce}) async {
    lastNonce = nonce;
    return credential;
  }
}
