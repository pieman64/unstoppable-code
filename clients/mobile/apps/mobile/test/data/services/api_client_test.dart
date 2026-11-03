import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';

void main() {
  group('ApiClient transient retries', () {
    test(
      'retries a GET twice before returning a successful response',
      () async {
        var attempts = 0;
        final client = MockClient((request) async {
          attempts++;
          if (attempts == 1) return http.Response('unavailable', 503);
          if (attempts == 2) return http.Response('bad gateway', 502);
          return http.Response('{"ready":true}', 200);
        });
        final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

        final result = await api.getJson('/api/account');

        expect(result, {'ready': true});
        expect(attempts, 3);
      },
    );

    test(
      'stops after two GET retries and surfaces the last response',
      () async {
        var attempts = 0;
        final client = MockClient((request) async {
          attempts++;
          return http.Response('still unavailable', 503);
        });
        final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

        await expectLater(
          api.getJson('/api/account'),
          throwsA(
            isA<ApiException>()
                .having((error) => error.statusCode, 'statusCode', 503)
                .having((error) => error.body, 'body', 'still unavailable'),
          ),
        );
        expect(attempts, 3);
      },
    );

    test('retries a GET after a transient transport failure', () async {
      var attempts = 0;
      final client = MockClient((request) async {
        attempts++;
        if (attempts == 1) throw http.ClientException('socket closed');
        return http.Response('{"ready":true}', 200);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      final result = await api.getJson('/api/account');

      expect(result, {'ready': true});
      expect(attempts, 2);
    });

    test('applies the retry policy to nullable and list reads too', () async {
      final attemptsByPath = <String, int>{};
      final client = MockClient((request) async {
        final path = request.url.path;
        final attempts = (attemptsByPath[path] ?? 0) + 1;
        attemptsByPath[path] = attempts;
        if (attempts == 1) return http.Response('unavailable', 503);
        return http.Response(path == '/nullable' ? 'null' : '[]', 200);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      expect(await api.getNullableJson('/nullable'), isNull);
      expect(await api.getJsonList('/list'), isEmpty);
      expect(attemptsByPath, {'/nullable': 2, '/list': 2});
    });

    test('does not retry a non-transient response', () async {
      var attempts = 0;
      final client = MockClient((request) async {
        attempts++;
        return http.Response('unauthorized', 401);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      await expectLater(
        api.getJson('/api/account'),
        throwsA(isA<ApiException>()),
      );
      expect(attempts, 1);
    });

    test('lets a specialized read opt out of transport retries', () async {
      var attempts = 0;
      final client = MockClient((request) async {
        attempts++;
        return http.Response('unavailable', 503);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      await expectLater(
        api.getJson('/api/probe', retryTransient: false),
        throwsA(isA<ApiException>()),
      );
      expect(attempts, 1);
    });

    test('does not automatically replay a mutating request', () async {
      var attempts = 0;
      final client = MockClient((request) async {
        attempts++;
        return http.Response('unavailable', 503);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      await expectLater(
        api.postJson('/api/action'),
        throwsA(isA<ApiException>()),
      );
      expect(attempts, 1);
    });
  });

  group('ApiClient dynamic base URL', () {
    test('resolves the origin immediately before each request', () async {
      var baseUrl = 'https://production.test';
      final captured = <Uri>[];
      final client = MockClient((request) async {
        captured.add(request.url);
        return http.Response('{}', 200);
      });
      final api = ApiClient.withBaseUrlProvider(
        baseUrlProvider: () => baseUrl,
        httpClient: client,
      );

      await api.getJson('/api/account');
      baseUrl = 'https://staging.test';
      await api.getJson('/api/account');

      expect(captured, [
        Uri.parse('https://production.test/api/account'),
        Uri.parse('https://staging.test/api/account'),
      ]);
    });
  });

  group('ApiClient two-factor proof header', () {
    test(
      'attaches x-two-factor-verified when the provider returns a value',
      () async {
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response('{}', 200);
        });
        final api = ApiClient(
          baseUrl: 'https://api.test',
          twoFactorProofProvider: () => 'proof-1',
          httpClient: client,
        );

        await api.getJson('/api/account/organizations');

        expect(captured.headers['x-two-factor-verified'], 'proof-1');
      },
    );

    test('omits the header when the provider returns null', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('{}', 200);
      });
      final api = ApiClient(
        baseUrl: 'https://api.test',
        twoFactorProofProvider: () => null,
        httpClient: client,
      );

      await api.getJson('/x');

      expect(captured.headers.containsKey('x-two-factor-verified'), isFalse);
    });
  });

  // Literals are pinned as strings, not through the Dart constants: they
  // mirror packages/protocol/src/client-surface/index.ts and must not drift.
  group('ApiClient client surface headers', () {
    Future<http.Request> capture(
      Future<void> Function(ApiClient api) send, {
      String? Function()? clientVersionProvider,
    }) async {
      late http.Request captured;
      final api = ApiClient(
        baseUrl: 'https://api.test',
        clientVersionProvider: clientVersionProvider,
        httpClient: MockClient((request) async {
          captured = request;
          return http.Response('{}', 200);
        }),
      );
      await send(api);
      return captured;
    }

    test('declares the mobile surface on reads and writes', () async {
      final read = await capture((api) => api.getJson('/api/cloud/workspaces'));
      final write = await capture(
        (api) => api.postJson('/api/cloud/chats/chat-1/messages', body: {}),
      );

      expect(read.headers['x-canopy-client'], 'mobile');
      expect(write.headers['x-canopy-client'], 'mobile');
      expect(write.headers['Content-Type'], contains('application/json'));
    });

    test('declares the surface on hand-rolled request headers', () {
      final api = ApiClient(baseUrl: 'https://api.test');

      expect(api.buildHeaders()['x-canopy-client'], 'mobile');
    });

    test('attaches the client version once the provider has one', () async {
      final request = await capture(
        (api) => api.postJson('/x', body: {}),
        clientVersionProvider: () => '1.4.2+57',
      );

      expect(request.headers['x-canopy-client-version'], '1.4.2+57');
    });

    test('omits the version until it is known', () async {
      final request = await capture(
        (api) => api.postJson('/x', body: {}),
        clientVersionProvider: () => null,
      );

      expect(request.headers['x-canopy-client'], 'mobile');
      expect(request.headers.containsKey('x-canopy-client-version'), isFalse);
    });

    test('omits a version the server contract would reject', () async {
      for (final version in ['', '1.4.2 beta', 'v' * 33, '1.0,2.0']) {
        final request = await capture(
          (api) => api.postJson('/x', body: {}),
          clientVersionProvider: () => version,
        );

        expect(
          request.headers.containsKey('x-canopy-client-version'),
          isFalse,
          reason: 'version "$version"',
        );
      }
    });

    test('keeps the version provider on a copied transport', () async {
      late http.Request captured;
      final original = ApiClient(
        baseUrl: 'https://api.test',
        clientVersionProvider: () => '2.0.0+9',
      );
      final copy = original.withHttpClient(
        MockClient((request) async {
          captured = request;
          return http.Response('{}', 200);
        }),
      );

      await copy.getJson('/x');

      expect(captured.headers['x-canopy-client'], 'mobile');
      expect(captured.headers['x-canopy-client-version'], '2.0.0+9');
    });
  });

  group('ApiClient.patchJson', () {
    test('PATCHes JSON and decodes the response body', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('{"id":"org-1"}', 200);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      final result = await api.patchJson('/x', body: {'role': 'ADMIN'});

      expect(captured.method, 'PATCH');
      expect(captured.url.path, '/x');
      expect(captured.headers['Content-Type'], contains('application/json'));
      expect(captured.body, '{"role":"ADMIN"}');
      expect(result['id'], 'org-1');
    });

    test('tolerates an empty 204 body and returns an empty map', () async {
      final client = MockClient((request) async => http.Response('', 204));
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      final result = await api.patchJson('/x', body: {'action': 'accept'});

      expect(result, isEmpty);
    });

    test('throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('nope', 409));
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      expect(
        () => api.patchJson('/x', body: {'role': 'OWNER'}),
        throwsA(isA<ApiException>()),
      );
    });
  });

  group('ApiClient.putJson', () {
    test('PUTs JSON and decodes the response body', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('{"id":"org-1"}', 200);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      final result = await api.putJson(
        '/x',
        body: {
          'memberUserIds': ['u1'],
        },
      );

      expect(captured.method, 'PUT');
      expect(captured.url.path, '/x');
      expect(captured.headers['Content-Type'], contains('application/json'));
      expect(captured.body, '{"memberUserIds":["u1"]}');
      expect(result['id'], 'org-1');
    });

    test('tolerates an empty 204 body and returns an empty map', () async {
      final client = MockClient((request) async => http.Response('', 204));
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      final result = await api.putJson('/x', body: {'a': 'b'});

      expect(result, isEmpty);
    });

    test('throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('nope', 409));
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      expect(
        () => api.putJson('/x', body: {'a': 'b'}),
        throwsA(isA<ApiException>()),
      );
    });
  });

  group('ApiClient.delete', () {
    test('completes on a 204 response', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      await api.delete('/api/account/invites/inv-1');

      expect(captured.method, 'DELETE');
      expect(captured.url.path, '/api/account/invites/inv-1');
    });

    test('throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('boom', 403));
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      expect(() => api.delete('/x'), throwsA(isA<ApiException>()));
    });
  });

  group('ApiClient.deleteJson', () {
    test('DELETEs and decodes the response body', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('{"id":"org-1"}', 200);
      });
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      final result = await api.deleteJson(
        '/api/account/organizations/org-1/members/u1',
      );

      expect(captured.method, 'DELETE');
      expect(result['id'], 'org-1');
    });

    test('tolerates an empty body and returns an empty map', () async {
      final client = MockClient((request) async => http.Response('', 204));
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      final result = await api.deleteJson('/x');

      expect(result, isEmpty);
    });

    test('throws ApiException on a non-2xx status', () async {
      final client = MockClient((request) async => http.Response('boom', 409));
      final api = ApiClient(baseUrl: 'https://api.test', httpClient: client);

      expect(() => api.deleteJson('/x'), throwsA(isA<ApiException>()));
    });
  });

  group('orgTeamsLapse', () {
    ApiException exception(int status, String body) =>
        ApiException(statusCode: status, body: body);

    const lapseBody =
        '{"error":"Your organization\'s trial has ended. Subscribe to Team to '
        'restore team features.","code":"org_teams_lapsed","lapseReason":'
        '"trial_ended","requiredPlanName":"Team","trialEndedAt":'
        '"2026-08-01T00:00:00.000Z"}';

    test('parses the org-billing 403', () {
      final lapse = orgTeamsLapse(exception(403, lapseBody));
      expect(lapse, isNotNull);
      expect(lapse!.code, 'org_teams_lapsed');
      expect(lapse.lapseReason, 'trial_ended');
      expect(lapse.requiredPlanName, 'Team');
      expect(lapse.trialEndedAt, '2026-08-01T00:00:00.000Z');
      expect(lapse.error, contains('trial has ended'));
    });

    test('returns null for a permission 403 on the same endpoint', () {
      // GET /organizations/{orgId}/usage refuses a lapsed org AND a viewer
      // below usageStatsMinRole with a 403. Only the coded one is a lapse.
      expect(
        orgTeamsLapse(
          exception(
            403,
            '{"error":"You do not have permission to view usage statistics"}',
          ),
        ),
        isNull,
      );
    });

    test('returns null for a 403 carrying an unknown code', () {
      expect(
        orgTeamsLapse(
          exception(403, '{"error":"Nope","code":"something_else"}'),
        ),
        isNull,
      );
    });

    test('returns null for a non-JSON body', () {
      expect(orgTeamsLapse(exception(403, '<html>Forbidden</html>')), isNull);
      expect(orgTeamsLapse(exception(403, '')), isNull);
    });

    test('returns null for a JSON body that is not a map', () {
      expect(orgTeamsLapse(exception(403, '["org_teams_lapsed"]')), isNull);
    });

    test('returns null when the coded body is missing its error sentence', () {
      expect(
        orgTeamsLapse(exception(403, '{"code":"org_teams_lapsed"}')),
        isNull,
      );
    });

    test('returns null for a non-403 status even with the lapse code', () {
      expect(orgTeamsLapse(exception(500, lapseBody)), isNull);
      expect(orgTeamsLapse(exception(401, lapseBody)), isNull);
    });

    test('errorOrgTeamsLapse tolerates a non-ApiException error', () {
      expect(errorOrgTeamsLapse(Exception('socket closed')), isNull);
      expect(errorOrgTeamsLapse(null), isNull);
      expect(errorOrgTeamsLapse(exception(403, lapseBody)), isNotNull);
    });
  });

  group('presentableErrorMessage', () {
    test('surfaces deliberate 4xx server copy', () {
      expect(
        presentableErrorMessage(
          ApiException(
            statusCode: 403,
            body:
                '{"error":"You do not have permission to view usage '
                'statistics"}',
          ),
        ),
        'You do not have permission to view usage statistics',
      );
    });

    test('withholds 5xx copy, which describes an internal fault', () {
      expect(
        presentableErrorMessage(
          ApiException(
            statusCode: 500,
            body: '{"error":"Database unavailable"}',
          ),
        ),
        isNull,
      );
    });

    test('withholds transport failures entirely', () {
      expect(presentableErrorMessage(Exception('socket closed')), isNull);
      expect(presentableErrorMessage(null), isNull);
    });

    test('never leaks the raw exception dump', () {
      // ApiException.toString() embeds the whole response body; the regression
      // that started CAN-2638 was exactly that string reaching a Text widget.
      final message = presentableErrorMessage(
        ApiException(statusCode: 403, body: 'not json at all'),
      );
      expect(message, isNull);
    });
  });

  group('ApiClient.postBytes', () {
    test(
      'sends raw bytes with the content type, query, and auth headers',
      () async {
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response('{"attachmentId":"a"}', 201);
        });
        final api = ApiClient(
          baseUrl: 'https://example.test',
          tokenProvider: () => 'token-1',
          httpClient: client,
        );
        final json = await api.postBytes(
          '/upload',
          bytes: Uint8List.fromList([1, 2, 3]),
          contentType: 'image/png',
          query: {'filename': 'a b.png', 'mediaType': 'image/png'},
        );
        expect(captured.method, 'POST');
        expect(
          captured.url.toString(),
          'https://example.test/upload?filename=a+b.png&mediaType=image%2Fpng',
        );
        expect(captured.headers['Content-Type'], startsWith('image/png'));
        expect(captured.headers['Authorization'], 'Bearer token-1');
        expect(captured.bodyBytes, [1, 2, 3]);
        expect(json['attachmentId'], 'a');
      },
    );

    test('throws ApiException on non-2xx', () async {
      final api = ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient(
          (_) async => http.Response('{"error":"too large"}', 413),
        ),
      );
      await expectLater(
        api.postBytes('/upload', bytes: Uint8List(1), contentType: 'image/png'),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 413)),
      );
    });
  });
}
