// Settings and its drill-downs at phone widths and the largest tested text
// scale, measured with the real Inter font. The default test font has
// different glyph widths, so overflow that users see only reproduces with
// the shipped font loaded.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/account_screen.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:provider/provider.dart';

import '../../../../support/fake_provider_usage_source.dart';
import '../../../../support/settings_root_providers.dart';

Future<void> _loadInter() async {
  final bytes = ByteData.sublistView(
    await File('assets/fonts/inter/InterVariable.ttf').readAsBytes(),
  );
  await (FontLoader('Inter')..addFont(Future.value(bytes))).load();
}

Future<void> _pumpSettings(
  WidgetTester tester, {
  required ThemeData theme,
  required Size size,
  required double scale,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
  );
  await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        Provider<FeedbackReportRepository>.value(
          value: MockFeedbackReportRepository(latency: Duration.zero),
        ),
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
        ListenableProvider<ProviderUsageSource>(
          create: (_) => FakeProviderUsageSource(),
        ),
        ChangeNotifierProvider<ApiKeysViewModel>(
          create: (_) => ApiKeysViewModel(
            repository: MockApiKeysRepository(latency: Duration.zero),
          )..load(),
        ),
        ChangeNotifierProvider<TwoFactorViewModel>(
          create: (_) => TwoFactorViewModel(
            repository: MockTwoFactorRepository(latency: Duration.zero),
            issuer: 'Test',
          )..load(),
        ),
        ChangeNotifierProvider<ProfileViewModel>(
          create: (_) => ProfileViewModel(
            repository: MockProfileRepository(latency: Duration.zero),
          ),
        ),
        ChangeNotifierProvider<AuthSourcesViewModel>(
          create: (_) => AuthSourcesViewModel(
            repository: MockAuthSourcesRepository(latency: Duration.zero),
          )..load(),
        ),
        ...settingsRootTestProviders(),
      ],
      child: MaterialApp(
        theme: theme,
        home: HomeTabControllerProvider(
          tabs: organizationHomeTabs,
          initialTab: HomeTab.account,
          child: const AccountScreen(showDeveloperOptions: true),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// Scrolls the current screen to its end, checking each step for overflow
/// and every visible row for a touch target of at least 48 dp.
Future<void> _scrollThrough(WidgetTester tester) async {
  final scrollable = find.byType(Scrollable).last;
  for (var i = 0; i < 30; i++) {
    expect(tester.takeException(), isNull);
    for (final row in find.byType(CanopySettingsRow).evaluate()) {
      final box = row.renderObject! as RenderBox;
      expect(box.size.height, greaterThanOrEqualTo(48));
    }
    final position = tester.state<ScrollableState>(scrollable).position;
    if (position.pixels >= position.maxScrollExtent) break;
    await tester.drag(scrollable, const Offset(0, -300));
    await tester.pumpAndSettle();
  }
  expect(tester.takeException(), isNull);
}

void main() {
  setUpAll(_loadInter);

  for (final theme in [AppTheme.light, AppTheme.dark]) {
    for (final size in const [Size(390, 844), Size(320, 700)]) {
      for (final scale in const [1.0, 3.0]) {
        final name =
            '${size.width.toInt()} px at text scale ${scale.toInt()} '
            '(${theme.brightness.name})';

        testWidgets('Settings and its drill-downs fit $name', (tester) async {
          await _pumpSettings(tester, theme: theme, size: size, scale: scale);
          expect(find.text('Settings'), findsOneWidget);
          await _scrollThrough(tester);

          for (final title in const [
            'Login methods',
            'Two-factor authentication',
            'API keys',
          ]) {
            final row = find.text(title);
            final page = find.byType(Scrollable).first;
            tester.state<ScrollableState>(page).position.jumpTo(0);
            await tester.pumpAndSettle();
            await tester.scrollUntilVisible(row, 100, scrollable: page);
            // Center it: the app bar overlays the top of the list.
            await Scrollable.ensureVisible(tester.element(row), alignment: 0.5);
            await tester.pumpAndSettle();
            await tester.tap(row);
            await tester.pumpAndSettle();
            await _scrollThrough(tester);
            await tester.pageBack();
            await tester.pumpAndSettle();
          }
        });
      }
    }
  }
}
