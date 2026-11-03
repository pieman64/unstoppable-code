import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the organization-settings endpoints: the enforced-sync half of the org
/// config PATCH and the org-level GitHub App connection.
///
/// The enforced-sync toggles reuse the same `.../config` PATCH the members
/// screen already uses for usage-stats visibility, only sending the
/// `enforcedSync` field instead of `usageStatsMinRole`. The GitHub connection
/// status is read from the org detail; disconnect is a dedicated route under
/// `/api/account/teams/{orgId}/github/connect`.
final class OrgSettingsApiService {
  const OrgSettingsApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Loads the full org detail so the settings screen can read the current
  /// `enforcedSync` scopes, the `githubConnection` status, and the viewer role
  /// used for gating.
  Future<OrganizationDetail> fetchOrganization(String orgId) async {
    final json = await apiClient.getJson('/api/account/organizations/$orgId');
    return OrganizationDetail.fromJson(json);
  }

  /// Replaces the org's enforced telemetry-sync [scopes] via the config PATCH.
  ///
  /// The server treats `enforcedSync` as a FULL replacement of ALL FOUR scopes:
  /// an omitted key parses as `null` (unset). Sending a partial map therefore
  /// does not "leave the rest alone" — it silently rewrites the scopes it left
  /// out. Every scope in [scopes] is written out here, `null` included, so a
  /// toggle of one scope can never drop another.
  ///
  /// `enforceMemberDataSharing` is deliberately NOT sent. The route reads the
  /// presence of that key as proof the caller is prohibition-aware and then
  /// takes every `false` literally as a prohibition. This screen's switches are
  /// binary (required / not required), so its "off" has to keep meaning "the
  /// member's own choice", which is exactly what the route does with a
  /// `false` from a caller that omits the marker.
  ///
  /// Because this client is not prohibition-aware, the server treats its writes
  /// as unable to express a prohibition in EITHER direction: it will not
  /// materialize an unset scope into a prohibition, and it preserves any
  /// prohibition the org already has rather than reading this screen's
  /// downgraded `null` as a request to lift it. So a mobile toggle can neither
  /// create nor erase a block — it only ever moves the required/not-required
  /// axis it actually renders.
  ///
  /// Returns the updated config detail.
  Future<OrganizationConfigDetail> updateEnforcedSync({
    required String orgId,
    required EnforcedSyncScopes scopes,
  }) async {
    final json = await apiClient.patchJson(
      '/api/account/organizations/$orgId/config',
      body: {
        'enforcedSync': {
          'transcripts': scopes.transcripts,
          'plans': scopes.plans,
          'metadata': scopes.metadata,
          'summaries': scopes.summaries,
        },
      },
    );
    return OrganizationConfigDetail.fromJson(json);
  }

  /// Disconnects the org-level GitHub App (a `204` flow).
  Future<void> disconnectGitHub(String orgId) =>
      apiClient.delete('/api/account/teams/$orgId/github/connect');
}
