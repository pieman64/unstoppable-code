import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/sub_teams_repository.dart';
import 'package:mobile/ui/features/sub_teams/view_models/sub_teams_view_model.dart';

void main() {
  group('SubTeamsViewModel', () {
    SubTeamsViewModel build() => SubTeamsViewModel(
      repository: MockSubTeamsRepository(latency: Duration.zero),
    );

    test('load populates the organization, sub-teams, and members', () async {
      final vm = build();
      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.organization, isNotNull);
      expect(vm.subTeams, isNotEmpty);
      expect(vm.members, isNotEmpty);
      expect(vm.error, isNull);
    });

    test('an admin viewer can manage sub-teams', () async {
      final vm = build();
      await vm.load();

      expect(vm.canManageSubTeams, isTrue);
    });

    test('a member viewer cannot manage sub-teams', () async {
      final vm = SubTeamsViewModel(
        repository: MockSubTeamsRepository(
          latency: Duration.zero,
          viewerRole: OrganizationRole.member,
        ),
      );
      await vm.load();

      expect(vm.canManageSubTeams, isFalse);
    });

    test('canManageSubTeams is false before any load', () {
      final vm = build();
      expect(vm.canManageSubTeams, isFalse);
    });

    test('createSubTeam appends a new team', () async {
      final vm = build();
      await vm.load();
      final before = vm.subTeams.length;

      await vm.createSubTeam('Platform');

      expect(vm.subTeams.length, before + 1);
      expect(vm.subTeams.last.name, 'Platform');
    });

    test('renameSubTeam updates the team name', () async {
      final vm = build();
      await vm.load();
      final teamId = vm.subTeams.first.id;

      await vm.renameSubTeam(teamId, 'Renamed');

      expect(vm.subTeams.firstWhere((t) => t.id == teamId).name, 'Renamed');
    });

    test('deleteSubTeam removes the team', () async {
      final vm = build();
      await vm.load();
      final teamId = vm.subTeams.first.id;

      await vm.deleteSubTeam(teamId);

      expect(vm.subTeams.where((t) => t.id == teamId), isEmpty);
    });

    test('setMembership replaces membership and updates the count', () async {
      final vm = build();
      await vm.load();
      final teamId = vm.subTeams.first.id;
      final ids = vm.members.take(2).map((m) => m.id).toList();

      await vm.setMembership(teamId, ids);

      expect(vm.membersInTeam(teamId).map((m) => m.id).toSet(), ids.toSet());
      expect(
        vm.subTeams.firstWhere((t) => t.id == teamId).memberCount,
        ids.length,
      );
    });

    test('membersInTeam returns only members assigned to the team', () async {
      final vm = build();
      await vm.load();
      final teamId = vm.subTeams.first.id;

      for (final member in vm.membersInTeam(teamId)) {
        expect(member.subTeamIds.contains(teamId), isTrue);
      }
    });

    test('load reports an error when the request fails', () async {
      final vm = SubTeamsViewModel(repository: _FailingSubTeamsRepository());
      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.error, isNotNull);
      expect(vm.organization, isNull);
      expect(vm.subTeams, isEmpty);
    });

    test('a failed mutation records actionError and rethrows', () async {
      final vm = SubTeamsViewModel(
        repository: _FailingMutationsSubTeamsRepository(),
      );
      await vm.load();
      expect(vm.organization, isNotNull);

      await expectLater(vm.createSubTeam('X'), throwsA(isA<StateError>()));
      expect(vm.actionError, isNotNull);
      expect(vm.isBusy, isFalse);
    });
  });
}

/// Fails every call; used to exercise the load error path.
final class _FailingSubTeamsRepository implements SubTeamsRepository {
  @override
  Future<OrganizationDetail> fetchOrganization() =>
      Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> createSubTeam(String name) =>
      Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> renameSubTeam({
    required String teamId,
    required String name,
  }) => Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> deleteSubTeam(String teamId) =>
      Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> setMembership({
    required String teamId,
    required List<String> memberUserIds,
  }) => Future.error(StateError('boom'));
}

/// Loads fine (delegating to the mock) but fails all mutations, so the
/// action-error path can be tested against a populated org.
final class _FailingMutationsSubTeamsRepository implements SubTeamsRepository {
  final MockSubTeamsRepository _delegate = MockSubTeamsRepository(
    latency: Duration.zero,
  );

  @override
  Future<OrganizationDetail> fetchOrganization() =>
      _delegate.fetchOrganization();

  @override
  Future<OrganizationDetail> createSubTeam(String name) =>
      Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> renameSubTeam({
    required String teamId,
    required String name,
  }) => Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> deleteSubTeam(String teamId) =>
      Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> setMembership({
    required String teamId,
    required List<String> memberUserIds,
  }) => Future.error(StateError('boom'));
}
