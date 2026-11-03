import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/members_api_service.dart';
import 'package:mobile/data/services/sub_teams_api_service.dart';

/// Abstraction over the organization sub-team backend: the initial org detail
/// load plus create / rename / delete and membership replacement.
///
/// Every mutation returns the updated [OrganizationDetail] so the caller can
/// replace its snapshot in place.
abstract interface class SubTeamsRepository {
  /// Loads the organization detail, including its sub-teams, members, and the
  /// viewer's role.
  Future<OrganizationDetail> fetchOrganization();

  /// Creates a sub-team named [name]. Returns the updated org detail.
  Future<OrganizationDetail> createSubTeam(String name);

  /// Renames sub-team [teamId] to [name]. Returns the updated org detail.
  Future<OrganizationDetail> renameSubTeam({
    required String teamId,
    required String name,
  });

  /// Deletes sub-team [teamId]. Returns the updated org detail.
  Future<OrganizationDetail> deleteSubTeam(String teamId);

  /// Replaces sub-team [teamId]'s membership with [memberUserIds] (member
  /// externalId UUIDs). Returns the updated org detail.
  Future<OrganizationDetail> setMembership({
    required String teamId,
    required List<String> memberUserIds,
  });
}

/// In-memory [SubTeamsRepository] used in mock mode (no API config) and in
/// tests. Mutations are reflected in subsequent [fetchOrganization] calls and in
/// the returned detail. Member [OrganizationMember.subTeamIds] and each
/// [OrganizationSubTeam.memberCount] are kept consistent across mutations so the
/// mock behaves like the server.
final class MockSubTeamsRepository implements SubTeamsRepository {
  MockSubTeamsRepository({
    this.latency = const Duration(milliseconds: 400),
    OrganizationRole viewerRole = OrganizationRole.admin,
  }) : _org = _sampleOrgWithViewerRole(viewerRole);

  final Duration latency;
  OrganizationDetail _org;
  int _seq = 0;

  @override
  Future<OrganizationDetail> fetchOrganization() async {
    await Future<void>.delayed(latency);
    return _org;
  }

  @override
  Future<OrganizationDetail> createSubTeam(String name) async {
    await Future<void>.delayed(latency);
    _seq += 1;
    final team = OrganizationSubTeam(
      id: 'team-new-$_seq',
      name: name.trim(),
      memberCount: 0,
    );
    _org = _copyOrg(_org, subTeams: [..._org.subTeams, team]);
    return _org;
  }

  @override
  Future<OrganizationDetail> renameSubTeam({
    required String teamId,
    required String name,
  }) async {
    await Future<void>.delayed(latency);
    _org = _copyOrg(
      _org,
      subTeams: _org.subTeams
          .map(
            (t) => t.id == teamId
                ? OrganizationSubTeam(
                    id: t.id,
                    name: name.trim(),
                    memberCount: t.memberCount,
                  )
                : t,
          )
          .toList(growable: false),
    );
    return _org;
  }

  @override
  Future<OrganizationDetail> deleteSubTeam(String teamId) async {
    await Future<void>.delayed(latency);
    _org = _copyOrg(
      _org,
      subTeams: _org.subTeams
          .where((t) => t.id != teamId)
          .toList(growable: false),
      members: _org.members
          .map(
            (m) => m.subTeamIds.contains(teamId)
                ? _memberWithSubTeams(
                    m,
                    m.subTeamIds
                        .where((id) => id != teamId)
                        .toList(growable: false),
                  )
                : m,
          )
          .toList(growable: false),
    );
    return _org;
  }

  @override
  Future<OrganizationDetail> setMembership({
    required String teamId,
    required List<String> memberUserIds,
  }) async {
    await Future<void>.delayed(latency);
    final selected = memberUserIds.toSet();
    final members = _org.members
        .map((m) {
          final inTeam = m.subTeamIds.contains(teamId);
          final shouldBeInTeam = selected.contains(m.id);
          if (inTeam == shouldBeInTeam) return m;
          final next = shouldBeInTeam
              ? [...m.subTeamIds, teamId]
              : m.subTeamIds
                    .where((id) => id != teamId)
                    .toList(growable: false);
          return _memberWithSubTeams(m, next);
        })
        .toList(growable: false);
    final memberCount = members
        .where((m) => m.subTeamIds.contains(teamId))
        .length;
    _org = _copyOrg(
      _org,
      members: members,
      subTeams: _org.subTeams
          .map(
            (t) => t.id == teamId
                ? OrganizationSubTeam(
                    id: t.id,
                    name: t.name,
                    memberCount: memberCount,
                  )
                : t,
          )
          .toList(growable: false),
    );
    return _org;
  }
}

OrganizationMember _memberWithSubTeams(
  OrganizationMember member,
  List<String> subTeamIds,
) => OrganizationMember(
  id: member.id,
  name: member.name,
  email: member.email,
  image: member.image,
  role: member.role,
  subTeamIds: subTeamIds,
);

/// Returns a copy of [org] overriding only the given fields. The single place
/// that enumerates every [OrganizationDetail] field, mirroring the members
/// repository so a newly-required field only needs adding here.
OrganizationDetail _copyOrg(
  OrganizationDetail org, {
  List<OrganizationMember>? members,
  List<OrganizationSubTeam>? subTeams,
}) => OrganizationDetail(
  id: org.id,
  name: org.name,
  viewerRole: org.viewerRole,
  members: members ?? org.members,
  subTeams: subTeams ?? org.subTeams,
  usageStatsMinRole: org.usageStatsMinRole,
  canViewUsageStats: org.canViewUsageStats,
  enforcedSync: org.enforcedSync,
  githubConnection: org.githubConnection,
);

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
    OrganizationSubTeam(id: 'team-fe', memberCount: 2, name: 'Frontend'),
    OrganizationSubTeam(id: 'team-be', memberCount: 1, name: 'Backend'),
  ],
  members: [
    OrganizationMember(
      id: 'u1',
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
      id: 'u3',
      name: 'Sam Chen',
      email: 'sam@acme.dev',
      role: OrganizationRole.member,
      subTeamIds: ['team-fe'],
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

/// Live [SubTeamsRepository] backed by [SubTeamsApiService] for mutations and
/// [MembersApiService] for the initial org-detail load (that GET already exists
/// and returns the same [OrganizationDetail]).
final class HttpSubTeamsRepository implements SubTeamsRepository {
  const HttpSubTeamsRepository({
    required this.subTeamsService,
    required this.membersService,
    required this.orgId,
  });

  final SubTeamsApiService subTeamsService;
  final MembersApiService membersService;
  final String orgId;

  @override
  Future<OrganizationDetail> fetchOrganization() =>
      membersService.fetchOrganization(orgId);

  @override
  Future<OrganizationDetail> createSubTeam(String name) =>
      subTeamsService.createSubTeam(orgId: orgId, name: name);

  @override
  Future<OrganizationDetail> renameSubTeam({
    required String teamId,
    required String name,
  }) => subTeamsService.renameSubTeam(orgId: orgId, teamId: teamId, name: name);

  @override
  Future<OrganizationDetail> deleteSubTeam(String teamId) =>
      subTeamsService.deleteSubTeam(orgId: orgId, teamId: teamId);

  @override
  Future<OrganizationDetail> setMembership({
    required String teamId,
    required List<String> memberUserIds,
  }) => subTeamsService.setMembership(
    orgId: orgId,
    teamId: teamId,
    memberUserIds: memberUserIds,
  );
}
