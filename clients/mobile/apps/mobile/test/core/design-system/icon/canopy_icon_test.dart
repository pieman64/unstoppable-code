import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';

void main() {
  testWidgets('renders the requested glyph and tint at the regular tier', (
    tester,
  ) async {
    const tint = Color(0xFF7C3AED);

    await tester.pumpWidget(
      const MaterialApp(
        home: CanopyIcon(glyph: CanopyGlyph.pullRequest, size: 32, tint: tint),
      ),
    );
    await tester.pumpAndSettle();

    final picture = tester.widget<SvgPicture>(find.byType(SvgPicture));
    final loader = picture.bytesLoader as SvgAssetLoader;
    expect(loader.assetName, CanopyGlyph.pullRequest.assetPath);
    expect(picture.width, 20);
    expect(picture.height, 20);
    expect(picture.colorFilter, const ColorFilter.mode(tint, BlendMode.srcIn));
    expect(tester.takeException(), isNull);
  });

  testWidgets('defaults to 20 pixels without applying a tint', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: CanopyIcon(glyph: CanopyGlyph.agent)),
    );
    await tester.pumpAndSettle();

    final picture = tester.widget<SvgPicture>(find.byType(SvgPicture));
    expect(picture.width, 20);
    expect(picture.height, 20);
    expect(picture.colorFilter, isNull);
  });

  testWidgets(
    'compact UI icons use 14 pixels and brand marks retain their size',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Row(
            children: [
              CanopyIcon(glyph: CanopyGlyph.magnifyingGlass, size: 16),
              CanopyIcon(glyph: CanopyGlyph.claudeai, size: 24),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      final pictures = tester
          .widgetList<SvgPicture>(find.byType(SvgPicture))
          .toList();
      expect(pictures[0].width, 14);
      expect(pictures[0].height, 14);
      expect(pictures[1].width, 24);
      expect(pictures[1].height, 24);
      expect(tester.takeException(), isNull);
    },
  );
}
