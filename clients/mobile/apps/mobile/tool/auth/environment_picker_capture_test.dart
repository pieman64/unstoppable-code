// Mobile debug environment picker before/after visual verification.
// ENV_PICKER_STAGE=before/after flutter test tool/auth/environment_picker_capture_test.dart --update-goldens
// Each run captures iOS and Android in both themes with deterministic fixed
// origins and mock authentication; it makes no network requests.
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/views/sign_in_screen.dart';
import 'package:provider/provider.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final stage = Platform.environment['ENV_PICKER_STAGE'] == 'before'
      ? 'before'
      : 'after';

  setUpAll(() async {
    for (final (family, folder) in [
      ('Inter', 'inter'),
      ('JetBrainsMono', 'jetbrains-mono'),
    ]) {
      final loader = FontLoader(family);
      for (final suffix in ['', '-Italic']) {
        loader.addFont(
          rootBundle.load('assets/fonts/$folder/${family}Variable$suffix.ttf'),
        );
      }
      await loader.load();
    }
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
  });

  for (final platform in [TargetPlatform.iOS, TargetPlatform.android]) {
    for (final dark in [false, true]) {
      testWidgets('picker ${platform.name} ${dark ? 'dark' : 'light'}', (
        tester,
      ) async {
        debugDefaultTargetPlatformOverride = platform;
        DemoMode.enabled.value = false;
        // Capture-only dependency injection; no production state is mutated.
        // ignore: invalid_use_of_visible_for_testing_member
        AppConfig.configureEnvironmentController(
          ApiEnvironmentController(
            productionBaseUrl: stage == 'before'
                ? ''
                : 'https://app.unstoppable.ai',
            stagingBaseUrl: 'https://code.ud-staging.com',
            initialEnvironment: ApiEnvironment.staging,
            preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
          ),
        );
        try {
          tester.view.physicalSize = const Size(390, 844);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.reset);
          final auth = AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
          );
          addTearDown(auth.dispose);
          await tester.pumpWidget(
            ChangeNotifierProvider.value(
              value: auth,
              child: MaterialApp(
                theme: dark ? AppTheme.dark : AppTheme.light,
                home: const SignInScreen(),
              ),
            ),
          );
          await tester.pumpAndSettle();

          final logo = find.byKey(const Key('signInLogo'));
          final gesture = await tester.startGesture(tester.getCenter(logo));
          await tester.pump(SignInScreen.environmentPickerHoldDuration);
          await tester.pumpAndSettle();
          await gesture.up();

          await expectLater(
            find.byKey(const Key('apiEnvironmentPicker')),
            matchesGoldenFile(
              '../../../../.playwright/mobile-debug-environments/picker-${platform.name}-$stage-${dark ? 'dark' : 'light'}.png',
            ),
          );
          expect(tester.takeException(), isNull);
        } finally {
          debugDefaultTargetPlatformOverride = null;
          DemoMode.enabled.value = false;
        }
      });
    }
  }
}
