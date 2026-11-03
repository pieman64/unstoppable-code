import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/repositories/space_notifications_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/space_notifications_api_service.dart';

Map<String, Object?> _snapshot({
  String spaceId = 'space-1',
  int revision = 3,
  String? override,
  bool writesEnabled = true,
}) => {
  'spaceId': spaceId,
  'revision': revision,
  'override': override,
  'effectiveLevel': override ?? 'all',
  'writesEnabled': writesEnabled,
  'transitions': <Object?>[],
  'nextRevision': revision + 1,
};

Matcher _failure(
  SpaceNotificationsFailure failure, {
  Matcher policy = isNull,
}) => isA<SpaceNotificationsException>()
    .having((e) => e.failure, 'failure', failure)
    .having((e) => e.policy, 'policy', policy);

void main() {
  group('SpaceNotificationPolicy.tryParse', () {
    test('reads the fields a client relies on', () {
      final policy = SpaceNotificationPolicy.tryParse(
        _snapshot(override: 'attention'),
      );
      expect(policy?.spaceId, 'space-1');
      expect(policy?.revision, 3);
      expect(policy?.override, SpaceNotificationLevel.attention);
      expect(policy?.writesEnabled, isTrue);
    });

    test('a null or absent override is Use default', () {
      expect(SpaceNotificationPolicy.tryParse(_snapshot())?.override, isNull);
      expect(
        SpaceNotificationPolicy.tryParse({
          'spaceId': 'space-1',
          'revision': 0,
          'writesEnabled': true,
        })?.override,
        isNull,
      );
    });

    test('an absent or malformed writesEnabled fails closed', () {
      for (final value in <Object?>[null, 'true', 1]) {
        expect(
          SpaceNotificationPolicy.tryParse({
            'spaceId': 'space-1',
            'revision': 0,
            'writesEnabled': value,
          })?.writesEnabled,
          isFalse,
        );
      }
    });

    test('rejects snapshots it cannot trust', () {
      for (final json in <Object?>[
        null,
        'nope',
        <Object?>[],
        {'revision': 1, 'writesEnabled': true},
        {'spaceId': '', 'revision': 1},
        {'spaceId': 7, 'revision': 1},
        {'spaceId': 'space-1'},
        {'spaceId': 'space-1', 'revision': -1},
        {'spaceId': 'space-1', 'revision': 1.5},
        {'spaceId': 'space-1', 'revision': '1'},
        {'spaceId': 'space-1', 'revision': 1, 'override': 'loud'},
        {'spaceId': 'space-1', 'revision': 1, 'override': 3},
      ]) {
        expect(SpaceNotificationPolicy.tryParse(json), isNull, reason: '$json');
      }
    });
  });

  group('HttpSpaceNotificationsRepository', () {
    HttpSpaceNotificationsRepository build(
      MockClient client, {
      Duration timeout = const Duration(seconds: 20),
    }) => HttpSpaceNotificationsRepository(
      service: SpaceNotificationsApiService(
        apiClient: ApiClient(
          baseUrl: 'https://api.test',
          tokenProvider: () => 'token-1',
          httpClient: client,
        ),
      ),
      timeout: timeout,
    );

    test('load GETs the encoded space route with the bearer token', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode(_snapshot(spaceId: 'a/b', override: 'mute')),
          200,
        );
      });

      final policy = await build(client).load('a/b');

      expect(captured.method, 'GET');
      expect(
        captured.url.toString(),
        'https://api.test/api/v1/notification-spaces/a%2Fb',
      );
      expect(captured.headers['Authorization'], 'Bearer token-1');
      expect(policy.override, SpaceNotificationLevel.mute);
    });

    test('save PATCHes the expected revision and override', () async {
      final bodies = <Object?>[];
      final client = MockClient((request) async {
        expect(request.method, 'PATCH');
        expect(request.url.path, '/api/v1/notification-spaces/space-1');
        bodies.add(jsonDecode(request.body));
        return http.Response(jsonEncode(_snapshot(revision: 4)), 200);
      });
      final repository = build(client);

      await repository.save(
        'space-1',
        expectedRevision: 3,
        override: SpaceNotificationLevel.attention,
      );
      await repository.save('space-1', expectedRevision: 3, override: null);

      expect(bodies, [
        {'expectedRevision': 3, 'override': 'attention'},
        {'expectedRevision': 3, 'override': null},
      ]);
    });

    test('maps refusals and carries the authoritative policy', () async {
      final policyBody = jsonEncode({
        'error': 'refused',
        'policy': _snapshot(revision: 9, override: 'mute'),
      });
      final hasPolicy = isA<SpaceNotificationPolicy>()
          .having((p) => p.revision, 'revision', 9)
          .having((p) => p.override, 'override', SpaceNotificationLevel.mute);
      for (final (status, body, matcher) in <(int, String, Matcher)>[
        (
          404,
          '{"error":"not found"}',
          _failure(SpaceNotificationsFailure.notFound),
        ),
        (
          409,
          policyBody,
          _failure(SpaceNotificationsFailure.staleRevision, policy: hasPolicy),
        ),
        (
          423,
          policyBody,
          _failure(
            SpaceNotificationsFailure.deliveryInProgress,
            policy: hasPolicy,
          ),
        ),
        (
          503,
          policyBody,
          _failure(SpaceNotificationsFailure.writesDisabled, policy: hasPolicy),
        ),
        (409, 'not json', _failure(SpaceNotificationsFailure.staleRevision)),
        (400, '{"error":"bad"}', _failure(SpaceNotificationsFailure.rejected)),
        (500, 'boom', _failure(SpaceNotificationsFailure.ambiguous)),
        (
          502,
          policyBody,
          _failure(SpaceNotificationsFailure.ambiguous, policy: hasPolicy),
        ),
      ]) {
        final client = MockClient((_) async => http.Response(body, status));
        await expectLater(
          build(client).save(
            'space-1',
            expectedRevision: 3,
            override: SpaceNotificationLevel.mute,
          ),
          throwsA(matcher),
          reason: 'HTTP $status',
        );
      }
    });

    test('an unreadable success or a transport failure is ambiguous', () async {
      for (final handler in <MockClientHandler>[
        (_) async => http.Response('{"spaceId":"space-1"}', 200),
        (_) async => http.Response('<html>', 200),
        (_) async => throw http.ClientException('offline'),
      ]) {
        await expectLater(
          build(
            MockClient(handler),
          ).save('space-1', expectedRevision: 3, override: null),
          throwsA(_failure(SpaceNotificationsFailure.ambiguous)),
        );
      }
    });

    test('a request that never answers times out as ambiguous', () {
      fakeAsync((async) {
        final never = Completer<http.Response>();
        Object? error;
        build(
          MockClient((_) => never.future),
          timeout: const Duration(seconds: 5),
        ).load('space-1').catchError((Object e) {
          error = e;
          return SpaceNotificationPolicy.tryParse(_snapshot())!;
        });
        async.elapse(const Duration(seconds: 6));
        expect(error, _failure(SpaceNotificationsFailure.ambiguous));
      });
    });
  });

  group('MockSpaceNotificationsRepository', () {
    test('starts on Use default and enforces revisions', () async {
      final repository = MockSpaceNotificationsRepository(
        latency: Duration.zero,
      );

      final initial = await repository.load('space-1');
      expect(initial.revision, 0);
      expect(initial.override, isNull);
      expect(initial.writesEnabled, isTrue);

      final saved = await repository.save(
        'space-1',
        expectedRevision: 0,
        override: SpaceNotificationLevel.mute,
      );
      expect(saved.revision, 1);
      expect(saved.override, SpaceNotificationLevel.mute);
      expect((await repository.load('space-1')).override, saved.override);

      await expectLater(
        repository.save('space-1', expectedRevision: 0, override: null),
        throwsA(
          _failure(
            SpaceNotificationsFailure.staleRevision,
            policy: isA<SpaceNotificationPolicy>().having(
              (p) => p.revision,
              'revision',
              1,
            ),
          ),
        ),
      );
      expect(repository.loadCount, 2);
      expect(repository.saveCount, 2);
    });
  });
}
