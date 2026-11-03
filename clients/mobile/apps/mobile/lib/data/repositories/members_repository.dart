import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/models/org_invite.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/members_api_service.dart';

/// Abstraction over the organization members + invites backend.
///
/// [MockMembersRepository] backs the UI today; a real implementation will hit
/// `GET /api/account/organizations/{orgId}` (members), `GET /api/account/invites`
/// (pending), and `POST /api/account/invites` (create) once wired.
abstract interface class MembersRepository {
  /// Loads the organization detail, including its member list + `viewerRole`.
  Future<OrganizationDetail> fetchOrganization();

  /// Loads the current user's outgoing invites for this organization.
  Future<List<OutgoingInvite>> fetchPendingInvites();

  /// Creates an invite for [email] with [role].  Throws on failure.
  Future<OutgoingInvite> inviteMember({
    required String email,
    required OrganizationRole role,
  });

  /// Loads the pending team invitations addressed to the current user.
  Future<List<IncomingInvitation>> fetchIncomingInvitations();

  /// Changes [memberId]'s role.  Returns the updated org detail.
  Future<OrganizationDetail> changeMemberRole({
    required String memberId,
    required OrganizationRole role,
  });

  /// Removes [memberId] from the org.  Returns the updated org detail.
  Future<OrganizationDetail> removeMember(String memberId);

  /// Revokes an outgoing invite the viewer created.
  Future<void> revokeInvite(String inviteId);

  /// Accepts or declines an incoming invitation.
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  });

  /// Sets the org usage-stats minimum role.  Returns the new minimum role.
  Future<OrganizationRole> setUsageStatsMinRole(OrganizationRole role);
}

/// In-memory [MembersRepository] returning representative sample data.
///
/// The viewer defaults to ADMIN (configurable via [viewerRole], so the invite
/// affordance shows).  Newly created invites are prepended to the in-memory
/// pending list.
final class MockMembersRepository implements MembersRepository {
  MockMembersRepository({
    this.latency = const Duration(milliseconds: 600),
    List<IncomingInvitation>? incoming,
    OrganizationRole viewerRole = OrganizationRole.admin,
  }) : _incoming = [...(incoming ?? _initialIncoming)],
       _org = _sampleOrgWithViewerRole(viewerRole);

  final Duration latency;

  OrganizationDetail _org;
  final List<OutgoingInvite> _invites = [..._initialInvites];
  final List<IncomingInvitation> _incoming;
  int _counter = 0;

  @override
  Future<OrganizationDetail> fetchOrganization() async {
    await Future<void>.delayed(latency);
    return _org;
  }

  @override
  Future<List<OutgoingInvite>> fetchPendingInvites() async {
    await Future<void>.delayed(latency);
    return List.unmodifiable(_invites);
  }

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() async {
    await Future<void>.delayed(latency);
    return List.unmodifiable(_incoming);
  }

  @override
  Future<OutgoingInvite> inviteMember({
    required String email,
    required OrganizationRole role,
  }) async {
    await Future<void>.delayed(latency);
    _counter += 1;
    final now = DateTime.now();
    final invite = OutgoingInvite(
      id: 'inv-new-$_counter',
      code: 'mock-invite-code-$_counter',
      status: InviteStatus.active,
      createdAt: now.toIso8601String(),
      expiresAt: now.add(const Duration(days: 14)).toIso8601String(),
      organizationId: _org.id,
      organizationName: _org.name,
      role: role,
      invitedEmail: email.trim(),
    );
    _invites.insert(0, invite);
    return invite;
  }

  @override
  Future<OrganizationDetail> changeMemberRole({
    required String memberId,
    required OrganizationRole role,
  }) async {
    await Future<void>.delayed(latency);
    _org = _copyOrg(
      _org,
      members: _org.members
          .map(
            (m) => m.id == memberId
                ? OrganizationMember(
                    id: m.id,
                    name: m.name,
                    email: m.email,
                    image: m.image,
                    role: role,
                    subTeamIds: m.subTeamIds,
                  )
                : m,
          )
          .toList(growable: false),
    );
    return _org;
  }

  @override
  Future<OrganizationDetail> removeMember(String memberId) async {
    await Future<void>.delayed(latency);
    _org = _copyOrg(
      _org,
      members: _org.members
          .where((m) => m.id != memberId)
          .toList(growable: false),
    );
    return _org;
  }

  @override
  Future<void> revokeInvite(String inviteId) async {
    await Future<void>.delayed(latency);
    _invites.removeWhere((i) => i.id == inviteId);
  }

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) async {
    await Future<void>.delayed(latency);
    _incoming.removeWhere((i) => i.id == inviteId);
  }

  @override
  Future<OrganizationRole> setUsageStatsMinRole(OrganizationRole role) async {
    await Future<void>.delayed(latency);
    _org = _copyOrg(_org, usageStatsMinRole: role);
    return role;
  }
}

