// Design system font references: deterministic before/after visual evidence.
// From apps/mobile:
// DESIGN_SYSTEM_STAGE=before flutter test tool/design_system/capture_test.dart --update-goldens
// DESIGN_SYSTEM_STAGE=after flutter test tool/design_system/capture_test.dart --update-goldens
// Run before production edits, then after. Default is after. Uses bundled fonts,
// real navigation and widgets, no account or network. Captures light and dark.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/developer_options/views/design_system_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final stage = Platform.environment['DESIGN_SYSTEM_STAGE'] ?? 'after';
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
  for (final dark in [false, true]) {
    testWidgets('design system ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> capture(String name) => expectLater(
        find.byType(Scaffold).last,
        matchesGoldenFile(
          '../../../../.playwright/mobile-design-system/$name-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      await capture('index');
      if (stage == 'before') return;

      for (final key in ['fonts', 'typography', 'code-markdown', 'progress']) {
        // `progress` shows an `active` checklist step, which renders an
        // indeterminate CircularProgressIndicator. That animation never
        // settles, so `pumpAndSettle` would throw on its timeout. Pump a
        // fixed frame budget on the test's fake clock instead: long enough
        // to finish the route transition, and deterministic because the
        // spinner lands on the same phase every run. The spinner is the
        // interesting state to review, so it stays in the capture.
        final settles = key != 'progress';
        Future<void> advance() async {
          if (settles) {
            await tester.pumpAndSettle();
            return;
          }
          for (var frame = 0; frame < 30; frame++) {
            await tester.pump(const Duration(milliseconds: 16));
          }
        }

        await tester.ensureVisible(find.byKey(ValueKey('$key-button')));
        await tester.tap(find.byKey(ValueKey('$key-button')));
        await tester.pump();
        await advance();
        await capture(key);
        if (key == 'fonts' || key == 'typography') {
          await tester.drag(find.byType(ListView), const Offset(0, -650));
          await tester.pumpAndSettle();
          await capture('$key-scrolled');
        }
        if (key == 'typography') {
          for (final (token, name) in [
            ('heading', 'typography-heading'),
            ('small body', 'typography-small-body'),
          ]) {
            await tester.scrollUntilVisible(
              find.byKey(ValueKey('text-style-$token')),
              500,
              scrollable: find
                  .descendant(
                    of: find.byKey(const ValueKey('design-reference-list')),
                    matching: find.byType(Scrollable),
                  )
                  .first,
            );
            await tester.pumpAndSettle();
            await capture(name);
          }
        }
        expect(tester.takeException(), isNull);
        await tester.pageBack();
        await advance();
      }
    });
  }
}
