import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/apple_native_result.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/auth_api_service.dart';

void main() {
  group('AuthApiService', () {
    test('signInWithEmail posts credentials and parses token + user', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'token': 'tok-abc',
            'user': {'id': '1', 'email': 'a@b.com', 'name': 'A'},
          }),
          200,
        );
      });
      final service = AuthApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      final session = await service.signInWithEmail(
        email: 'a@b.com',
        password: 'pw',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/auth/sign-in/email');
      expect(jsonDecode(captured.body)['email'], 'a@b.com');
      expect(session.token, 'tok-abc');
      expect(session.user.email, 'a@b.com');
    });

    test('currentUser returns null when there is no session', () async {
      final client = MockClient((request) async => http.Response('null', 200));
      final service = AuthApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      expect(await service.currentUser(), isNull);
    });

    test('attaches the bearer token from the provider', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'user': {'id': '1', 'email': 'a@b.com', 'name': 'A'},
          }),
          200,
        );
      });
      final service = AuthApiService(
        apiClient: ApiClient(
          baseUrl: 'https://api.test',
          tokenProvider: () => 'tok-xyz',
          httpClient: client,
        ),
      );

      await service.currentUser();

      expect(captured.headers['Authorization'], 'Bearer tok-xyz');
    });

    test(
      'exchangeOAuthCode posts code + verifier and parses the token',
      () async {
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({'token': 'sess-tok', 'twoFactorProof': 'proof-1'}),
            200,
          );
        });
        final service = AuthApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        );

        final result = await service.exchangeOAuthCode(
          code: 'code-abc',
          codeVerifier: 'verifier-xyz',
        );

        expect(captured.method, 'POST');
        expect(captured.url.path, '/api/mobile/oauth-token');
        final body = jsonDecode(captured.body) as Map<String, dynamic>;
        expect(body['code'], 'code-abc');
        expect(body['code_verifier'], 'verifier-xyz');
        expect(result.token, 'sess-tok');
        expect(result.twoFactorProof, 'proof-1');
      },
    );

    test('exchangeOAuthCode tolerates a missing twoFactorProof', () async {
      final client = MockClient(
        (request) async => http.Response(jsonEncode({'token': 't'}), 200),
      );
      final service = AuthApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      final result = await service.exchangeOAuthCode(
        code: 'c',
        codeVerifier: 'v',
      );

      expect(result.token, 't');
      expect(result.twoFactorProof, isNull);
    });

    test('appleNativeSignIn posts the identity token, nonce, and challenge, '
        'parsing an exchange code', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode({'code': 'ex-code'}), 200);
      });
      final service = AuthApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      final result = await service.appleNativeSignIn(
        identityToken: 'id-tok',
        nonce: 'n',
        codeChallenge: 'a' * 43,
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/mobile/oauth-apple-native');
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['identity_token'], 'id-tok');
      expect(body['nonce'], 'n');
      expect(body['code_challenge'], 'a' * 43);
      expect(body.containsKey('name'), isFalse);
      expect(result, isA<AppleNativeCode>());
      expect((result as AppleNativeCode).code, 'ex-code');
    });

    test('appleNativeSignIn includes name in the body when provided', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode({'code': 'ex-code'}), 200);
      });
      final service = AuthApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );

      await service.appleNativeSignIn(
        identityToken: 'id-tok',
        nonce: 'n',
        codeChallenge: 'a' * 43,
        name: 'A Name',
      );

      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['name'], 'A Name');
    });

    test(
      'appleNativeSignIn returns AppleNativeTwoFactor on two_factor_required',
      () async {
        final client = MockClient(
          (request) async => http.Response(
            jsonEncode({'two_factor_required': true, 'challenge': 'ch'}),
            200,
          ),
        );
        final service = AuthApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        );

        final result = await service.appleNativeSignIn(
          identityToken: 'tok',
          nonce: 'n',
          codeChallenge: 'a' * 43,
        );

        expect(result, isA<AppleNativeTwoFactor>());
        expect((result as AppleNativeTwoFactor).challenge, 'ch');
      },
    );

    test(
      'appleNativeSignIn throws ApiException on a malformed response',
      () async {
        final client = MockClient(
          (request) async => http.Response(jsonEncode({}), 200),
        );
        final service = AuthApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        );

        expect(
          () => service.appleNativeSignIn(
            identityToken: 'tok',
            nonce: 'n',
            codeChallenge: 'a' * 43,
          ),
          throwsA(isA<ApiException>()),
        );
      },
    );
  });
}
