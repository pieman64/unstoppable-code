import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/tabs/activity_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/cost_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/overview_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/pipelines_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/team_impact_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/tokens_tab.dart';
import 'package:mobile/ui/features/stats/views/tabs/tools_tab.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';
import '../../../../../support/usage_fixture.dart';

Future<void> _pump(WidgetTester tester, Widget body) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(body: body),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('StatsTabList', () {
    testWidgets('keeps full-width rows at 16px margins on a phone', (
      tester,
    ) async {
      // iPhone 13: 390x844 logical.
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await _pump(
        tester,
        StatsTabList(children: [Container(key: const Key('row'), height: 40)]),
      );

      expect(tester.getSize(find.byKey(const Key('row'))).width, 390 - 32);
    });

    testWidgets('centers a capped column on a tablet', (tester) async {
      // iPad Pro 12.9" portrait: 1024x1366 logical.
      tester.view.physicalSize = const Size(1024, 1366);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await _pump(
        tester,
        StatsTabList(children: [Container(key: const Key('row'), height: 40)]),
      );

      final row = tester.getRect(find.byKey(const Key('row')));
      expect(row.width, kStatsContentMaxWidth);
      expect(row.left, closeTo(1024 - row.right, 1.0));
    });
  });

  group('every usage tab', () {
    final usage = buildUsageFixture();
    final tabs = <String, Widget>{
      'Overview': OverviewTab(usage: usage),
      'Team Impact': TeamImpactTab(usage: usage),
      'Tokens': TokensTab(usage: usage),
      'Observed cost': CostTab(usage: usage),
      'Pipelines': PipelinesTab(usage: usage),
      'Tools': ToolsTab(usage: usage),
      'Activity': ActivityTab(usage: usage),
    };

    for (final entry in tabs.entries) {
      testWidgets('${entry.key} caps its content width on a tablet', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(1024, 1366);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await _pump(tester, entry.value);

        // Every tab scrolls through the shared body, so the whole Usage page —
        // not just the Overview grid — reads as one centered column instead of
        // phone-sized type stretched across the full tablet width.
        final padding = tester
            .widget<ListView>(find.byType(ListView))
            .padding
            ?.resolve(TextDirection.ltr);
        expect(padding?.left, (1024 - kStatsContentMaxWidth) / 2);
        expect(padding?.right, (1024 - kStatsContentMaxWidth) / 2);
        expect(tester.takeException(), isNull);
      });
    }
  });
}
