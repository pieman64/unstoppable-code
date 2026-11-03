import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:mobile/ui/features/desktop_app/views/desktop_app_prompt_sheet.dart';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/models/chat_destination_store.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/repositories/org_repository.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/stats_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/data/services/chat_destination_preference_store.dart';
import 'package:mobile/data/services/workspace_context_store.dart';
import 'package:mobile/app/desktop_app_prompt_binding.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';
import 'package:mobile/services/link_sharer.dart';
import 'package:mobile/data/services/desktop_app_prompt_store.dart';
import 'package:mobile/main.dart'
    show
        buildProviderUsageSourceProvider,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/chat/widgets/chat_location_subtitle.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/organizations/view_models/org_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/stats/view_models/stats_view_model.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';

import '../../../../support/settings_root_providers.dart';
import '../../../../support/cloud_chat_providers.dart';
import '../../../../support/composer_driver.dart';
import '../../../../support/fake_cloud_chat_repository.dart';
import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/overview_snapshot_fixture.dart';
import '../../../../support/workspace_context_fixture.dart';
import '../../../../support/account_organizations_fixture.dart';

/// A phone-width viewport. The default 800x600 test surface is wide enough to
/// hide bottom-bar overflow that a real handset would show.
const Size _phone = Size(390, 844);

void main() {
  group('HomeShell', () {
    void configureEnvironment(ApiEnvironment environment) {
      AppConfig.configureEnvironmentController(
        ApiEnvironmentController(
          productionBaseUrl: 'https://production.test',
          stagingBaseUrl: 'https://staging.test',
          initialEnvironment: environment,
          preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
        ),
      );
    }

    setUp(() => configureEnvironment(ApiEnvironment.production));

    /// Account- and device-scoped providers for the shell test hosts.
    List<SingleChildWidget> accountScopedProviders({
      RemoteControlRepository? remoteRepository,
      CloudChatRepository? cloudRepository,
      ChatDraftStore? draftStore,
      AuthViewModel? auth,
      bool provideAuth = true,
    }) => [
      if (provideAuth)
        if (auth != null)
          ChangeNotifierProvider<AuthViewModel>.value(value: auth)
        else
          ChangeNotifierProvider<AuthViewModel>(
            create: (_) => AuthViewModel(repository: MockAuthRepository()),
          ),
      if (provideAuth) workspaceContextProvider(),
      ...cloudChatTestProviders(
        repository: cloudRepository,
        draftStore: draftStore,
      ),
      ChangeNotifierProvider<ApiKeysViewModel>(
        create: (_) => ApiKeysViewModel(
          repository: MockApiKeysRepository(latency: Duration.zero),
        )..load(),
      ),
      ChangeNotifierProvider<AuthSourcesViewModel>(
        create: (_) => AuthSourcesViewModel(
          repository: MockAuthSourcesRepository(latency: Duration.zero),
        )..load(),
      ),
      ChangeNotifierProvider<TwoFactorViewModel>(
        create: (_) => TwoFactorViewModel(
          repository: MockTwoFactorRepository(latency: Duration.zero),
          issuer: 'Test',
        )..load(),
      ),
      ChangeNotifierProvider<OrgViewModel>(
        create: (_) =>
            OrgViewModel(repository: MockOrgRepository(latency: Duration.zero)),
      ),
      ChangeNotifierProvider<RemoteControlViewModel>(
        create: (_) => RemoteControlViewModel(
          repository:
              remoteRepository ??
              MockRemoteControlRepository(latency: Duration.zero),
        ),
      ),
      // Account's Usage limits row reads the shell's plan usage source.
      buildProviderUsageSourceProvider(),
      ...settingsRootTestProviders(),
    ];

    Widget buildSubject({
      HomeTabController? tabController,
      RemoteControlRepository? remoteRepository,
      CloudChatRepository? cloudRepository,
      ChatDraftStore? draftStore,
      AuthViewModel? auth,
      bool provideAuth = true,
      ThemeMode themeMode = ThemeMode.system,
      DesktopAppPromptController? desktopApp,
      ChatDestinationStore? chatDestinationStore,
      Widget home = const HomeShell(
        refreshActivity: refreshActivityFeed,
        activityAccount: watchActivityAccount,
      ),
    }) {
      return MultiProvider(
        providers: [
          if (desktopApp != null)
            ChangeNotifierProvider<DesktopAppPromptController>.value(
              value: desktopApp,
            ),
          ChangeNotifierProvider<HomeTabController>(
            create: (_) =>
                tabController ?? HomeTabController(tabs: organizationHomeTabs),
          ),
          if (chatDestinationStore != null)
            Provider<ChatDestinationStore>.value(value: chatDestinationStore),
          ...accountScopedProviders(
            remoteRepository: remoteRepository,
            cloudRepository: cloudRepository,
            draftStore: draftStore,
            auth: auth,
            provideAuth: provideAuth,
          ),
          // Org-scoped view models: only the organization shell mounts these.
          ChangeNotifierProvider<FeedViewModel>(
            create: (_) =>
                FeedViewModel(repository: MockFeedRepository())..loadFeed(),
          ),
          ChangeNotifierProvider<StatsViewModel>(
            create: (_) =>
                StatsViewModel(repository: MockStatsRepository())..loadUsage(),
          ),
          ChangeNotifierProvider<MembersViewModel>(
            create: (_) =>
                MembersViewModel(repository: MockMembersRepository())..load(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: themeMode,
          home: home,
        ),
      );
    }

    testWidgets(
      'Activity offers Remote Control setup once the probe finds no pairing '
      '(CAN-3715)',
      (tester) async {
        final tabs = HomeTabController(tabs: organizationHomeTabs);
        await tester.pumpWidget(
          buildSubject(
            tabController: tabs,
            remoteRepository: FakeRemoteControlRepository(),
          ),
        );
        tabs.select(HomeTab.activity);
        await tester.pumpAndSettle();

        expect(
          find.text('Connect Remote Control to open chats from notifications.'),
          findsOneWidget,
        );
        await tester.tap(find.text('Connect'));
        await tester.pumpAndSettle();
        expect(tabs.value, HomeTab.remote);
      },
    );

    testWidgets(
      'Activity hides the Remote Control prompt while connected (CAN-3715)',
      (tester) async {
        final tabs = HomeTabController(tabs: organizationHomeTabs);
        await tester.pumpWidget(
          buildSubject(
            tabController: tabs,
            remoteRepository: _ConnectedRemoteRepository(),
          ),
        );
        tabs.select(HomeTab.activity);
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('activity-connect-remote-control')),
          findsNothing,
        );
      },
    );

    testWidgets(
      'Activity offers Remote Control setup when the probe answers, not '
      'before (CAN-3715)',
      (tester) async {
        final probe = Completer<RemoteConnection?>();
        final tabs = HomeTabController(tabs: organizationHomeTabs);
        await tester.pumpWidget(
          buildSubject(
            tabController: tabs,
            remoteRepository: _DeferredProbeRemoteRepository(probe.future),
          ),
        );
        tabs.select(HomeTab.activity);
        // The pending probe keeps a progress indicator running, so frames are
        // pumped explicitly until it answers.
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        final notice = find.byKey(
          const ValueKey('activity-connect-remote-control'),
        );
        expect(notice, findsNothing);

        probe.complete(null);
        await tester.pumpAndSettle();
        expect(notice, findsOneWidget);
      },
    );

    testWidgets('Activity hides the Remote Control prompt without a Remote tab '
        '(CAN-3715)', (tester) async {
      final tabs = HomeTabController(
        tabs: [
          for (final tab in organizationHomeTabs)
            if (tab != HomeTab.remote) tab,
        ],
      );
      await tester.pumpWidget(
        buildSubject(
          tabController: tabs,
          remoteRepository: FakeRemoteControlRepository(),
        ),
      );
      tabs.select(HomeTab.activity);
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('activity-connect-remote-control')),
        findsNothing,
      );
    });

    testWidgets(
      'Activity follows the current account and its Personal action without '
      'rebuilding its screen (CAN-3715)',
      (tester) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        Future<AuthViewModel> signedIn(String? personalOrganizationId) async {
          final auth = AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
            loadOrganizations: () async => AccountOrganizations(
              organizations: workspaceContextOrganizations(),
              personalOrganizationId: personalOrganizationId,
            ),
          );
          addTearDown(auth.dispose);
          await tester.runAsync(
            () => auth.signIn(email: 'a@b.dev', password: 'password'),
          );
          return auth;
        }

        final teamsOnly = await signedIn(null);
        teamsOnly.switchOrg(workspaceContextOrgA);
        final withPersonal = await signedIn('org-personal');
        withPersonal.switchOrg(workspaceContextOrgB);
        final tabs = HomeTabController(
          tabs: organizationHomeTabs,
          initialTab: HomeTab.activity,
        );
        await tester.pumpWidget(
          buildSubject(auth: teamsOnly, tabController: tabs),
        );
        await tester.pumpAndSettle();
        FeedScreen feed() => tester.widget<FeedScreen>(find.byType(FeedScreen));
        final screen = tester.state(find.byType(FeedScreen));
        final scrollable = find
            .descendant(
              of: find.byType(FeedScreen),
              matching: find.byType(Scrollable),
            )
            .first;
        double scrolled() =>
            tester.state<ScrollableState>(scrollable).position.extentBefore;
        expect(feed().organizationName, 'Acme');
        expect(feed().onViewPersonal, isNull);
        await tester.dragFrom(const Offset(140, 500), const Offset(0, -200));
        await tester.pumpAndSettle();
        final reading = scrolled();
        expect(reading, greaterThan(0));

        // The account selects another team.
        teamsOnly.switchOrg(workspaceContextOrgB);
        await tester.pump();
        expect(feed().organizationName, 'Bluebird');

        // The composition replaces the account.
        await tester.pumpWidget(
          buildSubject(auth: withPersonal, tabController: tabs),
        );
        await tester.pump();
        expect(feed().organizationName, 'Bluebird');
        expect(feed().onViewPersonal, isNotNull);
        expect(tester.state(find.byType(FeedScreen)), same(screen));
        expect(scrolled(), reading);

        feed().onViewPersonal!();
        await tester.pump();
        expect(withPersonal.isPersonalActive, isTrue);
        expect(teamsOnly.activeOrgId, workspaceContextOrgB);
        expect(tester.takeException(), isNull);
      },
    );

    /// The no-organization shell, built WITHOUT the org-scoped view models: if
    /// it ever reaches for one, the missing provider fails the test rather
    /// than silently rendering mock data to a real signed-in user.
    Widget buildNoOrganizationSubject({HomeTabController? tabController}) {
      return MultiProvider(
        providers: [
          ChangeNotifierProvider<HomeTabController>(
            create: (_) =>
                tabController ??
                HomeTabController(
                  tabs: noOrganizationHomeTabs,
                  initialTab: noOrganizationLandingTab,
                ),
          ),
          ...accountScopedProviders(),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: HomeShell(
            refreshActivity: refreshActivityFeed,
            activityAccount: watchActivityAccount,

            membersTab: Scaffold(
              appBar: AppBar(
                leading: const HomeMenuButton(),
                title: const Text('Members'),
              ),
              body: const Text('no-org members tab'),
            ),
          ),
        ),
      );
    }

    Future<void> openNavigationMenu(WidgetTester tester) async {
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
    }

    testWidgets(
      'CAN-4429 Recents follow the context, and a switch closes the hosted '
      'chat without dropping Remote Control',
      (tester) async {
        tester.view.physicalSize = _phone * 3;
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
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
        final repository = _ContextRemoteRepository();
        await tester.pumpWidget(
          buildSubject(
            auth: auth,
            remoteRepository: repository,
            cloudRepository: FakeCloudChatRepository(
              workspaces: [sampleWorkspace(chats: [])],
            ),
            tabController: HomeTabController(
              tabs: organizationHomeTabs,
              initialTab: HomeTab.remote,
            ),
            // The authenticated gate keys the shell by context.
            home: Consumer<WorkspaceContext>(
              builder: (context, workspaceContext, _) => KeyedSubtree(
                key: ValueKey(workspaceContext),
                child: const HomeShell(
                  refreshActivity: refreshActivityFeed,
                  activityAccount: watchActivityAccount,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        Finder inDrawer(String text) => find.descendant(
          of: find.byKey(const ValueKey('home-navigation-drawer')),
          matching: find.text(text),
        );
        final remote = tester
            .element(find.byType(HomeShell))
            .read<RemoteControlViewModel>();
        expect(remote.isConnected, isTrue);
        final connection = remote.connection;

        await openNavigationMenu(tester);
        expect(inDrawer('Personal task chat'), findsOneWidget);
        expect(inDrawer('Loose chat'), findsOneWidget);
        expect(inDrawer('Acme task chat'), findsNothing);
        expect(inDrawer('Acme chat'), findsNothing);
        expect(inDrawer('Orphan chat'), findsNothing);

        await tester.tap(inDrawer('Personal task chat'));
        await tester.pumpAndSettle();
        expect(find.byType(RemoteChatScreen), findsOneWidget);

        await openNavigationMenu(tester);
        await tester.tap(
          find.byKey(const ValueKey('home-workspace-context-row')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Acme'));
        await tester.pumpAndSettle();

        // The Personal chat closed; the shell shows its landing draft.
        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(find.byType(CloudChatScreen), findsOneWidget);
        expect(identical(remote.connection, connection), isTrue);
        expect(remote.isConnected, isTrue);

        await openNavigationMenu(tester);
        expect(inDrawer('Acme task chat'), findsOneWidget);
        expect(inDrawer('Acme chat'), findsOneWidget);
        expect(inDrawer('Personal task chat'), findsNothing);
        expect(inDrawer('Loose chat'), findsNothing);
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree_chat_summaries',
                chatSummaries: remote.allChatSummaries,
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('home-workspace-context-row')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Bluebird'));
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);
        expect(inDrawer('No recent chats in Bluebird.'), findsOneWidget);
        expect(inDrawer('Acme task chat'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'CAN-4429 a membership reload closes a pushed chat from the previous '
      'context without dropping Remote Control',
      (tester) async {
        tester.view.physicalSize = _phone * 3;
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        final store = InMemoryWorkspaceContextStore();
        await store.write(
          'mock-user',
          const WorkspaceContext.organization(workspaceContextOrgA),
        );
        // Signing in fails to load memberships; each reload then waits for
        // the test to settle its own request.
        var signedIn = false;
        final loads = <Completer<List<OrganizationSummary>>>[];
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          workspaceContextStore: store,
          loadOrganizations: teamsOnly(() {
            if (!signedIn) return Future.error(Exception('offline'));
            final load = Completer<List<OrganizationSummary>>();
            loads.add(load);
            return load.future;
          }),
        );
        addTearDown(auth.dispose);
        await tester.runAsync(
          () => auth.signIn(email: 'a@b.dev', password: 'password'),
        );
        signedIn = true;
        expect(auth.organizationsLoadFailed, isTrue);
        expect(auth.workspaceContext, const WorkspaceContext.personal());

        final repository = _ContextRemoteRepository();
        await tester.pumpWidget(
          buildSubject(
            auth: auth,
            remoteRepository: repository,
            tabController: HomeTabController(
              tabs: organizationHomeTabs,
              initialTab: HomeTab.remote,
            ),
            // The authenticated gate keys the shell by context.
            home: Consumer<WorkspaceContext>(
              builder: (context, workspaceContext, _) => KeyedSubtree(
                key: ValueKey(workspaceContext),
                child: const HomeShell(
                  refreshActivity: refreshActivityFeed,
                  activityAccount: watchActivityAccount,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final remote = tester
            .element(find.byType(HomeShell))
            .read<RemoteControlViewModel>();
        expect(remote.isConnected, isTrue);
        final connection = remote.connection;

        Future<void> reload(
          void Function(Completer<List<OrganizationSummary>> load) settle,
        ) async {
          final reloading = auth.reloadOrganizations();
          await tester.pump();
          settle(loads.last);
          await reloading;
          await tester.pumpAndSettle();
        }

        // Retry starts while Personal is active; a Personal chat opens before
        // the memberships arrive and restore the saved organization.
        // Bounded pumps keep the held request inside its load timeout.
        final retry = auth.reloadOrganizations();
        await tester.pump();
        await tester.tap(find.text('Loose chat'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(RemoteChatScreen), findsOneWidget);
        expect(auth.isLoadingOrganizations, isTrue);
        loads.last.complete(workspaceContextOrganizations());
        await retry;
        await tester.pumpAndSettle();
        expect(
          auth.workspaceContext,
          const WorkspaceContext.organization(workspaceContextOrgA),
        );
        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(find.text('Acme task'), findsOneWidget);

        // A failed reload falls back to Personal and closes the Acme chat.
        await tester.tap(find.text('Acme task'));
        await tester.pumpAndSettle();
        expect(find.byType(RemoteChatScreen), findsOneWidget);
        await reload((load) => load.completeError(Exception('offline')));
        expect(auth.workspaceContext, const WorkspaceContext.personal());
        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(find.text('Loose chat'), findsOneWidget);

        // Losing the membership falls back to Personal the same way.
        await reload((load) => load.complete(workspaceContextOrganizations()));
        expect(
          auth.workspaceContext,
          const WorkspaceContext.organization(workspaceContextOrgA),
        );
        await tester.tap(find.text('Acme task'));
        await tester.pumpAndSettle();
        expect(find.byType(RemoteChatScreen), findsOneWidget);
        await reload(
          (load) => load.complete([
            workspaceContextOrganization(workspaceContextOrgB, 'Bluebird'),
          ]),
        );
        expect(auth.workspaceContext, const WorkspaceContext.personal());
        expect(find.byType(RemoteChatScreen), findsNothing);

        expect(identical(remote.connection, connection), isTrue);
        expect(remote.isConnected, isTrue);
        expect(repository.disconnectCalls, 0);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'CAN-4429 the drawer shows the Personal context below the wordmark',
      (tester) async {
        tester.view.physicalSize = _phone * 3;
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
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
        await tester.pumpWidget(
          buildSubject(
            auth: auth,
            tabController: HomeTabController(
              tabs: organizationHomeTabs,
              initialTab: HomeTab.remote,
            ),
          ),
        );
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);

        final row = find.byKey(const ValueKey('home-workspace-context-row'));
        expect(row, findsOneWidget);
        expect(
          find.descendant(of: row, matching: find.text('Personal')),
          findsOneWidget,
        );
        final brand = tester.getRect(
          find.byKey(const ValueKey('home-navigation-brand')),
        );
        final remote = tester.getRect(
          find.byKey(const ValueKey('home-nav-remote')),
        );
        final context = tester.getRect(row);
        expect(context.top, greaterThanOrEqualTo(brand.bottom));
        expect(context.bottom, lessThanOrEqualTo(remote.top));
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('remote-only shell builds without account state', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          tabController: HomeTabController(tabs: const [HomeTab.remote]),
          provideAuth: false,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(HomeShell), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    /// Opens [tab] the way a user would: from its drawer row, from the
    /// Settings cog for Account, or from the cog and then Account's row for a
    /// Settings destination (CAN-3558). Backs out of a Settings destination
    /// first, since it shows a back button instead of the menu button.
    Future<void> openDestination(WidgetTester tester, HomeTab tab) async {
      final back = find.byTooltip('Back');
      if (back.evaluate().isNotEmpty) {
        await tester.tap(back);
        await tester.pumpAndSettle();
      }
      await openNavigationMenu(tester);
      final fromAccount = settingsHomeTabs.contains(tab);
      await tester.tap(
        find.byKey(
          ValueKey(
            tab == HomeTab.account || fromAccount
                ? 'home-settings-button'
                : 'home-nav-${tab.name}',
          ),
        ),
      );
      await tester.pumpAndSettle();
      if (fromAccount) {
        await tester.tap(find.byKey(ValueKey('account-nav-${tab.name}')));
        await tester.pumpAndSettle();
      }
    }

    for (final dark in [false, true]) {
      testWidgets(
        'root app bars and drawer navigation ${dark ? "dark" : "light"}',
        (tester) async {
          tester.view.physicalSize = _phone;
          tester.view.devicePixelRatio = 1;
          tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
          addTearDown(tester.view.reset);
          final stage = Platform.environment['ROOT_BARS_STAGE'];
          if (stage != null) {
            await (FontLoader('Inter')..addFont(
                  rootBundle.load('assets/fonts/inter/InterVariable.ttf'),
                ))
                .load();
            await (FontLoader('MaterialIcons')
                  ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf')))
                .load();
          }
          tester.platformDispatcher.platformBrightnessTestValue = dark
              ? Brightness.dark
              : Brightness.light;
          addTearDown(
            tester.platformDispatcher.clearPlatformBrightnessTestValue,
          );
          await tester.pumpWidget(buildSubject());
          await tester.pumpAndSettle();
          for (final tab in ['activity', 'members', 'account', 'usage']) {
            await openDestination(tester, HomeTab.values.byName(tab));
            if (stage != null && tab != 'usage') {
              await expectLater(
                find.byType(HomeShell),
                matchesGoldenFile(
                  '../../../../../../../.playwright/mobile-root-app-bars/$tab-$stage-${dark ? "dark" : "light"}.png',
                ),
              );
            }
            if (stage != 'before') {
              if (tab == 'activity' || tab == 'members') {
                final glyphs = tester
                    .widgetList<CanopyIconButton>(
                      find.descendant(
                        of: find.byType(CanopyAppBar),
                        matching: find.byType(CanopyIconButton),
                      ),
                    )
                    .map((button) => button.glyph);
                expect(
                  glyphs,
                  containsAll(
                    tab == 'activity'
                        ? [CanopyGlyph.filter1]
                        : [
                            CanopyGlyph.userAdd,
                            CanopyGlyph.dotGrid1x3Horizontal,
                          ],
                  ),
                );
              }
              expect(
                find.byType(CanopyAppBar),
                tab == 'usage' ? findsNothing : findsOneWidget,
              );
            }
            expect(tester.takeException(), isNull);
          }
        },
      );
    }

    group('Get the desktop app (CAN-4424)', () {
      final entry = find.byKey(const ValueKey('home-nav-desktop-app'));
      final sheet = find.byKey(const ValueKey('desktop-app-prompt-sheet'));

      Future<AuthViewModel> signedIn(WidgetTester tester) async {
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
        );
        addTearDown(auth.dispose);
        await tester.runAsync(
          () => auth.signIn(email: 'a@b.dev', password: 'password'),
        );
        return auth;
      }

      DesktopAppPromptController controller({DesktopAppPromptStore? store}) =>
          DesktopAppPromptController(
            store: store ?? InMemoryDesktopAppPromptStore(),
            isActive: () => true,
            downloadUrl: () => 'https://production.test/download',
            sharer: _NoShare(),
            showPrompt: showDesktopAppPromptSheet,
          );

      /// The shell as production mounts it: under the binding that publishes
      /// the account and pairing state.
      Future<void> pumpShell(
        WidgetTester tester, {
        required DesktopAppPromptController desktopApp,
        required RemoteControlRepository remoteRepository,
        ThemeMode themeMode = ThemeMode.light,
        bool settle = true,
      }) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          buildSubject(
            auth: await signedIn(tester),
            desktopApp: desktopApp,
            remoteRepository: remoteRepository,
            themeMode: themeMode,
            home: const DesktopAppPromptBinding(
              child: HomeShell(
                refreshActivity: refreshActivityFeed,
                activityAccount: watchActivityAccount,
              ),
            ),
          ),
        );
        if (settle) await tester.pumpAndSettle();
      }

      for (final themeMode in [ThemeMode.light, ThemeMode.dark]) {
        testWidgets('offers it with no desktop paired and opens the prompt '
            '(${themeMode.name} theme)', (tester) async {
          await pumpShell(
            tester,
            desktopApp: controller(),
            remoteRepository: FakeRemoteControlRepository(),
            themeMode: themeMode,
          );
          await openNavigationMenu(tester);
          expect(entry, findsOneWidget);
          expect(find.text('Get the desktop app'), findsOneWidget);
          expect(tester.takeException(), isNull);

          await tester.tap(entry);
          await tester.pumpAndSettle();

          expect(sheet, findsOneWidget);
          expect(
            find.byKey(const ValueKey('home-navigation-drawer')),
            findsNothing,
          );
        });
      }

      testWidgets('opens the prompt even after it was closed before', (
        tester,
      ) async {
        final store = InMemoryDesktopAppPromptStore();
        final desktopApp = controller(store: store);
        await pumpShell(
          tester,
          desktopApp: desktopApp,
          remoteRepository: FakeRemoteControlRepository(),
        );
        await openNavigationMenu(tester);
        await tester.tap(entry);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('desktop-app-prompt-not-now')),
        );
        await tester.pumpAndSettle();
        expect(sheet, findsNothing);

        await openNavigationMenu(tester);
        await tester.tap(entry);
        await tester.pumpAndSettle();
        expect(sheet, findsOneWidget);
      });

      testWidgets('hides it with a paired desktop', (tester) async {
        await pumpShell(
          tester,
          desktopApp: controller(),
          remoteRepository: _ConnectedRemoteRepository(),
        );
        await openNavigationMenu(tester);
        expect(find.byKey(const ValueKey('home-nav-remote')), findsOneWidget);
        expect(entry, findsNothing);
      });

      testWidgets('hides it until the pairing probe answers', (tester) async {
        final probe = Completer<RemoteConnection?>();
        await pumpShell(
          tester,
          desktopApp: controller(),
          remoteRepository: _DeferredProbeRemoteRepository(probe.future),
          settle: false,
        );
        // The pending probe keeps a progress indicator running, so frames
        // are pumped explicitly until it answers.
        await tester.pump();
        await tester.tap(find.byTooltip('Open navigation menu'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        expect(entry, findsNothing);

        probe.complete(null);
        await tester.pumpAndSettle();
        expect(entry, findsOneWidget);
      });

      testWidgets('removes it once a desktop is paired', (tester) async {
        await pumpShell(
          tester,
          desktopApp: controller(),
          remoteRepository: FakeRemoteControlRepository(),
        );
        await openNavigationMenu(tester);
        expect(entry, findsOneWidget);

        final remote = tester
            .element(find.byType(HomeShell))
            .read<RemoteControlViewModel>();
        await tester.runAsync(() => remote.connect('123456'));
        await tester.pumpAndSettle();

        expect(entry, findsNothing);
      });

      testWidgets('is absent when the prompt is not provided', (tester) async {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);
        expect(entry, findsNothing);
      });
    });

    testWidgets('replaces the bottom bar with a navigation drawer', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.byType(NavigationBar), findsNothing);
      expect(find.text('Cloud chats'), findsOneWidget);
      expect(find.byTooltip('Open navigation menu'), findsOneWidget);

      await openNavigationMenu(tester);

      expect(
        find.byKey(const ValueKey('home-navigation-drawer')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('home-nav-cloud')), findsOneWidget);
      expect(find.byKey(const ValueKey('home-nav-remote')), findsOneWidget);
      expect(find.text('Remote control'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('home-settings-button')),
        findsOneWidget,
      );
    });

    testWidgets('switches screens from the drawer and closes it', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await openNavigationMenu(tester);
      await tester.tap(find.byKey(const ValueKey('home-nav-remote')));
      await tester.pumpAndSettle();

      expect(find.text('Remote Control'), findsOneWidget);
      expect(find.byTooltip('Open navigation menu'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('home-navigation-drawer')),
        findsNothing,
      );
    });

    testWidgets(
      'CAN-3150 defers automatic overview reconciliation off Remote',
      (tester) async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = initialOverview;
        addTearDown(repository.eventsController.close);
        await tester.pumpWidget(buildSubject(remoteRepository: repository));
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);
        await tester.tap(find.byKey(const ValueKey('home-nav-remote')));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), '123456');
        await tester.pump();
        await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
        await tester.pumpAndSettle();
        final vm = tester
            .element(find.byType(HomeShell))
            .read<RemoteControlViewModel>();
        expect(vm.isConnected, isTrue);
        final fetches = repository.snapshotFetches;
        // A shell delta without a cursor needs reconciliation, but leaving
        // the tab must defer its timer. SSE continues updating the hidden
        // Remote state.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateDeltaEvent(
                requiresOverviewRefresh: true,
                scope: 'worktree',
              ),
            ],
            nextCursor: 3,
          ),
        );
        await tester.pump();
        await openNavigationMenu(tester);
        await tester.tap(find.byKey(const ValueKey('home-nav-cloud')));
        await tester.pumpAndSettle();
        for (var second = 0; second < 60; second += 2) {
          repository.eventsController.add(
            overviewBatch(
              type: 'portal.state.delta',
              scope: 'worktree',
              entities: [
                {
                  'entityType': 'worktree',
                  'localId': 'wt-1',
                  'payload': overviewWorktree(state: 'merged'),
                },
              ],
            ),
          );
          await tester.pump(const Duration(seconds: 2));
        }
        expect(repository.snapshotFetches, fetches);
        expect(vm.allWorktrees.single.prStatuses.single.state, 'merged');
        expect(repository.pauseEventsCalls, 0);
        await openNavigationMenu(tester);
        await tester.tap(find.byKey(const ValueKey('home-nav-remote')));
        await tester.pumpAndSettle();
        await tester.pump(kRemoteStateRefreshDebounce);
        expect(repository.snapshotFetches, fetches + 1);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );

    testWidgets('slides the content aside so the menu sits underneath', (
      tester,
    ) async {
      tester.view.physicalSize = _phone;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(tester.getTopLeft(find.byType(IndexedStack)).dx, 0);

      await openNavigationMenu(tester);

      // The menu is pinned at the left edge and the content card has moved
      // right to reveal it, with a tinted scrim covering the card.
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('home-navigation-drawer'))),
        Offset.zero,
      );
      expect(tester.getTopLeft(find.byType(IndexedStack)).dx, greaterThan(0));
      expect(find.byKey(const ValueKey('home-menu-scrim')), findsOneWidget);
    });

    testWidgets(
      'caches the tab content in its own layer while the menu animates',
      (tester) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);

        // The content card is translated every frame of the 300ms slide. A
        // repaint boundary between the moving clip and the tab content lets
        // the raster cache reuse the content picture instead of re-drawing
        // every screen (and its blurred app bar) per frame.
        final contentSlot = find.byKey(const ValueKey('home-content-slot'));
        final boundary = find.descendant(
          of: contentSlot,
          matching: find.byKey(const ValueKey('home-content-repaint-boundary')),
        );
        expect(boundary, findsOneWidget);
        expect(tester.widget(boundary), isA<RepaintBoundary>());
        expect(
          find.descendant(of: boundary, matching: find.byType(IndexedStack)),
          findsOneWidget,
        );
        // The rounded clip must not force an extra offscreen save layer for
        // the whole card on top of that.
        final clip = tester.widget<ClipRRect>(
          find.descendant(of: contentSlot, matching: find.byType(ClipRRect)),
        );
        expect(clip.clipBehavior, Clip.antiAlias);
      },
    );

    testWidgets(
      'paints the open-menu tint as the rounded card decoration, not a rect',
      (tester) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(buildSubject(themeMode: ThemeMode.dark));
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);

        // Impeller does not clip content painted after a BackdropFilter (the
        // app bar) to a rounded ClipRRect unless the whole card goes through a
        // save layer, so a full-rect scrim child leaks into the corners. The
        // tint must therefore come from the rounded foreground decoration,
        // whose shape does not depend on the clip.
        final contentSlot = find.byKey(const ValueKey('home-content-slot'));
        final card = tester.widget<DecoratedBox>(
          find
              .descendant(of: contentSlot, matching: find.byType(DecoratedBox))
              .first,
        );
        expect(card.position, DecorationPosition.foreground);
        final decoration = card.decoration as BoxDecoration;
        expect(decoration.borderRadius, isNotNull);
        expect(decoration.color, isNotNull);
        expect(decoration.color!.a, greaterThan(0));

        // The scrim keeps its hit target but paints nothing of its own.
        final scrim = find.byKey(const ValueKey('home-menu-scrim'));
        expect(scrim, findsOneWidget);
        expect(
          find.descendant(of: scrim, matching: find.byType(ColoredBox)),
          findsNothing,
        );
      },
    );

    for (final mode in [ThemeMode.light, ThemeMode.dark]) {
      for (final tab in [HomeTab.activity, HomeTab.members, HomeTab.remote]) {
        testWidgets(
          'open card corners reveal the menu background in ${mode.name} on ${tab.name}',
          (tester) async {
            tester.view.physicalSize = _phone;
            tester.view.devicePixelRatio = 1;
            addTearDown(tester.view.reset);
            final boundaryKey = GlobalKey();
            await tester.pumpWidget(
              RepaintBoundary(
                key: boundaryKey,
                child: buildSubject(
                  themeMode: mode,
                  tabController: HomeTabController(
                    tabs: organizationHomeTabs,
                    initialTab: tab,
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            if (settingsHomeTabs.contains(tab)) {
              // Settings destinations show a back button (CAN-3558); the menu
              // is still one edge swipe away.
              await tester.dragFrom(const Offset(1, 300), const Offset(320, 0));
              await tester.pumpAndSettle();
            } else {
              await openNavigationMenu(tester);
            }
            final boundary =
                boundaryKey.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final image = (await tester.runAsync(() => boundary.toImage()))!;
            final pixels = (await tester.runAsync(
              () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
            ))!;
            addTearDown(image.dispose);
            int pixel(int x, int y) =>
                pixels.getUint32((y * image.width + x) * 4);
            // Outside both rounded left corners, just past the menu panel's
            // right edge, must match the exposed menu immediately to the left.
            for (final y in [2, 841]) {
              expect(
                pixel(328, y),
                pixel(320, y),
                reason: 'No rectangular backdrop outside the card at y=$y',
              );
            }
          },
        );
      }
    }

    testWidgets('tapping the dimmed content card closes the menu', (
      tester,
    ) async {
      tester.view.physicalSize = _phone;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await openNavigationMenu(tester);
      // Only a narrow sliver of the card peeks in from the right edge, so tap
      // inside that visible strip the way a user would.
      await tester.tapAt(Offset(_phone.width - 20, _phone.height / 2));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('home-navigation-drawer')),
        findsNothing,
      );
      expect(tester.getTopLeft(find.byType(IndexedStack)).dx, 0);
    });

    testWidgets('shows the menu button on every top-level screen', (
      tester,
    ) async {
      final controller = HomeTabController(tabs: organizationHomeTabs);
      await tester.pumpWidget(buildSubject(tabController: controller));
      await tester.pumpAndSettle();

      for (final tab in organizationHomeTabs) {
        controller.select(tab);
        await tester.pumpAndSettle();
        // Settings destinations go back to Account instead (CAN-3558).
        final fromAccount = settingsHomeTabs.contains(tab);
        expect(
          find.byTooltip('Open navigation menu'),
          fromAccount ? findsNothing : findsOneWidget,
          reason: '${tab.name} should expose the navigation drawer',
        );
        expect(
          find.byTooltip('Back'),
          fromAccount ? findsOneWidget : findsNothing,
          reason: '${tab.name} back button',
        );
      }
    });

    testWidgets('closes the drawer when the tab changes programmatically', (
      tester,
    ) async {
      final controller = HomeTabController(tabs: organizationHomeTabs);
      await tester.pumpWidget(buildSubject(tabController: controller));
      await tester.pumpAndSettle();

      await openNavigationMenu(tester);
      expect(
        find.byKey(const ValueKey('home-navigation-drawer')),
        findsOneWidget,
      );

      controller.select(HomeTab.usage);
      await tester.pumpAndSettle();

      expect(controller.value, HomeTab.usage);
      expect(
        find.byKey(const ValueKey('home-navigation-drawer')),
        findsNothing,
      );
    });

    testWidgets(
      'closes the drawer when the selected tab is requested programmatically',
      (tester) async {
        final controller = HomeTabController(tabs: organizationHomeTabs);
        await tester.pumpWidget(buildSubject(tabController: controller));
        await tester.pumpAndSettle();

        await openNavigationMenu(tester);
        expect(
          find.byKey(const ValueKey('home-navigation-drawer')),
          findsOneWidget,
        );

        controller.select(HomeTab.activity);
        await tester.pumpAndSettle();

        expect(controller.value, HomeTab.activity);
        expect(
          find.byKey(const ValueKey('home-navigation-drawer')),
          findsNothing,
        );
        // Selecting Activity reloads it (CAN-3715); let the mock answer.
        await tester.pump(const Duration(seconds: 1));
      },
    );

    testWidgets(
      'removes the covered content from semantics and focus traversal',
      (tester) async {
        final semantics = tester.ensureSemantics();
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        await openNavigationMenu(tester);

        expect(find.bySemanticsLabel('Open navigation menu'), findsNothing);
        final contentFocusScope = find.byKey(
          const ValueKey('home-content-focus-scope'),
        );
        expect(contentFocusScope, findsOneWidget);
        expect(
          tester.widget<FocusScope>(contentFocusScope).canRequestFocus,
          isFalse,
        );
        semantics.dispose();
      },
    );

    testWidgets('opens the drawer with a swipe from the left edge', (
      tester,
    ) async {
      tester.view.physicalSize = _phone;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.dragFrom(const Offset(1, 300), const Offset(320, 0));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('home-navigation-drawer')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('home-nav-remote')), findsOneWidget);
    });

    testWidgets(
      'opens the drawer from the left edge over the Usage tab pager',
      (tester) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);
        final controller = HomeTabController(
          tabs: organizationHomeTabs,
          initialTab: HomeTab.usage,
        );

        await tester.pumpWidget(buildSubject(tabController: controller));
        await tester.pumpAndSettle();
        expect(find.byType(TabBarView), findsOneWidget);

        await tester.dragFrom(const Offset(1, 300), const Offset(320, 0));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('home-navigation-drawer')),
          findsOneWidget,
        );
      },
    );

    for (final startX in [1.0, 140.0]) {
      testWidgets(
        'first swipe from $startX tracks across frames and opens fully',
        (tester) async {
          tester.view.physicalSize = _phone;
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.reset);
          await tester.pumpWidget(buildSubject());
          await tester.pumpAndSettle();

          final gesture = await tester.startGesture(Offset(startX, 300));
          await gesture.moveBy(const Offset(25, 0));
          await tester.pump(const Duration(milliseconds: 16));
          await gesture.moveBy(const Offset(20, 0));
          await tester.pump(const Duration(milliseconds: 16));
          final firstOffset = tester.getTopLeft(find.byType(IndexedStack)).dx;
          expect(firstOffset, greaterThan(0));
          for (var i = 0; i < 8; i++) {
            await gesture.moveBy(const Offset(20, 0));
            await tester.pump(const Duration(milliseconds: 16));
          }
          expect(
            tester.getTopLeft(find.byType(IndexedStack)).dx,
            greaterThan(firstOffset + 140),
          );
          await gesture.up();
          await tester.pumpAndSettle();
          expect(tester.getTopLeft(find.byType(IndexedStack)).dx, 326);

          // The same recognizer also tracks a closing drag across rebuilds.
          final close = await tester.startGesture(const Offset(370, 300));
          for (var i = 0; i < 12; i++) {
            await close.moveBy(const Offset(-25, 0));
            await tester.pump(const Duration(milliseconds: 16));
          }
          await close.up();
          await tester.pumpAndSettle();
          expect(tester.getTopLeft(find.byType(IndexedStack)).dx, 0);
        },
      );
    }

    testWidgets(
      'short swipe settles closed and vertical scrolling still works',
      (tester) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        // The Activity feed is long enough to scroll.
        await tester.pumpWidget(
          buildSubject(
            tabController: HomeTabController(
              tabs: organizationHomeTabs,
              initialTab: HomeTab.activity,
            ),
          ),
        );
        await tester.pumpAndSettle();

        final gesture = await tester.startGesture(const Offset(140, 300));
        await gesture.moveBy(const Offset(25, 0));
        await tester.pump(const Duration(milliseconds: 16));
        await gesture.moveBy(const Offset(40, 0));
        await tester.pump(const Duration(milliseconds: 500));
        await gesture.up();
        await tester.pumpAndSettle();
        expect(tester.getTopLeft(find.byType(IndexedStack)).dx, 0);

        final scrollable = find
            .descendant(
              of: find.byType(IndexedStack),
              matching: find.byType(Scrollable),
            )
            .first;
        // Activity's scroll offsets start at the reader's row, so the
        // distance from the top shows the scroll.
        final before = tester
            .state<ScrollableState>(scrollable)
            .position
            .extentBefore;
        await tester.dragFrom(const Offset(140, 500), const Offset(0, -200));
        await tester.pumpAndSettle();
        final mountedPosition = tester
            .state<ScrollableState>(scrollable)
            .position;
        expect(mountedPosition.extentBefore, greaterThan(before));
        expect(tester.getTopLeft(find.byType(IndexedStack)).dx, 0);
      },
    );

    testWidgets('shows no staging banner even when staging is selected', (
      tester,
    ) async {
      configureEnvironment(ApiEnvironment.staging);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('stagingEnvironmentBanner')), findsNothing);
      expect(find.text('STAGING SERVER'), findsNothing);
    });

    testWidgets('programmatic tab selection switches the visible tab', (
      tester,
    ) async {
      final controller = HomeTabController(tabs: organizationHomeTabs);
      await tester.pumpWidget(buildSubject(tabController: controller));
      await tester.pumpAndSettle();

      controller.select(HomeTab.remote);
      await tester.pumpAndSettle();

      expect(find.text('Remote Control'), findsOneWidget);
    });

    group('Chat destination (CAN-2930)', () {
      late FakeCloudChatRepository cloud;

      setUp(() {
        cloud = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
      });

      Finder newChatButton() =>
          find.byKey(const ValueKey('home-new-chat-button'));
      Finder draft() => find.byKey(const ValueKey('cloud-new-chat-screen'));
      Finder conversation() => find.byKey(const ValueKey('cloud-chat-screen'));

      Future<HomeTabController> pumpShell(
        WidgetTester tester, {
        HomeTab initialTab = HomeTab.chat,
        List<HomeTab> tabs = organizationHomeTabs,
        ChatDraftStore? draftStore,
      }) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
        addTearDown(tester.view.reset);
        final controller = HomeTabController(
          tabs: tabs,
          initialTab: initialTab,
        );
        await tester.pumpWidget(
          buildSubject(
            tabController: controller,
            cloudRepository: cloud,
            draftStore: draftStore,
          ),
        );
        final list = tester
            .element(find.byType(HomeShell))
            .read<CloudChatsViewModel>();
        await list.load();
        await list.ensureModels();
        await tester.pumpAndSettle();
        return controller;
      }

      Future<void> sendFirstMessage(WidgetTester tester, String text) async {
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          text,
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();
      }

      testWidgets('lands on a new chat that leads with the menu button', (
        tester,
      ) async {
        await pumpShell(tester);

        expect(draft(), findsOneWidget);
        expect(find.byTooltip('Open navigation menu'), findsOneWidget);
        expect(find.byType(BackButton), findsNothing);
        // Opening the app must not throw the keyboard over the landing chat.
        expect(tester.testTextInput.isVisible, isFalse);
      });

      for (final scale in [1.0, 2.0]) {
        testWidgets(
          'chat draft survives folding, resizing and keyboard changes at $scale text',
          (tester) async {
            tester.platformDispatcher.textScaleFactorTestValue = scale;
            addTearDown(
              tester.platformDispatcher.clearTextScaleFactorTestValue,
            );
            await pumpShell(tester);
            final field = find.byKey(const ValueKey('composer-draft'));
            await tester.enterText(field, 'Keep this draft while resizing');
            final chatState = tester.state(find.byType(CloudChatScreen));

            // Representative outer/inner display, rotated and split-window sizes.
            // Insets are deliberately asymmetric; real values come from iOS.
            for (final size in [
              const Size(466, 678),
              const Size(890, 626),
              const Size(626, 890),
              const Size(320, 626),
              const Size(678, 466),
              _phone,
            ]) {
              for (final keyboard in [0.0, 300.0]) {
                tester.view.physicalSize = size;
                tester.view.viewPadding = const FakeViewPadding(
                  top: 24,
                  right: 64,
                  bottom: 24,
                );
                tester.view.padding = FakeViewPadding(
                  top: 24,
                  right: 64,
                  bottom: keyboard == 0 ? 24 : 0,
                );
                tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
                await tester.pumpAndSettle();

                expect(
                  tester.takeException(),
                  isNull,
                  reason: '$size with keyboard $keyboard',
                );
                expect(
                  tester.state(find.byType(CloudChatScreen)),
                  same(chatState),
                );
                expect(
                  find.text('Keep this draft while resizing'),
                  findsOneWidget,
                );
                final composer = tester.getRect(
                  find.byKey(const ValueKey('chat-composer')),
                );
                expect(composer.left, greaterThanOrEqualTo(0));
                expect(composer.right, lessThanOrEqualTo(size.width - 64));
                expect(
                  composer.bottom,
                  lessThanOrEqualTo(size.height - keyboard),
                );
                expect(
                  find.byKey(const ValueKey('composer-send')).hitTestable(),
                  findsOneWidget,
                );
                final draftViewport = find
                    .ancestor(
                      of: field,
                      matching: find.byType(SingleChildScrollView),
                    )
                    .first;
                expect(tester.getSize(draftViewport).height, greaterThan(16));
                await tester.tapAt(tester.getRect(draftViewport).center);
                expect(
                  tester
                      .widget<EditableText>(find.byType(EditableText))
                      .focusNode
                      .hasFocus,
                  isTrue,
                );
              }
            }
          },
        );
      }

      testWidgets('marks the mounted Chat screen inactive after navigation', (
        tester,
      ) async {
        await pumpShell(tester);
        final chatScreen = find.byType(CloudChatScreen, skipOffstage: false);
        expect(tester.widget<CloudChatScreen>(chatScreen).isActive, isTrue);

        await openNavigationMenu(tester);
        await tester.tap(find.byKey(const ValueKey('home-nav-cloud')));
        await tester.pumpAndSettle();

        expect(tester.widget<CloudChatScreen>(chatScreen).isActive, isFalse);
      });

      testWidgets('the landing chat loads its own project list', (
        tester,
      ) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        // No Cloud chats tab to load the list on the Chat screen's behalf.
        await tester.pumpWidget(
          buildSubject(
            tabController: HomeTabController(
              tabs: const [HomeTab.activity, HomeTab.chat],
              initialTab: HomeTab.chat,
            ),
            cloudRepository: cloud,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.descendant(
            of: find.byKey(const ValueKey('new-chat-project-pill')),
            matching: find.text('Mobile App'),
          ),
          findsOneWidget,
        );
      });

      testWidgets('pins the Chat button at the bottom left of the drawer, '
          'outside the scrolling menu', (tester) async {
        await pumpShell(tester, initialTab: HomeTab.cloud);
        await openNavigationMenu(tester);

        expect(newChatButton(), findsOneWidget);
        expect(
          find.descendant(of: newChatButton(), matching: find.text('Chat')),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('home-nav-chat')), findsNothing);
        expect(
          find.descendant(
            of: find.byType(Scrollable),
            matching: newChatButton(),
          ),
          findsNothing,
        );
        final drawer = tester.getRect(
          find.byKey(const ValueKey('home-navigation-drawer')),
        );
        final button = tester.getRect(newChatButton());
        // 32px from the drawer's left edge and from the top of the 34px
        // home-indicator inset.
        expect(button.left - drawer.left, 32);
        expect(button.bottom, drawer.bottom - 34 - 32);
      });

      for (final dark in [false, true]) {
        testWidgets('the pinned Chat action uses primary colors '
            '${dark ? 'dark' : 'light'}', (tester) async {
          tester.view.physicalSize = _phone;
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.reset);
          await tester.pumpWidget(
            buildSubject(
              tabController: HomeTabController(
                tabs: organizationHomeTabs,
                initialTab: HomeTab.cloud,
              ),
              cloudRepository: cloud,
              themeMode: dark ? ThemeMode.dark : ThemeMode.light,
            ),
          );
          await tester.pumpAndSettle();
          await openNavigationMenu(tester);

          final button = newChatButton();
          final colors = AppColors.of(tester.element(button));
          expect(tester.widget<Material>(button).color, colors.accent);
          expect(
            tester
                .widget<CanopyIcon>(
                  find.descendant(
                    of: button,
                    matching: find.byType(CanopyIcon),
                  ),
                )
                .tint,
            colors.onAccent,
          );
          expect(
            tester
                .widget<Text>(
                  find.descendant(of: button, matching: find.text('Chat')),
                )
                .style
                ?.color,
            colors.onAccent,
          );
        });
      }

      testWidgets('the Chat button opens the new chat and closes the drawer', (
        tester,
      ) async {
        final controller = await pumpShell(tester, initialTab: HomeTab.cloud);
        expect(draft(), findsNothing);

        await openNavigationMenu(tester);
        await tester.tap(newChatButton());
        await tester.pumpAndSettle();

        expect(controller.value, HomeTab.chat);
        expect(draft(), findsOneWidget);
        expect(
          find.byKey(const ValueKey('home-navigation-drawer')),
          findsNothing,
        );
      });

      testWidgets('an unsent draft keeps its text through the Chat button', (
        tester,
      ) async {
        await pumpShell(tester);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'half written',
        );
        await tester.pump();

        await openNavigationMenu(tester);
        await tester.tap(newChatButton());
        await tester.pumpAndSettle();

        expect(draft(), findsOneWidget);
        expect(find.text('half written'), findsOneWidget);
      });

      testWidgets(
        'starting a new chat keeps the unsent follow-up in its chat',
        (tester) async {
          final store = InMemoryChatDraftStore();
          await pumpShell(tester, draftStore: store);
          await sendFirstMessage(tester, 'first message');
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'unsent follow-up',
          );
          await tester.pump();

          await openNavigationMenu(tester);
          await tester.tap(newChatButton());
          await tester.pumpAndSettle();

          expect(find.text('Discard unsent message?'), findsNothing);
          expect(conversation(), findsNothing);
          expect(draft(), findsOneWidget);
          expect(find.text('unsent follow-up'), findsNothing);
          expect(
            store.state.drafts.entries
                .where((e) => e.key.startsWith('cloud:chat:'))
                .map((e) => e.value.text),
            ['unsent follow-up'],
          );
        },
      );

      testWidgets('the sent chat stays in place with the menu button, and '
          'Chat starts a fresh draft', (tester) async {
        await pumpShell(tester);

        await sendFirstMessage(tester, 'start something new');

        expect(cloud.createCalls, hasLength(1));
        expect(conversation(), findsOneWidget);
        expect(find.textContaining('start something new'), findsOneWidget);
        expect(find.byTooltip('Open navigation menu'), findsOneWidget);
        expect(find.byType(BackButton), findsNothing);

        await openNavigationMenu(tester);
        await tester.tap(newChatButton());
        await tester.pumpAndSettle();

        expect(conversation(), findsNothing);
        expect(draft(), findsOneWidget);
        expect(find.textContaining('start something new'), findsNothing);
        expect(find.byType(HomeShell), findsOneWidget);
      });

      testWidgets('archiving the in-shell chat returns to a fresh draft', (
        tester,
      ) async {
        await pumpShell(tester);
        await sendFirstMessage(tester, 'archive me');

        await tester.tap(find.byKey(const ValueKey('cloud-chat-options')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('cloud-chat-archive')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('cloud-archive-confirm')));
        await tester.pumpAndSettle();

        expect(cloud.archiveCalls, hasLength(1));
        expect(find.byType(HomeShell), findsOneWidget);
        expect(draft(), findsOneWidget);
      });

      testWidgets('binding the shared session to another chat resets the '
          'in-shell chat to a fresh draft', (tester) async {
        await pumpShell(tester);
        await sendFirstMessage(tester, 'first chat');
        expect(conversation(), findsOneWidget);

        tester
            .element(find.byType(HomeShell))
            .read<CloudChatViewModel>()
            .open('chat-1', cursorEpoch: '');
        await tester.pumpAndSettle();

        expect(find.byType(HomeShell), findsOneWidget);
        expect(draft(), findsOneWidget);
      });

      testWidgets(
        'switching chats preserves an unsent follow-up for recovery',
        (tester) async {
          final store = InMemoryChatDraftStore();
          final controller = await pumpShell(tester, draftStore: store);
          await sendFirstMessage(tester, 'first chat');
          final list = tester
              .element(find.byType(HomeShell))
              .read<CloudChatsViewModel>();
          final session = tester
              .element(find.byType(HomeShell))
              .read<CloudChatViewModel>();
          final originalChatId = session.state!.chatId;
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'keep this follow-up',
          );
          await tester.pump();

          session.open('chat-1', cursorEpoch: '');
          await tester.pumpAndSettle();

          expect(session.state?.chatId, 'chat-1');
          expect(draft(), findsOneWidget);
          expect(
            store.draftFor(CloudChatDraftTarget(originalChatId)),
            'keep this follow-up',
          );

          // Reopening that chat brings its draft back.
          controller.select(HomeTab.cloud);
          await tester.pumpAndSettle();
          expect(list.chatById(originalChatId), isNotNull);
          await tester.tap(
            find.byKey(ValueKey('cloud-chat-actions-$originalChatId')),
          );
          await tester.pumpAndSettle();
          final resumed = tester.widget<TextField>(
            find.byKey(const ValueKey('composer-draft')),
          );
          expect(resumed.controller!.text, 'keep this follow-up');
        },
      );

      testWidgets('New Chat opens a fresh draft during first-chat creation', (
        tester,
      ) async {
        final creating = Completer<void>();
        cloud.createCompleters['ws-1'] = creating;
        final store = InMemoryChatDraftStore();
        await pumpShell(tester, draftStore: store);
        final session = tester
            .element(find.byType(HomeShell))
            .read<CloudChatViewModel>();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'pending first prompt',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        expect(cloud.createCalls, hasLength(1));

        await openNavigationMenu(tester);
        await tester.tap(newChatButton());
        await tester.pumpAndSettle();

        expect(draft(), findsOneWidget);
        expect(find.text('pending first prompt'), findsNothing);
        final field = tester.widget<TextField>(
          find.byKey(const ValueKey('composer-draft')),
        );
        expect(field.controller!.text, isEmpty);

        creating.complete();
        await tester.pumpAndSettle();
        expect(
          session.state?.chatId,
          isNot(cloud.createCalls.single.externalId),
        );
        // The fresh draft never showed the other screen's in-flight prompt;
        // it lands as the created chat's draft.
        expect(find.text('pending first prompt'), findsNothing);
        expect(
          store.draftFor(
            CloudChatDraftTarget(cloud.createCalls.single.externalId),
          ),
          'pending first prompt',
        );
        expect(store.unsentFor('cloud'), isEmpty);
      });

      testWidgets(
        'shows no Chat button when the shell has no Chat destination',
        (tester) async {
          await pumpShell(
            tester,
            initialTab: HomeTab.cloud,
            tabs: [
              for (final tab in organizationHomeTabs)
                if (tab != HomeTab.chat) tab,
            ],
          );
          await openNavigationMenu(tester);

          expect(newChatButton(), findsNothing);
        },
      );
    });

    group('Settings button', () {
      Finder settingsButton() =>
          find.byKey(const ValueKey('home-settings-button'));
      Finder newChatButton() =>
          find.byKey(const ValueKey('home-new-chat-button'));
      Finder drawer() => find.byKey(const ValueKey('home-navigation-drawer'));

      Finder cog() => find.descendant(
        of: settingsButton(),
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is CanopyIcon && widget.glyph == CanopyGlyph.settingsGear2,
        ),
      );

      Future<HomeTabController> pumpShell(
        WidgetTester tester, {
        List<HomeTab> tabs = organizationHomeTabs,
        AuthViewModel? auth,
      }) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
        addTearDown(tester.view.reset);
        final controller = HomeTabController(
          tabs: tabs,
          initialTab: HomeTab.cloud,
        );
        await tester.pumpWidget(
          buildSubject(tabController: controller, auth: auth),
        );
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);
        return controller;
      }

      testWidgets(
        'replaces the Account row with a cog on the Chat button row',
        (tester) async {
          await pumpShell(tester);

          expect(find.byKey(const ValueKey('home-nav-account')), findsNothing);
          expect(find.text('Account'), findsNothing);
          expect(settingsButton(), findsOneWidget);
          expect(find.byTooltip('Settings'), findsOneWidget);
          expect(
            find.descendant(
              of: settingsButton(),
              matching: find.byWidgetPredicate(
                (widget) =>
                    widget is CanopyIcon &&
                    widget.glyph == CanopyGlyph.settingsGear2,
              ),
            ),
            findsOneWidget,
          );
          expect(
            find.descendant(
              of: find.byType(Scrollable),
              matching: settingsButton(),
            ),
            findsNothing,
          );
          final panel = tester.getRect(drawer());
          final chat = tester.getRect(newChatButton());
          final settings = tester.getRect(settingsButton());
          expect(settings.center.dy, chat.center.dy);
          expect(settings.height, chat.height);
          expect(panel.right - settings.right, 32);
        },
      );

      /// A signed-in [AuthViewModel] whose user is named [name].
      Future<AuthViewModel> signedInAs(WidgetTester tester, String name) async {
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
        );
        addTearDown(auth.dispose);
        await tester.runAsync(
          () => auth.signIn(email: 'user@example.com', password: 'password'),
        );
        auth.applyProfileName(name);
        return auth;
      }

      testWidgets('keeps the Settings glyph for a signed-in user', (
        tester,
      ) async {
        final auth = await signedInAs(tester, 'Ada Lovelace');
        await pumpShell(tester, auth: auth);

        expect(cog(), findsOneWidget);
        expect(
          find.descendant(of: settingsButton(), matching: find.text('AL')),
          findsNothing,
        );
        expect(find.byTooltip('Settings'), findsOneWidget);

        auth.applyProfileName('Grace');
        await tester.pump();

        expect(cog(), findsOneWidget);
        expect(
          find.descendant(of: settingsButton(), matching: find.text('G')),
          findsNothing,
        );
      });

      testWidgets('keeps the Settings glyph when the user has no name', (
        tester,
      ) async {
        final auth = await signedInAs(tester, '   ');
        await pumpShell(tester, auth: auth);

        expect(cog(), findsOneWidget);
      });

      testWidgets('opens Account and closes the drawer', (tester) async {
        final controller = await pumpShell(tester);

        await tester.tap(settingsButton());
        await tester.pumpAndSettle();

        expect(controller.value, HomeTab.account);
        expect(drawer(), findsNothing);
      });

      testWidgets('opens one Settings page with the app settings on it '
          '(CAN-4449)', (tester) async {
        await pumpShell(tester);

        await tester.tap(settingsButton());
        await tester.pumpAndSettle();

        // Appearance and Push live on the page itself; no gear pushes a
        // second Settings screen.
        expect(find.byTooltip('Settings'), findsNothing);
        await tester.scrollUntilVisible(
          find.text('Push notifications'),
          300,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('Appearance'), findsOneWidget);
        expect(find.text('Push notifications'), findsOneWidget);
      });

      testWidgets('stays available when the shell has no Chat destination', (
        tester,
      ) async {
        await pumpShell(
          tester,
          tabs: [
            for (final tab in organizationHomeTabs)
              if (tab != HomeTab.chat) tab,
          ],
        );

        expect(newChatButton(), findsNothing);
        expect(settingsButton(), findsOneWidget);
      });
    });

    group('Settings destinations (CAN-3558)', () {
      Finder accountRow(HomeTab tab) =>
          find.byKey(ValueKey('account-nav-${tab.name}'));

      Future<void> openAccount(WidgetTester tester) async {
        await openNavigationMenu(tester);
        await tester.tap(find.byKey(const ValueKey('home-settings-button')));
        await tester.pumpAndSettle();
      }

      testWidgets('the drawer has no Timeline, Usage, or Members rows', (
        tester,
      ) async {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);

        for (final tab in settingsHomeTabs) {
          expect(
            find.byKey(ValueKey('home-nav-${tab.name}')),
            findsNothing,
            reason: '${tab.name} moved into Settings',
          );
        }
        expect(find.byKey(const ValueKey('home-nav-cloud')), findsOneWidget);
        expect(find.byKey(const ValueKey('home-nav-remote')), findsOneWidget);
      });

      testWidgets('Account lists Timeline, Usage, and Members in order', (
        tester,
      ) async {
        await tester.pumpWidget(
          buildSubject(
            tabController: HomeTabController(
              tabs: organizationHomeTabs,
              initialTab: HomeTab.remote,
            ),
          ),
        );
        await tester.pumpAndSettle();
        await openAccount(tester);

        final tops = [
          for (final tab in settingsHomeTabs)
            tester.getTopLeft(accountRow(tab)).dy,
        ];
        expect(tops, orderedEquals([...tops]..sort()));
        expect(
          find.descendant(
            of: accountRow(HomeTab.activity),
            matching: find.text('Timeline'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: accountRow(HomeTab.usage),
            matching: find.text('Usage'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: accountRow(HomeTab.members),
            matching: find.text('Members'),
          ),
          findsOneWidget,
        );
      });

      for (final tab in settingsHomeTabs) {
        testWidgets('${tab.name} opens from Account and its back button '
            'returns there', (tester) async {
          final controller = HomeTabController(
            tabs: organizationHomeTabs,
            initialTab: HomeTab.remote,
          );
          await tester.pumpWidget(buildSubject(tabController: controller));
          await tester.pumpAndSettle();
          await openAccount(tester);

          await tester.tap(accountRow(tab));
          await tester.pumpAndSettle();

          expect(controller.value, tab);
          expect(find.byTooltip('Open navigation menu'), findsNothing);
          await tester.tap(find.byTooltip('Back'));
          await tester.pumpAndSettle();
          expect(controller.value, HomeTab.account);
        });
      }

      testWidgets(
        'system back from a Settings destination returns to Account',
        (tester) async {
          final controller = HomeTabController(
            tabs: organizationHomeTabs,
            initialTab: HomeTab.remote,
          );
          await tester.pumpWidget(buildSubject(tabController: controller));
          await tester.pumpAndSettle();
          await openAccount(tester);
          await tester.tap(accountRow(HomeTab.usage));
          await tester.pumpAndSettle();

          final handled = await tester.binding.handlePopRoute();
          await tester.pumpAndSettle();

          expect(handled, isTrue);
          expect(controller.value, HomeTab.account);
        },
      );

      testWidgets('system back on a root tab does not close the app', (
        tester,
      ) async {
        final controller = HomeTabController(
          tabs: organizationHomeTabs,
          initialTab: HomeTab.remote,
        );
        final systemNavigatorCalls = <String>[];
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          (call) async {
            if (call.method.startsWith('SystemNavigator.')) {
              systemNavigatorCalls.add(call.method);
            }
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            SystemChannels.platform,
            null,
          ),
        );
        await tester.pumpWidget(buildSubject(tabController: controller));
        await tester.pumpAndSettle();

        final handled = await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();

        expect(handled, isTrue);
        expect(systemNavigatorCalls, isNot(contains('SystemNavigator.pop')));
        expect(controller.value, HomeTab.remote);
        expect(find.byType(HomeShell), findsOneWidget);
      });

      testWidgets('without an organization Account lists only Members', (
        tester,
      ) async {
        await tester.pumpWidget(buildNoOrganizationSubject());
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);
        expect(find.byKey(const ValueKey('home-nav-members')), findsNothing);
        await tester.tap(find.byKey(const ValueKey('home-settings-button')));
        await tester.pumpAndSettle();

        expect(accountRow(HomeTab.activity), findsNothing);
        expect(accountRow(HomeTab.usage), findsNothing);
        expect(accountRow(HomeTab.members), findsOneWidget);

        await tester.tap(accountRow(HomeTab.members));
        await tester.pumpAndSettle();
        expect(find.text('no-org members tab'), findsOneWidget);
      });
    });

    testWidgets('menu rows use design-system glyphs', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();
      await openNavigationMenu(tester);

      void expectGlyphs(String keyPrefix, Map<HomeTab, CanopyGlyph> glyphs) {
        for (final MapEntry(key: tab, value: glyph) in glyphs.entries) {
          expect(
            find.descendant(
              of: find.byKey(ValueKey('$keyPrefix-${tab.name}')),
              matching: find.byWidgetPredicate(
                (widget) => widget is CanopyIcon && widget.glyph == glyph,
              ),
            ),
            findsOneWidget,
            reason: '${tab.name} row',
          );
        }
      }

      expectGlyphs('home-nav', const {
        HomeTab.cloud: CanopyGlyph.cloud,
        HomeTab.remote: CanopyGlyph.globe2,
      });
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('home-navigation-drawer')),
          matching: find.byType(Icon),
        ),
        findsNothing,
      );

      // Account's rows for the Settings destinations keep the same glyphs
      // (CAN-3558).
      await tester.tap(find.byKey(const ValueKey('home-settings-button')));
      await tester.pumpAndSettle();
      expectGlyphs('account-nav', const {
        HomeTab.activity: CanopyGlyph.electrocardiogram,
        HomeTab.usage: CanopyGlyph.stackedBarChart,
        HomeTab.members: CanopyGlyph.userGroup,
      });
    });

    group('with no organization (CAN-2576)', () {
      testWidgets(
        'opens Remote with desktop pairing guidance and no keyboard for a solo account',
        (tester) async {
          await tester.pumpWidget(buildNoOrganizationSubject());
          await tester.pumpAndSettle();

          expect(find.text('Remote Control'), findsOneWidget);
          expect(find.text('Connect to your desktop'), findsOneWidget);
          expect(
            find.text('Your 6-digit code comes from the desktop app:'),
            findsOneWidget,
          );
          expect(find.text('no-org members tab'), findsNothing);
          expect(find.text('Account'), findsNothing);
          expect(tester.testTextInput.isVisible, isFalse);

          await openNavigationMenu(tester);
          expect(find.byKey(const ValueKey('home-nav-remote')), findsOneWidget);
          expect(
            find.byKey(const ValueKey('home-settings-button')),
            findsOneWidget,
          );
          // Members opens from Account (CAN-3558).
          expect(find.byKey(const ValueKey('home-nav-members')), findsNothing);
        },
      );

      testWidgets(
        'organization setup is optional and Remote remains reachable',
        (tester) async {
          await tester.pumpWidget(buildNoOrganizationSubject());
          await tester.pumpAndSettle();

          expect(find.text('Connect to your desktop'), findsOneWidget);
          expect(tester.testTextInput.isVisible, isFalse);
          await openDestination(tester, HomeTab.members);
          expect(find.text('no-org members tab'), findsOneWidget);
          await openDestination(tester, HomeTab.remote);

          expect(find.text('Connect to your desktop'), findsOneWidget);
          expect(tester.testTextInput.isVisible, isFalse);
          await tester.tap(find.byType(TextField));
          await tester.pumpAndSettle();
          expect(tester.testTextInput.isVisible, isTrue);
        },
      );

      testWidgets('drops the Activity and Usage tabs', (tester) async {
        await tester.pumpWidget(buildNoOrganizationSubject());
        await tester.pumpAndSettle();

        await openNavigationMenu(tester);

        expect(find.byKey(const ValueKey('home-nav-activity')), findsNothing);
        expect(find.byKey(const ValueKey('home-nav-usage')), findsNothing);
        expect(find.byKey(const ValueKey('home-nav-remote')), findsOneWidget);
      });

      testWidgets('renders the supplied members tab, not MembersScreen', (
        tester,
      ) async {
        await tester.pumpWidget(buildNoOrganizationSubject());
        await tester.pumpAndSettle();

        await openDestination(tester, HomeTab.members);

        expect(find.text('no-org members tab'), findsOneWidget);
      });

      testWidgets('fits a phone-width viewport without overflow', (
        tester,
      ) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(buildNoOrganizationSubject());
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
      });
    });

    testWidgets(
      'a first-run account lands on Chat with its first project ready',
      (tester) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final cloud = FakeCloudChatRepository();
        await tester.pumpWidget(
          buildSubject(
            tabController: HomeTabController(
              tabs: noOrganizationHomeTabs,
              initialTab: HomeTab.chat,
            ),
            cloudRepository: cloud,
            // No server-side pairing: this is not a desktop user.
            remoteRepository: FakeRemoteControlRepository(),
          ),
        );
        await tester.pumpAndSettle();

        expect(cloud.provisionCalls, ['My project']);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('new-chat-project-pill')),
            matching: find.text('My project'),
          ),
          findsOneWidget,
        );
        expect(find.text('No project'), findsNothing);
      },
    );

    group('New chat destination (CAN-2932)', () {
      late FakeCloudChatRepository cloud;

      setUp(() {
        cloud = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
      });

      Finder projectPill() =>
          find.byKey(const ValueKey('new-chat-project-pill'));
      Finder worktreePill() =>
          find.byKey(const ValueKey('remote-new-chat-worktree'));
      Finder cloudDraft() =>
          find.byKey(const ValueKey('cloud-new-chat-screen'));
      Finder computerDraft() =>
          find.byKey(const ValueKey('remote-new-chat-screen'));
      Finder sendButton() => find.byKey(const ValueKey('composer-send'));
      Finder projectRow(String key) =>
          find.byKey(ValueKey('new-chat-project-option-$key'));

      String composerText(WidgetTester tester) => tester
          .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
          .controller!
          .text;

      bool sendEnabled(WidgetTester tester) =>
          tester.widget<CanopyComposerAction>(sendButton()).onPressed != null;

      Finder inPill(Finder pill, String text) =>
          find.descendant(of: pill, matching: find.text(text));

      Finder inHeader(String text) => find.descendant(
        of: find.byType(ChatLocationSubtitle),
        matching: find.text(text),
      );

      Future<HomeTabController> pumpDraft(
        WidgetTester tester, {
        required FakeRemoteControlRepository remote,
        ChatDestinationStore? store,
        ChatDraftStore? drafts,
        bool settle = true,
        Size size = _phone,
      }) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
        addTearDown(tester.view.reset);
        final controller = HomeTabController(
          tabs: organizationHomeTabs,
          initialTab: HomeTab.chat,
        );
        await tester.pumpWidget(
          buildSubject(
            tabController: controller,
            cloudRepository: cloud,
            remoteRepository: remote,
            draftStore: drafts ?? InMemoryChatDraftStore(),
            chatDestinationStore: store ?? InMemoryChatDestinationStore(),
          ),
        );
        if (settle) {
          await tester.pumpAndSettle();
        } else {
          for (var i = 0; i < 8; i++) {
            await tester.pump(const Duration(milliseconds: 50));
          }
        }
        return controller;
      }

      Future<void> chooseProject(WidgetTester tester, String key) async {
        await tester.tap(projectPill());
        await tester.pumpAndSettle();
        await tester.tap(projectRow(key));
        await tester.pumpAndSettle();
      }

      testWidgets('a new chat opens on Cloud when none ran on a computer', (
        tester,
      ) async {
        await pumpDraft(tester, remote: _DestinationRemoteRepository());

        expect(cloudDraft(), findsOneWidget);
        expect(inPill(projectPill(), 'Mobile App'), findsOneWidget);
        expect(inHeader('Cloud'), findsOneWidget);
        // The pill sits above the composer box, not inside it, and Cloud
        // offers no worktree pill.
        expect(
          tester.getBottomLeft(projectPill()).dy,
          lessThanOrEqualTo(
            tester.getTopLeft(find.byKey(const ValueKey('chat-composer'))).dy,
          ),
        );
        expect(worktreePill(), findsNothing);
        expect(tester.takeException(), isNull);
      });

      testWidgets("a new chat opens on the last chat's computer", (
        tester,
      ) async {
        await pumpDraft(
          tester,
          remote: _DestinationRemoteRepository(),
          store: InMemoryChatDestinationStore('computer:Studio'),
        );

        expect(computerDraft(), findsOneWidget);
        expect(inPill(projectPill(), 'Mobile App'), findsOneWidget);
        expect(inHeader('Studio'), findsOneWidget);
        expect(inPill(worktreePill(), 'New worktree'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });

      testWidgets('a new chat opens on Cloud once that computer is no longer '
          'paired', (tester) async {
        await pumpDraft(
          tester,
          remote: _DestinationRemoteRepository(paired: false),
          store: InMemoryChatDestinationStore('computer:Studio'),
        );

        expect(cloudDraft(), findsOneWidget);
        expect(inHeader('Cloud'), findsOneWidget);
      });

      testWidgets(
        'delayed unpaired fallback restores the Cloud project and draft',
        (tester) async {
          final probe = Completer<RemoteConnection?>();
          final drafts = InMemoryChatDraftStore()
            ..setDraft(
              const CloudNewChatDraftTarget('ws-1'),
              'Saved Cloud draft',
            );
          await pumpDraft(
            tester,
            remote: _DeferredProbeRemoteRepository(probe.future),
            store: InMemoryChatDestinationStore('computer:Studio'),
            drafts: drafts,
            settle: false,
          );
          expect(computerDraft(), findsOneWidget);
          expect(inHeader('Studio'), findsOneWidget);
          probe.complete(null);
          await tester.pumpAndSettle();
          expect(cloudDraft(), findsOneWidget);
          expect(inPill(projectPill(), 'Mobile App'), findsOneWidget);
          expect(composerText(tester), 'Saved Cloud draft');
          expect(sendEnabled(tester), isTrue);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('computer first send survives New chat while provisioning', (
        tester,
      ) async {
        final remote = _DestinationRemoteRepository();
        final create = Completer<RemoteWorktreeCreateResult>();
        remote.createWorktreeHandler = () => create.future;
        await pumpDraft(
          tester,
          remote: remote,
          store: InMemoryChatDestinationStore('computer:Studio'),
        );
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep the first send',
        );
        await tester.pump();
        await tester.tap(sendButton());
        await tester.pump(const Duration(milliseconds: 100));
        await tester.tap(find.byTooltip('Open navigation menu'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        final newChat = find
            .byKey(const ValueKey('home-new-chat-button'))
            .hitTestable();
        expect(newChat, findsOneWidget);
        await tester.tap(newChat);
        await tester.pump(const Duration(milliseconds: 400));
        remote.createdWorktrees.add(
          const RemoteWorktree(
            localId: 'wt-new',
            workspaceLocalId: 'ws-mobile',
            branch: 'fix-login',
          ),
        );
        create.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-new',
          ),
        );
        await tester.pumpAndSettle();
        expect(remote.sendChatMessageCalls, hasLength(1));
        expect(remote.sendChatMessageCalls.single.text, 'Keep the first send');
        expect(tester.takeException(), isNull);
      });

      for (final navigation in ['New chat', 'Recents']) {
        testWidgets(
          '$navigation works after clearing a provisioning first send',
          (tester) async {
            cloud = FakeCloudChatRepository(
              workspaces: [
                sampleWorkspace(
                  chats: [sampleChat(id: 'recent', title: 'Saved chat')],
                ),
              ],
            );
            final remote = _DestinationRemoteRepository();
            final create = Completer<RemoteWorktreeCreateResult>();
            remote.createWorktreeHandler = () => create.future;
            await pumpDraft(
              tester,
              remote: remote,
              store: InMemoryChatDestinationStore('computer:Studio'),
            );
            await tester.enterText(
              find.byKey(const ValueKey('composer-draft')),
              'Clear me',
            );
            await tester.pump();
            await tester.tap(sendButton());
            await tester.pump(const Duration(milliseconds: 100));
            await tester.enterText(
              find.byKey(const ValueKey('composer-draft')),
              '',
            );
            remote.createdWorktrees.add(
              const RemoteWorktree(
                localId: 'wt-new',
                workspaceLocalId: 'ws-mobile',
                branch: 'fix-login',
              ),
            );
            create.complete(
              const RemoteWorktreeCreateResult(
                commandId: 'cmd-create',
                worktreeLocalId: 'wt-new',
              ),
            );
            await tester.pumpAndSettle();
            expect(remote.sendChatMessageCalls, isEmpty);
            await openNavigationMenu(tester);
            await tester.tap(
              find.byKey(
                ValueKey(
                  navigation == 'New chat'
                      ? 'home-new-chat-button'
                      : 'home-recent-cloud-recent',
                ),
              ),
            );
            await tester.pumpAndSettle();
            expect(
              find.byKey(const ValueKey('new-chat-started-on-computer')),
              findsNothing,
            );
            if (navigation == 'New chat') {
              expect(computerDraft(), findsOneWidget);
            } else {
              expect(find.byType(CloudChatScreen), findsOneWidget);
            }
            expect(tester.takeException(), isNull);
          },
        );
      }

      for (final failure in ['worktree', 'standalone']) {
        for (final navigation in ['New chat', 'Recents']) {
          testWidgets('$navigation works after $failure first-send failure', (
            tester,
          ) async {
            cloud = FakeCloudChatRepository(
              workspaces: [
                sampleWorkspace(
                  chats: [sampleChat(id: 'recent', title: 'Saved chat')],
                ),
              ],
            );
            final remote = _DestinationRemoteRepository();
            if (failure == 'worktree') {
              remote.createWorktreeHandler = () =>
                  throw const RemoteControlException('Creation rejected');
            } else {
              remote.supportsStandaloneChatCreate = true;
              remote.standaloneCreateHandler = () =>
                  throw const RemoteControlException('Creation rejected');
            }
            final drafts = InMemoryChatDraftStore();
            await pumpDraft(
              tester,
              remote: remote,
              drafts: drafts,
              store: InMemoryChatDestinationStore('computer:Studio'),
            );
            if (failure == 'standalone') {
              await chooseProject(tester, 'computer:Studio/ws-notes');
            }
            await tester.enterText(
              find.byKey(const ValueKey('composer-draft')),
              'Keep my failed draft',
            );
            await tester.pump();
            await tester.tap(sendButton());
            await tester.pumpAndSettle();
            expect(find.text('Creation rejected'), findsWidgets);
            await openNavigationMenu(tester);
            await tester.tap(
              find.byKey(
                ValueKey(
                  navigation == 'New chat'
                      ? 'home-new-chat-button'
                      : 'home-recent-cloud-recent',
                ),
              ),
            );
            await tester.pumpAndSettle();
            expect(
              find.byKey(const ValueKey('new-chat-started-on-computer')),
              findsNothing,
            );
            if (navigation == 'New chat') {
              expect(computerDraft(), findsOneWidget);
              expect(
                drafts.state.drafts.values.map((draft) => draft.text),
                contains('Keep my failed draft'),
              );
            } else {
              expect(find.byType(CloudChatScreen), findsOneWidget);
            }
            expect(tester.takeException(), isNull);
          });
        }
      }

      testWidgets('stale computer project is discarded after session loss', (
        tester,
      ) async {
        await pumpDraft(tester, remote: _DestinationRemoteRepository());
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep this',
        );
        await tester.pump();
        final remote = tester
            .element(cloudDraft())
            .read<RemoteControlViewModel>();
        await tester.tap(projectPill());
        await tester.pumpAndSettle();
        await remote.disconnect();
        await tester.pumpAndSettle();
        await tester.tap(projectRow('computer:Studio/ws-notes'));
        await tester.pumpAndSettle();
        expect(cloudDraft(), findsOneWidget);
        expect(inPill(projectPill(), 'Mobile App'), findsOneWidget);
        expect(composerText(tester), 'Keep this');
        expect(sendEnabled(tester), isTrue);
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'session loss keeps the carried draft through a Cloud remount',
        (tester) async {
          final drafts = InMemoryChatDraftStore();
          final store = InMemoryChatDestinationStore('computer:Studio');
          await pumpDraft(
            tester,
            remote: _DestinationRemoteRepository(),
            store: store,
            drafts: drafts,
          );
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Preserve this draft',
          );
          await tester.pump();
          await tester
              .element(computerDraft())
              .read<RemoteControlViewModel>()
              .disconnect();
          await tester.pumpAndSettle();
          expect(cloudDraft(), findsOneWidget);
          expect(composerText(tester), 'Preserve this draft');
          // The source must survive until a destination project can store it.
          final cloudSaved = drafts.draftFor(
            const CloudNewChatDraftTarget('ws-1'),
          );
          final remoteSaved = drafts.draftFor(
            const RemoteNewChatDraftTarget('ws-mobile'),
          );
          expect([cloudSaved, remoteSaved], contains('Preserve this draft'));
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
          await pumpDraft(
            tester,
            remote: _DestinationRemoteRepository(paired: false),
            store: store,
            drafts: drafts,
          );
          expect(composerText(tester), 'Preserve this draft');
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'draft returns from unmatched Cloud project without duplication',
        (tester) async {
          final drafts = InMemoryChatDraftStore();
          await pumpDraft(
            tester,
            remote: _DestinationRemoteRepository(),
            drafts: drafts,
          );
          await chooseProject(tester, 'computer:Studio/ws-notes');
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Research draft',
          );
          await tester.pump();
          final remote = tester
              .element(computerDraft())
              .read<RemoteControlViewModel>();
          await remote.disconnect();
          await tester.pumpAndSettle();
          expect(cloudDraft(), findsOneWidget);
          expect(inPill(projectPill(), 'Choose project'), findsOneWidget);
          expect(composerText(tester), 'Research draft');
          await tester.runAsync(() => remote.connect('123456'));
          await tester.pumpAndSettle();
          await chooseProject(tester, 'computer:Test Desktop/ws-notes');
          expect(composerText(tester), 'Research draft');
          expect(
            drafts.draftFor(const RemoteNewChatDraftTarget('ws-notes')),
            'Research draft',
          );
          expect(sendEnabled(tester), isTrue);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'picker applies Cloud choice after the computer draft is replaced',
        (tester) async {
          cloud = FakeCloudChatRepository(
            workspaces: [
              sampleWorkspace(),
              sampleWorkspace(id: 'ws-other', name: 'Other project'),
            ],
          );
          await pumpDraft(
            tester,
            remote: _DestinationRemoteRepository(),
            store: InMemoryChatDestinationStore('computer:Studio'),
          );
          final remote = tester
              .element(computerDraft())
              .read<RemoteControlViewModel>();
          await tester.tap(projectPill());
          await tester.pumpAndSettle();
          await remote.disconnect();
          await tester.pumpAndSettle();
          await tester.tap(projectRow('cloud/ws-other'));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          expect(inPill(projectPill(), 'Other project'), findsOneWidget);
        },
      );

      testWidgets('the project pill lists Cloud and computer projects in one '
          'list, Cloud first', (tester) async {
        await pumpDraft(tester, remote: _DestinationRemoteRepository());
        await tester.tap(projectPill());
        await tester.pumpAndSettle();

        final rows = [
          projectRow('cloud/ws-1'),
          projectRow('computer:Studio/ws-mobile'),
          projectRow('computer:Studio/ws-notes'),
        ];
        for (final row in rows) {
          expect(row, findsOneWidget);
        }
        expect(
          [for (final row in rows) tester.getTopLeft(row).dy],
          orderedEquals(
            [for (final row in rows) tester.getTopLeft(row).dy]..sort(),
          ),
        );
        // Both "Mobile App" rows say where they run.
        expect(
          find.descendant(of: rows[0], matching: find.text('Cloud')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: rows[1], matching: find.text('Studio')),
          findsOneWidget,
        );
        // One computer can be paired today (CAN-4425 adds more).
        expect(projectRow('add-computer'), findsNothing);
      });

      testWidgets('with nothing paired, Cloud works and "Add a computer" '
          'opens pairing', (tester) async {
        final tabs = await pumpDraft(
          tester,
          remote: _DestinationRemoteRepository(paired: false),
        );
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Hello',
        );
        await tester.pump();
        expect(sendEnabled(tester), isTrue);

        await tester.tap(projectPill());
        await tester.pumpAndSettle();
        expect(projectRow('cloud/ws-1'), findsOneWidget);
        await tester.tap(projectRow('add-computer'));
        await tester.pumpAndSettle();

        expect(tabs.value, HomeTab.remote);
      });

      testWidgets('picking a project on the other destination moves the '
          'draft there and keeps the text', (tester) async {
        await pumpDraft(tester, remote: _DestinationRemoteRepository());
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Summarize the research',
        );
        await tester.pump();

        await chooseProject(tester, 'computer:Studio/ws-notes');

        expect(computerDraft(), findsOneWidget);
        expect(cloudDraft(), findsNothing);
        expect(composerText(tester), 'Summarize the research');
        expect(inPill(projectPill(), 'Research'), findsOneWidget);
        expect(inHeader('Studio'), findsOneWidget);
        // A Cowork project has no worktree to start from.
        expect(worktreePill(), findsNothing);

        await chooseProject(tester, 'cloud/ws-1');

        expect(cloudDraft(), findsOneWidget);
        expect(composerText(tester), 'Summarize the research');
        expect(inPill(projectPill(), 'Mobile App'), findsOneWidget);
        expect(inHeader('Cloud'), findsOneWidget);
        expect(sendEnabled(tester), isTrue);
        expect(tester.takeException(), isNull);
      });

      testWidgets('an offline computer blocks send and offers Reconnect', (
        tester,
      ) async {
        final remote = _DestinationRemoteRepository(
          status: RemotePortalConnectionStatus.inactive,
        );
        await pumpDraft(
          tester,
          remote: remote,
          store: InMemoryChatDestinationStore('computer:Studio'),
        );

        expect(computerDraft(), findsOneWidget);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Run the tests',
        );
        await tester.pump();
        expect(sendEnabled(tester), isFalse);
        expect(find.textContaining('Studio is offline'), findsOneWidget);

        final fetches = remote.snapshotFetches;
        await tester.tap(
          find.byKey(const ValueKey('remote-new-chat-reconnect')),
        );
        await tester.pumpAndSettle();
        expect(remote.snapshotFetches, greaterThan(fetches));

        await tester.tap(projectPill());
        await tester.pumpAndSettle();
        expect(
          find.descendant(
            of: projectRow('computer:Studio/ws-mobile'),
            matching: find.text('Studio · Offline'),
          ),
          findsOneWidget,
        );
      });

      testWidgets('sending on the computer starts the chat there and marks '
          'the header with the computer', (tester) async {
        final remote = _DestinationRemoteRepository();
        final store = InMemoryChatDestinationStore();
        final semantics = tester.ensureSemantics();
        await pumpDraft(tester, remote: remote, store: store);
        await chooseProject(tester, 'computer:Studio/ws-notes');
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Summarize the research',
        );
        await tester.pump();

        await tester.tap(sendButton());
        await tester.pumpAndSettle();

        expect(find.byType(RemoteChatScreen), findsOneWidget);
        final send = remote.sendChatMessageCalls.single;
        expect(send.text, 'Summarize the research');
        expect(
          send.target,
          isA<RemoteStandaloneChatTarget>().having(
            (t) => t.projectLocalId,
            'projectLocalId',
            'ws-notes',
          ),
        );
        expect(cloud.createPluginSelections, isEmpty);
        // Untouched composer settings stay off the wire.
        expect(send.options?.model, isNull);
        expect(send.options?.thinkingLevel, isNull);
        expect(await store.read(), 'computer:Studio');
        // A started chat's project and destination are fixed.
        expect(projectPill(), findsNothing);
        final icon = find.byKey(const ValueKey('chat-location-icon'));
        expect(
          tester
              .widget<CanopyIcon>(
                find.descendant(of: icon, matching: find.byType(CanopyIcon)),
              )
              .glyph,
          CanopyGlyph.macbook,
        );
        expect(tester.getSemantics(icon).label, 'Chat on Studio');
        expect(inHeader('Research'), findsOneWidget);
        expect(inHeader('Studio'), findsOneWidget);
        semantics.dispose();
      });

      testWidgets('a code project can branch its new worktree from an '
          'existing one', (tester) async {
        final remote = _DestinationRemoteRepository();
        remote.createWorktreeHandler = () async {
          remote.createdWorktrees.add(
            const RemoteWorktree(
              localId: 'wt-new',
              workspaceLocalId: 'ws-mobile',
              branch: 'fix-login',
            ),
          );
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-new',
          );
        };
        await pumpDraft(
          tester,
          remote: remote,
          store: InMemoryChatDestinationStore('computer:Studio'),
        );
        await tester.tap(worktreePill());
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('remote-new-chat-worktree-option-')),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(const ValueKey('remote-new-chat-worktree-option-wt-1')),
        );
        await tester.pumpAndSettle();
        expect(inPill(worktreePill(), 'Branch from otter'), findsOneWidget);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Fix the login bug',
        );
        await tester.pump();

        await tester.tap(sendButton());
        await tester.pumpAndSettle();

        final create = remote.createWorktreeCalls.single;
        expect(create.workspaceLocalId, 'ws-mobile');
        expect(create.baseWorktreeId, 'wt-1');
        final send = remote.sendChatMessageCalls.single;
        expect(send.text, 'Fix the login bug');
        expect(
          send.target,
          isA<RemoteWorktreeChatTarget>().having(
            (t) => t.worktreeLocalId,
            'worktreeLocalId',
            'wt-new',
          ),
        );
      });

      testWidgets('a code project starts from its latest chat\'s model and '
          'thinking, as on web', (tester) async {
        await pumpDraft(
          tester,
          remote: _DestinationRemoteRepository(),
          store: InMemoryChatDestinationStore('computer:Studio'),
        );

        // Not the "Model" placeholder, and not the catalog default either:
        // the project's reference chat runs Claude Opus at medium.
        final model = find.byKey(const ValueKey('composer-model'));
        expect(
          find.descendant(of: model, matching: find.text('Claude Opus')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('composer-thinking')),
            matching: find.text('Medium'),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('an empty owner catalog offers no other owner models', (
        tester,
      ) async {
        await pumpDraft(
          tester,
          remote: _DestinationRemoteRepository(emptyOwnerCatalog: true),
          store: InMemoryChatDestinationStore('computer:Studio'),
        );
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        expect(find.text('Foreign owner model'), findsNothing);
        expect(
          find.byKey(const ValueKey('model-option-foreign-model')),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('the computer draft sends the shown model and settings with '
          'the first message', (tester) async {
        final remote = _DestinationRemoteRepository();
        remote.createWorktreeHandler = () async {
          remote.createdWorktrees.add(
            const RemoteWorktree(
              localId: 'wt-new',
              workspaceLocalId: 'ws-mobile',
              branch: 'fix-login',
            ),
          );
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-new',
          );
        };
        await pumpDraft(
          tester,
          remote: remote,
          store: InMemoryChatDestinationStore('computer:Studio'),
        );

        final model = find.byKey(const ValueKey('composer-model'));
        await tester.tap(model);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('model-option-claude-sonnet')),
        );
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: model, matching: find.text('Claude Sonnet')),
          findsOneWidget,
        );
        await toggleComposerPlan(tester);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Fix the login bug',
        );
        await tester.pump();

        await tester.tap(sendButton());
        await tester.pumpAndSettle();

        final options = remote.sendChatMessageCalls.single.options;
        expect(options?.model, 'claude-sonnet');
        expect(options?.providerType, 'claude');
        expect(options?.planMode, isTrue);
        // The seeded thinking level goes with it, as web submits it.
        expect(options?.thinkingLevel, 'medium');
        expect(tester.takeException(), isNull);
      });

      testWidgets('the next new chat opens on the computer the last chat '
          'started on', (tester) async {
        final store = InMemoryChatDestinationStore();
        await pumpDraft(
          tester,
          remote: _DestinationRemoteRepository(),
          store: store,
        );
        await chooseProject(tester, 'computer:Studio/ws-notes');
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'First',
        );
        await tester.pump();
        await tester.tap(sendButton());
        await tester.pumpAndSettle();

        await openNavigationMenu(tester);
        await tester.tap(find.byKey(const ValueKey('home-new-chat-button')));
        await tester.pumpAndSettle();

        expect(computerDraft(), findsOneWidget);
        expect(composerText(tester), isEmpty);
      });

      for (final size in const [Size(360, 800), Size(390, 844)]) {
        testWidgets('fits ${size.width.toInt()}px wide with both pills and '
            'the computer offline', (tester) async {
          await pumpDraft(
            tester,
            size: size,
            remote: _DestinationRemoteRepository(
              status: RemotePortalConnectionStatus.inactive,
            ),
            store: InMemoryChatDestinationStore('computer:Studio'),
          );
          expect(tester.takeException(), isNull);
          for (final pill in [projectPill(), worktreePill()]) {
            expect(tester.getSize(pill).height, greaterThanOrEqualTo(48));
            expect(tester.getTopRight(pill).dx, lessThanOrEqualTo(size.width));
          }
        });
      }
    });

    group('Recents (CAN-2931)', () {
      late FakeCloudChatRepository cloud;
      late _ConnectedRemoteRepository remote;

      setUp(() {
        cloud = FakeCloudChatRepository(
          workspaces: [
            sampleWorkspace(
              chats: [
                sampleChat(
                  id: 'cloud-newer',
                  title: 'Plan the mobile launch',
                  createdAtMs: DateTime.utc(2026, 9, 20).millisecondsSinceEpoch,
                ),
                sampleChat(
                  id: 'cloud-older',
                  title: 'Draft the release notes',
                  createdAtMs: DateTime.utc(2026, 9, 5).millisecondsSinceEpoch,
                ),
              ],
            ),
          ],
        );
        remote = _ConnectedRemoteRepository();
      });

      Finder recentRow(String key) => find.byKey(ValueKey('home-recent-$key'));

      Future<void> pumpRecents(
        WidgetTester tester, {
        ChatDraftStore? draftStore,
      }) async {
        tester.view.physicalSize = _phone;
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          buildSubject(
            tabController: HomeTabController(
              tabs: organizationHomeTabs,
              initialTab: HomeTab.account,
            ),
            cloudRepository: cloud,
            remoteRepository: remote,
            draftStore: draftStore,
          ),
        );
        await tester.pumpAndSettle();
        await openNavigationMenu(tester);
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpAndSettle();
      }

      testWidgets(
        'lists cloud and Remote Control chats together, newest activity first',
        (tester) async {
          await pumpRecents(tester);

          expect(
            find.byKey(const ValueKey('home-recents-header')),
            findsOneWidget,
          );
          expect(find.text('Recents'), findsOneWidget);
          final rows = tester
              .widgetList<Widget>(
                find.byWidgetPredicate(
                  (widget) =>
                      widget.key is ValueKey<String> &&
                      (widget.key as ValueKey<String>).value.startsWith(
                        'home-recent-',
                      ),
                ),
              )
              .map((widget) => (widget.key as ValueKey<String>).value)
              .toList();
          expect(rows, [
            'home-recent-remote-standalone-notes-1',
            'home-recent-cloud-cloud-newer',
            'home-recent-remote-worktree-wt-1-chat-a',
            'home-recent-cloud-cloud-older',
          ]);
          expect(find.text('Research notes'), findsOneWidget);
          expect(find.text('Plan the mobile launch'), findsOneWidget);
          expect(find.text('Fix the OAuth redirect'), findsOneWidget);
          expect(find.text('Draft the release notes'), findsOneWidget);
          // Remote Control chats are never buried in a separate section.
          expect(find.text('Remote control chats'), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'Recents exposes a failed desktop load and retries in place',
        (tester) async {
          remote.requestWorktreeChatSummariesHandler = () async {
            throw const RemoteControlException('private detail');
          };
          await pumpRecents(tester);
          expect(
            find.text("Couldn't load chats from your desktop."),
            findsOneWidget,
          );
          expect(recentRow('cloud-cloud-newer'), findsOneWidget);
          expect(recentRow('remote-worktree-wt-1-chat-a'), findsOneWidget);
          final attempts = remote.requestWorktreeChatSummariesStateCalls;
          await tester.tap(find.text('Retry'));
          await tester.pumpAndSettle();
          expect(remote.requestWorktreeChatSummariesStateCalls, attempts + 1);
          expect(recentRow('remote-worktree-wt-1-chat-a'), findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('Recents exposes a failed cloud load and retries in place', (
        tester,
      ) async {
        cloud.listError = StateError('private detail');
        await pumpRecents(tester);
        expect(find.text("Couldn't load cloud chats"), findsOneWidget);
        expect(recentRow('remote-worktree-wt-1-chat-a'), findsOneWidget);
        cloud.listError = null;
        await tester.tap(find.text('Retry'));
        await tester.pumpAndSettle();
        expect(find.text("Couldn't load cloud chats"), findsNothing);
        expect(recentRow('cloud-cloud-newer'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'Recents retries a failed cloud refresh after loading cached rows',
        (tester) async {
          await pumpRecents(tester);
          final list = tester
              .element(find.byType(HomeShell))
              .read<CloudChatsViewModel>();
          expect(recentRow('cloud-cloud-newer'), findsOneWidget);

          cloud.listError = StateError('private detail');
          await list.refresh();
          await tester.pumpAndSettle();
          expect(list.error, isNotNull);
          expect(recentRow('cloud-cloud-newer'), findsOneWidget);
          expect(recentRow('remote-worktree-wt-1-chat-a'), findsOneWidget);
          final attempts = cloud.listCalls.length;

          cloud.listError = null;
          await tester.tap(find.text('Retry'));
          await tester.pumpAndSettle();
          expect(cloud.listCalls.length, attempts + 1);
          expect(list.error, isNull);
          expect(recentRow('cloud-cloud-newer'), findsOneWidget);
          expect(recentRow('remote-worktree-wt-1-chat-a'), findsOneWidget);
          expect(find.text('Retry'), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('rows scroll with the menu rows under the pinned buttons', (
        tester,
      ) async {
        await pumpRecents(tester);

        final menuList = find.ancestor(
          of: find.byKey(const ValueKey('home-nav-cloud')),
          matching: find.byType(ListView),
        );
        expect(menuList, findsOneWidget);
        expect(
          find.descendant(
            of: menuList,
            matching: recentRow('cloud-cloud-newer'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(ListView),
            matching: find.byKey(const ValueKey('home-new-chat-button')),
          ),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('home-new-chat-button')),
          findsOneWidget,
        );
      });

      testWidgets('rows scroll under the system bars, dimmed at the top', (
        tester,
      ) async {
        await pumpRecents(tester);
        final screen = tester.getRect(find.byType(HomeShell));

        // The list spans the full height, behind the status and navigation
        // bars, while its first row still starts below the status bar.
        final menuList = find.ancestor(
          of: find.byKey(const ValueKey('home-nav-cloud')),
          matching: find.byType(ListView),
        );
        final listRect = tester.getRect(menuList);
        expect(listRect.top, screen.top);
        expect(listRect.bottom, screen.bottom);
        final title = find.descendant(
          of: menuList,
          matching: find.byKey(const ValueKey('home-navigation-brand')),
        );
        expect(tester.getRect(title).top, greaterThanOrEqualTo(47));

        // A short scrim dims only the status bar strip, not a tall band.
        final scrim = tester.getRect(
          find.byKey(const ValueKey('home-navigation-drawer-top-scrim')),
        );
        expect(scrim.top, screen.top);
        expect(scrim.height, greaterThan(47));
        expect(scrim.height, lessThan(47 + 32));

        // The pinned buttons keep clear of the navigation bar.
        expect(
          tester
              .getRect(find.byKey(const ValueKey('home-settings-button')))
              .bottom,
          screen.bottom - 34 - 32,
        );
      });

      testWidgets('marks unread chats and chats waiting for an answer', (
        tester,
      ) async {
        await pumpRecents(tester);

        expect(
          find.descendant(
            of: recentRow('remote-worktree-wt-1-chat-a'),
            matching: find.byTooltip('Unread'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: recentRow('remote-standalone-notes-1'),
            matching: find.byTooltip('Needs your answer'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: recentRow('cloud-cloud-newer'),
            matching: find.byType(Tooltip),
          ),
          findsNothing,
        );
      });

      testWidgets('tells cloud chats from chats on the computer', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await pumpRecents(tester);

        CanopyGlyph glyphOf(String key) => tester
            .widget<CanopyIcon>(
              find.descendant(
                of: recentRow(key),
                matching: find.byType(CanopyIcon),
              ),
            )
            .glyph;
        expect(glyphOf('cloud-cloud-newer'), CanopyGlyph.cloud);
        expect(glyphOf('remote-worktree-wt-1-chat-a'), CanopyGlyph.macbook);
        // The location merges into the row's own node, read before the
        // title, so a screen reader hears where the chat runs.
        expect(
          tester.getSemantics(recentRow('cloud-cloud-newer')).label,
          'Cloud chat\nPlan the mobile launch',
        );
        expect(
          tester.getSemantics(recentRow('remote-worktree-wt-1-chat-a')).label,
          // The row names the computer the chat runs on (CAN-2932).
          'Chat on Studio\nFix the OAuth redirect',
        );
        semantics.dispose();
      });

      /// The chat is hosted by the shell's own content card rather than a
      /// pushed route, so it keeps the menu button instead of a back button.
      void expectInShell(WidgetTester tester, Finder screen) {
        expect(screen, findsOneWidget);
        expect(
          find.ancestor(
            of: screen,
            matching: find.byKey(const ValueKey('home-content-slot')),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: screen,
            matching: find.byTooltip('Open navigation menu'),
          ),
          findsOneWidget,
        );
        expect(find.byType(BackButton), findsNothing);
        expect(
          find.byKey(const ValueKey('home-navigation-drawer')),
          findsNothing,
        );
      }

      testWidgets(
        'opening a cloud chat resumes it inside the shell, with the menu',
        (tester) async {
          await pumpRecents(tester);
          final controller = tester
              .element(find.byType(HomeShell))
              .read<HomeTabController>();

          await tester.tap(recentRow('cloud-cloud-older'));
          await tester.pumpAndSettle();

          final screen = find.byType(CloudChatScreen);
          expectInShell(tester, screen);
          expect(tester.widget<CloudChatScreen>(screen).chatId, 'cloud-older');
          expect(controller.value, HomeTab.chat);
        },
      );

      testWidgets(
        'opening a Remote Control chat resumes it inside the shell, and the '
        'menu opens from that chat to switch to another',
        (tester) async {
          await pumpRecents(tester);

          await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
          await tester.pumpAndSettle();

          final screen = find.byType(RemoteChatScreen);
          expectInShell(tester, screen);
          expect(
            tester.widget<RemoteChatScreen>(screen).initialChatId,
            'chat-a',
          );

          await openNavigationMenu(tester);
          await tester.tap(recentRow('remote-standalone-notes-1'));
          await tester.pumpAndSettle();

          expectInShell(tester, screen);
          expect(
            tester.widget<RemoteChatScreen>(screen).standaloneChat?.localId,
            'notes-1',
          );

          await openNavigationMenu(tester);
          await tester.tap(recentRow('cloud-cloud-newer'));
          await tester.pumpAndSettle();

          expect(find.byType(RemoteChatScreen), findsNothing);
          expectInShell(tester, find.byType(CloudChatScreen));
        },
      );

      testWidgets(
        'Recents reopens the requested worktree chat after a new tab',
        (tester) async {
          await pumpRecents(tester);
          await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
          await tester.pumpAndSettle();

          await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('new-chat-button')));
          await tester.pumpAndSettle();

          await openNavigationMenu(tester);
          await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
          await tester.pumpAndSettle();

          expect(
            tester
                .widget<ListTile>(find.byKey(const ValueKey('chat-tab-chat-a')))
                .selected,
            isTrue,
          );
        },
      );

      testWidgets('tray consumes back before the recent chat return tab', (
        tester,
      ) async {
        tester.binding.platformDispatcher.accessibilityFeaturesTestValue =
            const FakeAccessibilityFeatures(disableAnimations: true);
        addTearDown(
          tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue,
        );
        remote = _ConnectedRemoteRepository(
          backgroundProcesses: [
            {
              'localId': 'task',
              'workspaceLocalId': 'ws-code',
              'worktreeLocalId': 'wt-1',
              'chatId': 'chat-a',
              'toolUseId': 'tool',
              'taskId': 'provider',
              'kind': 'bash',
              'description': 'Shell back regression',
              'status': 'running',
              'startedAt': 1000,
              'updatedAt': 2000,
            },
          ],
        );
        await pumpRecents(tester);
        final controller = tester
            .element(find.byType(HomeShell))
            .read<HomeTabController>();
        await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
        await tester.pump();
        expect(find.text('Shell back regression'), findsOneWidget);
        await tester.binding.handlePopRoute();
        await tester.pump();
        expect(controller.value, HomeTab.chat);
        expect(find.text('Shell back regression'), findsNothing);
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        expect(controller.value, HomeTab.account);
        expect(tester.takeException(), isNull);
      });

      testWidgets('offstage tray does not consume Escape', (tester) async {
        tester.binding.platformDispatcher.accessibilityFeaturesTestValue =
            const FakeAccessibilityFeatures(disableAnimations: true);
        addTearDown(
          tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue,
        );
        remote = _ConnectedRemoteRepository(
          backgroundProcesses: [
            {
              'localId': 'task',
              'workspaceLocalId': 'ws-code',
              'worktreeLocalId': 'wt-1',
              'chatId': 'chat-a',
              'toolUseId': 'tool',
              'taskId': 'provider',
              'kind': 'bash',
              'description': 'Hidden work',
              'status': 'running',
              'startedAt': 1000,
              'updatedAt': 2000,
            },
          ],
        );
        await pumpRecents(tester);
        final controller = tester
            .element(find.byType(HomeShell))
            .read<HomeTabController>();
        await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
        await tester.pump();
        controller.select(HomeTab.account);
        await tester.pumpAndSettle();
        expect(await tester.sendKeyEvent(LogicalKeyboardKey.escape), isFalse);
        expect(tester.takeException(), isNull);
      });
      testWidgets(
        'native back returns to the tab before opening a recent chat',
        (tester) async {
          await pumpRecents(tester);
          final controller = tester
              .element(find.byType(HomeShell))
              .read<HomeTabController>();
          await tester.tap(recentRow('cloud-cloud-older'));
          await tester.pumpAndSettle();
          expect(controller.value, HomeTab.chat);

          await tester.binding.handlePopRoute();
          await tester.pumpAndSettle();

          expect(controller.value, HomeTab.account);
          expect(find.byType(HomeShell), findsOneWidget);
        },
      );

      testWidgets('the Chat button replaces an opened chat with a new draft', (
        tester,
      ) async {
        await pumpRecents(tester);
        await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
        await tester.pumpAndSettle();

        await openNavigationMenu(tester);
        await tester.tap(find.byKey(const ValueKey('home-new-chat-button')));
        await tester.pumpAndSettle();

        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(
          find.byKey(const ValueKey('cloud-new-chat-screen')),
          findsOneWidget,
        );
      });

      testWidgets('opening a recent chat keeps the unsent draft in its chat', (
        tester,
      ) async {
        final store = InMemoryChatDraftStore();
        await pumpRecents(tester, draftStore: store);
        await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'unsent reply',
        );
        await tester.pump();

        await openNavigationMenu(tester);
        await tester.tap(recentRow('cloud-cloud-older'));
        await tester.pumpAndSettle();

        expect(find.text('Discard unsent message?'), findsNothing);
        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(
          tester.widget<CloudChatScreen>(find.byType(CloudChatScreen)).chatId,
          'cloud-older',
        );
        expect(
          store.state.drafts.entries
              .where((e) => e.key.startsWith('rc:wt:'))
              .map((e) => e.value.text),
          ['unsent reply'],
        );
      });

      testWidgets(
        'an opened Remote Control chat goes inactive behind another tab',
        (tester) async {
          await pumpRecents(tester);
          final controller = tester
              .element(find.byType(HomeShell))
              .read<HomeTabController>();
          await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
          await tester.pumpAndSettle();
          final screen = find.byType(RemoteChatScreen, skipOffstage: false);
          expect(tester.widget<RemoteChatScreen>(screen).isActive, isTrue);

          controller.select(HomeTab.account);
          await tester.pumpAndSettle();
          expect(tester.widget<RemoteChatScreen>(screen).isActive, isFalse);

          controller.select(HomeTab.chat);
          await tester.pumpAndSettle();
          expect(tester.widget<RemoteChatScreen>(screen).isActive, isTrue);
        },
      );

      testWidgets(
        'an opened Remote Control chat keeps overview refresh active only '
        'while it is shown',
        (tester) async {
          await pumpRecents(tester);
          final viewModel = Provider.of<RemoteControlViewModel>(
            tester.element(find.byType(HomeShell)),
            listen: false,
          );
          final controller = tester
              .element(find.byType(HomeShell))
              .read<HomeTabController>();
          await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
          await tester.pumpAndSettle();

          final before = remote.snapshotFetches;
          viewModel.onAppBackgrounded();
          await viewModel.onAppForegrounded();
          expect(remote.snapshotFetches, greaterThan(before));

          controller.select(HomeTab.account);
          await tester.pumpAndSettle();
          final hidden = remote.snapshotFetches;
          viewModel.onAppBackgrounded();
          await viewModel.onAppForegrounded();
          expect(remote.snapshotFetches, hidden);

          controller.select(HomeTab.chat);
          await tester.pumpAndSettle();
          final shown = remote.snapshotFetches;
          viewModel.onAppBackgrounded();
          await viewModel.onAppForegrounded();
          expect(remote.snapshotFetches, greaterThan(shown));
        },
      );

      testWidgets(
        'a swipe from the right edge of an opened worktree chat opens its '
        'Activity panel, not the menu',
        (tester) async {
          await pumpRecents(tester);
          await tester.tap(recentRow('remote-worktree-wt-1-chat-a'));
          await tester.pumpAndSettle();

          final scaffold = tester.firstState<ScaffoldState>(
            find.descendant(
              of: find.byType(RemoteChatScreen),
              matching: find.byType(Scaffold),
            ),
          );
          await tester.dragFrom(
            Offset(_phone.width - 4, _phone.height / 2),
            const Offset(-300, 0),
          );
          await tester.pumpAndSettle();

          expect(scaffold.isEndDrawerOpen, isTrue);
          expect(
            find.byKey(const ValueKey('home-navigation-drawer')),
            findsNothing,
          );
        },
      );

      testWidgets('opening the menu hydrates the Remote Control chat index', (
        tester,
      ) async {
        await pumpRecents(tester);

        expect(remote.requestWorktreeChatSummariesStateCalls, 1);
      });

      testWidgets('a disconnected computer leaves the cloud chats in place', (
        tester,
      ) async {
        remote = _ConnectedRemoteRepository(paired: false);
        await pumpRecents(tester);

        expect(find.text('Plan the mobile launch'), findsOneWidget);
        expect(find.text('Draft the release notes'), findsOneWidget);
        expect(find.text('Fix the OAuth redirect'), findsNothing);
      });

      testWidgets('the brand title scrolls away with the menu rows', (
        tester,
      ) async {
        await pumpRecents(tester);
        tester.view.physicalSize = const Size(390, 420);
        await tester.pumpAndSettle();

        final drawer = find.byKey(const ValueKey('home-navigation-drawer'));
        final title = find.descendant(
          of: drawer,
          matching: find.byKey(const ValueKey('home-navigation-brand')),
        );
        final list = find.descendant(
          of: drawer,
          matching: find.byType(Scrollable),
        );
        expect(find.descendant(of: list, matching: title), findsOneWidget);

        final titleTop = tester.getTopLeft(title).dy;
        final rowTop = tester
            .getTopLeft(find.byKey(const ValueKey('home-nav-cloud')))
            .dy;
        await tester.drag(list, const Offset(0, -40));
        await tester.pumpAndSettle();

        final scrolled =
            rowTop -
            tester.getTopLeft(find.byKey(const ValueKey('home-nav-cloud'))).dy;
        expect(scrolled, greaterThan(0));
        expect(tester.getTopLeft(title).dy, closeTo(titleTop - scrolled, 0.5));
      });

      testWidgets('the brand title shows the wordmark when the brand has one', (
        tester,
      ) async {
        await pumpRecents(tester);

        final title = find.byKey(const ValueKey('home-navigation-brand'));
        expect(title, findsOneWidget);
        expect(find.bySemanticsLabel(Brand.shortName), findsOneWidget);
        final wordmark = find.descendant(
          of: title,
          matching: find.byType(SvgPicture),
        );
        if (Brand.wordmarkSvg == null) {
          expect(wordmark, findsNothing);
          expect(
            find.descendant(of: title, matching: find.text(Brand.shortName)),
            findsOneWidget,
          );
          return;
        }
        expect(wordmark, findsOneWidget);
        expect(
          find.descendant(of: title, matching: find.text(Brand.shortName)),
          findsNothing,
        );
        expect(tester.getSize(wordmark).height, 36);
        final context = tester.element(title);
        expect(
          tester.widget<SvgPicture>(wordmark).colorFilter,
          ColorFilter.mode(
            Theme.of(context).colorScheme.onSurface,
            BlendMode.srcIn,
          ),
        );
      });

      testWidgets('the section is absent when there is nothing recent', (
        tester,
      ) async {
        cloud = FakeCloudChatRepository(
          workspaces: [sampleWorkspace(chats: [])],
        );
        remote = _ConnectedRemoteRepository(paired: false);
        await pumpRecents(tester);

        expect(find.byKey(const ValueKey('home-recents-header')), findsNothing);
      });
    });
  });
}

/// A paired desktop whose first snapshot already carries a worktree chat and
/// a standalone chat, so the drawer has Remote Control history to show.
final class _ConnectedRemoteRepository extends FakeRemoteControlRepository {
  _ConnectedRemoteRepository({
    this.paired = true,
    List<Map<String, dynamic>> backgroundProcesses = const [],
  }) {
    supportsWorktreeChatSummariesScope = true;
    snapshotBuilder = () => RemoteSessionSnapshot(
      raw: {'backgroundProcesses': backgroundProcesses},
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-code',
          name: 'acme-web',
          type: RemoteWorkspaceType.singleRepo,
        ),
        RemoteWorkspace(
          localId: 'ws-notes',
          name: 'Research',
          type: RemoteWorkspaceType.cowork,
        ),
      ],
      worktrees: [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-code',
          branch: 'feature/oauth',
          label: 'otter',
        ),
      ],
      standaloneChats: [
        RemoteStandaloneChat(
          localId: 'notes-1',
          projectLocalId: 'ws-notes',
          title: 'Research notes',
          lastMessageAt: '2026-09-25T10:00:00Z',
          hasUnread: false,
        ),
      ],
      chatSummaries: [
        RemoteChatSummary(
          chatId: 'chat-a',
          scope: RemoteChatScope.worktree,
          title: 'Fix the OAuth redirect',
          workspaceLocalId: 'ws-code',
          worktreeLocalId: 'wt-1',
          lastMessageAt: '2026-09-10T10:00:00Z',
          hasUnread: true,
        ),
        RemoteChatSummary(
          chatId: 'notes-1',
          scope: RemoteChatScope.standalone,
          title: 'Research notes',
          lastMessageAt: '2026-09-25T10:00:00Z',
          pendingQuestions: [AskUserQuestionState(requestId: 'q-1')],
        ),
      ],
    );
  }

  final bool paired;

  @override
  Future<RemoteConnection?> restoreSession() async => paired
      ? RemoteConnection(deviceLabel: 'Studio', pairedAt: DateTime(2026))
      : null;
}

/// An unpaired device whose pairing probe answers when [probe] completes.
final class _DeferredProbeRemoteRepository extends FakeRemoteControlRepository {
  _DeferredProbeRemoteRepository(this.probe);

  final Future<RemoteConnection?> probe;

  @override
  Future<RemoteConnection?> restoreSession() => probe;
}

/// A paired desktop with Personal and organization projects (CAN-4429).
final class _ContextRemoteRepository extends FakeRemoteControlRepository {
  _ContextRemoteRepository() {
    supportsWorktreeChatSummariesScope = true;
    snapshotBuilder = () =>
        RemoteSessionSnapshot.fromJson(workspaceContextShellState());
  }

  @override
  Future<RemoteConnection?> restoreSession() async =>
      RemoteConnection(deviceLabel: 'Studio', pairedAt: DateTime(2026));
}

final class _NoShare implements LinkSharer {
  @override
  Future<void> share({
    required String text,
    String? subject,
    Rect? origin,
  }) async {}
}

/// A paired computer named Studio with a code project that shares its name
/// with the cloud sample project, and a Cowork project (CAN-2932).
final class _DestinationRemoteRepository extends FakeRemoteControlRepository {
  _DestinationRemoteRepository({
    this.paired = true,
    this.status,
    this.emptyOwnerCatalog = false,
  }) {
    snapshotBuilder = () => RemoteSessionSnapshot(
      workspaces: const [
        RemoteWorkspace(
          localId: 'ws-mobile',
          name: 'Mobile App',
          type: RemoteWorkspaceType.singleRepo,
        ),
        RemoteWorkspace(
          localId: 'ws-notes',
          name: 'Research',
          type: RemoteWorkspaceType.cowork,
        ),
      ],
      worktrees: [
        const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-mobile',
          branch: 'feature/login',
          label: 'otter',
        ),
        ...createdWorktrees,
      ],
      standaloneChats: [
        if (emptyOwnerCatalog)
          const RemoteStandaloneChat(
            localId: 'other-owner-chat',
            projectLocalId: 'other-owner',
            title: 'Other owner',
            availableModels: [
              ModelOption(
                id: 'foreign-model',
                label: 'Foreign owner model',
                provider: 'claude',
                kind: 'model',
                available: true,
              ),
            ],
          ),
      ],
      // An existing chat carries the desktop's model catalog.
      chatSummaries: [
        RemoteChatSummary.fromJson({
          'chatId': 'chat-1',
          'scope': 'worktree',
          'workspaceLocalId': 'ws-mobile',
          'worktreeLocalId': 'wt-1',
          'title': 'Login fix',
          'active': true,
          'model': 'claude-opus',
          'modelLabel': 'Claude Opus',
          'providerType': 'claude',
          'thinkingLevel': 'medium',
          'availableModels': emptyOwnerCatalog
              ? []
              : [
                  {
                    'id': 'claude-sonnet',
                    'label': 'Claude Sonnet',
                    'provider': 'claude',
                    'kind': 'model',
                    'available': true,
                    'isDefault': true,
                  },
                  {
                    'id': 'claude-opus',
                    'label': 'Claude Opus',
                    'provider': 'claude',
                    'kind': 'model',
                    'available': true,
                  },
                ],
        }),
      ],
    );
  }

  Future<String> Function()? standaloneCreateHandler;

  @override
  Future<String> createStandaloneChat(RemoteStandaloneChatTarget target) =>
      standaloneCreateHandler?.call() ?? super.createStandaloneChat(target);

  /// Worktrees the desktop reports once a test's create lands.
  final List<RemoteWorktree> createdWorktrees = [];

  final bool paired;
  final bool emptyOwnerCatalog;
  final RemotePortalConnectionStatus? status;

  @override
  Future<RemoteConnection?> restoreSession() async => paired
      ? RemoteConnection(
          deviceLabel: 'Studio',
          pairedAt: DateTime(2026),
          connectionStatus: status,
        )
      : null;
}
