import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';

void main() {
  group('IncomingInvitation.fromJson', () {
    test('parses a full incoming invitation', () {
      final json = <String, dynamic>{
        'id': 'inv-1',
        'organizationName': 'Acme Engineering',
        'organizationTeamName': 'Frontend',
        'role': 'ADMIN',
        'invitedByName': 'Alex Rivera',
        'createdAt': '2026-06-27T10:00:00.000Z',
        'expiresAt': '2026-07-11T10:00:00.000Z',
        'enforcedSettings': [
          {
            'organizationId': 'org-1',
            'organizationName': 'Acme Engineering',
            'policies': [
              {
                'kind': 'telemetry-sync',
                'scopes': {
                  'transcripts': true,
                  'plans': false,
                  'metadata': true,
                },
              },
            ],
          },
        ],
      };

      final invite = IncomingInvitation.fromJson(json);

      expect(invite.id, 'inv-1');
      expect(invite.organizationName, 'Acme Engineering');
      expect(invite.organizationTeamName, 'Frontend');
      expect(invite.role, OrganizationRole.admin);
      expect(invite.inviterName, 'Alex Rivera');
      expect(invite.expiresAt, '2026-07-11T10:00:00.000Z');
      expect(invite.enforcedSettings?.transcripts, isTrue);
      expect(invite.enforcedSettings?.metadata, isTrue);
      // A scope the org does not REQUIRE parses as null (unset), never false:
      // false means prohibited and belongs on prohibitedSettings.
      expect(invite.enforcedSettings?.plans, isNull);
      expect(invite.enforcedSettings?.summaries, isNull);
      expect(invite.prohibitedSettings, isNull);
    });

    test('parses prohibited scopes, including summaries', () {
      final json = <String, dynamic>{
        'id': 'inv-3',
        'organizationName': 'Secure Org',
        'role': 'MEMBER',
        'enforcedSettings': [
          {
            'organizationId': 'org-3',
            'organizationName': 'Secure Org',
            'policies': [
              {
                'kind': 'telemetry-sync',
                'scopes': {
                  'transcripts': false,
                  'plans': true,
                  'metadata': false,
                  'summaries': false,
                },
                'prohibitedScopes': {
                  'transcripts': true,
                  'plans': false,
                  'metadata': false,
                  'summaries': true,
                },
              },
            ],
          },
        ],
      };

      final invite = IncomingInvitation.fromJson(json);

      expect(invite.enforcedSettings?.plans, isTrue);
      expect(invite.prohibitedSettings?.transcripts, isTrue);
      expect(invite.prohibitedSettings?.summaries, isTrue);
      expect(invite.prohibitedSettings?.plans, isNull);
      expect(invite.prohibitedSettings?.metadata, isNull);
    });

    test('a prohibition beats a requirement for the same scope', () {
      final json = <String, dynamic>{
        'id': 'inv-4',
        'organizationName': 'Split Org',
        'role': 'MEMBER',
        'enforcedSettings': [
          {
            'organizationId': 'org-a',
            'organizationName': 'Org A',
            'policies': [
              {
                'kind': 'telemetry-sync',
                'scopes': {'summaries': true},
              },
            ],
          },
          {
            'organizationId': 'org-b',
            'organizationName': 'Org B',
            'policies': [
              {
                'kind': 'telemetry-sync',
                'scopes': <String, dynamic>{},
                'prohibitedScopes': {'summaries': true},
              },
            ],
          },
        ],
      };

      final invite = IncomingInvitation.fromJson(json);

      // Unioned across orgs, then resolved: blocked wins, so summaries must not
      // be claimed as required as well.
      expect(invite.prohibitedSettings?.summaries, isTrue);
      expect(invite.enforcedSettings, isNull);
    });

    test('tolerates a null team name and missing inviter', () {
      final json = <String, dynamic>{
        'id': 'inv-2',
        'organizationName': 'Beta Corp',
        'organizationTeamName': null,
        'role': 'MEMBER',
        'expiresAt': '2026-07-11T10:00:00.000Z',
      };

      final invite = IncomingInvitation.fromJson(json);

      expect(invite.organizationTeamName, isNull);
      expect(invite.inviterName, isNull);
      expect(invite.enforcedSettings, isNull);
      expect(invite.role, OrganizationRole.member);
    });
  });
}
