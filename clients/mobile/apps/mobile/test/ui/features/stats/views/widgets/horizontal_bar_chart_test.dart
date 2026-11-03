import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/stats/views/widgets/horizontal_bar_chart.dart';

void main() {
  testWidgets('renders a bar per datum with value labels', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: HorizontalBarChart(
            data: const [
              HorizontalBarDatum(label: 'File Edit', value: 480),
              HorizontalBarDatum(label: 'Shell', value: 320),
            ],
            valueFormatter: (v) => v.toStringAsFixed(0),
          ),
        ),
      ),
    );
    expect(find.text('File Edit'), findsOneWidget);
    expect(find.text('480'), findsOneWidget);
    expect(find.text('Shell'), findsOneWidget);
    final fills = tester
        .widgetList<FractionallySizedBox>(find.byType(FractionallySizedBox))
        .where((widget) => widget.widthFactor != null)
        .toList();
    expect(fills.map((widget) => widget.widthFactor), [1.0, 2 / 3]);
  });
}
