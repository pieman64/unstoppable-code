import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/stats_repository.dart';
import '../support/usage_fixture.dart';

void main() {
  test('buildUsageFixture populates every tab collection', () {
    final usage = buildUsageFixture();
    expect(usage.headline, isNotEmpty);
    expect(usage.mostExpensiveRuns, isNotEmpty);
    expect(usage.tokensByProvider, isNotEmpty);
    expect(usage.tokensByModel, isNotEmpty);
    expect(usage.costByProvider, isNotEmpty);
    expect(usage.costByModel, isNotEmpty);
    expect(usage.toolCategoryTotals, isNotEmpty);
    expect(usage.eventTypeStatusCounts, isNotEmpty);
    expect(usage.impactByUser, isNotEmpty);
    expect(usage.byUser, isNotEmpty);
    expect(usage.pipelines, isNotEmpty);
  });

  test('MockStatsRepository returns populated tab collections', () async {
    final usage = await MockStatsRepository(
      latency: Duration.zero,
    ).fetchUsage();
    expect(usage.tokensByProvider, isNotEmpty);
    expect(usage.pipelines, isNotEmpty);
    expect(usage.byUser, isNotEmpty);
  });
}
