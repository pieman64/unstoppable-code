import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/text-field/canopy_text_field.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';

void main() {
  late TextEditingController controller;
  setUp(() => controller = TextEditingController());
  tearDown(() => controller.dispose());

  for (final dark in [false, true]) {
    testWidgets(
      'form input supports edits, focus and errors (${dark ? 'dark' : 'light'})',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final changes = <String>[];
        final submits = <String>[];
        Widget host({String? error, bool enabled = true}) => MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(16),
              child: CanopyTextField(
                controller: controller,
                labelText: 'Base branch',
                helperText:
                    'Base branch used to compute the merge-base for review.',
                errorText: error,
                enabled: enabled,
                onChanged: changes.add,
                onSubmitted: submits.add,
                textInputAction: TextInputAction.done,
              ),
            ),
          ),
        );
        InputDecoration decoration() => tester
            .widget<InputDecorator>(find.byType(InputDecorator))
            .decoration;
        await tester.pumpWidget(host());
        final colors = dark ? AppColors.dark : AppColors.light;
        expect(decoration().fillColor, colors.surfaceRaised);
        expect(
          tester.getSize(find.byType(InputDecorator)).height,
          greaterThanOrEqualTo(48),
        );
        expect(
          find.text('Base branch used to compute the merge-base for review.'),
          findsOneWidget,
        );
        await tester.enterText(find.byType(CanopyTextField), 'main');
        await tester.pumpAndSettle();
        expect(changes, ['main']);
        expect(controller.text, 'main');
        expect(decoration().fillColor, isNot(colors.surfaceRaised));
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pumpAndSettle();
        expect(submits, ['main']);

        await tester.pumpWidget(host(error: 'Choose a branch.'));
        await tester.pumpAndSettle();
        expect(find.text('Choose a branch.'), findsOneWidget);
        expect(decoration().errorStyle?.color, colors['fg-destructive']);
        for (final border in [
          decoration().errorBorder,
          decoration().focusedErrorBorder,
        ]) {
          expect(border?.borderSide, BorderSide.none);
        }
        expect(controller.text, 'main');

        await tester.pumpWidget(host(enabled: false));
        await tester.pumpAndSettle();
        final editable = tester.widget<EditableText>(find.byType(EditableText));
        expect(editable.readOnly, isTrue);
        expect(editable.style.color, colors.disabledTint);
        expect(decoration().fillColor, colors.surfaceRaised);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.text = 'still usable';
        expect(controller.text, 'still usable');
      },
    );
  }

  for (final scale in [1.0, 2.0, 3.2]) {
    testWidgets('form input fits a phone at ${scale}x text', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(16),
              child: CanopyTextField(
                controller: controller,
                labelText: 'Base branch',
                helperText:
                    'Base branch used to compute the merge-base for review.',
              ),
            ),
          ),
        ),
      );
      await tester.enterText(
        find.byType(CanopyTextField),
        'release/long-branch-name',
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(
        tester.getSize(find.byType(TextField)).width,
        lessThanOrEqualTo(390),
      );
    });
  }
}
