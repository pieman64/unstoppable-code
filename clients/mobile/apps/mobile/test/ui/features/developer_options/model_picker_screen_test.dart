import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/developer_options/views/design_system_screen.dart';

void main() {
  for (final dark in [false, true]) {
    testWidgets('Design system shows the model picker parts '
        '(${dark ? 'dark' : 'light'})', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('model-picker-button')),
        200,
      );
      await tester.tap(find.byKey(const ValueKey('model-picker-button')));
      await tester.pumpAndSettle();
      expect(find.text('Disabled with reason'), findsOneWidget);
      expect(find.text('Add AI Credits to use this'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('preview-tab-claude')));
      await tester.pumpAndSettle();
      await tester.dragUntilVisible(
        find.text('Deep reasoning for long tasks.'),
        find.byType(ListView).first,
        const Offset(0, -200),
      );
      expect(find.text('Claude Opus'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
