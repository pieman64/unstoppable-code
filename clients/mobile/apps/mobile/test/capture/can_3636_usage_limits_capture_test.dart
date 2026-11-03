// CAN-3636: Account gains a Usage limits row (Claude and Codex plan usage
// from the paired desktop) that opens a Usage limits detail screen.
// From apps/mobile, before and after changing production code, at the normal
// and the largest tested text scale:
// CAN3636_CAPTURE=1 CAN3636_STAGE=before CAN3636_TEXT_SCALE=1 flutter test --no-pub test/capture/can_3636_usage_limits_capture_test.dart --update-goldens
// CAN3636_CAPTURE=1 CAN3636_STAGE=before CAN3636_TEXT_SCALE=3 flutter test --no-pub test/capture/can_3636_usage_limits_capture_test.dart --update-goldens
// Repeat both with CAN3636_STAGE=after. CAN3636_STAGE=prefix captures only
// the detail scrolled to Codex losing the desktop or the server, for matching
// a review repair's fix against the tree before it.
// Light and dark render the production shell (`buildSharedShellProviders`)
// at 390x844 with real fonts. Remote Control uses the production HTTP
// repository against a synthetic Portal server; usage values, plans and the
// email are invented. The spec only finds widgets by key and text, so the same
// file runs on the unchanged tree, where the detail screen does not exist yet.
// This capture is visual evidence; durable coverage lives in
// account_screen_test.dart, usage_limits_screen_test.dart and
// integration_test/can_3636_usage_limits_device_test.dart.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';

import '../support/provider_usage_fixture.dart';
import '../support/usage_limits_shell.dart';
import '../support/usage_limits_viewport.dart';

final bool _captureEnabled = Platform.environment['CAN3636_CAPTURE'] == '1';
final String _stage = switch (Platform.environment['CAN3636_STAGE']) {
  final stage? when stage == 'before' || stage == 'prefix' => stage,
  _ => 'after',
};
final double _textScale =
    double.tryParse(Platform.environment['CAN3636_TEXT_SCALE'] ?? '') ?? 1;
final String _scaleLabel = 's${_textScale.toStringAsFixed(0)}';

const _row = ValueKey('account-usage-limits');

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
}

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  tester.view.padding = const FakeViewPadding(top: 141, bottom: 102);
  tester.platformDispatcher.textScaleFactorTestValue = _textScale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

Future<void> _capture(WidgetTester tester, String name) async {
  await tester.pump(const Duration(milliseconds: 300));
  if (!_captureEnabled) return;
  Directory('../../.playwright/CAN-3636').createSync(recursive: true);
  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile(
      '../../../../.playwright/CAN-3636/host-$name-$_stage-$_scaleLabel.png',
    ),
  );
}

Future<bool> _openDetail(WidgetTester tester) async {
  final row = find.byKey(_row);
  if (row.evaluate().isEmpty) return false;
  await tester.tap(row);
  await tester.pump(const Duration(milliseconds: 600));
  return true;
}

