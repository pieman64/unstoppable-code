import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/tabs/overview_tab.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_tab_list.dart';
import '../../../../../support/usage_fixture.dart';

/// The six headline cards the server actually returns, so the grid under test
/// has enough tiles to reflow into more than two columns on a tablet.
const _sixHeadlineCards = [
  TelemetryHeadlineCard(
    key: 'totalCostUsd',
    label: 'Observed cost',
    unit: TelemetryCardUnit.currency,
    value: 1284.53,
    previousValue: 1102.10,
  ),
  TelemetryHeadlineCard(
    key: 'totalTokens',
    label: 'Total tokens',
    unit: TelemetryCardUnit.tokens,
    value: 48200000,
    previousValue: 41000000,
  ),
  TelemetryHeadlineCard(
    key: 'turnCount',
    label: 'Agent turns',
    unit: TelemetryCardUnit.count,
    value: 3120,
    previousValue: 3390,
  ),
  TelemetryHeadlineCard(
    key: 'worktreesCreated',
    label: 'Worktrees',
    unit: TelemetryCardUnit.count,
    value: 214,
  ),
  TelemetryHeadlineCard(
    key: 'plansImplemented',
    label: 'Plans',
    unit: TelemetryCardUnit.count,
    value: 63,
  ),
  TelemetryHeadlineCard(
    key: 'prsCreated',
    label: 'Pull requests',
    unit: TelemetryCardUnit.count,
    value: 128,
  ),
];

TeamUsageResponse _usageWithSixHeadlineCards() {
  final usage = buildUsageFixture();
  return TeamUsageResponse(
    byUser: usage.byUser,
    costByModel: usage.costByModel,
    costByProvider: usage.costByProvider,
    eventTypeStatusCounts: usage.eventTypeStatusCounts,
    headline: _sixHeadlineCards,
    impactByUser: usage.impactByUser,
    mostExpensiveRuns: usage.mostExpensiveRuns,
    pipelines: usage.pipelines,
    range: usage.range,
    scope: usage.scope,
    tokensByModel: usage.tokensByModel,
    tokensByProvider: usage.tokensByProvider,
    toolCategoryTotals: usage.toolCategoryTotals,
  );
}

Future<void> _pumpOverview(
  WidgetTester tester, {
  double textScaleFactor = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(
          context,
        ).copyWith(textScaler: TextScaler.linear(textScaleFactor)),
        child: child!,
      ),
      home: Scaffold(body: OverviewTab(usage: _usageWithSixHeadlineCards())),
    ),
  );
  await tester.pumpAndSettle();
}

/// Rects of the headline tiles, in layout order.
List<Rect> _cardRects(WidgetTester tester) {
  final finder = find.descendant(
    of: find.byType(GridView),
    matching: find.byType(Card),
  );
  final count = tester.widgetList<Card>(finder).length;
  return [for (var i = 0; i < count; i++) tester.getRect(finder.at(i))];
}

void main() {
  group('OverviewTab headline grid', () {
    testWidgets('keeps headline cards compact at tablet width', (tester) async {
      // iPad Pro 12.9" portrait: 1024x1366 logical.
      tester.view.physicalSize = const Size(1024, 1366);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await _pumpOverview(tester);

      // A width-derived aspect ratio makes each tile as tall as it is wide on a
      // tablet (~325px), stranding the label, value and trend at the top,
      // middle and bottom of a mostly empty card. Tile height must not scale
      // with the viewport.
      for (final rect in _cardRects(tester)) {
        expect(rect.height, lessThanOrEqualTo(160.0));
      }
    });

    testWidgets('reflows into more than two columns at tablet width', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1024, 1366);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await _pumpOverview(tester);

      final columns = {
        for (final rect in _cardRects(tester)) rect.left.round(),
      };
      expect(columns.length, greaterThanOrEqualTo(3));
    });

    testWidgets('caps content width so the tab reads as a centered column', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1024, 1366);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await _pumpOverview(tester);

      // Phone-sized type spanning the full tablet width reads as a stretched,
      // empty row; extra width becomes symmetric gutters instead.
      final gridWidth = tester.getSize(find.byType(GridView)).width;
      expect(gridWidth, lessThanOrEqualTo(kStatsContentMaxWidth));

      // ...and that column stays centered.
      final gridRect = tester.getRect(find.byType(GridView));
      expect(gridRect.left, closeTo(1024 - gridRect.right, 1.0));
    });

    testWidgets('keeps the two-column phone layout intact', (tester) async {
      // iPhone 13: 390x844 logical.
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await _pumpOverview(tester);

      final rects = _cardRects(tester);
      final columns = {for (final rect in rects) rect.left.round()};
      expect(columns.length, 2);
      for (final rect in rects) {
        expect(rect.height, lessThanOrEqualTo(160.0));
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('keeps two columns at the narrowest supported phone width', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await _pumpOverview(tester);

      final columns = {
        for (final rect in _cardRects(tester)) rect.left.round(),
      };
      expect(columns.length, 2);
      expect(tester.takeException(), isNull);
    });

    testWidgets('does not overflow at large accessibility text scales', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await _pumpOverview(tester, textScaleFactor: 3);

      expect(tester.takeException(), isNull);
    });
  });
}
