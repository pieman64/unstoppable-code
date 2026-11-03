import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the account-level organization endpoints.
final class AccountApiService {
  const AccountApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Lists the team organizations the current user belongs to, plus their
  /// Personal organization id when the server returns one.
  Future<AccountOrganizations> listOrganizations() async {
    final json = await apiClient.getJson('/api/account/organizations');
    final list = json['organizations'] as List<dynamic>? ?? const [];
    final personalId = json['personalOrganizationId'];
    return AccountOrganizations(
      organizations: list
          .map((e) => OrganizationSummary.fromJson(e as Map<String, dynamic>))
          .toList(growable: false),
      personalOrganizationId: personalId is String && personalId.isNotEmpty
          ? personalId
          : null,
    );
  }
}
