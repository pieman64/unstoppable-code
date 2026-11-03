// Visual-evidence capture for the non-production Developer options flow.
//
// What changes: Settings gains a non-production-only Developer options
// entry. It opens Design system, whose Icons reference renders every glyph in
// the branch's generated Canopy icon catalog.
//
// Run both stages from `apps/mobile`:
//
//   DEVELOPER_OPTIONS_STAGE=before flutter test test/capture/developer_options_capture_test.dart --update-goldens
//   DEVELOPER_OPTIONS_STAGE=after  flutter test test/capture/developer_options_capture_test.dart --update-goldens
//
// The before stage uses AccountScreen's production override to render the exact
// gated-off state. The after stage walks the real navigation flow. Both stages
// use in-repo mock repositories with no live account, service, or network.
// Output is written to the gitignored `<repo>/.playwright/developer-options/`.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/account_screen.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:provider/provider.dart';

import '../support/fake_provider_usage_source.dart';

final String? _requestedStage = Platform.environment['DEVELOPER_OPTIONS_STAGE'];
final String _stage = switch (_requestedStage) {
  null || 'after' => 'after',
  'before' => 'before',
  final value => throw ArgumentError.value(
    value,
    'DEVELOPER_OPTIONS_STAGE',
    'must be either "before" or "after"',
  ),
};

String _capture(String name, String theme) =>
    '../../../../.playwright/developer-options/$name-$_stage-$theme.png';

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
  if (_requestedStage == null) return;
  throw StateError(
    'No font found for "$family". Checked: '
    '${candidates.where((path) => path.isNotEmpty).join(', ')}',
  );
}

Future<void> _pumpAccount(WidgetTester tester, ThemeMode themeMode) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        // Account's Usage limits row reads the paired desktop's plan usage.
        ListenableProvider<ProviderUsageSource>(
          create: (_) => FakeProviderUsageSource(),
        ),
        Provider<FeedbackReportRepository>.value(
          value: MockFeedbackReportRepository(latency: Duration.zero),
        ),
        ChangeNotifierProvider<AuthViewModel>(
          create: (_) => AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
          ),
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
        ChangeNotifierProvider<ProfileViewModel>(
          create: (_) => ProfileViewModel(
            repository: MockProfileRepository(latency: Duration.zero),
          ),
        ),
        ChangeNotifierProvider<TwoFactorViewModel>(
          create: (_) => TwoFactorViewModel(
            repository: MockTwoFactorRepository(latency: Duration.zero),
            issuer: 'Capture',
          )..load(),
        ),
        ChangeNotifierProvider<ThemeController>(
          create: (_) => ThemeController(store: InMemoryThemePreferenceStore()),
        ),
        ChangeNotifierProvider<NotificationsViewModel>(
          create: (_) => NotificationsViewModel(
            repository: MockNotificationPreferencesRepository(
              latency: Duration.zero,
            ),
            isConfigured: () => true,
          ),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        home: AccountScreen(showDeveloperOptions: _stage == 'after'),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _writeCapture(Finder surface, String name, String theme) async {
  if (_requestedStage == null) return;
  Directory('../../.playwright/developer-options').createSync(recursive: true);
  await expectLater(surface, matchesGoldenFile(_capture(name, theme)));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFont('Roboto', const [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Supplemental/Verdana.ttf',
      '/Library/Fonts/Arial.ttf',
    ]);
    await _loadFont('MaterialIcons', <String>[
      if (Platform.environment['FLUTTER_ROOT'] case final root?)
        '$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
      for (final launcher in [
        '/opt/homebrew/bin/flutter',
        '/usr/local/bin/flutter',
      ])
        if (File(launcher).existsSync())
          '${File(launcher).resolveSymbolicLinksSync().replaceFirst(RegExp(r'/flutter$'), '')}/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    ]);
  });

  for (final (theme, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('Developer options flow ($theme)', (tester) async {
      await _pumpAccount(tester, mode);

      final target = _stage == 'after'
          ? find.text('Developer options')
          : find.text('Sign out');
      await tester.scrollUntilVisible(
        target,
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await _writeCapture(find.byType(Scaffold).first, 'account', theme);

      if (_stage == 'before') {
        expect(find.text('Developer options'), findsNothing);
        return;
      }

      await tester.tap(find.text('Developer options'));
      await tester.pumpAndSettle();
      await _writeCapture(
        find.byType(Scaffold).last,
        'developer-options',
        theme,
      );

      await tester.tap(find.text('Design system'));
      await tester.pumpAndSettle();
      await _writeCapture(find.byType(Scaffold).last, 'design-system', theme);

      await tester.tap(find.text('Icons'));
      await tester.pumpAndSettle();
      expect(find.text('agent'), findsOneWidget);
      await _writeCapture(find.byType(Scaffold).last, 'icons', theme);
      expect(tester.takeException(), isNull);
    });
  }
}
