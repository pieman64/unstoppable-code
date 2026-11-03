import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/members_api_service.dart';

void main() {
  group('MembersApiService', () {
    MembersApiService serviceWith(MockClient client) => MembersApiService(
      apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
    );

    test('fetchOrganization parses the org detail', () async {
      final client = MockClient(
        (request) async => http.Response(jsonEncode(_orgJson), 200),
      );

      final org = await serviceWith(client).fetchOrganization('org-1');

      expect(org.id, 'org-1');
      expect(org.members, hasLength(1));
      expect(org.viewerRole, OrganizationRole.admin);
    });

    test('listInvites parses the invites array', () async {
      final client = MockClient(
        (request) async => http.Response(
          jsonEncode({
            'invites': [_inviteJson],
            'inviteLimit': 10,
            'remaining': 9,
            'organizations': <dynamic>[],
            'enabled': true,
          }),
          200,
        ),
      );

      final invites = await serviceWith(client).listInvites();

      expect(invites, hasLength(1));
      expect(invites.first.invitedEmail, 'new@acme.dev');
    });

    test('createInvite posts the org, email and role', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_inviteJson), 201);
      });

      final invite = await serviceWith(client).createInvite(
        orgId: 'org-1',
        email: 'new@acme.dev',
        role: OrganizationRole.member,
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/account/invites');
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['organizationId'], 'org-1');
      expect(body['email'], 'new@acme.dev');
      expect(body['role'], 'MEMBER');
      expect(invite.invitedEmail, 'new@acme.dev');
    });

    test('updateMemberRole PATCHes the role and parses the detail', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_orgJson), 200);
      });

      final org = await serviceWith(client).updateMemberRole(
        orgId: 'org-1',
        memberId: 'u1',
        role: OrganizationRole.admin,
      );

      expect(captured.method, 'PATCH');
      expect(captured.url.path, '/api/account/organizations/org-1/members/u1');
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['role'], 'ADMIN');
      expect(org.id, 'org-1');
    });

    test('removeMember DELETEs the member and parses the detail', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(jsonEncode(_orgJson), 200);
      });

      final org = await serviceWith(
        client,
      ).removeMember(orgId: 'org-1', memberId: 'u3');

      expect(captured.method, 'DELETE');
      expect(captured.url.path, '/api/account/organizations/org-1/members/u3');
      expect(org.id, 'org-1');
    });

    test('revokeInvite DELETEs the invite', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });

      await serviceWith(client).revokeInvite('inv-1');

      expect(captured.method, 'DELETE');
      expect(captured.url.path, '/api/account/invites/inv-1');
    });

    test('listIncomingInvitations parses the invitations array', () async {
      final client = MockClient(
        (request) async => http.Response(
          jsonEncode({
            'invitations': [
              {
                'id': 'inv-9',
                'organizationName': 'Beta Corp',
                'organizationTeamName': null,
                'role': 'MEMBER',
                'invitedByName': 'Robin',
                'createdAt': '2026-06-27T10:00:00.000Z',
                'expiresAt': '2026-07-11T10:00:00.000Z',
                'enforcedSettings': [
                  {
                    'organizationId': 'org-2',
                    'organizationName': 'Beta Corp',
                    'policies': [
                      {
                        'kind': 'telemetry-sync',
                        'scopes': {
                          'transcripts': false,
                          'plans': true,
                          'metadata': false,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          200,
        ),
      );

      final invites = await serviceWith(client).listIncomingInvitations();

      expect(invites, hasLength(1));
      expect(invites.first.id, 'inv-9');
      expect(invites.first.organizationName, 'Beta Corp');
      expect(invites.first.role, OrganizationRole.member);
      expect(invites.first.enforcedSettings?.plans, isTrue);
    });

    test('respondToIncomingInvitation PATCHes accept', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });

      await serviceWith(
        client,
      ).respondToIncomingInvitation(inviteId: 'inv-9', accept: true);

      expect(captured.method, 'PATCH');
      expect(captured.url.path, '/api/account/organizations/invitations/inv-9');
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['action'], 'accept');
    });

    test('respondToIncomingInvitation PATCHes decline', () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });

      await serviceWith(
        client,
      ).respondToIncomingInvitation(inviteId: 'inv-9', accept: false);

      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['action'], 'decline');
    });

    test(
      'updateUsageStatsMinRole PATCHes config and parses the role',
      () async {
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'allowExternalContainerSharing': false,
              'blockedModelIds': <String>[],
              'enforceMemberDataSharing': false,
              'enforceMemberModelGateway': false,
              'enforceMemberModelPolicy': false,
              'modelGatewayBaseUrl': null,
              'modelGatewayEnforced': false,
              'modelGatewayModels': <dynamic>[],
              'modelGatewayPromptCachePassthrough': true,
              'reviewedModelIds': <String>[],
              'usageStatsMinRole': 'ADMIN',
              'enforcedSync': {
                'transcripts': false,
                'plans': false,
                'metadata': false,
              },
            }),
            200,
          );
        });

        final role = await serviceWith(
          client,
        ).updateUsageStatsMinRole(orgId: 'org-1', role: OrganizationRole.admin);

        expect(captured.method, 'PATCH');
        expect(captured.url.path, '/api/account/organizations/org-1/config');
        final body = jsonDecode(captured.body) as Map<String, dynamic>;
        expect(body['usageStatsMinRole'], 'ADMIN');
        // The config route treats an absent key as "leave untouched", so this
        // narrow write must not carry the org model policy: sending it would
        // let a mobile role change silently erase an org's blocked models.
        expect(body.containsKey('blockedModelIds'), isFalse);
        expect(body.containsKey('enforceMemberModelPolicy'), isFalse);
        expect(role, OrganizationRole.admin);
      },
    );
  });
}

const Map<String, dynamic> _orgJson = {
  'id': 'org-1',
  'name': 'Acme',
  'viewerRole': 'ADMIN',
  'canViewUsageStats': true,
  'usageStatsMinRole': 'MEMBER',
  'githubConnection': <String, dynamic>{'connected': false},
  'members': [
    {
      'id': 'u1',
      'name': 'Alex',
      'email': 'alex@acme.dev',
      'role': 'OWNER',
      'subTeamIds': <dynamic>[],
    },
  ],
  'subTeams': <dynamic>[],
};

const Map<String, dynamic> _inviteJson = {
  'id': 'inv-1',
  'code': 'code-1',
  'status': 'ACTIVE',
  'createdAt': '2026-06-27T10:00:00.000Z',
  'expiresAt': '2026-07-11T10:00:00.000Z',
  'organizationId': 'org-1',
  'role': 'MEMBER',
  'invitedEmail': 'new@acme.dev',
  'invitedUserExists': false,
};
