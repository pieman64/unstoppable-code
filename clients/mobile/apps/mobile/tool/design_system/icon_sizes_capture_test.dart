// Icon size increase and font license screen removal: deterministic before/after visual evidence.
// From apps/mobile:
// DESIGN_SYSTEM_STAGE=before flutter test tool/design_system/icon_sizes_capture_test.dart --update-goldens
// DESIGN_SYSTEM_STAGE=after flutter test tool/design_system/icon_sizes_capture_test.dart --update-goldens
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
          '../../../../.playwright/mobile-icon-sizing/$name-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      await capture('index');

      for (final key in ['icon-buttons']) {
        await tester.ensureVisible(find.byKey(ValueKey('$key-button')));
        await tester.tap(find.byKey(ValueKey('$key-button')));
        await tester.pump();
        await tester.pumpAndSettle();
        await capture(key);
        expect(tester.takeException(), isNull);
        await tester.pageBack();
        await tester.pumpAndSettle();
      }
    });
  }
}
