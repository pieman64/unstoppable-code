import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/sub_teams_repository.dart';

void main() {
  group('MockSubTeamsRepository mutations', () {
    MockSubTeamsRepository build() =>
        MockSubTeamsRepository(latency: Duration.zero);

    test('fetchOrganization seeds sub-teams and members', () async {
      final repo = build();
      final org = await repo.fetchOrganization();

      expect(org.subTeams, isNotEmpty);
      expect(org.members, isNotEmpty);
      expect(org.viewerRole, OrganizationRole.admin);
    });

    test('createSubTeam appends a zero-member team', () async {
      final repo = build();
      final before = await repo.fetchOrganization();

      final after = await repo.createSubTeam('Platform');

      expect(after.subTeams.length, before.subTeams.length + 1);
      final created = after.subTeams.last;
      expect(created.name, 'Platform');
      expect(created.memberCount, 0);
    });

    test('renameSubTeam updates only the target team name', () async {
      final repo = build();
      final before = await repo.fetchOrganization();
      final target = before.subTeams.first;

      final after = await repo.renameSubTeam(
        teamId: target.id,
        name: 'Renamed',
      );

      expect(
        after.subTeams.firstWhere((t) => t.id == target.id).name,
        'Renamed',
      );
      // Count is preserved across a rename.
      expect(
        after.subTeams.firstWhere((t) => t.id == target.id).memberCount,
        target.memberCount,
      );
    });

    test('deleteSubTeam drops the team and clears it from members', () async {
      final repo = build();
      final before = await repo.fetchOrganization();
      final target = before.subTeams.firstWhere(
        (t) => before.members.any((m) => m.subTeamIds.contains(t.id)),
      );

      final after = await repo.deleteSubTeam(target.id);

      expect(after.subTeams.where((t) => t.id == target.id), isEmpty);
      expect(
        after.members.any((m) => m.subTeamIds.contains(target.id)),
        isFalse,
      );
    });

    test(
      'setMembership replaces membership and recomputes the count',
      () async {
        final repo = build();
        final before = await repo.fetchOrganization();
        final team = before.subTeams.first;
        // Choose two members, one of which may already be in the team.
        final ids = before.members.take(2).map((m) => m.id).toList();

        final after = await repo.setMembership(
          teamId: team.id,
          memberUserIds: ids,
        );

        final inTeam = after.members
            .where((m) => m.subTeamIds.contains(team.id))
            .map((m) => m.id)
            .toSet();
        expect(inTeam, ids.toSet());
        expect(
          after.subTeams.firstWhere((t) => t.id == team.id).memberCount,
          ids.length,
        );
      },
    );

    test('setMembership with an empty list clears the team', () async {
      final repo = build();
      final before = await repo.fetchOrganization();
      final team = before.subTeams.firstWhere((t) => t.memberCount > 0);

      final after = await repo.setMembership(
        teamId: team.id,
        memberUserIds: const [],
      );

      expect(after.members.any((m) => m.subTeamIds.contains(team.id)), isFalse);
      expect(after.subTeams.firstWhere((t) => t.id == team.id).memberCount, 0);
    });

    test('a member viewer is seeded with the MEMBER role', () async {
      final repo = MockSubTeamsRepository(
        latency: Duration.zero,
        viewerRole: OrganizationRole.member,
      );

      final org = await repo.fetchOrganization();

      expect(org.viewerRole, OrganizationRole.member);
    });
  });
}
