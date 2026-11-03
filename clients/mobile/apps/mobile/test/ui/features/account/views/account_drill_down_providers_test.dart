// Settings' drill-downs (CAN-4449) are pushed on the root navigator, which
// does not see the shell-local account view models. Each route re-provides
// the borrowed instances, so this host mounts those view models BELOW
// `MaterialApp`, where `buildSharedShellProviders()` puts them in production.
// A route that created, replaced or disposed one would fail here.

import 'package:flutter/material.dart';
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
import 'package:provider/provider.dart';

import '../../../../support/fake_provider_usage_source.dart';
import '../../../../support/settings_root_providers.dart';

void main() {
  late ApiKeysViewModel apiKeys;
  late AuthSourcesViewModel authSources;
  late TwoFactorViewModel twoFactor;

  Future<void> pumpSettings(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
    );
    await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));
    apiKeys = ApiKeysViewModel(
      repository: MockApiKeysRepository(latency: Duration.zero),
    )..load();
    authSources = AuthSourcesViewModel(
      repository: MockAuthSourcesRepository(latency: Duration.zero),
    )..load();
    twoFactor = TwoFactorViewModel(
      repository: MockTwoFactorRepository(latency: Duration.zero),
      issuer: 'Test',
    )..load();

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AuthViewModel>.value(value: auth),
          Provider<FeedbackReportRepository>.value(
            value: MockFeedbackReportRepository(latency: Duration.zero),
          ),
          ...settingsRootTestProviders(),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: MultiProvider(
            providers: [
              ListenableProvider<ProviderUsageSource>(
                create: (_) => FakeProviderUsageSource(),
              ),
              ChangeNotifierProvider<ApiKeysViewModel>.value(value: apiKeys),
              ChangeNotifierProvider<AuthSourcesViewModel>.value(
                value: authSources,
              ),
              ChangeNotifierProvider<TwoFactorViewModel>.value(
                value: twoFactor,
              ),
              ChangeNotifierProvider<ProfileViewModel>(
                create: (_) => ProfileViewModel(
                  repository: MockProfileRepository(latency: Duration.zero),
                ),
              ),
            ],
            child: const AccountScreen(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder valueOf(String title) => find.descendant(
    of: find.widgetWithText(CanopySettingsRow, title),
    matching: find.byType(CanopySettingsValue),
  );

  T borrowed<T>(WidgetTester tester, Finder inRoute) =>
      Provider.of<T>(tester.element(inRoute), listen: false);

  void expectUsable(ChangeNotifier notifier) =>
      expect(() => notifier.addListener(() {}), returnsNormally);

  testWidgets('Login methods borrows its view models and keeps them on pop', (
    tester,
  ) async {
    await pumpSettings(tester);

    await tester.tap(find.text('Login methods'));
    await tester.pumpAndSettle();
    final row = find.text('Email and password');
    expect(row, findsOneWidget);
    expect(
      identical(borrowed<AuthSourcesViewModel>(tester, row), authSources),
      isTrue,
    );
    expect(
      identical(borrowed<TwoFactorViewModel>(tester, row), twoFactor),
      isTrue,
    );

    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('Email and password'), findsNothing);
    expectUsable(authSources);
    expectUsable(twoFactor);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Two-factor borrows its view model and keeps it on pop', (
    tester,
  ) async {
    await pumpSettings(tester);
    expect(
      find.descendant(
        of: valueOf('Two-factor authentication'),
        matching: find.text('Off'),
      ),
      findsOneWidget,
    );

    await tester.tap(find.text('Two-factor authentication'));
    await tester.pumpAndSettle();
    final status = find.text('Disabled');
    expect(status, findsOneWidget);
    expect(
      identical(borrowed<TwoFactorViewModel>(tester, status), twoFactor),
      isTrue,
    );

    await tester.pageBack();
    await tester.pumpAndSettle();
    expectUsable(twoFactor);
    expect(tester.takeException(), isNull);
  });

  testWidgets('API keys borrows its view model and the count follows a '
      'create', (tester) async {
    await pumpSettings(tester);
    expect(
      find.descendant(of: valueOf('API keys'), matching: find.text('2')),
      findsOneWidget,
    );

    await tester.tap(find.text('API keys'));
    await tester.pumpAndSettle();
    final key = find.text('CI token');
    expect(key, findsOneWidget);
    expect(identical(borrowed<ApiKeysViewModel>(tester, key), apiKeys), isTrue);

    await tester.tap(find.text('New key'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Synthetic token');
    await tester.tap(find.text('Create'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.text('Synthetic token'), findsOneWidget);

    await tester.pageBack();
    await tester.pumpAndSettle();
    expectUsable(apiKeys);
    expect(
      find.descendant(of: valueOf('API keys'), matching: find.text('3')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}
