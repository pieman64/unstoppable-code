import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/main.dart' show buildProviderUsageSourceProvider;
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/account/views/usage_limits_screen.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import '../../../../support/provider_usage_fixture.dart';
import '../../../../support/remote_session_fake_server.dart';
import '../../../../support/usage_limits_shell.dart';

/// The detail screen fed through the production HTTP repository by a
/// synthetic Portal desktop, with the fixture clock injected.
final class _Harness {
  _Harness(this.server, this.remote);

  final FakePortalSessionServer server;
  final RemoteControlViewModel remote;
  DateTime now = usageFixtureNow;

  void push(Map<String, dynamic> payload) {
    final cursor = server.row('sess-a').eventCursor + 1;
    server.push('sess-a', [
      providerUsageDeltaEnvelope(payload, cursor: cursor),
    ]);
  }
}

Future<_Harness> _pump(
  WidgetTester tester, {
  Map<String, dynamic>? usage,
  ThemeMode theme = ThemeMode.light,
  double textScale = 1,
}) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final server = FakePortalSessionServer()
    ..addSession(
      id: 'sess-a',
      clientName: 'Desktop A',
      eventCursor: 40,
      capabilities: const {'provider_usage': true},
      providerUsage: usage ?? providerUsagePayload(),
    );
  final remote = RemoteControlViewModel(
    repository: server.repository(),
    stateRefreshDebounce: Duration.zero,
  );
  final harness = _Harness(server, remote);
  _open.add(harness);
  unawaited(remote.restoreIfIdle());
  for (var i = 0; i < 20 && remote.providerUsage == null; i++) {
    await tester.pump(const Duration(milliseconds: 10));
  }
  expect(remote.providerUsage, isNotNull);
  await proveUsageLimitsDelivery(tester, server);
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
        buildProviderUsageSourceProvider(),
      ],
      child: MaterialApp(
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: theme,
        home: UsageLimitsScreen(clock: () => harness.now),
      ),
    ),
  );
  await tester.pump();
  return harness;
}

final _open = <_Harness>[];

/// A test whose harness is released inside the body: the binding checks for
/// pending timers before tear-downs run.
void _screenTest(
  String description,
  Future<void> Function(WidgetTester) body,
) => testWidgets(description, (tester) async {
  try {
    await body(tester);
  } finally {
    await tester.pumpWidget(const SizedBox.shrink());
    for (final harness in _open) {
      harness.server.close();
      harness.remote.dispose();
    }
    _open.clear();
    await tester.pump(const Duration(seconds: 1));
  }
});

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

Finder _inSection(String provider, Finder finder) => find.descendant(
  of: find.byKey(ValueKey('usage-limits-section-$provider')),
  matching: finder,
);

Color? _barColor(WidgetTester tester, String windowId) => tester
    .widget<LinearProgressIndicator>(
      find.descendant(
        of: find.byKey(ValueKey('usage-limit-window-$windowId')),
        matching: find.byType(LinearProgressIndicator),
      ),
    )
    .color;

IconButton _refresh(WidgetTester tester, String provider) =>
    tester.widget<IconButton>(
      find.descendant(
        of: find.byKey(ValueKey('usage-limits-refresh-$provider')),
        matching: find.byType(IconButton),
      ),
    );

