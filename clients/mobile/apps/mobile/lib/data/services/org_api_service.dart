import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the account organization lifecycle endpoints
/// (`/api/account/organizations`): create, rename, leave, and delete.
final class OrgApiService {
  const OrgApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Creates an organization named [name]. The server returns the new
  /// organization's detail (HTTP 201).
  Future<OrganizationDetail> createOrganization(String name) async {
    final json = await apiClient.postJson(
      '/api/account/organizations',
      body: {'name': name},
    );
    return OrganizationDetail.fromJson(json);
  }

  /// Renames organization [orgId] to [name]. The server returns the updated
  /// organization detail.
  Future<OrganizationDetail> renameOrganization({
    required String orgId,
    required String name,
  }) async {
    final json = await apiClient.patchJson(
      '/api/account/organizations/$orgId',
      body: {'name': name},
    );
    return OrganizationDetail.fromJson(json);
  }

  /// Leaves organization [orgId] (a `204` flow).
  Future<void> leaveOrganization(String orgId) =>
      apiClient.postJson('/api/account/organizations/$orgId/leave');

  /// Deletes organization [orgId] (owner only; a `204` flow).
  Future<void> deleteOrganization(String orgId) =>
      apiClient.delete('/api/account/organizations/$orgId');
}
