// CAN-3636 AC-10: why the values stopped updating must be readable where the
// user is looking. These scroll the detail screen to Codex in the production
// shell, then lose the desktop or this phone's delivery, and check that the
// note sits inside the visible body under the app bar without scrolling back,
// at the default and the largest supported text scale. The shipped Inter font
// is loaded so large-text layout matches what users see.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/provider_usage_fixture.dart';
import '../../../../support/usage_limits_shell.dart';
import '../../../../support/usage_limits_viewport.dart';

const _safeTop = 47.0;
const _safeBottom = 34.0;
const _screen = Size(390, 844);

const _disconnected = usageLimitsDisconnectedNote;
const _delivery = usageLimitsDeliveryNote;

void _phone(WidgetTester tester, double scale) {
  tester.view.physicalSize = _screen;
  tester.view.devicePixelRatio = 1;
  tester.view.padding = const FakeViewPadding(
    top: _safeTop,
    bottom: _safeBottom,
  );
  tester.view.viewPadding = const FakeViewPadding(
    top: _safeTop,
    bottom: _safeBottom,
  );
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
}

/// Opens the detail screen and scrolls until Codex leads the body.
Future<ScrollPosition> _openAtCodex(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('account-usage-limits')));
  await _settle(tester);
  return scrollUsageLimitsToCodex(tester);
}

Future<void> _loadInter() async {
  final bytes = ByteData.sublistView(
    await File('assets/fonts/inter/InterVariable.ttf').readAsBytes(),
  );
  await (FontLoader('Inter')..addFont(Future.value(bytes))).load();
}

void main() {
  setUpAll(_loadInter);

  for (final theme in [ThemeMode.light, ThemeMode.dark]) {
    for (final scale in [1.0, 3.0]) {
      final label = 'text scale ${scale.toStringAsFixed(0)}, ${theme.name}';

      testWidgets('desktop disconnect while at Codex shows the note in view '
          'without moving the list ($label)', (tester) async {
        _phone(tester, scale);
        final server = usageLimitsServer(providerUsage: providerUsagePayload());
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: theme,
        );
        final position = await _openAtCodex(tester);
        final offset = position.pixels;

        server.sleep('sess-a');
        await _settle(tester);

        expectUsageLimitsNoteInView(
          tester,
          _disconnected,
          'Desktop disconnected. Showing the last values received.',
        );
        expect(find.byKey(_delivery), findsNothing);
        expect(position.pixels, offset, reason: 'no forced scroll');
        expectInUsageLimitsBody(tester, find.text('55.0%'), 'Codex value kept');
        await expectUsageLimitsRefreshBlocked(
          tester,
          server,
          _disconnected,
          'Desktop disconnected. Showing the last values received.',
        );
        expect(server.commandBodies, isEmpty);
        expect(tester.takeException(), isNull);

        await tester.pageBack();
        await _settle(tester);
        expect(
          find.byKey(const ValueKey('account-usage-limits')),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
        await unmountUsageLimitsShell(tester, server, remote);
      });

      testWidgets('losing the server while at Codex shows reconnecting, then '
          'unreachable, in view until delivery returns ($label)', (
        tester,
      ) async {
        _phone(tester, scale);
        final server = usageLimitsServer(providerUsage: providerUsagePayload());
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: theme,
        );
        final position = await _openAtCodex(tester);
        final offset = position.pixels;

        server.dropDelivery();
        // Past the reconnect grace.
        await tester.pump(const Duration(seconds: 3));
        expectUsageLimitsNoteInView(
          tester,
          _delivery,
          'Reconnecting. Showing the last values received.',
        );
        expect(find.byKey(_disconnected), findsNothing);
        expect(position.pixels, offset, reason: 'no forced scroll');
        expectInUsageLimitsBody(tester, find.text('55.0%'), 'Codex value kept');

        await tester.pump(const Duration(seconds: 30));
        expectUsageLimitsNoteInView(
          tester,
          _delivery,
          "Can't reach the server. Showing the last values received.",
        );
        expect(find.byKey(_disconnected), findsNothing);
        expect(position.pixels, offset, reason: 'no forced scroll');
        expectInUsageLimitsBody(tester, find.text('55.0%'), 'Codex value kept');
        await expectUsageLimitsRefreshBlocked(
          tester,
          server,
          _delivery,
          "Can't reach the server. Showing the last values received.",
        );
        expect(server.commandBodies, isEmpty);
        expect(tester.takeException(), isNull);

        server.restoreDelivery();
        await _settle(tester);
        server.heartbeat('sess-a');
        await _settle(tester);
        expect(find.byKey(_delivery), findsNothing);
        expect(find.byKey(_disconnected), findsNothing);
        final codexRefresh = await scrollToUsageLimitsRefresh(
          tester,
          'codex',
          delta: 200,
        );
        expect(
          usageLimitsRefreshButton(tester, codexRefresh).onPressed,
          isNotNull,
        );
        await tester.tap(codexRefresh);
        await _settle(tester);
        await tester.scrollUntilVisible(
          find.text('55.0%'),
          200,
          scrollable: usageLimitsList,
        );
        expect(find.text('55.0%'), findsOneWidget);
        expect(server.commandBodies, [
          {
            'type': 'portal.provider_usage.refresh',
            'payload': {'provider': 'codex'},
          },
        ]);
        expect(tester.takeException(), isNull);
        await unmountUsageLimitsShell(tester, server, remote);
      });
    }
  }
}
