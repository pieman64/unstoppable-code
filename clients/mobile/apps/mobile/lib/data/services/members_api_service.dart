import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/models/org_invite.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the organization members + invites endpoints.
final class MembersApiService {
  const MembersApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Loads the organization detail (members + the viewer's role).
  Future<OrganizationDetail> fetchOrganization(String orgId) async {
    final json = await apiClient.getJson('/api/account/organizations/$orgId');
    return OrganizationDetail.fromJson(json);
  }

  /// Lists the current user's outgoing invites (all orgs/statuses; the caller
  /// filters to the active ones for the current org).
  Future<List<OutgoingInvite>> listInvites() async {
    final json = await apiClient.getJson('/api/account/invites');
    final list = json['invites'] as List<dynamic>? ?? const [];
    return list
        .map((e) => OutgoingInvite.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// Creates an invite for [email] with [role] in [orgId].
  Future<OutgoingInvite> createInvite({
    required String orgId,
    required String email,
    required OrganizationRole role,
  }) async {
    final json = await apiClient.postJson(
      '/api/account/invites',
      body: {'organizationId': orgId, 'email': email, 'role': role.wire},
    );
    return OutgoingInvite.fromJson(json);
  }

  /// Changes [memberId]'s role in [orgId].  Returns the updated org detail.
  Future<OrganizationDetail> updateMemberRole({
    required String orgId,
    required String memberId,
    required OrganizationRole role,
  }) async {
    final json = await apiClient.patchJson(
      '/api/account/organizations/$orgId/members/$memberId',
      body: {'role': role.wire},
    );
    return OrganizationDetail.fromJson(json);
  }

  /// Removes [memberId] from [orgId].  Returns the updated org detail.
  /// The route returns `OrganizationDetail` in the body, so this uses
  /// `deleteJson` (not the void `delete`).
  Future<OrganizationDetail> removeMember({
    required String orgId,
    required String memberId,
  }) async {
    final json = await apiClient.deleteJson(
      '/api/account/organizations/$orgId/members/$memberId',
    );
    return OrganizationDetail.fromJson(json);
  }

  /// Revokes an outgoing invite the viewer created (a `204` flow).
  Future<void> revokeInvite(String inviteId) =>
      apiClient.delete('/api/account/invites/$inviteId');

  /// Lists the pending team invitations addressed to the current user.
  Future<List<IncomingInvitation>> listIncomingInvitations() async {
    final json = await apiClient.getJson(
      '/api/account/organizations/invitations',
    );
    final list = json['invitations'] as List<dynamic>? ?? const [];
    return list
        .map((e) => IncomingInvitation.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// Accepts (`accept: true`) or declines (`accept: false`) an incoming invite.
  Future<void> respondToIncomingInvitation({
    required String inviteId,
    required bool accept,
  }) async {
    await apiClient.patchJson(
      '/api/account/organizations/invitations/$inviteId',
      body: {'action': accept ? 'accept' : 'decline'},
    );
  }

  /// Sets the minimum role that can view the usage dashboard for [orgId].
  /// Returns the new minimum role parsed from the org config detail.
  Future<OrganizationRole> updateUsageStatsMinRole({
    required String orgId,
    required OrganizationRole role,
  }) async {
    final json = await apiClient.patchJson(
      '/api/account/organizations/$orgId/config',
      body: {'usageStatsMinRole': role.wire},
    );
    return OrganizationConfigDetail.fromJson(json).usageStatsMinRole;
  }
}
