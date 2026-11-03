import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show RemoteLinkState;
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';

void main() {
  Future<void> pumpBanner(
    WidgetTester tester,
    RemoteDegradedBanner banner, {
    ThemeData? theme,
    double textScale = 1.0,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme ?? AppTheme.light,
        home: MediaQuery(
          data: MediaQueryData(
            size: const Size(390, 844),
            textScaler: TextScaler.linear(textScale),
          ),
          child: Scaffold(body: Column(children: [banner])),
        ),
      ),
    );
  }

  // CAN-4426: nothing on the phone can bring an offline desktop back, so the
  // banner says what to do on the desktop and offers no action.
  testWidgets('an offline desktop names it and says to open the app there', (
    tester,
  ) async {
    await pumpBanner(
      tester,
      const RemoteDegradedBanner(
        status: RemotePortalConnectionStatus.inactive,
        deviceLabel: 'MacBook-Pro-8.local',
      ),
    );

    expect(
      find.text(
        'MacBook-Pro-8.local is offline. Open ${Brand.productDisplayName} on '
        'that computer to reconnect. Showing cached data.',
      ),
      findsOneWidget,
    );
    expect(find.byType(TextButton), findsNothing);
  });

  testWidgets('an offline desktop without a name still says what to do', (
    tester,
  ) async {
    await pumpBanner(
      tester,
      const RemoteDegradedBanner(status: RemotePortalConnectionStatus.inactive),
    );

    expect(
      find.text(
        'Desktop is offline. Open ${Brand.productDisplayName} on your '
        'computer to reconnect. Showing cached data.',
      ),
      findsOneWidget,
    );
    expect(find.byType(TextButton), findsNothing);
  });

  testWidgets('the phone and reconnecting messages stay as they were', (
    tester,
  ) async {
    const label = 'MacBook-Pro-8.local';
    for (final (banner, message) in const [
      (
        RemoteDegradedBanner(
          status: RemotePortalConnectionStatus.reconnecting,
          deviceLabel: label,
        ),
        'Desktop is reconnecting…',
      ),
      (
        RemoteDegradedBanner(
          status: RemotePortalConnectionStatus.inactive,
          deviceLabel: label,
          linkState: RemoteLinkState.reconnecting,
        ),
        'Reconnecting…',
      ),
      (
        RemoteDegradedBanner(
          status: RemotePortalConnectionStatus.inactive,
          deviceLabel: label,
          linkState: RemoteLinkState.unreachable,
        ),
        "Can't reach the server. Showing cached data.",
      ),
    ]) {
      await pumpBanner(tester, banner);
      expect(find.text(message), findsOneWidget);
      expect(find.byType(TextButton), findsNothing);
    }
  });

  for (final (themeName, theme) in [
    ('light', AppTheme.light),
    ('dark', AppTheme.dark),
  ]) {
    for (final textScale in const [1.0, 2.0]) {
      testWidgets(
        'a long offline message fits 390pt ($themeName, text x$textScale)',
        (tester) async {
          await pumpBanner(
            tester,
            const RemoteDegradedBanner(
              status: RemotePortalConnectionStatus.inactive,
              deviceLabel: 'Engineering-MacBook-Pro-Build-Agent-8.local',
            ),
            theme: theme,
            textScale: textScale,
          );

          expect(tester.takeException(), isNull);
          final message = find.textContaining('is offline. Open');
          expect(message, findsOneWidget);
          final rect = tester.getRect(message);
          expect(rect.left, greaterThanOrEqualTo(0));
          expect(rect.right, lessThanOrEqualTo(390));
        },
      );
    }
  }
}