/// Returns a copy of [org] overriding only the given fields. The single place
/// that enumerates every [OrganizationDetail] field, so a newly-required field
/// (as `githubConnection` once was) only needs adding here.
OrganizationDetail _copyOrg(
  OrganizationDetail org, {
  List<OrganizationMember>? members,
  OrganizationRole? usageStatsMinRole,
}) => OrganizationDetail(
  id: org.id,
  name: org.name,
  viewerRole: org.viewerRole,
  members: members ?? org.members,
  subTeams: org.subTeams,
  usageStatsMinRole: usageStatsMinRole ?? org.usageStatsMinRole,
  canViewUsageStats: org.canViewUsageStats,
  enforcedSync: org.enforcedSync,
  githubConnection: org.githubConnection,
);

/// Live [MembersRepository] backed by [MembersApiService].
final class HttpMembersRepository implements MembersRepository {
  const HttpMembersRepository({required this.service, required this.orgId});

  final MembersApiService service;
  final String orgId;

  @override
  Future<OrganizationDetail> fetchOrganization() =>
      service.fetchOrganization(orgId);

  @override
  Future<List<OutgoingInvite>> fetchPendingInvites() => service.listInvites();

  @override
  Future<OutgoingInvite> inviteMember({
    required String email,
    required OrganizationRole role,
  }) => service.createInvite(orgId: orgId, email: email, role: role);

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() =>
      service.listIncomingInvitations();

  @override
  Future<OrganizationDetail> changeMemberRole({
    required String memberId,
    required OrganizationRole role,
  }) => service.updateMemberRole(orgId: orgId, memberId: memberId, role: role);

  @override
  Future<OrganizationDetail> removeMember(String memberId) =>
      service.removeMember(orgId: orgId, memberId: memberId);

  @override
  Future<void> revokeInvite(String inviteId) => service.revokeInvite(inviteId);

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) => service.respondToIncomingInvitation(inviteId: inviteId, accept: accept);

  @override
  Future<OrganizationRole> setUsageStatsMinRole(OrganizationRole role) =>
      service.updateUsageStatsMinRole(orgId: orgId, role: role);
}

/// Returns [_sampleOrg] with its `viewerRole` overridden to [viewerRole].
/// Used by [MockMembersRepository] to seed non-default viewer ranks (e.g. a
/// MEMBER viewer) for permission-gate tests.
OrganizationDetail _sampleOrgWithViewerRole(OrganizationRole viewerRole) =>
    OrganizationDetail(
      id: _sampleOrg.id,
      name: _sampleOrg.name,
      viewerRole: viewerRole,
      canViewUsageStats: _sampleOrg.canViewUsageStats,
      enforcedSync: _sampleOrg.enforcedSync,
      githubConnection: _sampleOrg.githubConnection,
      usageStatsMinRole: _sampleOrg.usageStatsMinRole,
      subTeams: _sampleOrg.subTeams,
      members: _sampleOrg.members,
    );

const OrganizationDetail _sampleOrg = OrganizationDetail(
  id: 'org-1',
  name: 'Acme Engineering',
  viewerRole: OrganizationRole.admin,
  canViewUsageStats: true,
  githubConnection: OrganizationGitHubConnectionDetail(connected: false),
  usageStatsMinRole: OrganizationRole.member,
  subTeams: [
    OrganizationSubTeam(id: 'team-fe', memberCount: 3, name: 'Frontend'),
    OrganizationSubTeam(id: 'team-be', memberCount: 4, name: 'Backend'),
  ],
  members: [
    OrganizationMember(
      id: 'user-001',
      name: 'Alex Rivera',
      email: 'alex@acme.dev',
      role: OrganizationRole.owner,
      subTeamIds: ['team-fe'],
    ),
    OrganizationMember(
      id: 'u2',
      name: 'Priya Nair',
      email: 'priya@acme.dev',
      role: OrganizationRole.admin,
      subTeamIds: ['team-be'],
    ),
    OrganizationMember(
      id: 'user-002',
      name: 'Sam Chen',
      email: 'sam@acme.dev',
      role: OrganizationRole.member,
      subTeamIds: ['team-fe', 'team-be'],
    ),
    OrganizationMember(
      id: 'u4',
      name: 'Jordan Lee',
      email: 'jordan@acme.dev',
      role: OrganizationRole.member,
      subTeamIds: [],
    ),
  ],
);

const List<OutgoingInvite> _initialInvites = [
  OutgoingInvite(
    id: 'inv-1',
    code: 'seed-code-1',
    status: InviteStatus.active,
    createdAt: '2026-06-27T10:00:00.000Z',
    expiresAt: '2026-07-11T10:00:00.000Z',
    organizationId: 'org-1',
    organizationName: 'Acme Engineering',
    role: OrganizationRole.member,
    invitedEmail: 'newhire@acme.dev',
  ),
];

const List<IncomingInvitation> _initialIncoming = [
  IncomingInvitation(
    id: 'incoming-1',
    organizationName: 'Globex Labs',
    organizationTeamName: 'Platform',
    role: OrganizationRole.member,
    inviterName: 'Dana Cruz',
    expiresAt: '2026-07-20T10:00:00.000Z',
  ),
];
