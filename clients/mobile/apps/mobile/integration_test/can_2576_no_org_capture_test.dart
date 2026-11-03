import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/main.dart'
    show
        buildNoOrganizationShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/home/views/no_organization_screen.dart';
import 'package:mobile/ui/features/home/views/organizations_unavailable_screen.dart';
import '../test/support/settings_root_providers.dart';

/// Captures the shells a signed-in account with no organization sees
/// (CAN-2576), for design/marketing/QA review. Visual evidence only — durable
/// regression coverage lives in the `flutter test` suite (home_shell_test,
/// no_organization_screen_test, organizations_unavailable_screen_test,
/// authenticated_shell_test, home_tab_controller_test).
///
/// Unlike promo_screenshots_test.dart this does not drive `app.main()`: these
/// states need `hasAuthApiConfig == true` plus a real signed-in account with no
/// organization, and demo mode deliberately forces mock mode, so they are
/// unreachable on a simulator through the real entry point. The widget tree is
/// composed directly instead, from the very same provider builders `_shell`
/// uses (`buildSharedShellProviders` / `buildNoOrganizationShellProviders`), so
/// there is no duplicated list here to drift out of sync. Empty API base URLs
/// make `AppConfig.hasAuthApiConfig` false, which is what resolves every
/// repository in those builders to its `Mock*` implementation.
///
///   xcrun simctl ui `DEVICE_ID` appearance dark   # or light
///   flutter drive --driver=test_driver/integration_test.dart \
///     --target=integration_test/can_2576_no_org_capture_test.dart -d `DEVICE_ID`
///
/// Captures land in build/promo_screenshots/.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Empty base URLs => hasAuthApiConfig false => every repository builder in
    // main.dart resolves to its Mock* implementation. No network, no real
    // account data, deterministic captures.
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: '',
        stagingBaseUrl: '',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
  });

  Widget wrap({required Widget child, required List<HomeTab> tabs}) =>
      MultiProvider(
        providers: [
          ...settingsRootTestProviders(),
          ChangeNotifierProvider<AuthViewModel>(
            create: (_) => AuthViewModel(
              repository: MockAuthRepository(latency: Duration.zero),
            ),
          ),
          ...buildSharedShellProviders(),
          ...buildNoOrganizationShellProviders(),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: HomeTabControllerProvider(tabs: tabs, child: child),
        ),
      );

  testWidgets('capture the no-organization shells', (tester) async {
    Future<void> switchTab(HomeTab tab) async {
      // A Settings destination shows a back button instead of the menu
      // button (CAN-3558).
      final back = find.byTooltip('Back');
      if (back.evaluate().isNotEmpty) {
        await tester.tap(back);
        await tester.pumpAndSettle();
      }
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      // Account has no menu row; the pinned Settings cog opens it, and the
      // Settings destinations open from Account.
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
      await tester.pumpAndSettle(const Duration(seconds: 1));
      if (fromAccount) {
        await tester.tap(find.byKey(ValueKey('account-nav-${tab.name}')));
        await tester.pumpAndSettle(const Duration(seconds: 1));
      }
    }

    // 1. What an individual/Pro account lands on: the Remote tab, working.
    await tester.pumpWidget(
      wrap(
        tabs: noOrganizationHomeTabs,
        child: const HomeShell(
          refreshActivity: refreshActivityFeed,
          activityAccount: watchActivityAccount,
          membersTab: NoOrganizationScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle(const Duration(seconds: 1));
    await binding.takeScreenshot('can2576-no-org-remote-landing');

    // 2. The Members tab: create-an-org CTA, opened from Account.
    await switchTab(HomeTab.members);
    await binding.takeScreenshot('can2576-no-org-members-tab');

    // 3. The Account tab, reachable at last (it holds sign-out).
    await switchTab(HomeTab.account);
    await binding.takeScreenshot('can2576-no-org-account-tab');

    // 4. The distinct load-failure state: Retry, never "create an org". Same
    // three-tab shell, so Remote and Account stay reachable when the teams API
    // is flag-gated off and retrying can never succeed.
    await tester.pumpWidget(
      wrap(
        tabs: noOrganizationHomeTabs,
        child: const HomeShell(
          refreshActivity: refreshActivityFeed,
          activityAccount: watchActivityAccount,
          membersTab: OrganizationsUnavailableScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle(const Duration(seconds: 1));
    await switchTab(HomeTab.members);
    await binding.takeScreenshot('can2576-organizations-unavailable');
  });
}
