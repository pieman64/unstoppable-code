import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/views/no_organization_screen.dart';
import 'package:mobile/ui/features/home/views/organizations_unavailable_screen.dart';
import 'package:mobile/ui/features/members/views/members_screen.dart';

void main() {
  group('resolveAuthenticatedShellMode', () {
    test('mock mode (no API config) always shows the organization shell', () {
      expect(
        resolveAuthenticatedShellMode(
          hasApiConfig: false,
          orgId: null,
          hasOrganizations: false,
          hasPersonalOrganization: false,
          organizationsLoadFailed: false,
        ),
        AuthenticatedShellMode.organization,
      );
      expect(
        resolveAuthenticatedShellMode(
          hasApiConfig: false,
          orgId: 'org-1',
          hasOrganizations: true,
          hasPersonalOrganization: false,
          organizationsLoadFailed: false,
        ),
        AuthenticatedShellMode.organization,
      );
    });

    test('real mode with a resolved organization shows the data screens', () {
      expect(
        resolveAuthenticatedShellMode(
          hasApiConfig: true,
          orgId: 'org-1',
          hasOrganizations: true,
          hasPersonalOrganization: false,
          organizationsLoadFailed: false,
        ),
        AuthenticatedShellMode.organization,
      );
    });

    test(
      'real mode with no organization shows the no-organization shell rather '
      'than blocking the whole app (CAN-2576)',
      () {
        expect(
          resolveAuthenticatedShellMode(
            hasApiConfig: true,
            orgId: null,
            hasOrganizations: false,
            hasPersonalOrganization: false,
            organizationsLoadFailed: false,
          ),
          AuthenticatedShellMode.noOrganization,
        );
      },
    );

    test('a failed organization load is not mistaken for "no organization": '
        'offering a create-org CTA there invites a duplicate org', () {
      expect(
        resolveAuthenticatedShellMode(
          hasApiConfig: true,
          orgId: null,
          hasOrganizations: false,
          hasPersonalOrganization: false,
          organizationsLoadFailed: true,
        ),
        AuthenticatedShellMode.organizationsUnavailable,
      );
    });

    test('CAN-4429 Personal with organizations keeps the full shell, not the '
        'no-organization shell', () {
      expect(
        resolveAuthenticatedShellMode(
          hasApiConfig: true,
          orgId: null,
          hasOrganizations: true,
          hasPersonalOrganization: false,
          organizationsLoadFailed: false,
        ),
        AuthenticatedShellMode.personal,
      );
      expect(
        homeTabsForShellMode(AuthenticatedShellMode.personal, hasTeams: true),
        organizationHomeTabs,
      );
      expect(
        landingTabForShellMode(
          AuthenticatedShellMode.personal,
          cloudAvailable: false,
        ),
        HomeTab.remote,
      );
    });

    test(
      'a stale load failure never hides an already-resolved organization',
      () {
        expect(
          resolveAuthenticatedShellMode(
            hasApiConfig: true,
            orgId: 'org-1',
            hasOrganizations: true,
            hasPersonalOrganization: false,
            organizationsLoadFailed: true,
          ),
          AuthenticatedShellMode.organization,
        );
      },
    );

    test('a Personal organization opens the Personal shell, even without a '
        'team (CAN-3715)', () {
      for (final hasOrganizations in [true, false]) {
        expect(
          resolveAuthenticatedShellMode(
            hasApiConfig: true,
            orgId: null,
            hasOrganizations: hasOrganizations,
            hasPersonalOrganization: true,
            organizationsLoadFailed: false,
          ),
          AuthenticatedShellMode.personal,
        );
      }
    });
  });
  group('shell composition for each mode', () {
    test('only the organization shell shows all five tabs', () {
      expect(
        homeTabsForShellMode(
          AuthenticatedShellMode.organization,
          hasTeams: true,
        ),
        organizationHomeTabs,
      );
      expect(
        homeTabsForShellMode(
          AuthenticatedShellMode.noOrganization,
          hasTeams: false,
        ),
        noOrganizationHomeTabs,
      );
      expect(
        homeTabsForShellMode(
          AuthenticatedShellMode.organizationsUnavailable,
          hasTeams: false,
        ),
        noOrganizationHomeTabs,
      );
    });

    test('Personal without a team shows Activity but no Usage (CAN-3715)', () {
      final tabs = homeTabsForShellMode(
        AuthenticatedShellMode.personal,
        hasTeams: false,
      );
      expect(tabs, personalHomeTabs);
      expect(tabs, contains(HomeTab.activity));
      expect(tabs, isNot(contains(HomeTab.usage)));
    });

    test('Personal offers team members only when there are teams, never the '
        'create-org CTA instead of them (CAN-3715)', () {
      expect(
        membersTabForShellMode(AuthenticatedShellMode.personal, hasTeams: true),
        isA<MembersScreen>(),
      );
      expect(
        membersTabForShellMode(
          AuthenticatedShellMode.personal,
          hasTeams: false,
        ),
        isA<NoOrganizationScreen>(),
      );
    });

    test('every shell mode lands on Chat while cloud chats may be available '
        '(CAN-2930)', () {
      for (final mode in AuthenticatedShellMode.values) {
        for (final cloudAvailable in [null, true]) {
          expect(
            landingTabForShellMode(mode, cloudAvailable: cloudAvailable),
            HomeTab.chat,
            reason: '$mode, cloudAvailable: $cloudAvailable',
          );
        }
      }
    });

    test(
      'without cloud chats each mode keeps its previous landing destination',
      () {
        expect(
          landingTabForShellMode(
            AuthenticatedShellMode.organization,
            cloudAvailable: false,
          ),
          // Activity now lives under Settings (CAN-3558), so the full shell
          // opens on Remote like a solo account.
          HomeTab.remote,
        );
        expect(
          landingTabForShellMode(
            AuthenticatedShellMode.noOrganization,
            cloudAvailable: false,
          ),
          HomeTab.remote,
        );
        expect(
          landingTabForShellMode(
            AuthenticatedShellMode.personal,
            cloudAvailable: false,
          ),
          HomeTab.remote,
        );
        expect(
          landingTabForShellMode(
            AuthenticatedShellMode.organizationsUnavailable,
            cloudAvailable: false,
          ),
          HomeTab.account,
        );
      },
    );

    test('every shell offers the Chat destination', () {
      for (final mode in AuthenticatedShellMode.values) {
        for (final hasTeams in [true, false]) {
          expect(
            homeTabsForShellMode(mode, hasTeams: hasTeams),
            contains(HomeTab.chat),
          );
        }
      }
    });

    test(
      'only the no-organization mode gets the create-org CTA — offering it on '
      'the unknown-membership path could duplicate an org the user owns',
      () {
        expect(
          membersTabForShellMode(
            AuthenticatedShellMode.noOrganization,
            hasTeams: false,
          ),
          isA<NoOrganizationScreen>(),
        );
        expect(
          membersTabForShellMode(
            AuthenticatedShellMode.organizationsUnavailable,
            hasTeams: false,
          ),
          isA<OrganizationsUnavailableScreen>(),
        );
        expect(
          membersTabForShellMode(
            AuthenticatedShellMode.organization,
            hasTeams: false,
          ),
          isA<MembersScreen>(),
        );
      },
    );
  });
  group('guest shell (CAN-2872)', () {
    test('a guest gets the guest shell whatever else is known', () {
      for (final hasApiConfig in [true, false]) {
        for (final orgId in [null, 'org-1']) {
          expect(
            resolveAuthenticatedShellMode(
              hasApiConfig: hasApiConfig,
              isGuest: true,
              orgId: orgId,
              hasOrganizations: orgId != null,
              hasPersonalOrganization: false,
              organizationsLoadFailed: orgId == null,
            ),
            AuthenticatedShellMode.guest,
          );
        }
      }
    });

    test('offers cloud chats and Settings only', () {
      for (final hasTeams in [true, false]) {
        expect(
          homeTabsForShellMode(
            AuthenticatedShellMode.guest,
            hasTeams: hasTeams,
          ),
          [HomeTab.cloud, HomeTab.account, HomeTab.chat],
        );
      }
    });

    test('opens on Settings, which offers sign-in, without cloud chats', () {
      final tabs = visibleHomeTabs(
        homeTabsForShellMode(AuthenticatedShellMode.guest, hasTeams: false),
        cloudAvailable: false,
      );
      final landing = landingTabForShellMode(
        AuthenticatedShellMode.guest,
        cloudAvailable: false,
      );

      expect(tabs, [HomeTab.account]);
      expect(landing, HomeTab.account);
    });
  });
  _cloudEntryPointTests();
}

