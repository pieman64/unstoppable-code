import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';

void main() {
  for (final dark in [false, true]) {
    for (final size in CanopyIconButtonSize.values) {
      testWidgets('${size.name} glyph action in ${dark ? 'dark' : 'light'}', (
        tester,
      ) async {
        var presses = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: Scaffold(
              body: Center(
                child: CanopyIconButton(
                  glyph: CanopyGlyph.plusSmall,
                  tooltip: 'Add item',
                  size: size,
                  onPressed: () => presses++,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final icon = tester.widget<CanopyIcon>(find.byType(CanopyIcon));
        expect(icon.glyph, CanopyGlyph.plusSmall);
        expect(icon.size, size == CanopyIconButtonSize.small ? 20 : 24);
        final button = tester.widget<IconButton>(find.byType(IconButton));
        final style = button.style!;
        expect(style.backgroundColor!.resolve({}), Colors.transparent);
        expect(
          style.fixedSize!.resolve({}),
          Size.square(size == CanopyIconButtonSize.small ? 32 : 40),
        );
        final shape = style.shape!.resolve({})! as RoundedRectangleBorder;
        expect(shape.borderRadius, BorderRadius.circular(AppRadii.md));
        expect(style.splashFactory, InkRipple.splashFactory);
        expect(
          style.overlayColor!.resolve({WidgetState.pressed})!.a,
          greaterThan(0),
        );
        expect(find.byTooltip('Add item'), findsOneWidget);
        final bounds = tester.getRect(find.byType(IconButton));
        expect(bounds.width, greaterThanOrEqualTo(48));
        expect(bounds.height, greaterThanOrEqualTo(48));
        // The padded touch area must activate the action too.
        await tester.tapAt(bounds.topLeft + const Offset(2, 2));
        await tester.pumpAndSettle();
        expect(presses, 1);
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('defaults to medium and exposes a disabled labeled action', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CanopyIconButton(
            glyph: CanopyGlyph.trashCan,
            tooltip: 'Delete item',
            onPressed: null,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.widget<CanopyIcon>(find.byType(CanopyIcon)).size, 24);
    expect(
      tester.widget<IconButton>(find.byType(IconButton)).onPressed,
      isNull,
    );
    expect(
      tester.getSemantics(find.byType(IconButton)),
      matchesSemantics(
        tooltip: 'Delete item',
        isImage: true,
        isButton: true,
        hasEnabledState: true,
        isEnabled: false,
      ),
    );
    await tester.tap(find.byType(IconButton));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });
}
