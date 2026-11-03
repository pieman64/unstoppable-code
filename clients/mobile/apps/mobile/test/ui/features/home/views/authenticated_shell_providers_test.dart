import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/main.dart'
    show
        buildCloudChatModels,
        buildNoOrganizationShellProviders,
        buildOrganizationShellProviders,
        buildPersonalShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_scope.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/stats/view_models/stats_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_transcript_cache_scope.dart';

import '../../../../support/account_organizations_fixture.dart';
import '../../../../support/memory_remote_transcript_storage.dart';
import '../../../../support/settings_root_providers.dart';
import '../../../../support/workspace_context_fixture.dart';

/// Covers the provider composition in `main.dart`'s `_shell`, which is the one
/// place a mistake in this change becomes a runtime `ProviderNotFoundException`
/// rather than an analyzer error — and only for the org-less users the change
/// exists to unblock. The three shell modes mount three different provider
/// sets, so each is pumped with exactly the list `_shell` supplies and every
/// destination in it is visited.
void main() {
  group('authenticated shell provider composition', () {
    setUp(() {
      // Empty base URLs => AppConfig.hasAuthApiConfig is false => every
      // repository builder in main.dart resolves to its Mock* implementation,
      // so no test here touches the network.
      AppConfig.configureEnvironmentController(
        ApiEnvironmentController(
          productionBaseUrl: '',
          stagingBaseUrl: '',
          initialEnvironment: ApiEnvironment.production,
          preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
        ),
      );
    });

    /// Composes a shell exactly the way `_authenticatedApp` does: tabs and the
    /// Members-tab widget come from the mapping functions, not from values
    /// written out here. A mapping change is therefore exercised against the
    /// real provider lists rather than against a copy that agrees with it.
    Widget buildShell({
      required AuthenticatedShellMode mode,
      required List<SingleChildWidget> modeProviders,
      bool hasTeams = false,
      AuthViewModel? auth,
    }) => MultiProvider(
      providers: [
        if (auth != null)
          ChangeNotifierProvider<AuthViewModel>.value(value: auth)
        else
          ChangeNotifierProvider<AuthViewModel>(
            create: (_) => AuthViewModel(
              repository: MockAuthRepository(latency: Duration.zero),
            ),
          ),
        workspaceContextProvider(),
        ...settingsRootTestProviders(),
        ...buildSharedShellProviders(),
        ...modeProviders,
      ],
      // The cloud models sit above the root Navigator in production; the
      // same scope and factory are used here so the interim Cloud tab
      // resolves exactly what `App` provides.
      child: CloudChatScope(
        create: buildCloudChatModels,
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: HomeTabControllerProvider(
            tabs: homeTabsForShellMode(mode, hasTeams: hasTeams),
            // Launch state: the cloud probe has not answered yet.
            initialTab: landingTabForShellMode(mode, cloudAvailable: null),
            child: HomeShell(
              refreshActivity: refreshActivityFeed,
              activityAccount: watchActivityAccount,

              membersTab: membersTabForShellMode(mode, hasTeams: hasTeams),
            ),
          ),
        ),
      ),
    );

    /// Visits every destination in the drawer and asserts nothing threw — a
    /// missing provider surfaces here, not at analyze time.
    Future<void> visitEveryDestination(
      WidgetTester tester,
      AuthenticatedShellMode mode, {
      bool hasTeams = false,
    }) async {
      for (final tab in homeTabsForShellMode(mode, hasTeams: hasTeams)) {
        await tester.tap(find.byTooltip('Open navigation menu'));
        await tester.pumpAndSettle();
        // Chat and Settings have no menu row; the pinned Chat button and
        // Settings cog are their entry points. The Settings destinations are
        // opened from Settings (CAN-3558).
        final fromAccount = settingsHomeTabs.contains(tab);
        await tester.tap(
          find.byKey(
            ValueKey(switch (tab) {
              HomeTab.chat => 'home-new-chat-button',
              HomeTab.account => 'home-settings-button',
              _ when fromAccount => 'home-settings-button',
              _ => 'home-nav-${tab.name}',
            }),
          ),
        );
        await tester.pumpAndSettle();
        if (fromAccount) {
          await tester.tap(find.byKey(ValueKey('account-nav-${tab.name}')));
          await tester.pumpAndSettle();
        }
        expect(
          tester.takeException(),
          isNull,
          reason: 'destination "${tab.name}" threw',
        );
        if (fromAccount) {
          await tester.tap(find.byTooltip('Back'));
          await tester.pumpAndSettle();
        }
      }
    }

    testWidgets(
      'opening the no-organization shell does not raise the keyboard — every '
      'tab is built by the IndexedStack, so an autofocused field on a tab the '
      'user cannot even see would still ambush them on launch',
      (tester) async {
        await tester.pumpWidget(
          buildShell(
            mode: AuthenticatedShellMode.noOrganization,
            modeProviders: buildNoOrganizationShellProviders(),
          ),
        );
        await tester.pumpAndSettle();

        expect(tester.testTextInput.isVisible, isFalse);
      },
    );

    testWidgets(
      'CAN-3373 the Remote view model persists through the account cache',
      (tester) async {
        final account = ValueNotifier(0);
        addTearDown(account.dispose);
        final storage = MemoryRemoteTranscriptStorage();
        await tester.pumpWidget(
          RemoteTranscriptCacheScope(
            account: account,
            accountScope: () => 'production:7',
            signedOut: () => false,
            create: (accountScope) => RemoteTranscriptCache(
              storage: storage,
              accountScope: accountScope,
            ),
            purge: storage.clear,
            child: buildShell(
              mode: AuthenticatedShellMode.noOrganization,
              modeProviders: buildNoOrganizationShellProviders(),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final context = tester.element(find.byType(HomeShell));
        final cache = maybeRemoteTranscriptCache(context);
        expect(cache?.accountScope, 'production:7');
        expect(
          Provider.of<RemoteControlViewModel>(
            context,
            listen: false,
          ).transcriptCache,
          same(cache),
        );
      },
    );

    testWidgets('the no-organization shell resolves every provider it needs', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildShell(
          mode: AuthenticatedShellMode.noOrganization,
          modeProviders: buildNoOrganizationShellProviders(),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      await visitEveryDestination(
        tester,
        AuthenticatedShellMode.noOrganization,
      );
    });

    testWidgets('the organizations-unavailable shell resolves every provider', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildShell(
          mode: AuthenticatedShellMode.organizationsUnavailable,
          modeProviders: const [],
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      await visitEveryDestination(
        tester,
        AuthenticatedShellMode.organizationsUnavailable,
      );
    });

    for (final hasTeams in [false, true]) {
      testWidgets(
        'the Personal shell resolves every provider without team-only ones '
        '(CAN-3715, hasTeams: $hasTeams)',
        (tester) async {
          final auth = AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
            loadOrganizations: () async => AccountOrganizations(
              organizations: hasTeams
                  ? workspaceContextOrganizations()
                  : const [],
              personalOrganizationId: 'personal-1',
            ),
          );
          addTearDown(auth.dispose);
          await tester.runAsync(
            () => auth.signIn(email: 'a@b.dev', password: 'password'),
          );
          expect(auth.isPersonalActive, isTrue);
          await tester.pumpWidget(
            buildShell(
              mode: AuthenticatedShellMode.personal,
              modeProviders: buildPersonalShellProviders('personal-1'),
              hasTeams: hasTeams,
              auth: auth,
            ),
          );
          await tester.pumpAndSettle();

          final context = tester.element(find.byType(HomeShell));
          expect(Provider.of<StatsViewModel?>(context, listen: false), isNull);
          expect(
            Provider.of<MembersViewModel?>(context, listen: false),
            isNull,
          );
          expect(tester.takeException(), isNull);
          await visitEveryDestination(
            tester,
            AuthenticatedShellMode.personal,
            hasTeams: hasTeams,
          );
          // Personal Activity is never gated; with teams, Usage and Members
          // ask for an organization (CAN-4429).
          expect(
            find.byKey(
              const ValueKey('organization-context-gate'),
              skipOffstage: false,
            ),
            findsNWidgets(hasTeams ? 2 : 0),
          );
        },
      );
    }

    testWidgets('the organization shell resolves every provider it needs', (
      tester,
    ) async {
      await tester.pumpWidget(
        // The organization mode maps to the real MembersScreen, which has the
        // most provider dependencies of any tab — the one most worth pairing
        // with the real org-scoped provider list.
        buildShell(
          mode: AuthenticatedShellMode.organization,
          modeProviders: buildOrganizationShellProviders('org-1'),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      await visitEveryDestination(tester, AuthenticatedShellMode.organization);
    });

    testWidgets(
      'CAN-4429 the Personal shell resolves every destination without '
      'organization view models',
      (tester) async {
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(
            () async => workspaceContextOrganizations(),
          ),
        );
        addTearDown(auth.dispose);
        await tester.runAsync(
          () => auth.signIn(email: 'a@b.dev', password: 'password'),
        );
        expect(auth.activeOrgId, isNull);
        // No org-scoped providers: a destination that reached for one would
        // throw instead of showing mock data to a real Personal user.
        await tester.pumpWidget(
          buildShell(
            mode: AuthenticatedShellMode.personal,
            modeProviders: buildPersonalShellProviders(null),
            hasTeams: true,
            auth: auth,
          ),
        );
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        await visitEveryDestination(
          tester,
          AuthenticatedShellMode.personal,
          hasTeams: true,
        );
        expect(
          find.byKey(
            const ValueKey('organization-context-gate'),
            skipOffstage: false,
          ),
          findsNWidgets(3),
        );
      },
    );
  });
}
