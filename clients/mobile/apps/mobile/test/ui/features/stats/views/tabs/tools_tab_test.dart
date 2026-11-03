import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/tabs/tools_tab.dart';
import '../../../../../support/usage_fixture.dart';

void main() {
  testWidgets('renders a labeled bar for each tool category', (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: ToolsTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('File Edit'), findsOneWidget);
    expect(find.text('Shell'), findsOneWidget);
    expect(find.text('Search'), findsOneWidget);
  });

  testWidgets('shows an empty state when there are no tools', (tester) async {
    final usage = buildUsageFixture();
    final empty = TeamUsageResponse(
      byUser: usage.byUser,
      costByModel: usage.costByModel,
      costByProvider: usage.costByProvider,
      eventTypeStatusCounts: usage.eventTypeStatusCounts,
      headline: usage.headline,
      impactByUser: usage.impactByUser,
      mostExpensiveRuns: usage.mostExpensiveRuns,
      pipelines: usage.pipelines,
      range: usage.range,
      scope: usage.scope,
      tokensByModel: usage.tokensByModel,
      tokensByProvider: usage.tokensByProvider,
      toolCategoryTotals: const [],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: ToolsTab(usage: empty)),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No tool usage for this range.'), findsOneWidget);
  });
}
