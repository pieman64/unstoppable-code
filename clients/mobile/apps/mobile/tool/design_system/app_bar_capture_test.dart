// Edge-to-edge Remote app bar. Seeded mock data, bundled fonts, no network.
// From apps/mobile: APP_BAR_STAGE=before (or after) flutter test
// tool/design_system/app_bar_capture_test.dart --update-goldens
// Both appearances are captured on each run; after is the default.
import 'dart:io';
import 'package:mobile/ui/features/developer_options/views/app_bars_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:provider/provider.dart';
import '../../test/support/reduced_motion.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['APP_BAR_STAGE'] ?? 'after';
  setUpAll(() async {
    final loader = FontLoader('Inter')
      ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'));
    await loader.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final dark in [false, true]) {
    if (stage == 'after') {
      testWidgets('app bar reference ${dark ? 'dark' : 'light'}', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const AppBarsScreen(),
          ),
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byType(AppBarsScreen),
          matchesGoldenFile(
            '../../../../.playwright/mobile-app-bar/preview-after-${dark ? 'dark' : 'light'}.png',
          ),
        );
      });
    }

    testWidgets('remote app bar ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      addTearDown(tester.view.reset);
      final vm = RemoteControlViewModel(
        repository: MockRemoteControlRepository(latency: Duration.zero),
      );
      await tester.runAsync(() => vm.connect('123456'));
      addTearDown(vm.dispose);
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: vm,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: HomeNavigationScope(
              openDrawer: () {},
              child: const RemoteScreen(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> capture(String name) => expectLater(
        find.byType(RemoteScreen),
        matchesGoldenFile(
          '../../../../.playwright/mobile-app-bar/$name-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      await capture('remote');
      for (final name in ['acme-web', 'platform']) {
        await tester.tap(find.text(name).last);
        await tester.pumpAndSettle();
      }
      await tester.drag(
        find.byKey(const ValueKey('remote-workspaces-list')),
        const Offset(0, -170),
      );
      await tester.pumpAndSettle();
      await capture('scrolled');
      await tester.tap(find.byTooltip('Remote options'));
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(Navigator),
        matchesGoldenFile(
          '../../../../.playwright/mobile-app-bar/menu-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      await tester.pump(const Duration(minutes: 2));
      expect(tester.takeException(), isNull);
    });
  }
}
