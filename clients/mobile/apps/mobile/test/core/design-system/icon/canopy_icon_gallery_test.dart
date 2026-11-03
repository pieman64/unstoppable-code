import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_icon_gallery.dart';

void main() {
  testWidgets('configures the grid with every Canopy glyph', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: CanopyIconGallery())),
    );
    await tester.pumpAndSettle();

    final grid = tester.widget<GridView>(find.byType(GridView));
    expect(
      grid.childrenDelegate.estimatedChildCount,
      CanopyGlyph.values.length,
    );
    final first = CanopyGlyph.values.first;
    expect(find.text(first.name), findsOneWidget);
    expect(
      tester.widget<CanopyIcon>(find.byType(CanopyIcon).first).glyph,
      first,
    );
    expect(
      tester.widget<Tooltip>(find.byType(Tooltip).first).message,
      'Icon: ${first.name}',
    );
  });

  testWidgets('forwards custom size and tint to gallery icons', (tester) async {
    const tint = Color(0xFF2563EB);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: CanopyIconGallery(iconSize: 30, tint: tint)),
      ),
    );
    await tester.pumpAndSettle();

    final icon = tester.widget<CanopyIcon>(find.byType(CanopyIcon).first);
    expect(icon.size, 30);
    expect(icon.tint, tint);
  });

  testWidgets('uses the active theme color when tint is omitted', (
    tester,
  ) async {
    const themedColor = Color(0xFFEA580C);

    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: themedColor),
        ),
        home: const Scaffold(body: CanopyIconGallery()),
      ),
    );
    await tester.pumpAndSettle();

    final context = tester.element(find.byType(CanopyIconGallery));
    final icon = tester.widget<CanopyIcon>(find.byType(CanopyIcon).first);
    expect(icon.tint, Theme.of(context).colorScheme.onSurface);
  });
}