Future<void> _scrollToEnd(WidgetTester tester) async {
  final scrollable = find.byType(Scrollable).last;
  await tester.drag(scrollable, const Offset(0, -3000));
  await tester.pump(const Duration(milliseconds: 600));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFont('Inter', const ['assets/fonts/inter/InterVariable.ttf']);
    await _loadFont('JetBrainsMono', const [
      'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
    ]);
    final flutterRoot = File(
      Platform.resolvedExecutable,
    ).parent.parent.parent.parent.parent.path;
    await _loadFont('MaterialIcons', [
      'build/unit_test_assets/fonts/MaterialIcons-Regular.otf',
      '$flutterRoot/bin/cache/artifacts/material_fonts/'
          'MaterialIcons-Regular.otf',
    ]);
  });

  for (final theme in [ThemeMode.light, ThemeMode.dark]) {
    final label = theme.name;

    testWidgets(
      'Account and detail, both providers, $label',
      (tester) async {
        _phone(tester);
        final server = usageLimitsServer(providerUsage: providerUsagePayload());
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: theme,
        );
        await _capture(tester, 'account-both-$label');
        if (await _openDetail(tester)) {
          await _capture(tester, 'detail-both-$label');
          await _scrollToEnd(tester);
          await _capture(tester, 'detail-both-end-$label');
        }
        expect(tester.takeException(), isNull);
        await unmountUsageLimitsShell(tester, server, remote);
      },
      skip: !_captureEnabled || _stage == 'prefix',
    );

    testWidgets(
      'no-organization Account, $label',
      (tester) async {
        _phone(tester);
        final server = usageLimitsServer(providerUsage: providerUsagePayload());
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: theme,
          mode: AuthenticatedShellMode.noOrganization,
        );
        await _capture(tester, 'account-no-org-$label');
        expect(tester.takeException(), isNull);
        await unmountUsageLimitsShell(tester, server, remote);
      },
      skip: !_captureEnabled || _stage == 'prefix',
    );

    testWidgets(
      'Account with only Claude signed in, $label',
      (tester) async {
        _phone(tester);
        final server = usageLimitsServer(
          providerUsage: providerUsagePayload(
            codex: signedOutUsageEntry('codex'),
          ),
        );
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: theme,
        );
        await _capture(tester, 'account-claude-only-$label');
        expect(tester.takeException(), isNull);
        await unmountUsageLimitsShell(tester, server, remote);
      },
      skip: !_captureEnabled || _stage != 'after',
    );

    testWidgets(
      'Account and detail, Claude fetch failed and Codex signed out, $label',
      (tester) async {
        _phone(tester);
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
          themeMode: theme,
        );
        await tester.pump(const Duration(milliseconds: 300));
        expectUsageLimitsUnavailableRow(tester);
        await _capture(tester, 'account-claude-error-$label');
        expect(await _openDetail(tester), isTrue);
        await tester.pump(const Duration(milliseconds: 300));
        expectUsageLimitsErrorDetail(tester, message);
        await _capture(tester, 'detail-claude-error-$label');
        await scrollToUsageLimitsSignedOutCodex(tester);
        await _capture(tester, 'detail-claude-error-codex-$label');
        expect(server.commandBodies, isEmpty);
        expect(tester.takeException(), isNull);
        await unmountUsageLimitsShell(tester, server, remote);
      },
      skip: !_captureEnabled || _stage != 'after',
    );

    testWidgets('detail scrolled under the title, then server lost, '
        '$label', (tester) async {
      _phone(tester);
      final server = usageLimitsServer(providerUsage: providerUsagePayload());
      final remote = await pumpUsageLimitsShell(
        tester,
        server: server,
        themeMode: theme,
      );
      expect(await _openDetail(tester), isTrue);
      // Let the route transition finish so it no longer absorbs the drag.
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      // Partway, so body text sits under the title and Back.
      final scrollable = find.byType(Scrollable).last;
      await tester.drag(scrollable, const Offset(0, -160));
      await tester.pump(const Duration(milliseconds: 600));
      final position = tester.state<ScrollableState>(scrollable).position;
      expect(position.pixels, greaterThan(0));
      await _capture(tester, 'detail-scrolled-title-$label');

      await tester.drag(scrollable, const Offset(0, 3000));
      await tester.pump(const Duration(milliseconds: 600));
      expect(position.pixels, 0);
      server.dropDelivery();
      // Past the reconnect grace.
      await tester.pump(const Duration(seconds: 3));
      expect(
        find.text(
          'Reconnecting. Showing the last values received.',
          findRichText: true,
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('usage-limits-disconnected')),
        findsNothing,
      );
      expect(find.text('72.0%'), findsOneWidget);
      await _capture(tester, 'detail-reconnecting-$label');
      expect(tester.takeException(), isNull);
      await unmountUsageLimitsShell(tester, server, remote);
    }, skip: !_captureEnabled || _stage != 'after');

    testWidgets('detail states, $label', (tester) async {
      _phone(tester);
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
        themeMode: theme,
      );
      expect(await _openDetail(tester), isTrue);
      // 98% red, 80% amber, 79.9% default; the passed 5-hour reset overlays.
      await _capture(tester, 'detail-thresholds-reset-passed-$label');

      final gate = server.commandGate = Completer<void>();
      await tester.tap(
        find.byKey(const ValueKey('usage-limits-refresh-claude')),
      );
      await tester.pump(const Duration(milliseconds: 300));
      await _capture(tester, 'detail-refreshing-$label');
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
      await _capture(tester, 'detail-error-signed-out-$label');

      server.sleep('sess-a');
      await tester.pump(const Duration(milliseconds: 600));
      await _capture(tester, 'detail-disconnected-$label');
      expect(tester.takeException(), isNull);
      await unmountUsageLimitsShell(tester, server, remote);
    }, skip: !_captureEnabled || _stage != 'after');

    testWidgets(
      'detail at Codex, then server and desktop lost, $label',
      (tester) async {
        _phone(tester);
        final server = usageLimitsServer(providerUsage: providerUsagePayload());
        final remote = await pumpUsageLimitsShell(
          tester,
          server: server,
          themeMode: theme,
        );
        expect(await _openDetail(tester), isTrue);
        for (var i = 0; i < 4; i++) {
          await tester.pump(const Duration(milliseconds: 200));
        }
        // Claude scrolled away; Codex leads the body.
        await scrollUsageLimitsToCodex(tester);
        await _capture(tester, 'detail-codex-live-$label');
        server.dropDelivery();
        // Past the reconnect grace, then past the unreachable threshold.
        await tester.pump(const Duration(seconds: 3));
        await _capture(tester, 'detail-codex-reconnecting-$label');
        await tester.pump(const Duration(seconds: 30));
        await _capture(tester, 'detail-codex-unreachable-$label');
        server.restoreDelivery();
        await tester.pump(const Duration(milliseconds: 600));
        server.heartbeat('sess-a');
        await tester.pump(const Duration(milliseconds: 600));
        server.sleep('sess-a');
        await tester.pump(const Duration(milliseconds: 600));
        await _capture(tester, 'detail-codex-disconnected-$label');
        expect(tester.takeException(), isNull);
        await unmountUsageLimitsShell(tester, server, remote);
      },
      skip: !_captureEnabled || _stage == 'before',
    );
  }
}
