/// Mounts the production authenticated shell with Remote Control paired to a
/// synthetic Portal desktop ([FakePortalSessionServer]) and opens Settings.
/// Shared by the CAN-3636 widget capture, device capture and device flow so
/// all three exercise the same composition: `buildSharedShellProviders`,
/// with only the Remote Control repository replaced by the real HTTP
/// repository talking to the fake server, and Account's usage source
/// re-derived from it by `buildProviderUsageSourceProvider`.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/main.dart'
    show
        buildNoOrganizationShellProviders,
        buildOrganizationShellProviders,
        buildProviderUsageSourceProvider,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import 'cloud_chat_providers.dart';
import 'remote_session_fake_server.dart';
import 'settings_root_providers.dart';

/// A paired desktop announcing the `provider_usage` capability.
FakePortalSessionServer usageLimitsServer({
  required Map<String, dynamic>? providerUsage,
  Map<String, bool> capabilities = const {'provider_usage': true},
}) => FakePortalSessionServer()
  ..addSession(
    id: 'sess-a',
    clientName: 'Desktop A',
    eventCursor: 40,
    capabilities: capabilities,
    providerUsage: providerUsage,
  );

/// Pumps the shell, waits for the pairing, and opens Settings from the menu.
Future<RemoteControlViewModel> pumpUsageLimitsShell(
  WidgetTester tester, {
  required FakePortalSessionServer server,
  required ThemeMode themeMode,
  AuthenticatedShellMode mode = AuthenticatedShellMode.organization,
}) async {
  AppConfig.configureEnvironmentController(
    ApiEnvironmentController(
      productionBaseUrl: '',
      stagingBaseUrl: '',
      initialEnvironment: ApiEnvironment.production,
      preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
    ),
  );
  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
  );
  await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));
  final remote = RemoteControlViewModel(
    repository: server.repository(),
    stateRefreshDebounce: Duration.zero,
  );
  final organization = mode == AuthenticatedShellMode.organization;
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
        ...buildSharedShellProviders(),
        // Later providers shadow earlier ones: the shell's own Remote Control
        // view model is replaced by one paired to the synthetic desktop, and
        // Account's usage source is derived from the replacement.
        ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
        buildProviderUsageSourceProvider(),
        ...cloudChatTestProviders(),
        ...settingsRootTestProviders(),
        if (organization)
          ...buildOrganizationShellProviders('org-1')
        else
          ...buildNoOrganizationShellProviders(),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        home: HomeTabControllerProvider(
          tabs: homeTabsForShellMode(mode, hasTeams: false),
          initialTab: HomeTab.remote,
          child: HomeShell(
            refreshActivity: refreshActivityFeed,
            activityAccount: watchActivityAccount,

            membersTab: membersTabForShellMode(mode, hasTeams: false),
          ),
        ),
      ),
    ),
  );
  for (var i = 0; i < 40 && !remote.isConnected; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(remote.isConnected, isTrue, reason: 'synthetic desktop paired');
  await proveUsageLimitsDelivery(tester, server);
  await tester.pump(const Duration(milliseconds: 300));
  await tester.tap(find.byTooltip('Open navigation menu').first);
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
  await tester.tap(find.byKey(const ValueKey('home-settings-button')));
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
  expect(find.text('Settings'), findsWidgets);
  return remote;
}

/// Answers the first held long-poll with an empty batch, so this phone's
/// delivery reads live, as the production stream's primer makes it, instead
/// of drifting to reconnecting while the fake holds every poll.
Future<void> proveUsageLimitsDelivery(
  WidgetTester tester,
  FakePortalSessionServer server, {
  String sessionId = 'sess-a',
}) async {
  for (var i = 0; i < 40 && server.heldPolls(sessionId) == 0; i++) {
    await tester.pump(const Duration(milliseconds: 10));
  }
  expect(server.heldPolls(sessionId), greaterThan(0), reason: 'polling');
  server.answerIdle(sessionId);
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 10));
  }
}

/// Releases the fake server and the shell so no request outlives the test.
Future<void> unmountUsageLimitsShell(
  WidgetTester tester,
  FakePortalSessionServer server,
  RemoteControlViewModel remote,
) async {
  server.close();
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 100));
  remote.dispose();
}
