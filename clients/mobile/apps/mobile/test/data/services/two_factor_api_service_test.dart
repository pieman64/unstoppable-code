import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/two_factor_api_service.dart';

const _baseUrl = 'https://canopy.example.com';

TwoFactorApiService _service(MockClient client) => TwoFactorApiService(
  apiClient: ApiClient(
    baseUrl: _baseUrl,
    defaultHeaders: const {},
    httpClient: client,
  ),
);

void main() {
  group('TwoFactorApiService', () {
    test('fetchStatus reads user.twoFactorEnabled from auth-sources', () async {
      Uri? uri;
      String? method;
      final client = MockClient((req) async {
        uri = req.url;
        method = req.method;
        return http.Response(
          jsonEncode({
            'user': {
              'name': 'Ada',
              'email': 'ada@example.com',
              'twoFactorEnabled': true,
            },
            'sources': [
              {
                'providerId': 'credential',
                'accountId': 'acct_1',
                'label': 'Email and password',
                'linkedAt': '2026-07-01T00:00:00.000Z',
                'canUnlink': true,
              },
            ],
          }),
          200,
        );
      });

      final status = await _service(client).fetchStatus();

      expect(method, 'GET');
      expect(uri?.path, '/api/account/auth-sources');
      expect(status.enabled, isTrue);
      expect(status.hasCredentialAuthSource, isTrue);
    });

    test('fetchStatus defaults to disabled when the flag is missing', () async {
      final client = MockClient(
        (req) async => http.Response(
          jsonEncode({
            'user': {'name': 'Ada', 'email': 'ada@example.com'},
            'sources': <dynamic>[],
          }),
          200,
        ),
      );

      final status = await _service(client).fetchStatus();

      expect(status.enabled, isFalse);
      expect(status.hasCredentialAuthSource, isFalse);
    });

    test('beginEnrollment posts the issuer and parses totpURI + codes', () async {
      Uri? uri;
      String? method;
      String? body;
      final client = MockClient((req) async {
        uri = req.url;
        method = req.method;
        body = req.body;
        return http.Response(
          jsonEncode({
            'totpURI':
                'otpauth://totp/Canopy:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Canopy',
            'backupCodes': ['aaaa1111', 'bbbb2222'],
          }),
          200,
        );
      });

      final enrollment = await _service(
        client,
      ).beginEnrollment(issuer: 'Canopy');

      expect(method, 'POST');
      expect(uri?.path, '/api/auth/two-factor/enable');
      expect(jsonDecode(body!), {'issuer': 'Canopy'});
      expect(enrollment.otpauthUri, contains('secret=JBSWY3DPEHPK3PXP'));
      expect(enrollment.secret, 'JBSWY3DPEHPK3PXP');
      expect(enrollment.backupCodes, ['aaaa1111', 'bbbb2222']);
    });

    test('beginEnrollment includes a password when provided', () async {
      String? body;
      final client = MockClient((req) async {
        body = req.body;
        return http.Response(
          jsonEncode({'totpURI': 'otpauth://totp/Canopy?secret=ABC'}),
          200,
        );
      });

      await _service(
        client,
      ).beginEnrollment(issuer: 'Canopy', password: 'correct horse');

      expect(jsonDecode(body!), {
        'issuer': 'Canopy',
        'password': 'correct horse',
      });
    });

    test('beginEnrollment tolerates a missing backupCodes array', () async {
      final client = MockClient(
        (req) async => http.Response(
          jsonEncode({'totpURI': 'otpauth://totp/Canopy?secret=ABC'}),
          200,
        ),
      );

      final enrollment = await _service(
        client,
      ).beginEnrollment(issuer: 'Canopy');

      expect(enrollment.backupCodes, isEmpty);
    });

    test('beginEnrollment maps 401 to a needsReauth failure', () async {
      final client = MockClient(
        (req) async => http.Response('Unauthorized', 401),
      );

      await expectLater(
        _service(client).beginEnrollment(issuer: 'Canopy'),
        throwsA(
          isA<TwoFactorException>().having(
            (e) => e.failure,
            'failure',
            TwoFactorFailure.needsReauth,
          ),
        ),
      );
    });

    test('verifyEnrollment posts the code to verify-totp', () async {
      Uri? uri;
      String? method;
      String? body;
      final client = MockClient((req) async {
        uri = req.url;
        method = req.method;
        body = req.body;
        return http.Response(jsonEncode({'ok': true}), 200);
      });

      await _service(client).verifyEnrollment(code: '123456');

      expect(method, 'POST');
      expect(uri?.path, '/api/auth/two-factor/verify-totp');
      expect(jsonDecode(body!), {'code': '123456', 'trustDevice': false});
    });

    test('verifyEnrollment maps 401 to an invalidCode failure', () async {
      final client = MockClient(
        (req) async => http.Response('Invalid code', 401),
      );

      await expectLater(
        _service(client).verifyEnrollment(code: '000000'),
        throwsA(
          isA<TwoFactorException>().having(
            (e) => e.failure,
            'failure',
            TwoFactorFailure.invalidCode,
          ),
        ),
      );
    });

    test('disable posts to the better-auth disable endpoint', () async {
      Uri? uri;
      String? method;
      String? body;
      final client = MockClient((req) async {
        uri = req.url;
        method = req.method;
        body = req.body;
        return http.Response('', 200);
      });

      await _service(client).disable();

      expect(method, 'POST');
      expect(uri?.path, '/api/auth/two-factor/disable');
      expect(jsonDecode(body!), <String, dynamic>{});
    });

    test('disable includes a password when provided', () async {
      String? body;
      final client = MockClient((req) async {
        body = req.body;
        return http.Response('', 200);
      });

      await _service(client).disable(password: 'correct horse');

      expect(jsonDecode(body!), {'password': 'correct horse'});
    });

    test('disable maps 403 to a needsReauth failure', () async {
      final client = MockClient(
        (req) async => http.Response('Two-factor verification required', 403),
      );

      await expectLater(
        _service(client).disable(),
        throwsA(
          isA<TwoFactorException>().having(
            (e) => e.failure,
            'failure',
            TwoFactorFailure.needsReauth,
          ),
        ),
      );
    });

    test('disable maps 401 to a needsReauth failure', () async {
      final client = MockClient(
        (req) async => http.Response('Unauthorized', 401),
      );

      await expectLater(
        _service(client).disable(),
        throwsA(
          isA<TwoFactorException>().having(
            (e) => e.failure,
            'failure',
            TwoFactorFailure.needsReauth,
          ),
        ),
      );
    });

    test('disable maps 429 to a rateLimited failure', () async {
      final client = MockClient(
        (req) async => http.Response('Too many requests', 429),
      );

      await expectLater(
        _service(client).disable(),
        throwsA(
          isA<TwoFactorException>().having(
            (e) => e.failure,
            'failure',
            TwoFactorFailure.rateLimited,
          ),
        ),
      );
    });
  });
}
