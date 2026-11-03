// CAN-3558: the drawer shows the brand wordmark, and Activity, Usage, and
// Members move from drawer rows into Account, which the Settings cog opens.
// From apps/mobile, before and after changing production code:
// CAN3558_CAPTURE=1 CAN3558_STAGE=before flutter test --no-pub test/capture/can_3558_settings_destinations_capture_test.dart --update-goldens
// CAN3558_CAPTURE=1 CAN3558_STAGE=after flutter test --no-pub test/capture/can_3558_settings_destinations_capture_test.dart --update-goldens
// Both themes use production shell composition and mock repositories; no
// network. The spec reaches Activity through Account when Account lists it and
// through the drawer otherwise, so the same file runs on both stages.
// This capture is visual evidence; durable coverage lives in home_shell_test.dart.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/main.dart'
    show
        buildNoOrganizationShellProviders,
        buildOrganizationShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:provider/provider.dart';

import '../support/cloud_chat_providers.dart';
import '../support/settings_root_providers.dart';

final bool _captureEnabled = Platform.environment['CAN3558_CAPTURE'] == '1';
final String _stage = Platform.environment['CAN3558_STAGE'] == 'before'
    ? 'before'
    : 'after';

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
}

Future<void> _pumpShell(
  WidgetTester tester,
  ThemeMode themeMode, {
  required AuthenticatedShellMode mode,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
  addTearDown(tester.view.reset);

  AppConfig.configureEnvironmentController(
    ApiEnvironmentController(
      productionBaseUrl: '',
      stagingBaseUrl: '',
      initialEnvironment: ApiEnvironment.production,
      preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
    ),
  );

  final organization = mode == AuthenticatedShellMode.organization;
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ...settingsRootTestProviders(),
        ChangeNotifierProvider<AuthViewModel>(
          create: (_) => AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
          ),
        ),
        ...buildSharedShellProviders(),
        ...cloudChatTestProviders(),
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
          // Remote is a drawer row on both stages, so every capture starts
          // from the same screen.
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
  await tester.pumpAndSettle();
}

Future<void> _openMenu(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Open navigation menu'));
  await tester.pumpAndSettle();
}

Future<void> _capture(WidgetTester tester, String name) async {
  if (!_captureEnabled) return;
  Directory('../../.playwright/can-3558').createSync(recursive: true);
  await expectLater(
    find.byType(HomeShell),
    matchesGoldenFile('../../../../.playwright/can-3558/$name.png'),
  );
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFont('Inter', const ['assets/fonts/inter/InterVariable.ttf']);
    await _loadFont('JetBrainsMono', const [
      'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
    ]);
    final flutterRoot = File(
      Platform.resolvedExecutable,
    ).parent.parent.parent.parent.parent.path;
    await _loadFont('MaterialIcons', [
      'build/unit_test_assets/fonts/MaterialIcons-Regular.otf',
      '$flutterRoot/bin/cache/artifacts/material_fonts/'
          'MaterialIcons-Regular.otf',
    ]);
  });

  for (final theme in [ThemeMode.light, ThemeMode.dark]) {
    final label = theme.name;

    testWidgets(
      'organization drawer, Account, and Activity in $label',
      (tester) async {
        await _pumpShell(
          tester,
          theme,
          mode: AuthenticatedShellMode.organization,
        );

        await _openMenu(tester);
        await _capture(tester, 'org-drawer-$_stage-$label');
        await tester.tap(find.byKey(const ValueKey('home-settings-button')));
        await tester.pumpAndSettle();
        await _capture(tester, 'org-account-$_stage-$label');

        final accountRow = find.byKey(const ValueKey('account-nav-activity'));
        if (accountRow.evaluate().isNotEmpty) {
          await tester.tap(accountRow);
        } else {
          await _openMenu(tester);
          await tester.tap(find.byKey(const ValueKey('home-nav-activity')));
        }
        await tester.pumpAndSettle();
        await _capture(tester, 'org-activity-$_stage-$label');
        expect(tester.takeException(), isNull);
      },
      skip: !_captureEnabled,
    );

    testWidgets('no-organization drawer and Account in $label', (tester) async {
      await _pumpShell(
        tester,
        theme,
        mode: AuthenticatedShellMode.noOrganization,
      );

      await _openMenu(tester);
      await _capture(tester, 'no-org-drawer-$_stage-$label');
      await tester.tap(find.byKey(const ValueKey('home-settings-button')));
      await tester.pumpAndSettle();
      await _capture(tester, 'no-org-account-$_stage-$label');
      expect(tester.takeException(), isNull);
    }, skip: !_captureEnabled);
  }
}
