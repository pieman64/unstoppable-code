import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/org_api_service.dart';

/// Contract for the organization lifecycle actions surfaced on the Members
/// screen: create, rename, leave, and delete.
///
/// Create and rename return the affected organization's detail; leave and
/// delete complete without a value.
abstract interface class OrgRepository {
  Future<OrganizationDetail> create(String name);
  Future<OrganizationDetail> rename({
    required String orgId,
    required String name,
  });
  Future<void> leave(String orgId);
  Future<void> delete(String orgId);
}

/// In-memory [OrgRepository] used in mock mode (no API config) and in tests.
/// It does not own the canonical org list — that lives in `AuthViewModel` — so
/// these methods only fabricate a plausible result for the caller.
final class MockOrgRepository implements OrgRepository {
  MockOrgRepository({this.latency = const Duration(milliseconds: 400)});

  final Duration latency;
  int _seq = 0;

  @override
  Future<OrganizationDetail> create(String name) async {
    await Future<void>.delayed(latency);
    return _detail(id: 'org-new-${++_seq}', name: name);
  }

  @override
  Future<OrganizationDetail> rename({
    required String orgId,
    required String name,
  }) async {
    await Future<void>.delayed(latency);
    return _detail(id: orgId, name: name);
  }

  @override
  Future<void> leave(String orgId) async {
    await Future<void>.delayed(latency);
  }

  @override
  Future<void> delete(String orgId) async {
    await Future<void>.delayed(latency);
  }

  OrganizationDetail _detail({required String id, required String name}) =>
      OrganizationDetail(
        id: id,
        name: name,
        viewerRole: OrganizationRole.owner,
        canViewUsageStats: true,
        githubConnection: const OrganizationGitHubConnectionDetail(
          connected: false,
        ),
        usageStatsMinRole: OrganizationRole.member,
        subTeams: const [],
        members: const [],
      );
}

/// Live [OrgRepository] backed by [OrgApiService].
final class HttpOrgRepository implements OrgRepository {
  const HttpOrgRepository({required this.service});

  final OrgApiService service;

  @override
  Future<OrganizationDetail> create(String name) =>
      service.createOrganization(name);

  @override
  Future<OrganizationDetail> rename({
    required String orgId,
    required String name,
  }) => service.renameOrganization(orgId: orgId, name: name);

  @override
  Future<void> leave(String orgId) => service.leaveOrganization(orgId);

  @override
  Future<void> delete(String orgId) => service.deleteOrganization(orgId);
}