void main() {
  _screenTest('hides Copilot when the paired desktop does not report it', (
    tester,
  ) async {
    await _pump(tester);
    await tester.drag(find.byType(Scrollable).last, const Offset(0, -20000));
    await tester.pump();
    expect(
      find.byKey(const ValueKey('usage-limits-section-copilot')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  for (final theme in [ThemeMode.light, ThemeMode.dark]) {
    for (final scale in [1.0, 3.0]) {
      _screenTest(
        'Copilot quotas, account and refresh fit a phone in ${theme.name} at scale $scale',
        (tester) async {
          final harness = await _pump(
            tester,
            theme: theme,
            textScale: scale,
            usage: providerUsagePayload(
              claude: signedOutUsageEntry('claude'),
              codex: signedOutUsageEntry('codex'),
              copilot: copilotUsageEntry(premium: 0),
            ),
          );
          final button = find.byKey(
            const ValueKey('usage-limits-refresh-copilot'),
          );
          await tester.scrollUntilVisible(button, 300);
          expect(
            _inSection('copilot', find.text('fixture-github-user')),
            findsOneWidget,
          );
          await tester.tap(button);
          await _settle(tester);
          expect(harness.server.commandBodies, [
            {
              'type': 'portal.provider_usage.refresh',
              'payload': {'provider': 'copilot'},
            },
          ]);
          harness.push(
            providerUsagePayload(
              claude: signedOutUsageEntry('claude'),
              codex: signedOutUsageEntry('codex'),
              copilot: copilotUsageEntry(premium: 38),
            ),
          );
          await _settle(tester);
          await tester.scrollUntilVisible(find.text('Unlimited'), 200);
          expect(_inSection('copilot', find.text('Unlimited')), findsOneWidget);
          await tester.scrollUntilVisible(find.text('38.0%'), 200);
          expect(_inSection('copilot', find.text('38.0%')), findsOneWidget);
          expect(tester.takeException(), isNull);
          harness.server.sleep('sess-a');
          await _settle(tester);
          await tester.scrollUntilVisible(button, -300);
          expect(_refresh(tester, 'copilot').onPressed, isNull);
          expect(
            find.byKey(const ValueKey('usage-limits-disconnected')),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  _screenTest(
    'keeps missing Copilot usage distinct from unlimited and withdraws a removed provider',
    (tester) async {
      final harness = await _pump(
        tester,
        usage: providerUsagePayload(
          claude: signedOutUsageEntry('claude'),
          codex: signedOutUsageEntry('codex'),
          copilot: {
            ...copilotUsageEntry(),
            'windows': [
              {'id': 'unknown', 'label': 'Premium requests'},
            ],
          },
        ),
      );
      await tester.scrollUntilVisible(find.text('Usage unavailable'), 200);
      expect(
        _inSection('copilot', find.text('Usage unavailable')),
        findsOneWidget,
      );
      expect(_inSection('copilot', find.text('Unlimited')), findsNothing);
      expect(
        _inSection('copilot', find.byType(LinearProgressIndicator)),
        findsNothing,
      );
      harness.push(providerUsagePayload());
      await _settle(tester);
      expect(
        find.byKey(const ValueKey('usage-limits-section-copilot')),
        findsNothing,
      );
      expect(find.text('fixture-github-user'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  _screenTest('shows each provider with plan, account, windows and credits '
      '(AC-04)', (tester) async {
    await _pump(tester);

    expect(find.text('Usage limits'), findsOneWidget);
    expect(
      tester
          .getTopLeft(find.byKey(const ValueKey('usage-limits-section-claude')))
          .dy,
      lessThan(
        tester
            .getTopLeft(
              find.byKey(const ValueKey('usage-limits-section-codex')),
            )
            .dy,
      ),
    );
    expect(_inSection('claude', find.text('Claude Max 20x')), findsOneWidget);
    expect(_inSection('claude', find.text(usageFixtureEmail)), findsOneWidget);
    for (final label in [
      '5-hour window',
      '7-day',
      '7-day Opus',
      'Extra usage',
    ]) {
      expect(_inSection('claude', find.text(label)), findsOneWidget);
    }
    for (final percent in ['41.0%', '72.0%', '12.0%', '30.0%']) {
      expect(_inSection('claude', find.text(percent)), findsOneWidget);
    }
    expect(
      _inSection('claude', find.text('Spent \$15.50 of \$50.00')),
      findsOneWidget,
    );
    expect(
      _inSection('claude', find.textContaining('Resets ')),
      findsNWidgets(3),
      reason: 'Extra usage has no reset time',
    );
    expect(
      _inSection('claude', find.textContaining('Updated ')),
      findsOneWidget,
    );

    await tester.scrollUntilVisible(find.text('ChatGPT Pro'), 200);
    expect(_inSection('codex', find.text('55.0%')), findsOneWidget);
    expect(
      _inSection('codex', find.text('1,250 credits remaining')),
      findsNWidgets(2),
    );
    expect(find.textContaining('\$1,250'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  _screenTest('a signed-out provider and a failed fetch say so (AC-05)', (
    tester,
  ) async {
    await _pump(
      tester,
      usage: providerUsagePayload(
        claude: failedUsageEntry('claude'),
        codex: signedOutUsageEntry('codex'),
      ),
    );
    expect(
      _inSection(
        'claude',
        find.text("Couldn't reach Claude. Check the desktop's connection."),
      ),
      findsOneWidget,
    );
    expect(
      _inSection('codex', find.text('Not signed in on desktop')),
      findsOneWidget,
    );
    expect(find.byType(LinearProgressIndicator), findsNothing);
  });

  _screenTest('a passed reset overlays its card, also when the deadline '
      'arrives while open (AC-06)', (tester) async {
    final harness = await _pump(
      tester,
      usage: providerUsagePayload(
        claude: claudeUsageEntry(fiveHourResetIn: const Duration(minutes: -1)),
      ),
    );
    expect(
      find.byKey(const ValueKey('usage-limit-reset-passed-five_hour')),
      findsOneWidget,
    );
    expect(find.text('Reset time has passed'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('usage-limit-reset-passed-codex-primary')),
      findsNothing,
    );

    // Codex's 5-hour window resets in one hour; no usage update arrives.
    harness.now = usageFixtureNow.add(const Duration(hours: 1));
    await tester.pump(const Duration(hours: 1));
    await tester.scrollUntilVisible(find.text('ChatGPT Pro'), 200);
    expect(
      find.byKey(const ValueKey('usage-limit-reset-passed-codex-primary')),
      findsOneWidget,
    );
  });

  for (final theme in [ThemeMode.light, ThemeMode.dark]) {
    _screenTest('bars use default, amber and red at the thresholds in '
        '${theme.name} (AC-08)', (tester) async {
      await _pump(
        tester,
        theme: theme,
        usage: providerUsagePayload(
          claude: claudeUsageEntry(
            fiveHour: 98,
            sevenDay: 80,
            sevenDayOpus: 79.9,
          ),
        ),
      );
      final colors = theme == ThemeMode.dark ? AppColors.dark : AppColors.light;
      expect(_barColor(tester, 'five_hour'), colors['bg-destructive']);
      expect(_barColor(tester, 'seven_day'), colors['bg-attention']);
      expect(_barColor(tester, 'seven_day_opus'), colors.accent);
      expect(
        tester.widget<Text>(find.text('98.0%')).style?.color,
        colors['fg-destructive'],
      );
      expect(
        tester.widget<Text>(find.text('80.0%')).style?.color,
        colors['fg-attention'],
      );
    });
  }

  _screenTest('refresh sends one command, shows progress, and settles on '
      'the pushed values (AC-07, AC-09)', (tester) async {
    final harness = await _pump(tester);
    final gate = harness.server.commandGate = Completer<void>();
    await tester.tap(find.byKey(const ValueKey('usage-limits-refresh-claude')));
    await tester.pump();
    expect(
      find.byKey(const ValueKey('usage-limits-progress-claude')),
      findsOneWidget,
    );
    expect(_refresh(tester, 'claude').onPressed, isNull);
    expect(_refresh(tester, 'codex').onPressed, isNotNull);
    await tester.tap(
      find.byKey(const ValueKey('usage-limits-refresh-claude')),
      warnIfMissed: false,
    );
    gate.complete();
    harness.server.commandGate = null;
    await _settle(tester);
    expect(harness.server.commandBodies, [
      {
        'type': 'portal.provider_usage.refresh',
        'payload': {'provider': 'claude'},
      },
    ]);
    expect(
      find.byKey(const ValueKey('usage-limits-progress-claude')),
      findsOneWidget,
      reason: 'the acknowledgement only means the read started',
    );

    harness.push(
      providerUsagePayload(
        claude: claudeUsageEntry(sevenDay: 84, updatedAgo: Duration.zero),
      ),
    );
    await _settle(tester);
    expect(
      find.byKey(const ValueKey('usage-limits-progress-claude')),
      findsNothing,
    );
    expect(find.text('84.0%'), findsOneWidget);
    expect(find.text('72.0%'), findsNothing);
    expect(find.byType(UsageLimitsScreen), findsOneWidget);
  });

  _screenTest('a desktop going away keeps the values, says so and disables '
      'refresh (AC-10)', (tester) async {
    final harness = await _pump(tester);
    const note = ValueKey('usage-limits-disconnected');
    expect(find.byKey(note), findsNothing);
    harness.server.sleep('sess-a');
    await _settle(tester);
    expect(
      find.descendant(
        of: find.byKey(note),
        matching: find.text(
          'Desktop disconnected. Showing the last values received.',
          findRichText: true,
        ),
      ),
      findsOneWidget,
    );
    expect(find.text('72.0%'), findsOneWidget);
    expect(_refresh(tester, 'claude').onPressed, isNull);
    expect(_refresh(tester, 'codex').onPressed, isNull);
  });

  _screenTest('losing the server keeps the values, says so without blaming '
      'the desktop, disables refresh, and recovers', (tester) async {
    final harness = await _pump(tester);
    const delivery = ValueKey('usage-limits-delivery');
    const disconnected = ValueKey('usage-limits-disconnected');
    Finder notice(String text) => find.descendant(
      of: find.byKey(delivery),
      matching: find.text(text, findRichText: true),
    );

    // Control: a quiet but delivering link stays live past the grace.
    await tester.pump(const Duration(seconds: 3));
    expect(find.byKey(delivery), findsNothing);
    expect(_refresh(tester, 'claude').onPressed, isNotNull);

    harness.server.dropDelivery();
    await _settle(tester);
    // Within the reconnect grace nothing changes, so a brief blip on resume
    // does not flash a warning.
    expect(find.byKey(delivery), findsNothing);
    expect(_refresh(tester, 'claude').onPressed, isNotNull);

    await tester.pump(const Duration(seconds: 2));
    await tester.tap(
      find.byKey(const ValueKey('usage-limits-refresh-claude')),
      warnIfMissed: false,
    );
    await _settle(tester);
    expect(harness.server.commandBodies, isEmpty);
    expect(_refresh(tester, 'claude').onPressed, isNull);
    expect(_refresh(tester, 'codex').onPressed, isNull);
    expect(find.text('72.0%'), findsOneWidget);
    expect(
      notice('Reconnecting. Showing the last values received.'),
      findsOneWidget,
    );
    expect(find.byKey(disconnected), findsNothing);

    await tester.pump(const Duration(seconds: 30));
    expect(
      notice("Can't reach the server. Showing the last values received."),
      findsOneWidget,
    );
    expect(find.byKey(disconnected), findsNothing);
    expect(find.text('72.0%'), findsOneWidget);
    expect(_refresh(tester, 'claude').onPressed, isNull);

    // Delivery is back once a batch arrives; refresh works again.
    harness.server.restoreDelivery();
    await _settle(tester);
    harness.server.heartbeat('sess-a');
    await _settle(tester);
    expect(find.byKey(delivery), findsNothing);
    expect(find.byKey(disconnected), findsNothing);
    expect(_refresh(tester, 'claude').onPressed, isNotNull);
    await tester.tap(find.byKey(const ValueKey('usage-limits-refresh-claude')));
    await _settle(tester);
    expect(harness.server.commandBodies, [
      {
        'type': 'portal.provider_usage.refresh',
        'payload': {'provider': 'claude'},
      },
    ]);
  });

  for (final theme in [ThemeMode.light, ThemeMode.dark]) {
    _screenTest('fits 390 px at text scale 3 with 44 px targets in '
        '${theme.name} (AC-11)', (tester) async {
      await _pump(
        tester,
        theme: theme,
        textScale: 3,
        usage: providerUsagePayload(
          claude: claudeUsageEntry(
            fiveHourResetIn: const Duration(minutes: -1),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      for (final provider in ['claude', 'codex']) {
        final button = find.byKey(ValueKey('usage-limits-refresh-$provider'));
        await tester.scrollUntilVisible(button, 300);
        final size = tester.getSize(button);
        expect(size.width, greaterThanOrEqualTo(44));
        expect(size.height, greaterThanOrEqualTo(44));
        expect(tester.takeException(), isNull);
      }
      await tester.drag(find.byType(Scrollable).last, const Offset(0, -20000));
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  }
}
