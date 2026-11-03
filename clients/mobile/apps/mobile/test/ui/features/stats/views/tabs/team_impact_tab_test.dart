import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/tabs/team_impact_tab.dart';
import '../../../../../support/usage_fixture.dart';

void main() {
  testWidgets('renders a leaderboard card per person and expands detail', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: TeamImpactTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    // Both names also appear in the chart legend above the leaderboard (the
    // fixture only has 2 people, under foldTopKeys' fold threshold), so scope
    // to the leaderboard's ExpansionTile to assert exactly one card exists
    // per person.
    final alexCard = find.widgetWithText(ExpansionTile, 'Alex Rivera');
    final priyaCard = find.widgetWithText(ExpansionTile, 'Priya Nair');
    expect(alexCard, findsOneWidget);
    expect(priyaCard, findsOneWidget);

    // Expanded detail is hidden until the tile is tapped.
    expect(find.text('Worktrees created'), findsNothing);
    await tester.tap(alexCard);
    await tester.pumpAndSettle();
    expect(find.text('Worktrees created'), findsWidgets);
  });

  testWidgets('separates consecutive leaderboard cards with a vertical gap', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: TeamImpactTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    // The global cardTheme zeroes out Card.margin, so each leaderboard card
    // must add its own spacing or the cards render flush against each other.
    // Assert the top of the lower card sits below the bottom of the upper
    // card's surface (scoped to the ExpansionTile so the chart legend text
    // above doesn't match).
    final alex = tester.getRect(
      find.widgetWithText(ExpansionTile, 'Alex Rivera'),
    );
    final priya = tester.getRect(
      find.widgetWithText(ExpansionTile, 'Priya Nair'),
    );
    final upper = alex.top < priya.top ? alex : priya;
    final lower = alex.top < priya.top ? priya : alex;
    expect(lower.top - upper.bottom, greaterThanOrEqualTo(12.0));
  });

  testWidgets('sorts leaderboard cards by impact score descending', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final usage = buildUsageFixture();
    // Source order is intentionally ascending by impactScore (the opposite of
    // the fixture's default order) so this test fails if TeamImpactTab
    // renders rows in source order instead of sorting them.
    final reordered = TeamUsageResponse(
      byUser: [
        const TelemetryUserLeaderboardRow(
          agentTurns: 50,
          agentWorkBonus: 2.5,
          agentWorkUnits: 90,
          avgCycleTimeMs: 0,
          avgPrSize: 180,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          changedFiles: 18,
          checksDecided: 4,
          checksPassing: 3,
          deliveryArtifacts: 0,
          deliveryEntries: 0,
          deliveryEntriesDone: 0,
          deliveryEntriesWithTicket: 0,
          deliveryExternalActions: 0,
          deliveryImpactRaw: 0,
          deliverySharedRuns: 0,
          executionBonus: 1,
          impactScore: 9.0,
          inputTokens: 300000,
          linesChanged: 900,
          outputTokens: 20000,
          pipelineAgentSteps: 250,
          pipelineAvgRunMs: 480000,
          pipelineDistinctPipelines: 2,
          pipelineRetries: 0,
          pipelineRuns: 12,
          pipelineRunsCancelled: 1,
          pipelineRunsFailed: 2,
          pipelineRunsSucceeded: 9,
          plansCreated: 1,
          plansImplemented: 1,
          prImpactRaw: 8.0,
          prsCreated: 3,
          prsMerged: 2,
          prsOpen: 1,
          prsWithTicket: 1,
          toolUseCount: 120,
          totalCostUsd: 14.25,
          turnCount: 60,
          userId: 'user-2',
          userName: 'Priya Nair',
          worktreesCreated: 4,
        ),
        const TelemetryUserLeaderboardRow(
          agentTurns: 180,
          agentWorkBonus: 9.0,
          agentWorkUnits: 220,
          avgCycleTimeMs: 5400000,
          avgPrSize: 320,
          cacheCreationInputTokens: 50000,
          cacheReadInputTokens: 400000,
          changedFiles: 42,
          checksDecided: 10,
          checksPassing: 9,
          deliveryArtifacts: 0,
          deliveryEntries: 0,
          deliveryEntriesDone: 0,
          deliveryEntriesWithTicket: 0,
          deliveryExternalActions: 0,
          deliveryImpactRaw: 0,
          deliverySharedRuns: 0,
          executionBonus: 2,
          impactScore: 12.5,
          inputTokens: 1200000,
          linesChanged: 3400,
          outputTokens: 90000,
          pipelineAgentSteps: 900,
          pipelineAvgRunMs: 620000,
          pipelineDistinctPipelines: 5,
          pipelineRetries: 3,
          pipelineRuns: 40,
          pipelineRunsCancelled: 2,
          pipelineRunsFailed: 4,
          pipelineRunsSucceeded: 34,
          plansCreated: 4,
          plansImplemented: 3,
          prImpactRaw: 10.5,
          prsCreated: 8,
          prsMerged: 6,
          prsOpen: 2,
          prsWithTicket: 5,
          toolUseCount: 480,
          totalCostUsd: 82.5,
          turnCount: 210,
          userId: 'user-1',
          userName: 'Alex Rivera',
          worktreesCreated: 12,
        ),
      ],
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
      toolCategoryTotals: usage.toolCategoryTotals,
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: TeamImpactTab(usage: reordered)),
      ),
    );
    await tester.pumpAndSettle();

    // Alex Rivera (impactScore 12.5) must render above Priya Nair
    // (impactScore 9.0) even though the source list has Priya first. Both
    // names also appear in the chart legend, so scope to the leaderboard's
    // ExpansionTile widgets to compare card position rather than any text
    // match.
    final alexTop = tester
        .getTopLeft(find.widgetWithText(ExpansionTile, 'Alex Rivera'))
        .dy;
    final priyaTop = tester
        .getTopLeft(find.widgetWithText(ExpansionTile, 'Priya Nair'))
        .dy;
    expect(alexTop, lessThan(priyaTop));
  });

  testWidgets('shows an empty state when byUser is empty', (tester) async {
    final usage = buildUsageFixture();
    final empty = TeamUsageResponse(
      byUser: const [],
      costByModel: usage.costByModel,
      costByProvider: usage.costByProvider,
      eventTypeStatusCounts: usage.eventTypeStatusCounts,
      headline: usage.headline,
      impactByUser: const [],
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
        home: Scaffold(body: TeamImpactTab(usage: empty)),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No attributed usage for this range.'), findsOneWidget);
  });
}
