import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'canopy_glyph.dart';

/// Renders a [CanopyGlyph] from the shared design-system asset catalog.
class CanopyIcon extends StatelessWidget {
  const CanopyIcon({super.key, required this.glyph, this.size = 24, this.tint});

  /// The design-system glyph to render.
  final CanopyGlyph glyph;

  /// UI glyphs resolve to 14px compact (up to 16 requested) or 20px regular.
  /// Brand/provider marks preserve the requested logical-pixel size.
  final double size;

  /// Optional color applied to the monochrome glyph.
  final Color? tint;

  @override
  Widget build(BuildContext context) {
    final resolvedSize = glyph.isBrandMark ? size : (size <= 16 ? 14.0 : 20.0);
    return SvgPicture.asset(
      glyph.assetPath,
      width: resolvedSize,
      height: resolvedSize,
      colorFilter: tint == null
          ? null
          : ColorFilter.mode(tint!, BlendMode.srcIn),
    );
  }
}
