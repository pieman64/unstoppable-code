import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/button/canopy_mini_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/typography.dart';

void main() {
  for (final dark in [false, true]) {
    for (final enabled in [false, true]) {
      for (final withGlyph in [false, true]) {
        testWidgets(
          'mini action in ${dark ? 'dark' : 'light'}, enabled=$enabled, glyph=$withGlyph',
          (tester) async {
            tester.view.physicalSize = const Size(390, 844);
            tester.view.devicePixelRatio = 1;
            addTearDown(tester.view.reset);
            final semantics = tester.ensureSemantics();
            var presses = 0;
            await tester.pumpWidget(
              MaterialApp(
                theme: dark ? AppTheme.dark : AppTheme.light,
                home: Scaffold(
                  body: Center(
                    child: CanopyMiniButton(
                      label: 'Run',
                      glyph: withGlyph ? CanopyGlyph.play : null,
                      semanticsLabel: 'Run a pipeline',
                      onPressed: enabled ? () => presses++ : null,
                    ),
                  ),
                ),
              ),
            );
            final button = find.byType(CanopyMiniButton);
            final colors = AppColors.of(tester.element(button));
            final tint = enabled ? colors.accent : colors.disabledTint;
            final text = tester.widget<RichText>(
              find.descendant(
                of: find.text('Run'),
                matching: find.byType(RichText),
              ),
            );
            expect(
              text.text.style?.fontSize,
              AppTypography.compactLabel.fontSize,
            );
            expect(
              text.text.style?.fontVariations,
              AppTypography.emphasisVariations,
            );
            expect(text.text.style?.color, tint);
            if (withGlyph) {
              final icon = tester.widget<CanopyIcon>(find.byType(CanopyIcon));
              expect(icon.size, 16);
              expect(icon.tint, tint);
            } else {
              expect(find.byType(CanopyIcon), findsNothing);
            }
            expect(tester.getSize(button).height, greaterThanOrEqualTo(48));
            expect(tester.getSize(button).width, greaterThanOrEqualTo(48));
            expect(
              tester.getSemantics(button),
              isSemantics(
                label: 'Run a pipeline',
                isButton: true,
                hasEnabledState: true,
                isEnabled: enabled,
                hasTapAction: enabled,
              ),
            );
            // Tap the padded touch target, outside the visible 32px control.
            await tester.tapAt(tester.getCenter(button) + const Offset(0, 22));
            await tester.pumpAndSettle();
            expect(presses, enabled ? 1 : 0);
            expect(tester.takeException(), isNull);
            semantics.dispose();
          },
        );
      }
    }
  }

  for (final scale in [1.0, 2.0, 3.2]) {
    testWidgets('long mini label fits at ${scale}x text', (tester) async {
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
            body: Center(
              child: SizedBox(
                width: 160,
                child: CanopyMiniButton(
                  label: 'Run the selected pipeline',
                  glyph: CanopyGlyph.play,
                  onPressed: () {},
                ),
              ),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(
        tester.getSize(find.byType(CanopyMiniButton)).height,
        greaterThanOrEqualTo(48),
      );
    });
  }
}
