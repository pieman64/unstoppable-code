import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/org_settings_api_service.dart';

void main() {
  group('OrgSettingsApiService', () {
    OrgSettingsApiService serviceWith(MockClient client) =>
        OrgSettingsApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        );

    test('fetchOrganization GETs the org detail', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_orgJson), 200);
      });

      final org = await serviceWith(client).fetchOrganization('org-1');

      expect(captured.method, 'GET');
      expect(captured.url.path, '/api/account/organizations/org-1');
      expect(org.id, 'org-1');
      expect(org.enforcedSync?.plans, isTrue);
      expect(org.githubConnection.connected, isTrue);
      expect(org.githubConnection.accountLogin, 'acme-eng');
    });

    test(
      'updateEnforcedSync PATCHes the full scope set to the config route',
      () async {
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'allowExternalContainerSharing': false,
              'blockedModelIds': <String>[],
              'enforceMemberDataSharing': true,
              'enforceMemberModelGateway': false,
              'enforceMemberModelPolicy': false,
              'modelGatewayBaseUrl': null,
              'modelGatewayEnforced': false,
              'modelGatewayModels': <dynamic>[],
              'modelGatewayPromptCachePassthrough': true,
              'reviewedModelIds': <String>[],
              'usageStatsMinRole': 'MEMBER',
              'enforcedSync': {
                'transcripts': true,
                'plans': false,
                'metadata': true,
                'summaries': false,
              },
            }),
            200,
          );
        });

        final config = await serviceWith(client).updateEnforcedSync(
          orgId: 'org-1',
          scopes: const EnforcedSyncScopes(
            transcripts: true,
            plans: false,
            metadata: true,
            summaries: false,
          ),
        );

        expect(captured.method, 'PATCH');
        expect(captured.url.path, '/api/account/organizations/org-1/config');
        final body = jsonDecode(captured.body) as Map<String, dynamic>;
        final sync = body['enforcedSync'] as Map<String, dynamic>;
        // The server treats enforcedSync as a full replacement, so all FOUR
        // scopes must be present on every call.
        expect(sync['transcripts'], isTrue);
        expect(sync['plans'], isFalse);
        expect(sync['metadata'], isTrue);
        expect(sync['summaries'], isFalse);
        expect(config.enforceMemberDataSharing, isTrue);
        expect(config.enforcedSync.transcripts, isTrue);
        expect(config.enforcedSync.metadata, isTrue);
        expect(config.enforcedSync.summaries, isFalse);
      },
    );

    test(
      'updateEnforcedSync round-trips the summaries scope verbatim',
      () async {
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'allowExternalContainerSharing': false,
              'blockedModelIds': <String>[],
              'enforceMemberDataSharing': true,
              'enforceMemberModelGateway': false,
              'enforceMemberModelPolicy': false,
              'modelGatewayBaseUrl': null,
              'modelGatewayEnforced': false,
              'modelGatewayModels': <dynamic>[],
              'modelGatewayPromptCachePassthrough': true,
              'reviewedModelIds': <String>[],
              'usageStatsMinRole': 'MEMBER',
              'enforcedSync': {
                'transcripts': true,
                'plans': null,
                'metadata': null,
                'summaries': true,
              },
            }),
            200,
          );
        });

        await serviceWith(client).updateEnforcedSync(
          orgId: 'org-1',
          scopes: const EnforcedSyncScopes(
            transcripts: true,
            plans: null,
            metadata: null,
            summaries: true,
          ),
        );

        final body = jsonDecode(captured.body) as Map<String, dynamic>;
        final sync = body['enforcedSync'] as Map<String, dynamic>;
        // Omitting `summaries` would parse server-side as unset, rewriting a
        // policy this call never touched. The server-side counterpart is
        // `team-service.test.ts` "preserves a stored prohibition when the body
        // is not prohibition-aware" — these two halves have to stay in step.
        expect(sync.containsKey('summaries'), isTrue);
        expect(sync['summaries'], isTrue);
        // An unset scope is sent as an explicit null, not dropped.
        expect(sync.containsKey('plans'), isTrue);
        expect(sync['plans'], isNull);
        expect(sync.containsKey('metadata'), isTrue);
        expect(sync['metadata'], isNull);
        // The master switch is deliberately NOT sent: its presence would make
        // the server read every `false` here as a prohibition, which this
        // screen's binary toggles cannot express.
        expect(body.containsKey('enforceMemberDataSharing'), isFalse);
        // Nor is the org model policy: the config route treats an absent key
        // as "leave untouched", so a mobile sync write must never be able to
        // erase an org's blocked-model list. This fails loudly if someone
        // later switches this call to PATCH a whole config object.
        expect(body.containsKey('blockedModelIds'), isFalse);
        expect(body.containsKey('enforceMemberModelPolicy'), isFalse);
        expect(body.containsKey('reviewedModelIds'), isFalse);
      },
    );

    test('disconnectGitHub DELETEs the teams github/connect route', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });

      await serviceWith(client).disconnectGitHub('org-1');

      expect(captured.method, 'DELETE');
      expect(captured.url.path, '/api/account/teams/org-1/github/connect');
    });

    test('updateEnforcedSync surfaces a non-2xx as ApiException', () async {
      final client = MockClient(
        (request) async => http.Response('forbidden', 403),
      );

      await expectLater(
        serviceWith(client).updateEnforcedSync(
          orgId: 'org-1',
          scopes: const EnforcedSyncScopes(
            transcripts: true,
            plans: true,
            metadata: true,
          ),
        ),
        throwsA(isA<ApiException>()),
      );
    });
  });
}

const Map<String, dynamic> _orgJson = {
  'id': 'org-1',
  'name': 'Acme',
  'viewerRole': 'ADMIN',
  'canViewUsageStats': true,
  'usageStatsMinRole': 'MEMBER',
  'enforceMemberDataSharing': true,
  'enforcedSync': {
    'transcripts': false,
    'plans': true,
    'metadata': null,
    'summaries': false,
  },
  'githubConnection': {'connected': true, 'accountLogin': 'acme-eng'},
  'members': <dynamic>[],
  'subTeams': <dynamic>[],
};
