import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/members_api_service.dart';

/// Read/respond access to the current user's pending incoming team invitations.
///
/// These operations are user-scoped — they do not require an active
/// organization — so they can back the no-organization screen, where a
/// first-time invitee who has no org yet can still see and accept an invite.
abstract interface class IncomingInvitationsRepository {
  /// Loads the pending team invitations addressed to the current user.
  Future<List<IncomingInvitation>> fetchIncomingInvitations();

  /// Accepts ([accept] true) or declines an incoming invitation.
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  });
}

/// In-memory [IncomingInvitationsRepository] returning representative data.
final class MockIncomingInvitationsRepository
    implements IncomingInvitationsRepository {
  MockIncomingInvitationsRepository({
    this.latency = const Duration(milliseconds: 400),
    List<IncomingInvitation>? incoming,
  }) : _incoming = [...(incoming ?? _sampleIncoming)];

  final Duration latency;
  final List<IncomingInvitation> _incoming;

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() async {
    await Future<void>.delayed(latency);
    return List.unmodifiable(_incoming);
  }

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) async {
    await Future<void>.delayed(latency);
    _incoming.removeWhere((i) => i.id == inviteId);
  }
}

/// Live [IncomingInvitationsRepository] backed by the user-scoped invitation
/// endpoints on [MembersApiService].
final class HttpIncomingInvitationsRepository
    implements IncomingInvitationsRepository {
  const HttpIncomingInvitationsRepository({required this.service});

  final MembersApiService service;

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() =>
      service.listIncomingInvitations();

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) => service.respondToIncomingInvitation(inviteId: inviteId, accept: accept);
}

/// A single enforcing-org invitation so the consent disclosure is exercised in
/// mock/dev runs and tests. It carries both dispositions (required scopes and
/// a prohibition) so the two-heading disclosure is visible in mock runs.
const List<IncomingInvitation> _sampleIncoming = [
  IncomingInvitation(
    id: 'incoming-1',
    organizationName: 'Globex Labs',
    organizationTeamName: 'Platform',
    role: OrganizationRole.member,
    inviterName: 'Dana Cruz',
    // Required: `true` where required, `null` (not `false`) elsewhere.
    enforcedSettings: EnforcedSyncScopes(metadata: true, transcripts: true),
    // Prohibited: `true` marks the blocked scope.
    prohibitedSettings: EnforcedSyncScopes(summaries: true),
    expiresAt: '2026-07-20T10:00:00.000Z',
  ),
];
