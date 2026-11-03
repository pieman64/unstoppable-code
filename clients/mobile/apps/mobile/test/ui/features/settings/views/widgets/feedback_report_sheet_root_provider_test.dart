import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/main.dart' show buildRootProviders;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/account_screen.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';

import '../../../../../support/fake_provider_usage_source.dart';

/// Regression coverage for CAN-1957 Task 11: `FeedbackReportRepository` must
/// be reachable from Settings' Send feedback row when only main.dart's
/// production `buildRootProviders()` sits above `MaterialApp`.
///
/// This mirrors `remote/root_providers_reach_pushed_screens_test.dart`'s
/// pattern for `TurnFeedbackController` (CAN-1957 Task 8, fix round 1):
/// `account_screen_test.dart`'s own `_host()` puts every provider —
/// including `FeedbackReportRepository` — directly above `MaterialApp`, so it
/// structurally cannot distinguish "registered in `buildRootProviders()`"
/// from "registered in `buildSharedShellProviders()`".
///
/// Here only `buildRootProviders()` supplies anything above `MaterialApp`.
/// Every other provider Settings needs is reconstructed inside `home:`,
/// matching where `buildSharedShellProviders()` places them in production,
/// and `FeedbackReportRepository` is deliberately NOT re-provided there. The
/// feedback sheet is a modal route on the root navigator, so a registration
/// anywhere other than `buildRootProviders()` would throw. Settings now hosts
/// the row directly (CAN-4449), and it also reads `NotificationsViewModel`
/// from the same root list.
void main() {
  void usePhoneViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
  }

  Widget buildRealisticHost() {
    return MultiProvider(
      // `ThemeController` is provided alongside `buildRootProviders()` in
      // this exact shape in production (`App.build()`), also above
      // `MaterialApp` — not inside `buildSharedShellProviders()` — so it
      // belongs here too, not in the shell reconstruction below.
      providers: [
        ChangeNotifierProvider<ThemeController>(
          create: (_) => ThemeController(store: InMemoryThemePreferenceStore()),
        ),
        ...buildRootProviders(),
      ],
      child: MaterialApp(
        theme: AppTheme.light,
        home: MultiProvider(
          providers: [
            // Account's Usage limits row reads the paired desktop's plan usage.
            ListenableProvider<ProviderUsageSource>(
              create: (_) => FakeProviderUsageSource(),
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
                issuer: 'Test',
              )..load(),
            ),
          ],
          child: const Scaffold(body: AccountScreen()),
        ),
      ),
    );
  }

  testWidgets(
    'Send feedback opens from Settings using only buildRootProviders',
    (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildRealisticHost());
      await tester.pumpAndSettle();
      expect(find.text('Settings'), findsOneWidget);

      final feedback = find.text('Send feedback');
      await tester.scrollUntilVisible(
        feedback,
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(feedback);
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('feedback-report-sheet')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );
}
