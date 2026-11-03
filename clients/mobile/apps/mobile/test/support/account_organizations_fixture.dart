import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/protocol/generated/organization.dart';

/// Adapts a team-list fixture to the account loader, for accounts without a
/// Personal organization.
Future<AccountOrganizations> Function() teamsOnly(
  Future<List<OrganizationSummary>> Function() load,
) =>
    () async => AccountOrganizations(organizations: await load());
