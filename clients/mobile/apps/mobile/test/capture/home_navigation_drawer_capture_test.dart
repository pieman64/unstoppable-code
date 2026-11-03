// Visual evidence for the mobile home-navigation drawer.
//
// What changed: the side menu opens with one uninterrupted swipe from anywhere
// in the content. The same center-origin swipe is replayed before and after.
//
// Run from `apps/mobile`:
//
//   HOME_DRAWER_CAPTURE=1 HOME_DRAWER_STAGE=before flutter test --no-pub test/capture/home_navigation_drawer_capture_test.dart --update-goldens
//   HOME_DRAWER_CAPTURE=1 HOME_DRAWER_STAGE=after  flutter test --no-pub test/capture/home_navigation_drawer_capture_test.dart --update-goldens
//
// Both color modes are captured from deterministic in-repo repositories; no
// live account, desktop, agent, or network is involved. Output is written to
// the gitignored `<repo>/.playwright/mobile-home-drawer/` directory.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/main.dart'
    show
        buildOrganizationShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:provider/provider.dart';

import '../support/cloud_chat_providers.dart';
import '../support/settings_root_providers.dart';

final bool _captureEnabled = Platform.environment['HOME_DRAWER_CAPTURE'] == '1';
final String _stage = Platform.environment['HOME_DRAWER_STAGE'] == 'before'
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
  HomeTab? initialTab,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  AppConfig.configureEnvironmentController(
    ApiEnvironmentController(
      productionBaseUrl: '',
      stagingBaseUrl: '',
      initialEnvironment: ApiEnvironment.production,
      preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
    ),
  );

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
        ...buildOrganizationShellProviders('org-1'),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        home: HomeTabControllerProvider(
          tabs: organizationHomeTabs,
          initialTab: initialTab,
          child: const HomeShell(
            refreshActivity: refreshActivityFeed,
            activityAccount: watchActivityAccount,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _capture(WidgetTester tester, String name) => expectLater(
  find.byType(HomeShell),
  matchesGoldenFile('../../../../.playwright/mobile-home-drawer/$name.png'),
);

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

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    final label = mode.name;
    testWidgets('open home drawer in $label mode', (tester) async {
      await _pumpShell(tester, mode);

      expect(find.byTooltip('Open navigation menu'), findsOneWidget);
      if (_captureEnabled) {
        Directory(
          '../../.playwright/mobile-home-drawer',
        ).createSync(recursive: true);
        await _capture(tester, 'home-screen-menu-button-$_stage-$label');
      }

      final gesture = await tester.startGesture(const Offset(140, 300));
      for (var i = 0; i < 10; i++) {
        await gesture.moveBy(const Offset(22, 0));
        await tester.pump(const Duration(milliseconds: 16));
        if (_captureEnabled && i == 5) {
          await _capture(tester, 'home-drawer-partial-$_stage-$label');
        }
      }
      await gesture.up();
      await tester.pumpAndSettle();
      if (_stage == 'after') {
        expect(tester.getTopLeft(find.byType(IndexedStack)).dx, 326);
      }
      expect(tester.takeException(), isNull);

      if (_captureEnabled) {
        await _capture(tester, 'home-drawer-$_stage-$label');
      }
    });

    testWidgets('open home drawer over Usage pager in $label mode', (
      tester,
    ) async {
      await _pumpShell(tester, mode, initialTab: HomeTab.usage);
      expect(find.byType(TabBarView), findsOneWidget);

      final gesture = await tester.startGesture(const Offset(1, 300));
      for (var i = 0; i < 12; i++) {
        await gesture.moveBy(const Offset(25, 0));
        await tester.pump(const Duration(milliseconds: 16));
      }
      await gesture.up();
      await tester.pumpAndSettle();

      final cardOffset = tester.getTopLeft(find.byType(IndexedStack)).dx;
      expect(cardOffset, _stage == 'before' ? 0 : 326);
      expect(tester.takeException(), isNull);
      if (_captureEnabled) {
        Directory(
          '../../.playwright/mobile-home-drawer',
        ).createSync(recursive: true);
        await _capture(tester, 'usage-edge-swipe-$_stage-$label');
      }
    });
  }
}
