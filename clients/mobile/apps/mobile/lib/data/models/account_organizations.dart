import 'package:mobile/data/protocol/generated/organization.dart';

/// The account's contexts from `GET /api/account/organizations`.
///
/// [organizations] lists team organizations only. The Personal organization
/// is kept apart in [personalOrganizationId], so a team row never stands in
/// for it and Personal never gets an invented team role or member count.
final class AccountOrganizations {
  const AccountOrganizations({
    this.organizations = const [],
    this.personalOrganizationId,
  });

  final List<OrganizationSummary> organizations;

  /// The Personal organization's external id; null when the account has none.
  final String? personalOrganizationId;
}
