// CAN-4449 — device flow for the merged Settings page. Run from apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_4449_settings_device_test.dart \
//     -d <device-id>
//
// It mounts the production HomeShell with main.dart's shared and
// organization shell providers BELOW MaterialApp, where production puts
// them, so every drill-down must borrow the shell's view models. The drawer
// opens Settings; the flow changes the appearance, toggles push, opens each
// drill-down and returns, creates an API key, edits the name, opens
// feedback, licenses and Developer options, and signs out.
//
// Data is synthetic: empty API base URLs select main.dart's mock
// repositories. No account, desktop or network is used. Screenshots live in
// the separate capture harness.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/main.dart'
    show
        buildOrganizationShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:provider/provider.dart';

import '../test/support/cloud_chat_providers.dart';
import '../test/support/settings_root_providers.dart';

Future<AuthViewModel> _pumpShell(WidgetTester tester) async {
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
  await auth.signInWithSocial(SocialProvider.google);
  const mode = AuthenticatedShellMode.organization;
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
        Provider<FeedbackReportRepository>.value(
          value: MockFeedbackReportRepository(latency: Duration.zero),
        ),
        ...settingsRootTestProviders(),
      ],
      child: Consumer<ThemeController>(
        builder: (context, theme, _) => MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: theme.mode,
          home: MultiProvider(
            providers: [
              ...buildSharedShellProviders(),
              ...cloudChatTestProviders(),
              ...buildOrganizationShellProviders('org-1'),
            ],
            child: HomeTabControllerProvider(
              tabs: homeTabsForShellMode(mode, hasTeams: true),
              initialTab: HomeTab.remote,
              child: HomeShell(
                refreshActivity: refreshActivityFeed,
                activityAccount: watchActivityAccount,

                membersTab: membersTabForShellMode(mode, hasTeams: true),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return auth;
}

/// Scrolls the Settings list from the top until [finder] is built, centers
/// it clear of the overlaid app bar, then taps it.
Future<void> _tapRow(WidgetTester tester, Finder finder) async {
  final page = find.byType(Scrollable).first;
  tester.state<ScrollableState>(page).position.jumpTo(0);
  await tester.pumpAndSettle();
  await tester.scrollUntilVisible(finder, 200, scrollable: page);
  await Scrollable.ensureVisible(tester.element(finder), alignment: 0.5);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

/// main.dart's mock repositories answer after a real delay, which
/// `pumpAndSettle` does not wait for; pump until [finder] matches.
Future<void> _pumpUntil(WidgetTester tester, Finder finder) async {
  for (var i = 0; i < 50 && finder.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pumpAndSettle();
  expect(finder, findsWidgets);
}

/// A native keyboard animates in after a field autofocuses. Pump until the
/// bottom inset holds still for five frames, so later taps hit the final
/// layout. Hosts without a keyboard settle at once.
Future<void> _pumpUntilInsetSettles(WidgetTester tester) async {
  var inset = tester.view.viewInsets.bottom;
  for (var i = 0, still = 0; i < 30 && still < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    final next = tester.view.viewInsets.bottom;
    still = next == inset ? still + 1 : 0;
    inset = next;
  }
  await tester.pumpAndSettle();
}

Future<void> _back(WidgetTester tester) async {
  await tester.pageBack();
  await tester.pumpAndSettle();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Settings: one page, its menus, drill-downs and actions', (
    tester,
  ) async {
    final auth = await _pumpShell(tester);
    final context = tester.element(find.byType(HomeShell));
    final theme = context.read<ThemeController>();
    final notifications = context.read<NotificationsViewModel>();

    // The drawer's Settings button opens the merged page; no gear remains.
    await tester.tap(find.byTooltip('Open navigation menu').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('home-settings-button')));
    await tester.pumpAndSettle();
    expect(find.text('Settings'), findsOneWidget);
    expect(find.byTooltip('Settings'), findsNothing);

    // Appearance: Dark applies at once; dismissing changes nothing.
    await _tapRow(tester, find.text('Appearance'));
    await tester.tap(find.widgetWithText(PopupMenuItem<ThemeMode>, 'Dark'));
    await tester.pumpAndSettle();
    expect(theme.mode, ThemeMode.dark);
    await _tapRow(tester, find.text('Appearance'));
    await tester.tapAt(const Offset(8, 200));
    await tester.pumpAndSettle();
    expect(theme.mode, ThemeMode.dark);
    await _tapRow(tester, find.text('Appearance'));
    await tester.tap(find.widgetWithText(PopupMenuItem<ThemeMode>, 'System'));
    await tester.pumpAndSettle();
    expect(theme.mode, ThemeMode.system);

    // Push: a tap anywhere on the row toggles it once.
    final pushBefore = notifications.pushEnabled;
    await _tapRow(tester, find.text('Push notifications'));
    expect(notifications.pushEnabled, !pushBefore);
    await _pumpUntil(tester, find.byType(Switch));

    // Each drill-down opens with the shell's data and returns.
    await _tapRow(tester, find.text('Login methods'));
    await _pumpUntil(tester, find.text('Email and password'));
    await _back(tester);

    await _tapRow(tester, find.text('Two-factor authentication'));
    await _pumpUntil(tester, find.text('Enable'));
    await _back(tester);

    await _tapRow(tester, find.text('API keys'));
    await _pumpUntil(tester, find.byTooltip('Revoke'));
    final keyCount = find.byTooltip('Revoke').evaluate().length;
    await tester.tap(find.text('New key'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Synthetic token');
    await tester.tap(find.text('Create'));
    await _pumpUntil(tester, find.text('API key created'));
    await tester.tap(find.text('Done'));
    await _pumpUntil(tester, find.text('Synthetic token'));
    expect(find.byTooltip('Revoke'), findsNWidgets(keyCount + 1));
    await _back(tester);
    expect(find.text('${keyCount + 1}'), findsOneWidget);

    // The pencil badge edits the display name.
    await _tapRow(tester, find.byTooltip('Edit name'));
    await tester.enterText(find.byType(TextField), 'Ada Synthetic');
    await tester.tap(find.text('Save'));
    await _pumpUntil(tester, find.text('Ada Synthetic'));

    // Help and Developer rows open their existing destinations.
    await _tapRow(tester, find.byKey(const ValueKey('send-feedback-tile')));
    final feedback = find.byKey(const ValueKey('feedback-report-sheet'));
    expect(feedback, findsOneWidget);
    // On a device the keyboard opens and the sheet fills the screen, so a
    // tap outside it is not possible. Close it with its own Cancel action.
    await _pumpUntilInsetSettles(tester);
    final cancel = find.descendant(
      of: feedback,
      matching: find.widgetWithText(TextButton, 'Cancel'),
    );
    await tester.ensureVisible(cancel);
    await tester.pumpAndSettle();
    await tester.tap(cancel);
    await tester.pumpAndSettle();
    expect(feedback, findsNothing);

    await _tapRow(tester, find.byKey(const ValueKey('open-source-licenses')));
    expect(find.byType(LicensePage), findsOneWidget);
    await _back(tester);

    await _tapRow(
      tester,
      find.byKey(const ValueKey('developer-options-button')),
    );
    expect(find.text('Design system'), findsOneWidget);
    await _back(tester);

    // Sign out runs the existing flow once.
    await _tapRow(tester, find.text('Sign out'));
    expect(auth.status, AuthStatus.unauthenticated);
    expect(tester.takeException(), isNull);
  });
}
