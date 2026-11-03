import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/tabs/tokens_tab.dart';
import '../../../../../support/usage_fixture.dart';

void main() {
  testWidgets('renders the provider breakdown by default and swaps to model', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: TokensTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    // Provider series/table keys.
    expect(find.text('anthropic'), findsWidgets);
    expect(find.text('claude-opus-4-8'), findsNothing);

    // Toggle to Model.
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
    // iPhone 13 (390 logical wide): the header title + Provider/Model toggle
    // share the same layout the Observed cost tab overflowed with.
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: TokensTab(usage: buildUsageFixture())),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Provider'), findsOneWidget);
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
