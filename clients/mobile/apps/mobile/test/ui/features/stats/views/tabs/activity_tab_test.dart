import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/tabs/activity_tab.dart';
import '../../../../../support/usage_fixture.dart';

void main() {
  testWidgets('groups event types into cards with status chips', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: ActivityTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    // One card per event type (WORKTREE_CHAT + PIPELINE_AGENT_TURN).
    expect(find.text('Worktree Chat'), findsOneWidget);
    expect(find.text('Pipeline'), findsOneWidget);
    // Status -> count chips.
    expect(find.textContaining('Success'), findsWidgets);
    expect(find.textContaining('120'), findsOneWidget);
  });

  testWidgets('separates event type cards with a vertical gap', (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: ActivityTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    // The global cardTheme zeroes out Card.margin, so each card must add its
    // own spacing or the cards render flush against each other. ActivityTab
    // renders only _ActivityCard widgets, so assert every Card carries the gap.
    final cards = tester.widgetList<Card>(find.byType(Card)).toList();
    expect(cards, isNotEmpty);
    for (final card in cards) {
      expect(card.margin, const EdgeInsets.only(bottom: 12));
    }
  });

  testWidgets('shows an empty state when there is no activity', (tester) async {
    final usage = buildUsageFixture();
    final empty = TeamUsageResponse(
      byUser: usage.byUser,
      costByModel: usage.costByModel,
      costByProvider: usage.costByProvider,
      eventTypeStatusCounts: const [],
      headline: usage.headline,
      impactByUser: usage.impactByUser,
      mostExpensiveRuns: usage.mostExpensiveRuns,
      pipelines: usage.pipelines,
      range: usage.range,
      scope: usage.scope,
      tokensByModel: usage.tokensByModel,
      tokensByProvider: usage.tokensByProvider,
      toolCategoryTotals: usage.toolCategoryTotals,
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: ActivityTab(usage: empty)),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No agent activity for this range.'), findsOneWidget);
  });

  testWidgets('sorts event type cards by total count descending', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final usage = buildUsageFixture();
    // Create unsorted data: Pipeline (45) → Standalone Chat (30) → Worktree Chat (128).
    // The sort should reorder them to: Worktree Chat (128) → Pipeline (45) → Standalone Chat (30).
    final unsorted = TeamUsageResponse(
      byUser: usage.byUser,
      costByModel: usage.costByModel,
      costByProvider: usage.costByProvider,
      eventTypeStatusCounts: const [
        TelemetryEventStatusCount(
          eventType: 'PIPELINE_AGENT_TURN',
          status: 'SUCCESS',
          count: 45,
        ),
        TelemetryEventStatusCount(
          eventType: 'STANDALONE_CHAT',
          status: 'SUCCESS',
          count: 30,
        ),
        TelemetryEventStatusCount(
          eventType: 'WORKTREE_CHAT',
          status: 'SUCCESS',
          count: 100,
        ),
        TelemetryEventStatusCount(
          eventType: 'WORKTREE_CHAT',
          status: 'FAILURE',
          count: 28,
        ),
      ],
      headline: usage.headline,
      impactByUser: usage.impactByUser,
      mostExpensiveRuns: usage.mostExpensiveRuns,
      pipelines: usage.pipelines,
      range: usage.range,
      scope: usage.scope,
      tokensByModel: usage.tokensByModel,
      tokensByProvider: usage.tokensByProvider,
      toolCategoryTotals: usage.toolCategoryTotals,
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: ActivityTab(usage: unsorted)),
      ),
    );
    await tester.pumpAndSettle();

    // Verify card titles are rendered in descending-total order.
    final worktreeChatPosition = tester
        .getTopLeft(find.text('Worktree Chat'))
        .dy;
    final pipelinePosition = tester.getTopLeft(find.text('Pipeline')).dy;
    final standaloneChatPosition = tester
        .getTopLeft(find.text('Standalone Chat'))
        .dy;

    // Worktree Chat (128 total) should appear first (smallest dy).
    expect(
      worktreeChatPosition < pipelinePosition,
      isTrue,
      reason:
          'Worktree Chat (total 128) should render before Pipeline (total 45)',
    );
    // Pipeline (45 total) should appear before Standalone Chat (30 total).
    expect(
      pipelinePosition < standaloneChatPosition,
      isTrue,
      reason:
          'Pipeline (total 45) should render before Standalone Chat (total 30)',
    );
  });
}
