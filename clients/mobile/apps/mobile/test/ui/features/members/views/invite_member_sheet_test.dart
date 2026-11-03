import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/models/org_invite.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/members/views/invite_member_sheet.dart';

void main() {
  group('InviteMemberSheet', () {
    Widget buildSubject({
      bool canGrantAdmin = false,
      MembersViewModel? viewModel,
    }) {
      final resolvedViewModel =
          viewModel ??
          MembersViewModel(
            repository: MockMembersRepository(latency: Duration.zero),
          );
      return MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: InviteMemberSheet(
            viewModel: resolvedViewModel,
            canGrantAdmin: canGrantAdmin,
          ),
        ),
      );
    }

    testWidgets('validates the email before submitting', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Send invite'));
      await tester.pump();

      expect(find.text('Enter a valid email address'), findsOneWidget);
    });

    testWidgets('creates an invite and shows the link', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'invitee@acme.dev');
      await tester.tap(find.widgetWithText(FilledButton, 'Send invite'));
      await tester.pumpAndSettle();

      expect(find.text('Invite created'), findsOneWidget);
      expect(find.textContaining('/invite/'), findsOneWidget);
    });

    testWidgets('offers the admin role only when the viewer may grant it', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(canGrantAdmin: true));
      await tester.pumpAndSettle();

      expect(find.byType(SegmentedButton<OrganizationRole>), findsOneWidget);
      expect(find.text('Admin'), findsOneWidget);
    });

    testWidgets(
      'shows the lapse cause and remedy when invite creation is gated',
      (tester) async {
        final viewModel = MembersViewModel(
          repository: _LapsedInviteRepository(),
        );
        await tester.pumpWidget(buildSubject(viewModel: viewModel));
        final load = viewModel.load();
        await tester.pumpAndSettle();
        await load;

        await tester.enterText(find.byType(TextField), 'invitee@acme.dev');
        await tester.tap(find.widgetWithText(FilledButton, 'Send invite'));
        await tester.pumpAndSettle();

        expect(
          find.text(
            'Your trial has ended. Ask an organization owner to subscribe to '
            'restore your team.',
          ),
          findsOneWidget,
        );
        expect(
          find.text('Could not send the invite. Please try again.'),
          findsNothing,
        );
        expect(find.textContaining('ApiException'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  });
}

final class _LapsedInviteRepository implements MembersRepository {
  final MockMembersRepository _delegate = MockMembersRepository(
    latency: Duration.zero,
  );

  @override
  Future<OrganizationDetail> fetchOrganization() =>
      _delegate.fetchOrganization();

  @override
  Future<List<OutgoingInvite>> fetchPendingInvites() =>
      _delegate.fetchPendingInvites();

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() =>
      _delegate.fetchIncomingInvitations();

  @override
  Future<OutgoingInvite> inviteMember({
    required String email,
    required OrganizationRole role,
  }) => throw const ApiException(
    statusCode: 403,
    body:
        '{"error":"Your organization\'s trial has ended. Subscribe to Team '
        'to restore team features.","code":"org_teams_lapsed",'
        '"lapseReason":"trial_ended","requiredPlanName":"Team",'
        '"trialEndedAt":null}',
  );

  @override
  Future<OrganizationDetail> changeMemberRole({
    required String memberId,
    required OrganizationRole role,
  }) => _delegate.changeMemberRole(memberId: memberId, role: role);

  @override
  Future<OrganizationDetail> removeMember(String memberId) =>
      _delegate.removeMember(memberId);

  @override
  Future<void> revokeInvite(String inviteId) =>
      _delegate.revokeInvite(inviteId);

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) => _delegate.respondToInvitation(inviteId: inviteId, accept: accept);

  @override
  Future<OrganizationRole> setUsageStatsMinRole(OrganizationRole role) =>
      _delegate.setUsageStatsMinRole(role);
}
