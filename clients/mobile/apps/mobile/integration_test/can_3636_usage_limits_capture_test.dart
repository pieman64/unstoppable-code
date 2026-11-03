// CAN-3636 — device captures of Account's Usage limits row and detail screen.
// Visual evidence only; durable coverage is
// can_3636_usage_limits_device_test.dart. Run from apps/mobile, before and
// after changing production code, at text scale 1 and 3:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3636_usage_limits_capture_test.dart \
//     --dart-define=CAN3636_STAGE=before --dart-define=CAN3636_TEXT_SCALE=1 \
//     -d <device-id>
//
// CAN3636_STAGE=prefix captures only the detail scrolled to Codex losing the
// server and then the desktop, for matching a review repair's fix against the
// tree before it.
//
// Light and dark use the production shell with Remote Control paired to a
// synthetic Portal server (invented plans, email and values). The spec finds
// widgets only by key and text, so it runs on the unchanged tree too, where
// only Account exists. Screenshots land in build/promo_screenshots.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';

import '../test/support/provider_usage_fixture.dart';
import '../test/support/usage_limits_shell.dart';
import '../test/support/usage_limits_viewport.dart';

const String _stage = String.fromEnvironment(
  'CAN3636_STAGE',
  defaultValue: 'after',
);
const String _scaleDefine = String.fromEnvironment(
  'CAN3636_TEXT_SCALE',
  defaultValue: '1',
);

