// CAN-3636 — durable device flow for the Account Usage limits row and detail
// screen. Run from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3636_usage_limits_device_test.dart \
//     -d <device-id>
//
// The production shell and HTTP repository talk to a synthetic Portal server
// (`remote_session_fake_server.dart`) whose desktop projects invented Claude
// and Codex usage. It covers the phone's side: the initial cached singleton,
// pushed deltas, the refresh command, this phone losing the server and a
// desktop going away. It does not prove a live desktop or real provider
// account.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/support/provider_usage_fixture.dart';
import '../test/support/usage_limits_shell.dart';
import '../test/support/usage_limits_viewport.dart';

const _row = ValueKey('account-usage-limits');
const _refreshClaude = ValueKey('usage-limits-refresh-claude');
const _disconnected = usageLimitsDisconnectedNote;
const _delivery = usageLimitsDeliveryNote;
const _disconnectedMessage =
    'Desktop disconnected. Showing the last values received.';

Finder _inRow(String text) =>
    find.descendant(of: find.byKey(_row), matching: find.text(text));

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Account row, detail, refresh, live update and disconnect', (
    tester,
  ) async {
    final server = usageLimitsServer(providerUsage: providerUsagePayload());
    final remote = await pumpUsageLimitsShell(
      tester,
      server: server,
      themeMode: ThemeMode.light,
    );
    // The fixture reached Account: profile and Organization are on screen.
    expect(find.text('google.user@example.com'), findsOneWidget);
    expect(find.text('Organization'), findsOneWidget);

    // AC-01: the row sits between the profile and Organization.
    expect(find.byKey(_row), findsOneWidget);
    expect(_inRow('72% · 7-day'), findsOneWidget);
    expect(_inRow('55% · 7-day window'), findsOneWidget);
    expect(
      tester.getBottomLeft(find.byKey(_row)).dy,
      lessThanOrEqualTo(tester.getTopLeft(find.text('Organization')).dy),
    );

    // AC-04: the detail screen opens with every window and the credits.
    await tester.tap(find.byKey(_row));
    await _settle(tester);
    expect(find.text('Claude Max 20x'), findsOneWidget);
    expect(find.text('ChatGPT Pro'), findsOneWidget);
    expect(find.text('72.0%'), findsOneWidget);
    expect(find.text('5-hour window'), findsWidgets);
    await tester.scrollUntilVisible(find.text('Extra usage'), 200);
    expect(find.text('Spent \$15.50 of \$50.00'), findsOneWidget);
    await tester.scrollUntilVisible(find.byKey(_refreshClaude), -200);

    // AC-07: repeated taps send one refresh and show progress until data.
    final gate = server.commandGate = Completer<void>();
    await tester.tap(find.byKey(_refreshClaude));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(_refreshClaude), warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 100));
    expect(
      find.byKey(const ValueKey('usage-limits-progress-claude')),
      findsOneWidget,
    );
    gate.complete();
    server.commandGate = null;
    await _settle(tester);
    expect(server.commandBodies, [
      {
        'type': 'portal.provider_usage.refresh',
        'payload': {'provider': 'claude'},
      },
    ]);
    expect(
      find.byKey(const ValueKey('usage-limits-progress-claude')),
      findsOneWidget,
    );
    server.push('sess-a', [
      providerUsageDeltaEnvelope(
        providerUsagePayload(
          claude: claudeUsageEntry(sevenDay: 81, updatedAgo: Duration.zero),
        ),
        cursor: 41,
      ),
    ]);
    await _settle(tester);
    expect(
      find.byKey(const ValueKey('usage-limits-progress-claude')),
      findsNothing,
    );
    expect(find.text('81.0%'), findsOneWidget);

    // AC-09: a pushed Codex update lands without leaving the screen.
    server.push('sess-a', [
      providerUsageDeltaEnvelope(
        providerUsagePayload(
          claude: claudeUsageEntry(sevenDay: 81, updatedAgo: Duration.zero),
          codex: codexUsageEntry(secondary: 64),
        ),
        cursor: 42,
      ),
    ]);
    await _settle(tester);
    // Codex leads the body, Claude scrolled away above it.
    final position = await scrollUsageLimitsToCodex(
      tester,
      codexValue: '64.0%',
    );
    final offset = position.pixels;

    // AC-10: the desktop goes away while the user is at Codex. The note is
    // in view there without scrolling, the values stay, refresh is disabled.
    server.sleep('sess-a');
    await _settle(tester);
    expectUsageLimitsNoteInView(tester, _disconnected, _disconnectedMessage);
    expect(position.pixels, offset, reason: 'no forced scroll');
    expectInUsageLimitsBody(tester, find.text('64.0%'), 'Codex value kept');
    await expectUsageLimitsRefreshBlocked(
      tester,
      server,
      _disconnected,
      _disconnectedMessage,
    );
    expect(server.commandBodies, hasLength(1));

    await tester.pageBack();
    await _settle(tester);
    expect(find.byKey(_row), findsNothing);
    expect(find.text('Organization'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await unmountUsageLimitsShell(tester, server, remote);
  });

  testWidgets('losing the server keeps the values and disables refresh '
      'until delivery returns', (tester) async {
    final server = usageLimitsServer(providerUsage: providerUsagePayload());
    final remote = await pumpUsageLimitsShell(
      tester,
      server: server,
      themeMode: ThemeMode.dark,
    );
    await tester.tap(find.byKey(_row));
    await _settle(tester);
    expect(find.text('72.0%'), findsOneWidget);
    final position = await scrollUsageLimitsToCodex(tester);
    final offset = position.pixels;

    server.dropDelivery();
    // Past the reconnect grace: the note is in view at Codex.
    await tester.pump(const Duration(seconds: 3));
    expectUsageLimitsNoteInView(
      tester,
      _delivery,
      'Reconnecting. Showing the last values received.',
    );
    expect(find.byKey(_disconnected), findsNothing);
    expect(position.pixels, offset, reason: 'no forced scroll');
    expectInUsageLimitsBody(tester, find.text('55.0%'), 'Codex value kept');

    // Past the unreachable threshold: the same place, a different reason.
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

    server.restoreDelivery();
    await _settle(tester);
    server.heartbeat('sess-a');
    await _settle(tester);
    expect(find.byKey(_delivery), findsNothing);
    final claudeRefresh = await scrollToUsageLimitsRefresh(tester, 'claude');
    expect(
      usageLimitsRefreshButton(tester, claudeRefresh).onPressed,
      isNotNull,
    );
    await tester.tap(claudeRefresh);
    await _settle(tester);
    expect(server.commandBodies, [
      {
        'type': 'portal.provider_usage.refresh',
        'payload': {'provider': 'claude'},
      },
    ]);

    await tester.pageBack();
    await _settle(tester);
    expect(find.byKey(_row), findsOneWidget);
    expect(tester.takeException(), isNull);
    await unmountUsageLimitsShell(tester, server, remote);
  });

  testWidgets('one signed-in provider shows one line (AC-02)', (tester) async {
    final server = usageLimitsServer(
      providerUsage: providerUsagePayload(codex: signedOutUsageEntry('codex')),
    );
    final remote = await pumpUsageLimitsShell(
      tester,
      server: server,
      themeMode: ThemeMode.dark,
    );
    expect(find.text('Organization'), findsOneWidget);
    expect(find.byKey(_row), findsOneWidget);
    expect(_inRow('Claude'), findsOneWidget);
    expect(_inRow('Codex'), findsNothing);
    await unmountUsageLimitsShell(tester, server, remote);
  });

  testWidgets('a signed-in provider whose fetch failed keeps its line, '
      'which opens its error; refresh recovers it (AC-05, AC-07)', (
    tester,
  ) async {
    const message = "Couldn't reach Claude. Check the desktop's connection.";
    const claudeOnly = {
      'type': 'portal.provider_usage.refresh',
      'payload': {'provider': 'claude'},
    };
    final server = usageLimitsServer(
      providerUsage: providerUsagePayload(
        claude: failedUsageEntry('claude', message: message),
        codex: signedOutUsageEntry('codex'),
      ),
    );
    final remote = await pumpUsageLimitsShell(
      tester,
      server: server,
      themeMode: ThemeMode.light,
    );
    final progress = find.byKey(const ValueKey('usage-limits-progress-claude'));
    // Remote Control's banner, composer gate and turn reporting read these;
    // a usage refresh, failed or not, must never reach them.
    void expectNoRemoteCommandFailure(String commandId) {
      expect(remote.commandFailureMessage, isNull);
      expect(remote.hasCommandFailed(commandId), isFalse);
    }

    expect(find.byKey(_row), findsOneWidget);
    expect(_inRow('Claude'), findsOneWidget);
    expect(_inRow('Usage unavailable'), findsOneWidget);
    expect(_inRow('Codex'), findsNothing);
    await tester.tap(find.byKey(_row));
    await _settle(tester);
    expect(find.text(message), findsOneWidget);
    expect(find.text('Not signed in on desktop'), findsOneWidget);
    final refresh = await scrollToUsageLimitsRefresh(tester, 'claude');
    expect(usageLimitsRefreshButton(tester, refresh).onPressed, isNotNull);

    // The desktop rejects the first refresh before this phone reads its ACK.
    // While it is in flight the refresh shows progress and takes no second tap.
    final gate = server.commandGate = Completer<void>();
    await tester.tap(refresh);
    await tester.pump(const Duration(milliseconds: 100));
    expect(progress, findsOneWidget);
    expect(usageLimitsRefreshButton(tester, refresh).onPressed, isNull);
    await tester.tap(refresh, warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 100));
    expect(server.commandBodies, [claudeOnly]);
    server.push('sess-a', [
      {
        'eventId': 'evt-usage-failed-1',
        'cursor': 41,
        'type': 'portal.command.failed',
        'payload': {'commandId': 'cmd-1', 'error': 'Claude is busy.'},
      },
    ]);
    await _settle(tester);
    gate.complete();
    server.commandGate = null;
    await _settle(tester);
    expect(progress, findsNothing);
    expect(find.text('Claude is busy.'), findsOneWidget);
    expect(find.text(message), findsOneWidget);
    expect(usageLimitsRefreshButton(tester, refresh).onPressed, isNotNull);
    expectNoRemoteCommandFailure('cmd-1');

    // Retry: acknowledged, then rejected after the ACK.
    await tester.tap(refresh);
    await _settle(tester);
    expect(server.commandBodies, [claudeOnly, claudeOnly]);
    expect(progress, findsOneWidget);
    expect(find.text('Claude is busy.'), findsNothing);
    server.push('sess-a', [
      {
        'eventId': 'evt-usage-failed-2',
        'cursor': 42,
        'type': 'portal.command.failed',
        'payload': {'commandId': 'cmd-2', 'error': 'Claude is still busy.'},
      },
    ]);
    await _settle(tester);
    expect(progress, findsNothing);
    expect(find.text('Claude is still busy.'), findsOneWidget);
    expectNoRemoteCommandFailure('cmd-2');

    // Retry again: the desktop reads usage and pushes recovered values.
    await tester.tap(refresh);
    await _settle(tester);
    expect(server.commandBodies, [claudeOnly, claudeOnly, claudeOnly]);
    expect(progress, findsOneWidget);
    expect(find.text('Claude is still busy.'), findsNothing);
    server.push('sess-a', [
      providerUsageDeltaEnvelope(
        providerUsagePayload(
          claude: claudeUsageEntry(updatedAgo: Duration.zero),
          codex: signedOutUsageEntry('codex'),
        ),
        cursor: 43,
      ),
    ]);
    await _settle(tester);
    expect(progress, findsNothing);
    expect(find.text(message), findsNothing);
    expect(find.text('72.0%'), findsOneWidget);
    expect(find.text('Not signed in on desktop'), findsOneWidget);
    expect(usageLimitsRefreshButton(tester, refresh).onPressed, isNotNull);
    expectNoRemoteCommandFailure('cmd-3');
    expect(server.commandBodies, [claudeOnly, claudeOnly, claudeOnly]);

    // Back on the same Account, the row shows the recovered window.
    await tester.pageBack();
    await _settle(tester);
    expect(find.text('google.user@example.com'), findsOneWidget);
    expect(find.text('Organization'), findsOneWidget);
    expect(_inRow('72% · 7-day'), findsOneWidget);
    expect(_inRow('Usage unavailable'), findsNothing);
    expect(_inRow('Codex'), findsNothing);
    expectNoRemoteCommandFailure('cmd-3');
    expect(tester.takeException(), isNull);
    await unmountUsageLimitsShell(tester, server, remote);
  });

  testWidgets('a desktop without the capability hides the row (AC-03)', (
    tester,
  ) async {
    final server = usageLimitsServer(
      providerUsage: providerUsagePayload(),
      capabilities: const {},
    );
    final remote = await pumpUsageLimitsShell(
      tester,
      server: server,
      themeMode: ThemeMode.light,
    );
    expect(find.text('Organization'), findsOneWidget);
    expect(find.byKey(_row), findsNothing);
    expect(find.text('Usage limits'), findsNothing);
    await unmountUsageLimitsShell(tester, server, remote);
  });
}
