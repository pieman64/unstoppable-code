// CAN-4429 — device verification for the Personal/organization workspace
// context. Run from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_4429_workspace_context_device_test.dart \
//     -d <device-id>
//
// Then prove the saved choice survives a cold relaunch. `flutter drive`
// uninstalls the app after a run, which would clear its preferences, so run
// the first pass with --keep-app-running, stop the app, and run again:
//
//   flutter drive ... --keep-app-running -d <device-id>
//   adb -s <device-id> shell am force-stop com.unstoppabledomains.canopy
//   flutter drive ... --dart-define=CAN4429_STAGE=relaunch -d <device-id>
//
// For a screen recording, add --dart-define=CAN4429_RECORDING=true: only the
// navigation flow runs, paced for video, with no screenshots or surface
// conversion. Captures otherwise land in build/promo_screenshots.
//
// The production Remote Control repository talks to a synthetic Portal server
// (`remote_session_fake_server.dart`) whose desktop holds Personal and
// organization projects (`workspace_context_fixture.dart`). Organizations come
// from a synthetic loader and the choice is saved in the device's real
// preferences. No real account, desktop or network is involved. The shell is
// composed the way `AuthGate` composes it: one key per context, with the
// notification binding above it.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/org_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/data/services/workspace_context_store.dart';
import 'package:mobile/main.dart'
    show
        buildOrganizationShellProviders,
        buildProviderUsageSourceProvider,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/organizations/view_models/org_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/chat_search_screen.dart';
import 'package:mobile/ui/features/remote/views/push_tap_binding.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/support/cloud_chat_providers.dart';
import '../test/support/remote_session_fake_server.dart';
import '../test/support/settings_root_providers.dart';
import '../test/support/workspace_context_fixture.dart';
import '../test/support/account_organizations_fixture.dart';

const _stage = String.fromEnvironment('CAN4429_STAGE');
const _recording = bool.fromEnvironment('CAN4429_RECORDING');
const _relaunch = _stage == 'relaunch';

