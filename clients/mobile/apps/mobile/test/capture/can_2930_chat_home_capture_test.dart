// Visual evidence for CAN-2930: the app opens on a new chat, and the drawer
// pins a Chat button to its bottom-left corner.
//
// What changed: an organization account used to land on Activity; it now
// lands on the new-chat draft with the menu button in its app bar. The drawer
// gains a high-contrast "Chat" pill that stays put above the scrolling menu.
//
// Run from `apps/mobile`, on the unchanged tree and then on this change:
//
//   CAN2930_CAPTURE=1 CAN2930_STAGE=before flutter test --no-pub test/capture/can_2930_chat_home_capture_test.dart --update-goldens
//   CAN2930_CAPTURE=1 CAN2930_STAGE=after  flutter test --no-pub test/capture/can_2930_chat_home_capture_test.dart --update-goldens
//
// The spec compiles on both trees: it looks up the Chat destination by name
// and falls back to the old landing tab, so the "before" run shows what the
// app opened on before this change. Both color modes come from deterministic
// in-repo fakes; no live account, desktop, agent, or network is involved.
// Output goes to the gitignored `<repo>/.playwright/can-2930/` directory, or
// to `CAN2930_OUT` when set (for running the "before" stage elsewhere).

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
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:provider/provider.dart';

import '../support/cloud_chat_providers.dart';
import '../support/fake_cloud_chat_repository.dart';
import '../support/settings_root_providers.dart';

final bool _captureEnabled = Platform.environment['CAN2930_CAPTURE'] == '1';
final String _stage = Platform.environment['CAN2930_STAGE'] == 'before'
    ? 'before'
    : 'after';
final String _outDir =
    Platform.environment['CAN2930_OUT'] ??
    Directory('../../.playwright/can-2930').absolute.path;

/// Where the organization shell opens on this tree: Chat when it exists.
final HomeTab _landingTab = HomeTab.values.firstWhere(
  (tab) => tab.name == 'chat',
  orElse: () => organizationLandingTab,
);

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
        ...cloudChatTestProviders(
          repository: FakeCloudChatRepository(workspaces: [sampleWorkspace()]),
        ),
        ...buildOrganizationShellProviders('org-1'),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        home: HomeTabControllerProvider(
          tabs: organizationHomeTabs,
          initialTab: _landingTab,
          child: const HomeShell(
            refreshActivity: refreshActivityFeed,
            activityAccount: watchActivityAccount,
          ),
        ),
      ),
    ),
  );
  final list = tester
      .element(find.byType(HomeShell))
      .read<CloudChatsViewModel>();
  await list.load();
  await list.ensureModels();
  await tester.pumpAndSettle();
}

Future<void> _capture(WidgetTester tester, String name) async {
  if (!_captureEnabled) return;
  Directory(_outDir).createSync(recursive: true);
  await expectLater(
    find.byType(HomeShell),
    matchesGoldenFile(Uri.file('$_outDir/$name-$_stage.png')),
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

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    final label = mode.name;

    testWidgets('app landing screen and drawer in $label mode', (tester) async {
      await _pumpShell(tester, mode);

      expect(find.byTooltip('Open navigation menu'), findsOneWidget);
      if (_stage == 'after') {
        expect(
          find.byKey(const ValueKey('cloud-new-chat-screen')),
          findsOneWidget,
        );
      }
      await _capture(tester, 'landing-$label');

      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('home-new-chat-button')),
        _stage == 'after' ? findsOneWidget : findsNothing,
      );
      expect(tester.takeException(), isNull);
      await _capture(tester, 'drawer-$label');
    });
  }
}
