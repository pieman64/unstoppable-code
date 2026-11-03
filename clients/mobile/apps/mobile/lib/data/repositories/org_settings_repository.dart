import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/org_settings_api_service.dart';

/// Contract for reading and editing organization-wide settings: the enforced
/// telemetry-sync scopes and the org-level GitHub App connection.
abstract interface class OrgSettingsRepository {
  /// Loads the org detail (enforced sync + GitHub status + viewer role).
  Future<OrganizationDetail> fetchOrganization();

  /// Replaces the enforced-sync [scopes] (full replacement). Returns the
  /// updated scopes parsed from the config detail.
  Future<EnforcedSyncScopes> setEnforcedSync(EnforcedSyncScopes scopes);

  /// Disconnects the org-level GitHub App.
  Future<void> disconnectGitHub();
}

/// In-memory [OrgSettingsRepository] used in mock mode (no API config) and in
/// tests. Mutations are reflected in subsequent [fetchOrganization] calls.
final class MockOrgSettingsRepository implements OrgSettingsRepository {
  MockOrgSettingsRepository({
    this.latency = const Duration(milliseconds: 400),
    this.viewerRole = OrganizationRole.admin,
    this.enforcedSync = const EnforcedSyncScopes(
      transcripts: false,
      plans: true,
      metadata: false,
    ),
    this.githubConnection = const OrganizationGitHubConnectionDetail(
      connected: true,
      accountLogin: 'acme-eng',
    ),
  }) : _enforcedSync = enforcedSync,
       _githubConnection = githubConnection;

  final Duration latency;
  final OrganizationRole viewerRole;

  /// Seed values for the initial fetch; live state is tracked in the private
  /// fields below so mutations are reflected on the next [fetchOrganization].
  final EnforcedSyncScopes enforcedSync;
  final OrganizationGitHubConnectionDetail githubConnection;

  EnforcedSyncScopes _enforcedSync;
  OrganizationGitHubConnectionDetail _githubConnection;

  @override
  Future<OrganizationDetail> fetchOrganization() async {
    await Future<void>.delayed(latency);
    return OrganizationDetail(
      id: 'org-1',
      name: 'Acme Engineering',
      viewerRole: viewerRole,
      canViewUsageStats: true,
      usageStatsMinRole: OrganizationRole.member,
      enforcedSync: _enforcedSync,
      githubConnection: _githubConnection,
      subTeams: const [],
      members: const [],
    );
  }

  @override
  Future<EnforcedSyncScopes> setEnforcedSync(EnforcedSyncScopes scopes) async {
    await Future<void>.delayed(latency);
    _enforcedSync = scopes;
    return scopes;
  }

  @override
  Future<void> disconnectGitHub() async {
    await Future<void>.delayed(latency);
    _githubConnection = const OrganizationGitHubConnectionDetail(
      connected: false,
      accountLogin: null,
    );
  }
}

/// Live [OrgSettingsRepository] backed by [OrgSettingsApiService].
final class HttpOrgSettingsRepository implements OrgSettingsRepository {
  const HttpOrgSettingsRepository({required this.service, required this.orgId});

  final OrgSettingsApiService service;
  final String orgId;

  @override
  Future<OrganizationDetail> fetchOrganization() =>
      service.fetchOrganization(orgId);

  @override
  Future<EnforcedSyncScopes> setEnforcedSync(EnforcedSyncScopes scopes) async {
    final config = await service.updateEnforcedSync(
      orgId: orgId,
      scopes: scopes,
    );
    return config.enforcedSync;
  }

  @override
  Future<void> disconnectGitHub() => service.disconnectGitHub(orgId);
}
