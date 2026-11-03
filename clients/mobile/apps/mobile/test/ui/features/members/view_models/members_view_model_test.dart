import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/models/org_invite.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';

void main() {
  group('MembersViewModel', () {
    MembersViewModel build() => MembersViewModel(
      repository: MockMembersRepository(latency: Duration.zero),
    );

    test('load populates organization and pending invites', () async {
      final vm = build();
      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.organization, isNotNull);
      expect(vm.organization?.members, isNotEmpty);
      expect(vm.pendingInvites, isNotEmpty);
      expect(vm.error, isNull);
    });

    test('an admin viewer can manage members but not grant admin', () async {
      final vm = build();
      await vm.load();

      expect(vm.canManageMembers, isTrue);
      expect(vm.canGrantAdmin, isFalse);
    });

    test('submitInvite prepends a new active invite', () async {
      final vm = build();
      await vm.load();
      final before = vm.pendingInvites.length;

      final invite = await vm.submitInvite(
        email: 'new@acme.dev',
        role: OrganizationRole.member,
      );

      expect(invite.invitedEmail, 'new@acme.dev');
      expect(invite.status, InviteStatus.active);
      expect(vm.pendingInvites.length, before + 1);
      expect(vm.pendingInvites.first.invitedEmail, 'new@acme.dev');
    });

    test('load reports an error when a request fails', () async {
      final vm = MembersViewModel(repository: _FailingMembersRepository());
      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.error, isNotNull);
      expect(vm.organization, isNull);
      expect(vm.pendingInvites, isEmpty);
    });

    test('load does not orphan the pending-invites request when the '
        'organization request fails first', () async {
      final uncaught = <Object>[];
      await runZonedGuarded(() async {
        final vm = MembersViewModel(repository: _FailingMembersRepository());
        await vm.load();
        expect(vm.error, isNotNull);
        // Give the (previously orphaned) invites future time to settle so any
        // unhandled error would surface to the zone handler below.
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }, (error, _) => uncaught.add(error));

      expect(
        uncaught,
        isEmpty,
        reason:
            'the pending-invites request error must be awaited, not '
            'left to fail as an unhandled async error',
      );
    });

    test('load also populates incoming invitations', () async {
      final vm = build();
      await vm.load();

      expect(vm.incomingInvitations, isNotEmpty);
    });

    test(
      'an admin can edit usage-stats config but cannot change roles',
      () async {
        final vm = build();
        await vm.load();

        expect(vm.canEditUsageStatsConfig, isTrue);
        expect(vm.canChangeRoles, isFalse); // mock viewer is ADMIN
      },
    );

    test('canRemove is true only for lower-ranked members', () async {
      final vm = build();
      await vm.load();
      final members = vm.organization!.members;
      final owner = members.firstWhere((m) => m.role == OrganizationRole.owner);
      final member = members.firstWhere(
        (m) => m.role == OrganizationRole.member,
      );

      // ADMIN viewer outranks MEMBER but not OWNER.
      expect(vm.canRemove(member), isTrue);
      expect(vm.canRemove(owner), isFalse);
    });

    test(
      'changeMemberRole updates the organization from the returned detail',
      () async {
        final vm = build();
        await vm.load();
        final target = vm.organization!.members.firstWhere(
          (m) => m.role == OrganizationRole.member,
        );

        await vm.changeMemberRole(target.id, OrganizationRole.admin);

        expect(
          vm.organization!.members.firstWhere((m) => m.id == target.id).role,
          OrganizationRole.admin,
        );
        expect(vm.isBusy, isFalse);
      },
    );

    test('removeMember drops the member from the organization', () async {
      final vm = build();
      await vm.load();
      final target = vm.organization!.members.firstWhere(
        (m) => m.role == OrganizationRole.member,
      );

      await vm.removeMember(target.id);

      expect(vm.organization!.members.where((m) => m.id == target.id), isEmpty);
    });

    test('revokeInvite drops the outgoing invite', () async {
      final vm = build();
      await vm.load();
      final target = vm.pendingInvites.first;

      await vm.revokeInvite(target.id);

      expect(vm.pendingInvites.where((i) => i.id == target.id), isEmpty);
    });

    test('acceptInvitation drops the incoming invitation', () async {
      final vm = build();
      await vm.load();
      final target = vm.incomingInvitations.first;

      await vm.acceptInvitation(target.id);

      expect(vm.incomingInvitations.where((i) => i.id == target.id), isEmpty);
    });

    test(
      'mutation completion after dispose does not notify a dead listener',
      () async {
        final vm = MembersViewModel(
          repository: MockMembersRepository(
            latency: const Duration(milliseconds: 1),
          ),
        );
        await vm.load();
        final target = vm.incomingInvitations.first;

        final future = vm.acceptInvitation(target.id);
        vm.dispose();

        await expectLater(future, completes);
      },
    );

    test('declineInvitation drops the incoming invitation', () async {
      final vm = build();
      await vm.load();
      final target = vm.incomingInvitations.first;

      await vm.declineInvitation(target.id);

      expect(vm.incomingInvitations.where((i) => i.id == target.id), isEmpty);
    });

    test(
      'setUsageStatsMinRole refetches and reflects the new min role',
      () async {
        final vm = build();
        await vm.load();

        await vm.setUsageStatsMinRole(OrganizationRole.admin);

        expect(vm.organization!.usageStatsMinRole, OrganizationRole.admin);
      },
    );

    test(
      'a mutation surfaces actionError when the repository throws',
      () async {
        final vm = MembersViewModel(repository: _MutationFailingRepository());

        // _runAction rethrows (by design, so callers can react/surface a
        // snackbar) in addition to recording actionError, so the caller must
        // expect the throw.
        await expectLater(
          vm.changeMemberRole('u1', OrganizationRole.admin),
          throwsA(isA<StateError>()),
        );

        expect(vm.actionError, isNotNull);
        expect(vm.isBusy, isFalse);
      },
    );
  });
}

