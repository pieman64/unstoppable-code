import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/account/views/usage_limits_row.dart';
import 'package:mobile/ui/features/account/views/usage_limits_screen.dart';
import 'package:provider/provider.dart';

import '../../../../support/fake_provider_usage_source.dart';
import '../../../../support/provider_usage_fixture.dart';

const _row = ValueKey('account-usage-limits');

/// Mounts the row the way production does: the source is provided inside
/// `MaterialApp(home:)`, like the shell providers, so the detail route pushed
/// on the root navigator only sees it if the row re-provides it.
Future<void> _pump(WidgetTester tester, ProviderUsageSource source) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light,
      home: ListenableProvider<ProviderUsageSource>.value(
        value: source,
        child: const Scaffold(body: UsageLimitsRow()),
      ),
    ),
  );
}

void main() {
  testWidgets('a Copilot-only account opens its quotas from Account', (
    tester,
  ) async {
    final source = FakeProviderUsageSource();
    source.update(
      (s) => s
        ..isAvailable = true
        ..projection = PortalProviderUsageProjection.fromJson(
          providerUsagePayload(
            claude: signedOutUsageEntry('claude'),
            codex: signedOutUsageEntry('codex'),
            copilot: copilotUsageEntry(allUnlimited: true),
          ),
        ),
    );
    await _pump(tester, source);
    expect(find.text('Copilot'), findsOneWidget);
    expect(find.text('Unlimited'), findsOneWidget);
    await tester.tap(find.byKey(_row));
    await tester.pumpAndSettle();
    final account = find.text('fixture-github-user');
    await tester.scrollUntilVisible(account, 200);
    expect(account, findsOneWidget);
    expect(find.byType(UsageLimitsScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    source.dispose();
  });

  testWidgets('the row follows the source and opens a detail screen that '
      'borrows it', (tester) async {
    final source = FakeProviderUsageSource();
    await _pump(tester, source);
    expect(find.byKey(_row), findsNothing);

    source.update(
      (s) => s
        ..isAvailable = true
        ..projection = PortalProviderUsageProjection.fromJson(
          providerUsagePayload(claude: claudeUsageEntry(fiveHour: 91)),
        ),
    );
    await tester.pump();
    expect(
      find.descendant(
        of: find.byKey(_row),
        matching: find.text('91% · 5-hour window'),
      ),
      findsOneWidget,
    );
    final rowListeners = source.listenerCount;

    await tester.tap(find.byKey(_row));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(UsageLimitsScreen), findsOneWidget);
    expect(find.text('91.0%'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('usage-limits-refresh-claude')));
    await tester.pump();
    expect(source.refreshes, [PortalProviderUsageProvider.claude]);

    // The pushed route follows the borrowed source's delivery too.
    source.update((s) => s.delivery = ProviderUsageDelivery.reconnecting);
    await tester.pump();
    expect(find.byKey(const ValueKey('usage-limits-delivery')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('usage-limits-disconnected')),
      findsNothing,
    );
    await tester.tap(
      find.byKey(const ValueKey('usage-limits-refresh-claude')),
      warnIfMissed: false,
    );
    await tester.pump();
    expect(source.refreshes, [PortalProviderUsageProvider.claude]);
    source.update((s) => s.delivery = ProviderUsageDelivery.live);
    await tester.pump();
    expect(find.byKey(const ValueKey('usage-limits-delivery')), findsNothing);

    source.update((s) => s.isAvailable = false);
    await tester.pump();
    expect(
      find.byKey(const ValueKey('usage-limits-disconnected')),
      findsOneWidget,
    );

    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(source.listenerCount, rowListeners, reason: 'detail detached');
    // The borrowed source outlives the route.
    source.update((s) => s.isAvailable = true);
    await tester.pump();
    expect(find.byKey(_row), findsOneWidget);
  });
}
