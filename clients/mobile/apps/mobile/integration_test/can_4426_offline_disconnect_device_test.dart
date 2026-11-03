// CAN-4426 — device verification for leaving a paired desktop that went
// offline. Run from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_4426_offline_disconnect_device_test.dart \
//     -d <device-id>
//
// The production repository talks to a synthetic Portal server
// (`remote_session_fake_server.dart`). The fixture covers the phone's side of
// the flow, not a real desktop quitting or restarting. The end request runs
// on the device's real clock, so the timeout case waits for the 15-second
// bound. Captures land in build/promo_screenshots via the shared
// integration-test driver.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

import '../test/support/remote_session_fake_server.dart';

const _offlineCopy =
    'Desktop A is offline. Open ${Brand.productDisplayName} on that computer '
    'to reconnect. Showing cached data.';
const _noDesktopCopy =
    'Open ${Brand.productDisplayName} on your computer, turn on Remote '
    'Control, then enter the new code.';
const _stagingHint =
    'This phone uses the staging server. Use staging in the desktop app too.';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  void useEnvironment(ApiEnvironment environment) {
    ApiEnvironmentController controller(ApiEnvironment value) =>
        ApiEnvironmentController(
          productionBaseUrl: 'https://production.test',
          stagingBaseUrl: 'https://staging.test',
          initialEnvironment: value,
          preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
        );
    AppConfig.configureEnvironmentController(controller(environment));
    addTearDown(
      () => AppConfig.configureEnvironmentController(
        controller(ApiEnvironment.production),
      ),
    );
  }

  /// Pairs with Desktop A. With [offline], A then quits, so its row goes
  /// `inactive` and the phone shows the cached list under the banner.
  Future<FakePortalSessionServer> pumpPairedToA(
    WidgetTester tester,
    ThemeMode mode, {
    bool offline = true,
  }) async {
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
    if (!offline) return server;

    server.sleep('sess-a');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(RemoteDegradedBanner), findsOneWidget);
    return server;
  }

  /// Taps the overflow Disconnect, then renders the next frame.
  Future<void> tapDisconnect(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Remote options'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.text('Disconnect'));
    await tester.pump();
    await tester.pump();
  }

  /// A background and foreground in the platform's lifecycle order.
  Future<void> foreground(WidgetTester tester) async {
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    // Frames are disabled while paused on a device, so a pump here never
    // completes; wait without requesting a frame instead.
    await Future<void>.delayed(const Duration(milliseconds: 50));
    for (final state in const [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> submitCode(WidgetTester tester) async {
    await tester.enterText(find.byType(TextField), '123456');
    await tester.pump(const Duration(milliseconds: 300));
    final connect = find.widgetWithText(FilledButton, 'Connect');
    await tester.ensureVisible(connect);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(connect);
    await tester.pump(const Duration(milliseconds: 300));
  }

  /// Dismisses the keyboard and scrolls [message] into view for a capture.
  Future<void> showMessage(WidgetTester tester, Finder message) async {
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.ensureVisible(message);
    await tester.pump(const Duration(milliseconds: 300));
  }

  Future<void> unmount(
    WidgetTester tester,
    FakePortalSessionServer server,
  ) async {
    server.close();
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 300));
  }

  void expectNoBannerAction() {
    expect(
      find.descendant(
        of: find.byType(RemoteDegradedBanner),
        matching: find.byWidgetPredicate(
          (widget) => widget is ButtonStyleButton,
        ),
      ),
      findsNothing,
    );
  }

  for (final (label, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('offline banner names A and recovers on its own ($label)', (
      tester,
    ) async {
      final server = await pumpPairedToA(tester, mode);

      expect(find.text(_offlineCopy), findsOneWidget);
      expectNoBannerAction();
      expect(find.text('Desktop A workspace'), findsOneWidget);
      await binding.takeScreenshot('can-4426-offline-banner-$label');

      // A opens again: its heartbeat answers the next poll.
      server
        ..heartbeat('sess-a')
        ..restoreDelivery();
      await tester.pump(const Duration(seconds: 1));
      server.heartbeat('sess-a');
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));

      expect(find.byType(RemoteDegradedBanner), findsNothing);
      expect(find.text('Desktop A workspace'), findsOneWidget);
      expect(server.endRequests, isEmpty);
      await binding.takeScreenshot('can-4426-recovered-$label');
      await unmount(tester, server);
    });

    testWidgets('Disconnect responds at once and stays disconnected ($label)', (
      tester,
    ) async {
      useEnvironment(ApiEnvironment.production);
      final server = await pumpPairedToA(tester, mode);
      // The end request never gets an answer.
      final endGate = server.endGate = Completer<void>();

      await tapDisconnect(tester);

      expect(find.byType(ConnectDesktopView), findsOneWidget);
      expect(find.text('Desktop A workspace'), findsNothing);
      expect(server.endRequests, [
        'POST $portalBrowserBasePath/sessions/sess-a/end',
      ]);
      await binding.takeScreenshot('can-4426-disconnect-pending-$label');

      // A foreground while the end request waits does not reattach A.
      await foreground(tester);
      expect(find.byType(ConnectDesktopView), findsOneWidget);
      expect(find.text('Desktop A workspace'), findsNothing);

      // The request gives up at its bound; A is still current on the server.
      await Future<void>.delayed(const Duration(seconds: 16));
      await foreground(tester);
      expect(endGate.isCompleted, isFalse);
      expect(server.row('sess-a').connectionStatus, 'inactive');
      expect(find.byType(ConnectDesktopView), findsOneWidget);
      expect(find.text('Desktop A workspace'), findsNothing);

      // A is still offline, so no desktop can take a code.
      await submitCode(tester);
      final message = find.text(_noDesktopCopy);
      await showMessage(tester, message);
      expect(message, findsOneWidget);
      expect(find.textContaining('No pending'), findsNothing);
      expect(find.textContaining('staging'), findsNothing);
      await binding.takeScreenshot('can-4426-no-desktop-error-$label');
      // The abandoned end request stays unanswered.
      await unmount(tester, server);
    });

    testWidgets('a code entered during the end waits for it ($label)', (
      tester,
    ) async {
      useEnvironment(ApiEnvironment.staging);
      // A is live and re-arms a code on the same session.
      final server = await pumpPairedToA(tester, mode, offline: false);
      server.connectResponse = (code) =>
          server.row('sess-a').connectionStatus == 'ended'
          ? (
              status: 404,
              body: const {
                'error':
                    'No pending remote control session was found for this '
                    'account.',
                'code': 'no_eligible_desktop',
              },
            )
          : (
              status: 200,
              body: const {'sessionId': 'sess-a', 'status': 'active'},
            );
      final endGate = server.endGate = Completer<void>();

      await tapDisconnect(tester);
      expect(find.byType(ConnectDesktopView), findsOneWidget);
      await submitCode(tester);

      expect(
        server.requests,
        isNot(contains('POST $portalBrowserBasePath/connect')),
      );
      expect(find.byType(LoadingSpinner), findsOneWidget);
      expect(find.byType(ConnectDesktopView), findsNothing);

      // The end lands first, so the code finds no desktop instead of a
      // pairing the old end request would then end.
      endGate.complete();
      await tester.pump(const Duration(seconds: 1));
      final message = find.text('$_noDesktopCopy\n$_stagingHint');
      await showMessage(tester, message);
      expect(server.row('sess-a').connectionStatus, 'ended');
      expect(message, findsOneWidget);
      expect(find.text('Desktop A workspace'), findsNothing);
      await binding.takeScreenshot('can-4426-staging-error-$label');
      await unmount(tester, server);
    });
  }
}
