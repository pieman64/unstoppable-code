// Remaining route app bars: deterministic mock data, bundled fonts, no network.
// From apps/mobile: ROUTE_BARS_STAGE=before (or after) flutter test
// tool/design_system/route_app_bars_capture_test.dart --update-goldens
// Run each stage against its corresponding implementation; both themes run.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import '../../test/support/app_bar_routes.dart';
import '../../test/support/reduced_motion.dart';

void main() {
  useReducedMotion();
  final stage = Platform.environment['ROUTE_BARS_STAGE'] ?? 'after';
  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('JetBrainsMono')
          ..addFont(
            rootBundle.load(
              'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
            ),
          )
          ..addFont(
            rootBundle.load(
              'assets/fonts/jetbrains-mono/JetBrainsMonoVariable-Italic.ttf',
            ),
          ))
        .load();
  });
  for (final dark in [false, true]) {
    testWidgets('route app bars ${dark ? "dark" : "light"}', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      addTearDown(tester.view.reset);
      final remote = RemoteControlViewModel(
        repository: MockRemoteControlRepository(latency: Duration.zero),
      );
      await tester.runAsync(() => remote.connect('123456'));
      addTearDown(remote.dispose);
      for (final entry in appBarRoutes(remote).entries) {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpWidget(
          appBarRouteHost(remote: remote, screen: entry.value, dark: dark),
        );
        await tester.tap(find.text('Open screen'));
        await tester.pumpAndSettle();
        await expectLater(
          find.byType(Navigator),
          matchesGoldenFile(
            '../../../../.playwright/mobile-route-app-bars/${entry.key}-$stage-${dark ? "dark" : "light"}.png',
          ),
        );
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
}
