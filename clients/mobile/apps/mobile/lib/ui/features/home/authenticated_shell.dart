import 'package:flutter/widgets.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/views/no_organization_screen.dart';
import 'package:mobile/ui/features/home/views/organizations_unavailable_screen.dart';
import 'package:mobile/ui/features/members/views/members_screen.dart';

/// Which shell an authenticated user should see, given how organization
/// resolution turned out.
enum AuthenticatedShellMode {
  /// An organization is resolved (or mock mode, which ignores the org id):
  /// the full five-tab app.
  organization,

  /// The account works in Personal (CAN-4429) and belongs to organizations
  /// or has a Personal organization. Activity shows the viewer's own work
  /// from the Personal organization (CAN-3715); other organization
  /// destinations ask the user to choose an organization.
  personal,

  /// The account belongs to no organization and has no Personal
  /// organization. Individual and Pro accounts are legitimate users, so they
  /// get the app minus the org-scoped tabs rather than a dead end (CAN-2576).
  noOrganization,

  /// The organization list could not be loaded, so membership is unknown.
  organizationsUnavailable,

  /// A guest session (CAN-2872): Settings only. A guest has no
  /// organizations, sign-in methods or paired desktop.
  guest,
}

/// Resolves which authenticated shell to render.
///
/// The important distinction is between *no organization* and *could not load
/// organizations*: both leave [orgId] null, but only the first is a real
/// individual account. A loaded membership or Personal organization with a
/// null [orgId] is Personal, which is a choice, not a missing organization.
/// Showing the create-an-organization CTA after a failed
/// load would invite a user whose existing org simply failed to fetch to
/// create a duplicate one, so that case gets its own retryable state.
///
/// Mock mode (no API config) ignores the org id and always renders the
/// mock-backed screens, so it never requires an organization.
///
/// A guest's shell wins over everything else: it has no organizations to
/// resolve.
AuthenticatedShellMode resolveAuthenticatedShellMode({
  required bool hasApiConfig,
  bool isGuest = false,
  required String? orgId,
  required bool hasOrganizations,
  required bool hasPersonalOrganization,
  required bool organizationsLoadFailed,
}) {
  if (isGuest) return AuthenticatedShellMode.guest;
  if (!hasApiConfig || orgId != null) {
    return AuthenticatedShellMode.organization;
  }
  if (organizationsLoadFailed) {
    return AuthenticatedShellMode.organizationsUnavailable;
  }
  return hasOrganizations || hasPersonalOrganization
      ? AuthenticatedShellMode.personal
      : AuthenticatedShellMode.noOrganization;
}

/// The side-menu destinations [mode] should show. [hasTeams] says whether the
/// account belongs to any team organization: Personal without one has no
/// organization to choose for Usage, so it leaves Usage out.
List<HomeTab> homeTabsForShellMode(
  AuthenticatedShellMode mode, {
  required bool hasTeams,
}) => switch (mode) {
  AuthenticatedShellMode.organization => organizationHomeTabs,
  AuthenticatedShellMode.personal =>
    hasTeams ? organizationHomeTabs : personalHomeTabs,
  AuthenticatedShellMode.noOrganization ||
  AuthenticatedShellMode.organizationsUnavailable => noOrganizationHomeTabs,
  AuthenticatedShellMode.guest => guestHomeTabs,
};

/// Computer Connect is the signed-in landing page in every account context.
HomeTab landingTabForShellMode(AuthenticatedShellMode mode) =>
    mode == AuthenticatedShellMode.guest ? HomeTab.account : HomeTab.chat;

/// The Members-tab content for [mode]. [hasTeams] says whether the account
/// belongs to any team organization.
///
/// The distinction between the two org-less modes is load-bearing and easy to
/// get backwards, which is why it lives in a function with a test rather than
/// inline in the shell: [AuthenticatedShellMode.noOrganization] offers a
/// create-organization CTA, while [AuthenticatedShellMode.organizationsUnavailable]
/// must not — membership there is unknown, so the CTA could hand the user a
/// duplicate of an organization they already own. Personal with teams shows
/// the members of a chosen organization; without one it offers invitations
/// and team creation, like an account with no organization.
Widget membersTabForShellMode(
  AuthenticatedShellMode mode, {
  required bool hasTeams,
}) => switch (mode) {
  AuthenticatedShellMode.organization => const MembersScreen(),
  AuthenticatedShellMode.personal =>
    hasTeams ? const MembersScreen() : const NoOrganizationScreen(),
  AuthenticatedShellMode.noOrganization => const NoOrganizationScreen(),
  AuthenticatedShellMode.organizationsUnavailable =>
    const OrganizationsUnavailableScreen(),
  // [guestHomeTabs] has no Members destination.
  AuthenticatedShellMode.guest => const SizedBox.shrink(),
};
