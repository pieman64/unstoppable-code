import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/activity_sidebar.dart';
import '../../../support/app_bar_routes.dart';
import '../../../support/reduced_motion.dart';

void main() {
  useReducedMotion();

  Future<RemoteControlViewModel> connect(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
    addTearDown(tester.view.reset);
    final remote = RemoteControlViewModel(
      repository: MockRemoteControlRepository(latency: Duration.zero),
    );
    await tester.runAsync(() => remote.connect('123456'));
    return remote;
  }

  for (final dark in [false, true]) {
    testWidgets(
      'all migrated routes open and return with shared back control ($dark)',
      (tester) async {
        final remote = await connect(tester);
        for (final entry in appBarRoutes(remote).entries) {
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpWidget(
            appBarRouteHost(remote: remote, screen: entry.value, dark: dark),
          );
          await tester.tap(find.text('Open screen'));
          await tester.pumpAndSettle();
          expect(find.byType(CanopyAppBar), findsOneWidget, reason: entry.key);
          expect(
            find.descendant(
              of: find.byType(CanopyAppBar),
              matching: find.byType(CanopyIconButton),
            ),
            findsWidgets,
          );
          expect(tester.getRect(find.byType(CanopyAppBar)).top, 0);
          expect(tester.takeException(), isNull, reason: entry.key);
          await tester.tap(find.byTooltip('Back'));
          await tester.pumpAndSettle();
          expect(find.text('Open screen'), findsOneWidget, reason: entry.key);
        }
        await tester.pumpWidget(const SizedBox.shrink());
        remote.dispose();
      },
    );
  }

  testWidgets(
    'chat composer remains above keyboard and opens activity drawer',
    (tester) async {
      final remote = await connect(tester);
      await tester.pumpWidget(
        appBarRouteHost(
          remote: remote,
          screen: appBarRoutes(remote)['remote-chat']!,
          dark: false,
        ),
      );
      await tester.tap(find.text('Open screen'));
      await tester.pumpAndSettle();
      final composer = find.byKey(const ValueKey('chat-composer'));
      final composerBottomBeforeKeyboard = tester.getRect(composer).bottom;
      await tester.showKeyboard(
        find.descendant(of: composer, matching: find.byType(TextField)).first,
      );
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      await tester.pumpAndSettle();
      expect(tester.getRect(composer).bottom, lessThanOrEqualTo(544));
      expect(
        tester.getRect(composer).top,
        greaterThan(tester.getRect(find.byType(CanopyAppBar)).bottom),
      );
      tester.view.viewInsets = const FakeViewPadding();
      tester.testTextInput.hide();
      await tester.pumpAndSettle();
      expect(
        tester.getRect(composer).bottom,
        composerBottomBeforeKeyboard,
        reason: 'Dismissing the keyboard must reclaim its space',
      );
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();
      // The drawer has a Scaffold of its own; take the one that hosts it.
      final scaffold = tester.state<ScaffoldState>(
        find
            .ancestor(
              of: find.byType(RemoteActivitySidebar),
              matching: find.byType(Scaffold),
            )
            .first,
      );
      expect(scaffold.isEndDrawerOpen, isTrue);
      scaffold.closeEndDrawer();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.text('Open screen'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      remote.dispose();
    },
  );
}