/// Fails both requests, with the invites request settling *after* the
/// organization request so a sequential-await path would orphan the invites
/// future when the organization request throws first.
final class _FailingMembersRepository implements MembersRepository {
  @override
  Future<OrganizationDetail> fetchOrganization() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('organization request failed');
  }

  @override
  Future<List<OutgoingInvite>> fetchPendingInvites() async {
    await Future<void>.delayed(const Duration(milliseconds: 5));
    throw StateError('pending invites request failed');
  }

  @override
  Future<OutgoingInvite> inviteMember({
    required String email,
    required OrganizationRole role,
  }) => throw UnimplementedError();

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() async {
    // Async (not a bare synchronous `throw`) so this rejects as a proper
    // `Future` instead of throwing while the `load()` record literal is
    // still being constructed — a synchronous throw here would orphan the
    // sibling `fetchOrganization`/`fetchPendingInvites` futures before
    // `.wait` can ever subscribe to them.
    throw UnimplementedError();
  }

  @override
  Future<OrganizationDetail> changeMemberRole({
    required String memberId,
    required OrganizationRole role,
  }) => throw UnimplementedError();

  @override
  Future<OrganizationDetail> removeMember(String memberId) =>
      throw UnimplementedError();

  @override
  Future<void> revokeInvite(String inviteId) => throw UnimplementedError();

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) => throw UnimplementedError();

  @override
  Future<OrganizationRole> setUsageStatsMinRole(OrganizationRole role) =>
      throw UnimplementedError();
}

/// A repository whose mutations always throw, exercising the view-model's
/// action error path.
final class _MutationFailingRepository implements MembersRepository {
  @override
  Future<OrganizationDetail> fetchOrganization() => throw UnimplementedError();

  @override
  Future<List<OutgoingInvite>> fetchPendingInvites() =>
      throw UnimplementedError();

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() =>
      throw UnimplementedError();

  @override
  Future<OutgoingInvite> inviteMember({
    required String email,
    required OrganizationRole role,
  }) => throw UnimplementedError();

  @override
  Future<OrganizationDetail> changeMemberRole({
    required String memberId,
    required OrganizationRole role,
  }) async => throw StateError('boom');

  @override
  Future<OrganizationDetail> removeMember(String memberId) async =>
      throw StateError('boom');

  @override
  Future<void> revokeInvite(String inviteId) async => throw StateError('boom');

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) async => throw StateError('boom');

  @override
  Future<OrganizationRole> setUsageStatsMinRole(OrganizationRole role) async =>
      throw StateError('boom');
}