const _row = ValueKey('account-usage-limits');

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final textScale = double.tryParse(_scaleDefine) ?? 1;
  final platform = Platform.isIOS ? 'ios' : 'android';

  Future<void> prepare(WidgetTester tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }

  Future<void> shot(WidgetTester tester, String name) async {
    await tester.pump(const Duration(milliseconds: 400));
    final view = tester.view;
    debugPrint(
      'CAN3636 capture $name: logical '
      '${view.physicalSize.width / view.devicePixelRatio}x'
      '${view.physicalSize.height / view.devicePixelRatio} '
      'dpr ${view.devicePixelRatio} textScale $textScale',
    );
    await binding.takeScreenshot(
      'can-3636-$name-$_stage-$platform-s${textScale.toStringAsFixed(0)}',
    );
  }

  Future<void> convertSurface(WidgetTester tester) async {
    if (Platform.isAndroid) await binding.convertFlutterSurfaceToImage();
    await tester.pump(const Duration(milliseconds: 300));
  }

  Future<bool> openDetail(WidgetTester tester) async {
    if (find.byKey(_row).evaluate().isEmpty) return false;
    await tester.tap(find.byKey(_row));
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    return true;
  }

  for (final (label, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('Account and detail, both providers ($label)', (tester) async {
      await prepare(tester);
      final server = usageLimitsServer(providerUsage: providerUsagePayload());
      final remote = await pumpUsageLimitsShell(
        tester,
        server: server,
        themeMode: mode,
      );
      await convertSurface(tester);
      await shot(tester, 'account-both-$label');
      if (await openDetail(tester)) {
        await shot(tester, 'detail-both-$label');
        await tester.drag(find.byType(Scrollable).last, const Offset(0, -3000));
        await tester.pump(const Duration(milliseconds: 600));
        await shot(tester, 'detail-both-end-$label');
      }
      await unmountUsageLimitsShell(tester, server, remote);
    }, skip: _stage == 'prefix');

    testWidgets('no-organization Account ($label)', (tester) async {
      await prepare(tester);
      final server = usageLimitsServer(providerUsage: providerUsagePayload());
      final remote = await pumpUsageLimitsShell(
        tester,
        server: server,
        themeMode: mode,
        mode: AuthenticatedShellMode.noOrganization,
      );
      await convertSurface(tester);
      await shot(tester, 'account-no-org-$label');
      await unmountUsageLimitsShell(tester, server, remote);
    }, skip: _stage == 'prefix');

    if (_stage != 'before') {
      testWidgets('detail at Codex, then server and desktop lost ($label)', (
        tester,
      ) async {
        await prepare(tester);
        final server = usageLimitsServer(providerUsage: providerUsagePayload());
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: mode,
        );
        await convertSurface(tester);
        expect(await openDetail(tester), isTrue);
        // Claude scrolled away; Codex leads the body.
        await scrollUsageLimitsToCodex(tester);
        await shot(tester, 'detail-codex-live-$label');
        server.dropDelivery();
        // Past the reconnect grace, then past the unreachable threshold.
        await tester.pump(const Duration(seconds: 3));
        await shot(tester, 'detail-codex-reconnecting-$label');
        await tester.pump(const Duration(seconds: 30));
        await shot(tester, 'detail-codex-unreachable-$label');
        server.restoreDelivery();
        await tester.pump(const Duration(milliseconds: 600));
        server.heartbeat('sess-a');
        await tester.pump(const Duration(milliseconds: 600));
        server.sleep('sess-a');
        await tester.pump(const Duration(milliseconds: 600));
        await shot(tester, 'detail-codex-disconnected-$label');
        await unmountUsageLimitsShell(tester, server, remote);
      });
    }

    if (_stage == 'after') {
      testWidgets('detail scrolled under the title, then server lost '
          '($label)', (tester) async {
        await prepare(tester);
        final server = usageLimitsServer(providerUsage: providerUsagePayload());
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: mode,
        );
        await convertSurface(tester);
        expect(await openDetail(tester), isTrue);
        // Partway, so body text sits under the title and Back.
        await tester.drag(find.byType(Scrollable).last, const Offset(0, -160));
        await tester.pump(const Duration(milliseconds: 600));
        await shot(tester, 'detail-scrolled-title-$label');
        await tester.drag(find.byType(Scrollable).last, const Offset(0, 3000));
        await tester.pump(const Duration(milliseconds: 600));
        server.dropDelivery();
        await tester.pump(const Duration(seconds: 3));
        await shot(tester, 'detail-reconnecting-$label');
        await unmountUsageLimitsShell(tester, server, remote);
      });

      testWidgets('Account and detail, Claude fetch failed and Codex signed '
          'out ($label)', (tester) async {
        await prepare(tester);
        const message =
            "Couldn't reach Claude. Check the desktop's connection.";
        final server = usageLimitsServer(
          providerUsage: providerUsagePayload(
            claude: failedUsageEntry('claude', message: message),
            codex: signedOutUsageEntry('codex'),
          ),
        );
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: mode,
        );
        await convertSurface(tester);
        expectUsageLimitsUnavailableRow(tester);
        await shot(tester, 'account-claude-error-$label');
        expect(await openDetail(tester), isTrue);
        await tester.pump(const Duration(milliseconds: 300));
        expectUsageLimitsErrorDetail(tester, message);
        await shot(tester, 'detail-claude-error-$label');
        await scrollToUsageLimitsSignedOutCodex(tester);
        await shot(tester, 'detail-claude-error-codex-$label');
        expect(server.commandBodies, isEmpty);
        await unmountUsageLimitsShell(tester, server, remote);
      });

      testWidgets('detail states ($label)', (tester) async {
        await prepare(tester);
        final server = usageLimitsServer(
          providerUsage: providerUsagePayload(
            claude: claudeUsageEntry(
              fiveHour: 98,
              sevenDay: 80,
              sevenDayOpus: 79.9,
              fiveHourResetIn: const Duration(minutes: -5),
            ),
          ),
        );
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: mode,
        );
        await convertSurface(tester);
        expect(await openDetail(tester), isTrue);
        await shot(tester, 'detail-thresholds-reset-passed-$label');
        final gate = server.commandGate = Completer<void>();
        await tester.tap(
          find.byKey(const ValueKey('usage-limits-refresh-claude')),
        );
        await tester.pump(const Duration(milliseconds: 300));
        await shot(tester, 'detail-refreshing-$label');
        gate.complete();
        server.commandGate = null;
        server.push('sess-a', [
          providerUsageDeltaEnvelope(
            providerUsagePayload(
              claude: failedUsageEntry('claude'),
              codex: signedOutUsageEntry('codex'),
            ),
            cursor: 41,
          ),
        ]);
        await tester.pump(const Duration(milliseconds: 600));
        await shot(tester, 'detail-error-signed-out-$label');
        server.sleep('sess-a');
        await tester.pump(const Duration(milliseconds: 600));
        await shot(tester, 'detail-disconnected-$label');
        await unmountUsageLimitsShell(tester, server, remote);
      });
    }
  }
}
