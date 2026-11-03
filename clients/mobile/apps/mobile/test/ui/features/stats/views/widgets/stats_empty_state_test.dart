import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_empty_state.dart';

void main() {
  group('StatsEmptyState', () {
    testWidgets('renders the message', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: const Scaffold(
            body: StatsEmptyState(message: 'No tool usage for this range.'),
          ),
        ),
      );

      expect(find.text('No tool usage for this range.'), findsOneWidget);
    });

    testWidgets('is scrollable so pull-to-refresh can reach it', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: const Scaffold(body: StatsEmptyState(message: 'Nothing yet.')),
        ),
      );

      // An always-scrollable viewport is required so the empty state can be
      // over-dragged to trigger the enclosing RefreshIndicator.
      final scrollable = tester.widget<Scrollable>(find.byType(Scrollable));
      expect(scrollable.physics, isA<AlwaysScrollableScrollPhysics>());
    });
  });
}
