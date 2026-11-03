import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/members_repository.dart';

void main() {
  group('MockMembersRepository mutations', () {
    MockMembersRepository build() =>
        MockMembersRepository(latency: Duration.zero);

    test('changeMemberRole returns a detail with the updated role', () async {
      final repo = build();
      final before = await repo.fetchOrganization();
      final target = before.members.firstWhere(
        (m) => m.role == OrganizationRole.member,
      );

      final after = await repo.changeMemberRole(
        memberId: target.id,
        role: OrganizationRole.admin,
      );

      expect(
        after.members.firstWhere((m) => m.id == target.id).role,
        OrganizationRole.admin,
      );
    });

    test('removeMember drops the member from the returned detail', () async {
      final repo = build();
      final before = await repo.fetchOrganization();
      final target = before.members.firstWhere(
        (m) => m.role == OrganizationRole.member,
      );

      final after = await repo.removeMember(target.id);

      expect(after.members.where((m) => m.id == target.id), isEmpty);
    });

    test('revokeInvite removes the invite from the pending list', () async {
      final repo = build();
      final before = await repo.fetchPendingInvites();
      expect(before, isNotEmpty);

      await repo.revokeInvite(before.first.id);
      final after = await repo.fetchPendingInvites();

      expect(after.where((i) => i.id == before.first.id), isEmpty);
    });

    test('fetchIncomingInvitations returns the seeded invitations', () async {
      final repo = build();

      final invites = await repo.fetchIncomingInvitations();

      expect(invites, isNotEmpty);
    });

    test('respondToInvitation drops the incoming invitation', () async {
      final repo = build();
      final before = await repo.fetchIncomingInvitations();

      await repo.respondToInvitation(inviteId: before.first.id, accept: true);
      final after = await repo.fetchIncomingInvitations();

      expect(after.where((i) => i.id == before.first.id), isEmpty);
    });

    test('setUsageStatsMinRole returns the new role', () async {
      final repo = build();

      final role = await repo.setUsageStatsMinRole(OrganizationRole.admin);

      expect(role, OrganizationRole.admin);
      final org = await repo.fetchOrganization();
      expect(org.usageStatsMinRole, OrganizationRole.admin);
    });
  });
}