const _account = 'context@example.test';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    // Empty base URLs keep every organization repository on its mock, so the
    // shell never reaches a network. The shell mode below is resolved as for
    // a configured server.
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: '',
        stagingBaseUrl: '',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
    // Each flow starts from a fresh install's preferences, except the
    // relaunch run, which reads what the previous run saved.
    if (!_relaunch) await (await SharedPreferences.getInstance()).clear();
  });

  var memberships = <String, List<OrganizationSummary>>{};
  setUp(() => memberships = {_account: workspaceContextOrganizations()});

  Future<AuthViewModel> signIn(WidgetTester tester) async {
    late final AuthViewModel auth;
    auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
      loadOrganizations: teamsOnly(
        () async => memberships[_account] ?? const [],
      ),
      // The device's real preferences, namespaced like production.
      workspaceContextStore: const SharedPrefsWorkspaceContextStore(
        namespace: 'production',
      ),
    );
    addTearDown(auth.dispose);
    await tester.runAsync(
      () => auth.signIn(email: _account, password: 'password'),
    );
    return auth;
  }

  Future<void> settle(WidgetTester tester, [int frames = 6]) async {
    for (var i = 0; i < frames; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  /// A paced pause so a recording shows each step.
  Future<void> beat(WidgetTester tester) => settle(tester, _recording ? 12 : 6);

  var themeLabel = 'light';
  var surfaceConverted = false;
  Future<void> shot(WidgetTester tester, String name) async {
    if (_recording) return;
    if (!surfaceConverted) {
      await binding.convertFlutterSurfaceToImage();
      surfaceConverted = true;
      await settle(tester, 3);
    }
    await binding.takeScreenshot('can-4429-android-$name-after-$themeLabel');
  }

  /// The authenticated shell, composed like `AuthGate`, over a desktop paired
  /// through the synthetic Portal server.
  Future<
    ({
      FakePortalSessionServer server,
      PushMessageCoordinator coordinator,
      RemoteControlViewModel remote,
    })
  >
  pumpShell(
    WidgetTester tester,
    AuthViewModel auth, {
    ThemeMode mode = ThemeMode.light,
  }) async {
    themeLabel = mode == ThemeMode.dark ? 'dark' : 'light';
    surfaceConverted = false;
    final server = FakePortalSessionServer()
      ..addSession(
        id: 'sess-context',
        clientName: 'Studio',
        capabilities: const {'worktree_chat_summaries_scope': true},
        shellState: workspaceContextShellState(),
      );
    final coordinator = PushMessageCoordinator(messaging: FakePushMessaging());
    unawaited(coordinator.start());
    addTearDown(() => unawaited(coordinator.dispose()));
    final remote = RemoteControlViewModel(
      repository: server.repository(),
      stateRefreshDebounce: Duration.zero,
    );
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AuthViewModel>.value(value: auth),
          workspaceContextProvider(),
          ...settingsRootTestProviders(),
          ...cloudChatTestProviders(),
          ChangeNotifierProvider<OrgViewModel>(
            create: (_) => OrgViewModel(
              repository: MockOrgRepository(latency: Duration.zero),
            ),
          ),
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
          buildProviderUsageSourceProvider(),
          ChangeNotifierProvider<ApiKeysViewModel>(
            create: (_) => ApiKeysViewModel(
              repository: MockApiKeysRepository(latency: Duration.zero),
            ),
          ),
          ChangeNotifierProvider<AuthSourcesViewModel>(
            create: (_) => AuthSourcesViewModel(
              repository: MockAuthSourcesRepository(latency: Duration.zero),
            ),
          ),
          ChangeNotifierProvider<TwoFactorViewModel>(
            create: (_) => TwoFactorViewModel(
              repository: MockTwoFactorRepository(latency: Duration.zero),
              issuer: 'Test',
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: mode,
          debugShowCheckedModeBanner: false,
          home: HomeTabControllerProvider(
            tabs: organizationHomeTabs,
            initialTab: HomeTab.remote,
            child: PushTapBinding(
              coordinator: coordinator,
              selectWorkspaceContext: auth.selectWorkspaceContext,
              workspaceContext: () => auth.workspaceContext,
              child: Consumer<AuthViewModel>(
                builder: (context, auth, _) {
                  final orgId = auth.activeOrgId;
                  final shellMode = resolveAuthenticatedShellMode(
                    hasApiConfig: true,
                    orgId: orgId,
                    hasOrganizations: auth.organizations.isNotEmpty,
                    hasPersonalOrganization:
                        auth.personalOrganizationId != null,
                    organizationsLoadFailed: auth.organizationsLoadFailed,
                  );
                  final shell = HomeShell(
                    refreshActivity: refreshActivityFeed,
                    activityAccount: watchActivityAccount,

                    membersTab: membersTabForShellMode(
                      shellMode,
                      hasTeams: auth.organizations.isNotEmpty,
                    ),
                  );
                  return orgId == null
                      ? KeyedSubtree(
                          key: const ValueKey('personal-context'),
                          child: shell,
                        )
                      : KeyedSubtree(
                          key: ValueKey(orgId),
                          child: MultiProvider(
                            providers: buildOrganizationShellProviders(orgId),
                            child: shell,
                          ),
                        );
                },
              ),
            ),
          ),
        ),
      ),
    );
    await settle(tester, 10);
    expect(remote.isConnected, isTrue);
    return (server: server, coordinator: coordinator, remote: remote);
  }

  Future<void> unmount(
    WidgetTester tester,
    FakePortalSessionServer server,
  ) async {
    server.close();
    await tester.pumpWidget(const SizedBox.shrink());
    await settle(tester, 2);
  }

  Finder project(String id) => find.byKey(ValueKey('workspace-$id'));
  final drawer = find.byKey(const ValueKey('home-navigation-drawer'));
  final contextRow = find.byKey(const ValueKey('home-workspace-context-row'));
  Finder inDrawer(String text) =>
      find.descendant(of: drawer, matching: find.text(text));

  Future<void> openDrawer(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Open navigation menu').hitTestable());
    await beat(tester);
  }

  Future<void> choose(WidgetTester tester, String label) async {
    await tester.tap(contextRow);
    await beat(tester);
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('workspace-context-picker')),
        matching: find.text(label),
      ),
    );
    await beat(tester);
  }

  Future<void> openRemote(WidgetTester tester) async {
    if (drawer.evaluate().isEmpty) await openDrawer(tester);
    await tester.tap(find.byKey(const ValueKey('home-nav-remote')));
    await beat(tester);
  }

  void expectProjects({
    required List<String> shown,
    required List<String> hidden,
  }) {
    for (final id in shown) {
      expect(project(id), findsOneWidget, reason: id);
    }
    for (final id in hidden) {
      expect(project(id), findsNothing, reason: id);
    }
  }

  testWidgets('CAN-4429 Personal shows P and hides Q', (tester) async {
    final auth = await signIn(tester);
    final shell = await pumpShell(tester, auth);

    expect(project('ws-personal'), findsOneWidget);
    expect(project('ws-org-a'), findsNothing);
    await openDrawer(tester);
    expect(
      find.descendant(of: contextRow, matching: find.text('Personal')),
      findsOneWidget,
    );

    await unmount(tester, shell.server);
  }, skip: _relaunch || _recording);

  for (final (label, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets(
      'CAN-4429 each context scopes every list and keeps the connection '
      '($label)',
      (tester) async {
        final auth = await signIn(tester);
        final shell = await pumpShell(tester, auth, mode: mode);
        final session = shell.remote.connection;
        final requestsBefore = shell.server.requests.length;

        // Personal: P and its chats only.
        expectProjects(
          shown: workspaceContextPersonalIds,
          hidden: workspaceContextOrgAIds,
        );
        expect(find.text('Loose chat'), findsOneWidget);
        await shot(tester, 'remote-personal');
        await openDrawer(tester);
        expect(inDrawer('Personal task chat'), findsOneWidget);
        expect(inDrawer('Acme task chat'), findsNothing);
        await shot(tester, 'drawer-personal');
        await tester.tap(contextRow);
        await beat(tester);
        await shot(tester, 'picker');
        await tester.tapAt(const Offset(20, 20));
        await beat(tester);

        // Organization A: Q and its chats only.
        await choose(tester, 'Acme');
        expect(auth.activeOrgId, workspaceContextOrgA);
        await openDrawer(tester);
        expect(
          find.descendant(of: contextRow, matching: find.text('Acme')),
          findsOneWidget,
        );
        expect(inDrawer('Acme task chat'), findsOneWidget);
        expect(inDrawer('Personal task chat'), findsNothing);
        expect(inDrawer('Loose chat'), findsNothing);
        await shot(tester, 'drawer-org-a');
        await openRemote(tester);
        expectProjects(
          shown: workspaceContextOrgAIds,
          hidden: workspaceContextPersonalIds,
        );
        expect(find.text('Acme task'), findsOneWidget);
        expect(find.text('Personal task'), findsNothing);
        await shot(tester, 'remote-org-a');

        // Chat search in A.
        await tester.tap(find.byTooltip('Remote options'));
        await beat(tester);
        await tester.tap(find.text('Search chats'));
        await beat(tester);
        await tester.enterText(
          find.byKey(const ValueKey('chat-search-field')),
          'chat',
        );
        await beat(tester);
        expect(find.text('Acme task chat'), findsOneWidget);
        expect(find.text('Personal task chat'), findsNothing);
        FocusManager.instance.primaryFocus?.unfocus();
        Navigator.of(tester.element(find.byType(ChatSearchScreen))).pop();
        await beat(tester);

        // Organization B: an empty state.
        await openDrawer(tester);
        await choose(tester, 'Bluebird');
        expect(auth.activeOrgId, workspaceContextOrgB);
        await openRemote(tester);
        expect(
          find.byKey(const ValueKey('remote-no-organization-projects')),
          findsOneWidget,
        );
        expectProjects(
          shown: const [],
          hidden: [...workspaceContextPersonalIds, ...workspaceContextOrgAIds],
        );
        await shot(tester, 'remote-org-b');
        await openDrawer(tester);
        await shot(tester, 'drawer-org-b');

        // Back in Personal, organization pages ask for an organization.
        await choose(tester, 'Personal');
        await openDrawer(tester);
        await tester.tap(find.byKey(const ValueKey('home-settings-button')));
        await beat(tester);
        await tester.tap(find.byKey(const ValueKey('account-nav-activity')));
        await beat(tester);
        expect(
          find.byKey(const ValueKey('organization-context-gate')),
          findsOneWidget,
        );
        await shot(tester, 'activity-personal-gate');

        // Switching only re-filtered: same session, no end, no re-pair.
        expect(identical(shell.remote.connection, session), isTrue);
        expect(shell.remote.isConnected, isTrue);
        final requests = shell.server.requests.sublist(requestsBefore);
        expect(requests.where((r) => r.contains('/end')), isEmpty);
        expect(requests.where((r) => r.contains('/connect')), isEmpty);
        expect(tester.takeException(), isNull);
        await unmount(tester, shell.server);
      },
      skip: _relaunch || _recording,
    );
  }

  testWidgets(
    'CAN-4429 a switch closes the open chat; a notification switches context '
    'and opens its chat',
    (tester) async {
      final auth = await signIn(tester);
      auth.switchOrg(workspaceContextOrgA);
      final shell = await pumpShell(tester, auth);
      // Gives the external recorder time to start before the first step.
      if (_recording) await settle(tester, 30);
      await beat(tester);

      // Q's chat is open from Recents in organization A.
      await openDrawer(tester);
      await tester.tap(inDrawer('Acme task chat'));
      await beat(tester);
      expect(find.byType(RemoteChatScreen), findsOneWidget);

      // Choosing Personal closes it and shows the landing draft.
      await openDrawer(tester);
      await choose(tester, 'Personal');
      expect(auth.activeOrgId, isNull);
      expect(find.byType(RemoteChatScreen), findsNothing);
      expect(find.byType(CloudChatScreen), findsOneWidget);
      await beat(tester);

      // A notification for Q's chat switches back to A and opens it.
      shell.coordinator.requestOpen(
        const PushMessage(data: {'clientChatId': 'tab-acme'}),
      );
      await beat(tester);
      await beat(tester);
      expect(auth.activeOrgId, workspaceContextOrgA);
      final chat = tester.widget<RemoteChatScreen>(
        find.byType(RemoteChatScreen),
      );
      expect(chat.worktree?.localId, 'wt-acme');
      expect(chat.initialChatId, 'tab-acme');
      expect(shell.coordinator.pendingTap.value, isNull);
      await beat(tester);
      expect(tester.takeException(), isNull);
      await unmount(tester, shell.server);
    },
    skip: _relaunch,
  );

  testWidgets(
    'CAN-4429 the choice is saved per account and falls back to Personal',
    (tester) async {
      // A fresh install starts in Personal.
      final first = await signIn(tester);
      expect(first.activeOrgId, isNull);
      expect(
        await first.selectWorkspaceContext(_contextA),
        WorkspaceContextSelection.saved,
      );

      // A new view model over the same preferences restores A.
      final restored = await signIn(tester);
      expect(restored.activeOrgId, workspaceContextOrgA);
      final shell = await pumpShell(tester, restored);
      expectProjects(
        shown: workspaceContextOrgAIds,
        hidden: workspaceContextPersonalIds,
      );
      await unmount(tester, shell.server);

      // Account isolation needs distinct user ids, which this mock sign-in
      // does not mint; workspace_context_selection_test.dart covers it.

      // After the user leaves A, the next launch falls back to Personal.
      memberships[_account] = [
        workspaceContextOrganization(workspaceContextOrgB, 'Bluebird'),
      ];
      final left = await signIn(tester);
      expect(left.activeOrgId, isNull);

      // Rejoin and choose A again, for the cold relaunch run.
      memberships[_account] = workspaceContextOrganizations();
      final again = await signIn(tester);
      expect(
        await again.selectWorkspaceContext(_contextA),
        WorkspaceContextSelection.saved,
      );
    },
    skip: _relaunch || _recording,
  );

  testWidgets('CAN-4429 a cold relaunch restores the saved organization', (
    tester,
  ) async {
    final auth = await signIn(tester);
    expect(auth.activeOrgId, workspaceContextOrgA);
    final shell = await pumpShell(tester, auth);
    expectProjects(
      shown: workspaceContextOrgAIds,
      hidden: workspaceContextPersonalIds,
    );
    await unmount(tester, shell.server);
    await (await SharedPreferences.getInstance()).clear();
  }, skip: !_relaunch);
}

const _contextA = WorkspaceContext.organization(workspaceContextOrgA);
