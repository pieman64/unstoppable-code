// CAN-2873: Unstoppable sign-in button before/after visual verification.
// CAN2873_STAGE=before/after flutter test tool/auth/unstoppable_sign_in_capture_test.dart --update-goldens
// Each run captures iOS and Android in both themes using bundled fonts and mock auth.
// No network, live accounts, or nondeterministic provider pages.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/features/auth/views/sign_in_screen.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final stage = Platform.environment['CAN2873_STAGE'] ?? 'after';
  setUpAll(() async {
    for (final (family, folder) in [
      ('Inter', 'inter'),
      // Button styles without a family use the test harness fallback.
      ('Roboto', 'inter'),
      ('JetBrainsMono', 'jetbrains-mono'),
    ]) {
      final assetFamily = family == 'Roboto' ? 'Inter' : family;
      final loader = FontLoader(family);
      for (final suffix in ['', '-Italic']) {
        loader.addFont(
          rootBundle.load(
            'assets/fonts/$folder/${assetFamily}Variable$suffix.ttf',
          ),
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
      testWidgets('sign in ${platform.name} ${dark ? 'dark' : 'light'}', (
        tester,
      ) async {
        debugDefaultTargetPlatformOverride = platform;
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
          await tester.runAsync(
            () => precacheImage(
              const AssetImage('assets/splash/splash_logo.png'),
              tester.element(find.byType(SignInScreen)),
            ),
          );
          await tester.pumpAndSettle();
          // FilledButton's explicit label style has no font family. The test
          // engine substitutes Ahem; normalize only the capture's rendered labels
          // to bundled Inter in both stages so they remain readable. Production
          // widget styles are not mutated by this capture-only adjustment.
          for (final element
              in find
                  .descendant(
                    of: find.byType(FilledButton),
                    matching: find.byType(RichText),
                  )
                  .evaluate()) {
            final paragraph = element.renderObject! as RenderParagraph;
            final span = paragraph.text as TextSpan;
            paragraph.text = TextSpan(
              text: span.text,
              children: span.children,
              style: (span.style ?? const TextStyle()).copyWith(
                fontFamily: 'Inter',
              ),
            );
          }
          await tester.pump();
          await expectLater(
            find.byType(Scaffold).last,
            matchesGoldenFile(
              '../../../../.playwright/can-2873/sign-in-${platform.name}-$stage-${dark ? 'dark' : 'light'}.png',
            ),
          );
          expect(tester.takeException(), isNull);
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      });
    }
  }
}
