import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/tabs/cost_tab.dart';
import '../../../../../support/usage_fixture.dart';

void main() {
  testWidgets('shows the disclaimer and swaps provider to model', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: CostTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Standard list price for these AI interactions'),
      findsOneWidget,
    );
    expect(find.text('anthropic'), findsWidgets);
    expect(find.text('claude-opus-4-8'), findsNothing);

    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();

    expect(find.text('claude-opus-4-8'), findsWidgets);
    expect(find.text('gpt-5'), findsWidgets);
    // The provider-only key must be gone now that the data source switched.
    expect(find.text('anthropic'), findsNothing);
  });

  testWidgets('lays out the header without overflow at phone width', (
    tester,
  ) async {
    // iPhone 13 (390 logical wide) — the header title + Provider/Model toggle
    // used to overflow here (RIGHT OVERFLOWED BY 35).
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: CostTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    // Toggle still works at phone width.
    expect(find.text('Provider'), findsOneWidget);
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
