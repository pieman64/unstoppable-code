import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';

void main() {
  testWidgets('loading inline button is disabled with a trailing spinner', (
    tester,
  ) async {
    var presses = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: CanopyButton(
            label: 'Merging PR…',
            glyph: CanopyGlyph.mergedSimple,
            variant: CanopyButtonVariant.inline,
            foregroundColor: StatusColors.light.merged,
            loading: true,
            onPressed: () => presses++,
          ),
        ),
      ),
    );

    final control = tester.widget<TextButton>(find.byType(TextButton));
    expect(control.onPressed, isNull);
    expect(find.text('Merging PR…'), findsOneWidget);
    expect(find.byType(CanopyIcon), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(
      tester.getTopLeft(find.byType(CircularProgressIndicator)).dx,
      greaterThan(tester.getTopRight(find.text('Merging PR…')).dx),
    );
    await tester.tap(find.byType(TextButton));
    expect(presses, 0);
  });

  for (final semanticsLabel in [null, 'Run a pipeline']) {
    testWidgets('spoken label ${semanticsLabel ?? 'defaults to the label'}', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: Center(
              child: CanopyButton(
                label: 'Run',
                glyph: CanopyGlyph.play,
                variant: CanopyButtonVariant.inline,
                semanticsLabel: semanticsLabel,
                onPressed: () {},
              ),
            ),
          ),
        ),
      );

      expect(find.text('Run'), findsOneWidget);
      expect(
        tester.getSemantics(find.byType(CanopyButton)),
        isSemantics(
          label: semanticsLabel ?? 'Run',
          isButton: true,
          isEnabled: true,
          hasTapAction: true,
        ),
      );
      handle.dispose();
    });
  }
}
