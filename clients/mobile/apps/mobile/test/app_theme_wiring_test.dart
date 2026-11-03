import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/main.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/theme_controller.dart';

import 'support/memory_remote_transcript_storage.dart';

void main() {
  testWidgets('MaterialApp.themeMode tracks the ThemeController', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final controller = ThemeController(store: InMemoryThemePreferenceStore());
    await tester.pumpWidget(
      App(
        themeController: controller,
        transcriptStorage: MemoryRemoteTranscriptStorage(),
      ),
    );

    MaterialApp app() => tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app().themeMode, ThemeMode.system);

    await controller.setMode(ThemeMode.dark);
    await tester.pump();
    expect(app().themeMode, ThemeMode.dark);
    await tester.pumpAndSettle();
    final style = SystemChrome.latestStyle!;
    expect(style.systemNavigationBarIconBrightness, Brightness.light);
    expect(
      style.systemNavigationBarColor,
      AppTheme.dark.scaffoldBackgroundColor,
    );

    // Flush the mock restore() timer so no timer is left pending.
    await tester.pump(const Duration(seconds: 1));
  });
}