void _cloudEntryPointTests() {
  group('cloud entry point (CAN-3143)', () {
    test(
      'every shell lists Cloud chats, then Advisor, then Remote control',
      () {
        for (final tabs in [
          organizationHomeTabs,
          personalHomeTabs,
          noOrganizationHomeTabs,
        ]) {
          final cloud = tabs.indexOf(HomeTab.cloud);
          expect(cloud, isNonNegative, reason: '$tabs');
          expect(tabs[cloud + 1], HomeTab.advisor);
          expect(tabs[cloud + 2], HomeTab.remote);
        }
      },
    );

    test('visibleHomeTabs hides Cloud and Chat only once the server says '
        'unavailable', () {
      expect(
        visibleHomeTabs(noOrganizationHomeTabs, cloudAvailable: null),
        noOrganizationHomeTabs,
      );
      expect(
        visibleHomeTabs(noOrganizationHomeTabs, cloudAvailable: true),
        noOrganizationHomeTabs,
      );
      expect(visibleHomeTabs(noOrganizationHomeTabs, cloudAvailable: false), [
        HomeTab.advisor,
        HomeTab.remote,
        HomeTab.account,
        HomeTab.members,
      ]);
      expect(
        visibleHomeTabs(organizationHomeTabs, cloudAvailable: false),
        isNot(anyOf(contains(HomeTab.cloud), contains(HomeTab.chat))),
      );
    });
  });
}
