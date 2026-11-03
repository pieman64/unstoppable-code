// CAN-3624 — device verification that a paired phone never ends a sleeping
// desktop's Remote Control session on its own. Run from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3624_sleeping_desktop_device_test.dart \
//     -d <device-id>
//
// The production repository talks to a synthetic Portal server
// (`remote_session_fake_server.dart`): Desktop A is paired and then sleeps
// past the stale sweep, while the account's current-session read returns
// another desktop's row. The fixture covers the phone's side of the flow, not
// a real desktop sleep or server sweep. Captures land in
// build/promo_screenshots via the shared integration-test driver.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

import '../test/support/remote_session_fake_server.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<FakePortalSessionServer> pumpPairedToSleepingA(
    WidgetTester tester,
    ThemeMode mode,
  ) async {
    final server = FakePortalSessionServer()
      ..addSession(id: 'sess-a', clientName: 'Desktop A', eventCursor: 40);
    await tester.pumpWidget(
      ChangeNotifierProvider<RemoteControlViewModel>(
        create: (_) => RemoteControlViewModel(
          repository: server.repository(),
          stateRefreshDebounce: Duration.zero,
        ),
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: mode,
          home: const RemoteScreen(),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));
    // Per-test teardown reverts the conversion, so every test converts again.
    await binding.convertFlutterSurfaceToImage();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Desktop A workspace'), findsOneWidget);

    server.sleep('sess-a');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(RemoteDegradedBanner), findsOneWidget);
    return server;
  }

  Future<void> foregroundThenPullToRefresh(WidgetTester tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    // Frames are disabled while paused on a device, so a pump here never
    // completes; wait without requesting a frame instead.
    await Future<void>.delayed(const Duration(milliseconds: 50));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 500));
    if (find.byType(RefreshIndicator).evaluate().isNotEmpty) {
      await tester.fling(
        find.byType(RefreshIndicator),
        const Offset(0, 320),
        1200,
      );
    }
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> unmount(
    WidgetTester tester,
    FakePortalSessionServer server,
  ) async {
    server.close();
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 300));
  }

  void expectStillShowingSleepingA(FakePortalSessionServer server) {
    expect(server.endRequests, isEmpty);
    expect(server.requestsFor('sess-b'), isEmpty);
    expect(find.byType(ConnectDesktopView), findsNothing);
    expect(find.text('Desktop A'), findsOneWidget);
    expect(find.text('Desktop A workspace'), findsOneWidget);
    expect(find.byType(RemoteDegradedBanner), findsOneWidget);
  }

  for (final (label, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('another desktop awaiting its code does not end A ($label)', (
      tester,
    ) async {
      final server = await pumpPairedToSleepingA(tester, mode);
      server.addSession(
        id: 'sess-b',
        clientName: 'Desktop B',
        status: 'pending_auth',
        connectionStatus: 'pending',
      );

      await foregroundThenPullToRefresh(tester);

      expect(
        server.requests,
        contains('POST $portalBrowserBasePath/sessions/sess-a/commands'),
      );
      expectStillShowingSleepingA(server);
      await binding.takeScreenshot('can-3624-pending-other-$label');
      await unmount(tester, server);
    });

    testWidgets('another active desktop does not replace A ($label)', (
      tester,
    ) async {
      final server = await pumpPairedToSleepingA(tester, mode);
      server.addSession(id: 'sess-b', clientName: 'Desktop B');

      await foregroundThenPullToRefresh(tester);

      expect(
        server.requests,
        contains('POST $portalBrowserBasePath/sessions/sess-a/commands'),
      );
      expectStillShowingSleepingA(server);
      await binding.takeScreenshot('can-3624-active-other-$label');
      await unmount(tester, server);
    });

    testWidgets('A reported gone shows the pairing form locally ($label)', (
      tester,
    ) async {
      final server = await pumpPairedToSleepingA(tester, mode);
      server.currentSessionOverride = () =>
          (status: 200, body: const {'session': null});

      await foregroundThenPullToRefresh(tester);

      expect(find.byType(ConnectDesktopView), findsOneWidget);
      expect(
        find.text(
          'The desktop is no longer connected. Connect it again to continue.',
        ),
        findsOneWidget,
      );
      expect(server.endRequests, isEmpty);
      await binding.takeScreenshot('can-3624-own-session-gone-$label');
      await unmount(tester, server);
    });

    testWidgets('Disconnect ends A on the server once ($label)', (
      tester,
    ) async {
      final server = await pumpPairedToSleepingA(tester, mode);

      await tester.tap(find.byTooltip('Remote options'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.text('Disconnect'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pump();

      expect(find.text('Connect to your desktop'), findsOneWidget);
      expect(server.endRequests, [
        'POST $portalBrowserBasePath/sessions/sess-a/end',
      ]);
      await binding.takeScreenshot('can-3624-user-disconnect-$label');
      await unmount(tester, server);
    });
  }
}
