// The drawer's pinned Settings button keeps the settings glyph for signed-in
// users, while Account's profile header may show the user's initials.
// From apps/mobile:
// DRAWER_SETTINGS_CAPTURE=1 flutter test --no-pub test/capture/drawer_settings_glyph_capture_test.dart --update-goldens
// Both themes use production shell composition and mock repositories; no
// network. Output goes to the gitignored `<repo>/.playwright/drawer-settings-glyph/`.
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

final bool _captureEnabled =
    Platform.environment['DRAWER_SETTINGS_CAPTURE'] == '1';

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
  required String userName,
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

  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
  );
  await tester.runAsync(
    () => auth.signIn(email: 'ada@example.com', password: 'password'),
  );
  auth.applyProfileName(userName);

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ...settingsRootTestProviders(),
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
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
          tabs: homeTabsForShellMode(
            AuthenticatedShellMode.organization,
            hasTeams: false,
          ),
          initialTab: HomeTab.remote,
          child: HomeShell(
            refreshActivity: refreshActivityFeed,
            activityAccount: watchActivityAccount,

            membersTab: membersTabForShellMode(
              AuthenticatedShellMode.organization,
              hasTeams: false,
            ),
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
  Directory(
    '../../.playwright/drawer-settings-glyph',
  ).createSync(recursive: true);
  await expectLater(
    find.byType(HomeShell),
    matchesGoldenFile(
      '../../../../.playwright/drawer-settings-glyph/$name.png',
    ),
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

    testWidgets('Settings glyph and Account header in $label', (tester) async {
      await _pumpShell(tester, theme, userName: 'Ada Lovelace');

      await _openMenu(tester);
      await _capture(tester, 'drawer-settings-$label');
      await tester.tap(find.byKey(const ValueKey('home-settings-button')));
      await tester.pumpAndSettle();
      await _capture(tester, 'account-$label');
      expect(tester.takeException(), isNull);
    }, skip: !_captureEnabled);

    testWidgets('Settings glyph for a blank name in $label', (tester) async {
      await _pumpShell(tester, theme, userName: ' ');

      await _openMenu(tester);
      await _capture(tester, 'drawer-blank-name-$label');
      expect(tester.takeException(), isNull);
    }, skip: !_captureEnabled);
  }
}
