import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/org_settings_repository.dart';

void main() {
  group('MockOrgSettingsRepository', () {
    MockOrgSettingsRepository build() =>
        MockOrgSettingsRepository(latency: Duration.zero);

    test('fetchOrganization returns the seeded detail', () async {
      final org = await build().fetchOrganization();

      expect(org.id, 'org-1');
      expect(org.viewerRole, OrganizationRole.admin);
      expect(org.enforcedSync?.plans, isTrue);
      expect(org.githubConnection.connected, isTrue);
      expect(org.githubConnection.accountLogin, 'acme-eng');
    });

    test('setEnforcedSync is reflected on the next fetch', () async {
      final repo = build();

      final updated = await repo.setEnforcedSync(
        const EnforcedSyncScopes(
          transcripts: true,
          plans: false,
          metadata: true,
        ),
      );
      expect(updated.transcripts, isTrue);

      final org = await repo.fetchOrganization();
      expect(org.enforcedSync?.transcripts, isTrue);
      expect(org.enforcedSync?.plans, isFalse);
      expect(org.enforcedSync?.metadata, isTrue);
    });

    test('disconnectGitHub clears the connection on the next fetch', () async {
      final repo = build();

      await repo.disconnectGitHub();

      final org = await repo.fetchOrganization();
      expect(org.githubConnection.connected, isFalse);
      expect(org.githubConnection.accountLogin, isNull);
    });

    test('viewerRole seed is honoured', () async {
      final repo = MockOrgSettingsRepository(
        latency: Duration.zero,
        viewerRole: OrganizationRole.member,
      );

      final org = await repo.fetchOrganization();
      expect(org.viewerRole, OrganizationRole.member);
    });
  });
}
