import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the organization sub-team endpoints
/// (`/api/account/organizations/{orgId}/teams`).
///
/// Every mutation returns the full updated [OrganizationDetail] (the same shape
/// the members screen consumes), so callers can replace their org snapshot from
/// the response rather than refetching.
final class SubTeamsApiService {
  const SubTeamsApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Creates a sub-team named [name] in [orgId]. Returns the updated org detail.
  Future<OrganizationDetail> createSubTeam({
    required String orgId,
    required String name,
  }) async {
    final json = await apiClient.postJson(
      '/api/account/organizations/$orgId/teams',
      body: {'name': name},
    );
    return OrganizationDetail.fromJson(json);
  }

  /// Renames sub-team [teamId] in [orgId] to [name]. Returns the updated detail.
  Future<OrganizationDetail> renameSubTeam({
    required String orgId,
    required String teamId,
    required String name,
  }) async {
    final json = await apiClient.patchJson(
      '/api/account/organizations/$orgId/teams/$teamId',
      body: {'name': name},
    );
    return OrganizationDetail.fromJson(json);
  }

  /// Deletes sub-team [teamId] from [orgId]. The route returns the updated
  /// [OrganizationDetail] in the body, so this uses `deleteJson` (not the void
  /// `delete`). Returns the updated detail.
  Future<OrganizationDetail> deleteSubTeam({
    required String orgId,
    required String teamId,
  }) async {
    final json = await apiClient.deleteJson(
      '/api/account/organizations/$orgId/teams/$teamId',
    );
    return OrganizationDetail.fromJson(json);
  }

  /// Replaces sub-team [teamId]'s membership with [memberUserIds] (the member
  /// externalId UUIDs, i.e. [OrganizationMember.id] values). This is a full
  /// set-replacement PUT, not an incremental add/remove. Returns the updated
  /// [OrganizationDetail].
  Future<OrganizationDetail> setMembership({
    required String orgId,
    required String teamId,
    required List<String> memberUserIds,
  }) async {
    final json = await apiClient.putJson(
      '/api/account/organizations/$orgId/teams/$teamId/members',
      body: {'memberUserIds': memberUserIds},
    );
    return OrganizationDetail.fromJson(json);
  }
}
