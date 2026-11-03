import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/tabs/pipelines_tab.dart';
import '../../../../../support/usage_fixture.dart';

void main() {
  testWidgets('renders a row per pipeline with name and type badge', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: PipelinesTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    // Resolved name for the first pipeline, raw id fallback for the second.
    expect(find.text('Implementation Autopilot'), findsOneWidget);
    expect(find.text('code-review.yaml'), findsOneWidget);
    // Type badges.
    expect(find.text('Bundled'), findsOneWidget);
    expect(find.text('Project'), findsOneWidget);
  });

  testWidgets('shows an empty state when there are no pipelines', (
    tester,
  ) async {
    final usage = buildUsageFixture();
    final empty = TeamUsageResponse(
      byUser: usage.byUser,
      costByModel: usage.costByModel,
      costByProvider: usage.costByProvider,
      eventTypeStatusCounts: usage.eventTypeStatusCounts,
      headline: usage.headline,
      impactByUser: usage.impactByUser,
      mostExpensiveRuns: usage.mostExpensiveRuns,
      pipelines: const [],
      range: usage.range,
      scope: usage.scope,
      tokensByModel: usage.tokensByModel,
      tokensByProvider: usage.tokensByProvider,
      toolCategoryTotals: usage.toolCategoryTotals,
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: PipelinesTab(usage: empty)),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No pipeline runs for this range.'), findsOneWidget);
  });

  testWidgets(
    'sorts pipelines by run count descending and displays all badge types',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final usage = buildUsageFixture();
      // Create unsorted data with all four pipeline types in non-descending-runCount order:
      // Private (3) → Shared (30) → Project (20) → Bundled (10)
      // The sort should reorder them to: Shared (30) → Project (20) → Bundled (10) → Private (3)
      final unsorted = TeamUsageResponse(
        byUser: usage.byUser,
        costByModel: usage.costByModel,
        costByProvider: usage.costByProvider,
        eventTypeStatusCounts: usage.eventTypeStatusCounts,
        headline: usage.headline,
        impactByUser: usage.impactByUser,
        mostExpensiveRuns: usage.mostExpensiveRuns,
        pipelines: const [
          TelemetryPipelineUsage(
            agentTimeMs: 60000,
            clientPipelineId: 'plain-name',
            inputTokens: 100000,
            outputTokens: 5000,
            pipelineName: null,
            runCount: 3,
            totalCostUsd: 5.0,
            turnCount: 10,
          ),
          TelemetryPipelineUsage(
            agentTimeMs: 600000,
            clientPipelineId: 'shared:team-alpha',
            inputTokens: 800000,
            outputTokens: 50000,
            pipelineName: 'Team Alpha Pipeline',
            runCount: 30,
            totalCostUsd: 50.0,
            turnCount: 100,
          ),
          TelemetryPipelineUsage(
            agentTimeMs: 300000,
            clientPipelineId: 'flow.yaml',
            inputTokens: 600000,
            outputTokens: 30000,
            pipelineName: null,
            runCount: 20,
            totalCostUsd: 30.0,
            turnCount: 60,
          ),
          TelemetryPipelineUsage(
            agentTimeMs: 240000,
            clientPipelineId: 'bundled-autopilot',
            inputTokens: 400000,
            outputTokens: 20000,
            pipelineName: 'Autopilot',
            runCount: 10,
            totalCostUsd: 20.0,
            turnCount: 40,
          ),
        ],
        range: usage.range,
        scope: usage.scope,
        tokensByModel: usage.tokensByModel,
        tokensByProvider: usage.tokensByProvider,
        toolCategoryTotals: usage.toolCategoryTotals,
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(body: PipelinesTab(usage: unsorted)),
        ),
      );
      await tester.pumpAndSettle();

      // Verify all four badge labels are rendered exactly once each.
      expect(find.text('Shared'), findsOneWidget);
      expect(find.text('Project'), findsOneWidget);
      expect(find.text('Bundled'), findsOneWidget);
      expect(find.text('Private'), findsOneWidget);

      // Verify render order is descending by runCount via vertical position (dy).
      final sharedPosition = tester
          .getTopLeft(find.text('Team Alpha Pipeline'))
          .dy;
      final projectPosition = tester.getTopLeft(find.text('flow.yaml')).dy;
      final bundledPosition = tester.getTopLeft(find.text('Autopilot')).dy;
      final privatePosition = tester.getTopLeft(find.text('plain-name')).dy;

      // Shared (runCount: 30) should appear first (smallest dy).
      expect(
        sharedPosition < projectPosition,
        isTrue,
        reason:
            'Shared (runCount 30) should render before Project (runCount 20)',
      );
      // Project (runCount: 20) should appear before Bundled (runCount: 10).
      expect(
        projectPosition < bundledPosition,
        isTrue,
        reason:
            'Project (runCount 20) should render before Bundled (runCount 10)',
      );
      // Bundled (runCount: 10) should appear before Private (runCount: 3).
      expect(
        bundledPosition < privatePosition,
        isTrue,
        reason:
            'Bundled (runCount 10) should render before Private (runCount 3)',
      );
    },
  );
}
