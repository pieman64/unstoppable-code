// CAN-2864: solo accounts start on Remote Control instead of organization setup.
// From apps/mobile, before and after changing production code:
// CAN2864_CAPTURE=1 CAN2864_STAGE=before flutter test --no-pub test/capture/can_2864_solo_landing_capture_test.dart --update-goldens
// CAN2864_CAPTURE=1 CAN2864_STAGE=after flutter test --no-pub test/capture/can_2864_solo_landing_capture_test.dart --update-goldens
// Both themes use production shell composition and mock repositories; no network.
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
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:provider/provider.dart';

import '../support/cloud_chat_providers.dart';
import '../support/settings_root_providers.dart';

final bool _captureEnabled = Platform.environment['CAN2864_CAPTURE'] == '1';
final String _stage = Platform.environment['CAN2864_STAGE'] == 'before'
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

Future<void> _pumpShell(WidgetTester tester, ThemeMode themeMode) async {
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
        ...buildNoOrganizationShellProviders(),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        home: HomeTabControllerProvider(
          tabs: noOrganizationHomeTabs,
          initialTab: noOrganizationLandingTab,
          child: HomeShell(
            refreshActivity: refreshActivityFeed,
            activityAccount: watchActivityAccount,

            membersTab: membersTabForShellMode(
              AuthenticatedShellMode.noOrganization,
              hasTeams: false,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _capture(WidgetTester tester, String name) => expectLater(
  find.byType(HomeShell),
  matchesGoldenFile('../../../../.playwright/can-2864/$name.png'),
);

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFont('Inter', const ['assets/fonts/inter/InterVariable.ttf']);
    await _loadFont('MaterialIcons', const [
      'build/unit_test_assets/fonts/MaterialIcons-Regular.otf',
    ]);
  });
  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    testWidgets('solo account landing ${mode.name}', (tester) async {
      await _pumpShell(tester, mode);
      expect(tester.testTextInput.isVisible, isFalse);
      expect(tester.takeException(), isNull);
      Directory('../../.playwright/can-2864').createSync(recursive: true);
      await _capture(tester, 'solo-landing-$_stage-${mode.name}');
    }, skip: !_captureEnabled);
  }
}
