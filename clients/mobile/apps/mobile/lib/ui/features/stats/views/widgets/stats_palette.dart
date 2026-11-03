import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';

/// Brand categorical series palette (`categorical-1..6` plus two primitive
/// extensions), matching the desktop/web chart tokens instead of the old
/// hardcoded Tailwind hexes. Light and dark charts read their own tiers, the
/// same split the generated theme tokens use. Memoized per brightness —
/// chart builds call [statsSeriesColor] per stack item per bucket.
List<Color> statsPalette(Brightness brightness) =>
    _palettes.putIfAbsent(brightness, () => _buildPalette(brightness));

final Map<Brightness, List<Color>> _palettes = {};

List<Color> _buildPalette(Brightness brightness) {
  final semantic = brightness == Brightness.dark
      ? Brand.darkSemanticColors
      : Brand.lightSemanticColors;
  final primitives = brightness == Brightness.dark
      ? Brand.darkPrimitives
      : Brand.lightPrimitives;
  final tier = brightness == Brightness.dark ? '300' : '600';
  return List.unmodifiable([
    for (var i = 1; i <= 6; i++)
      semantic['categorical-$i'] ?? primitives['blue-$tier'] ?? Colors.grey,
    primitives['cyan-$tier'] ?? Colors.grey,
    primitives['pink-$tier'] ?? Colors.grey,
  ]);
}

/// Series color for [index], wrapping when the palette is exceeded.
Color statsSeriesColor(int index, Brightness brightness) {
  final palette = statsPalette(brightness);
  return palette[index % palette.length];
}
