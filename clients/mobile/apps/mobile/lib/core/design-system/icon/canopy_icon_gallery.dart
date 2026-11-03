import 'package:flutter/material.dart';

import 'canopy_glyph.dart';
import 'canopy_icon.dart';

/// Developer-facing catalog of every glyph in the Canopy design system.
class CanopyIconGallery extends StatelessWidget {
  const CanopyIconGallery({
    super.key,
    this.iconSize = 24,
    this.tint,
    this.padding = const EdgeInsets.all(16),
  });

  /// The width and height of each displayed icon in logical pixels.
  final double iconSize;

  /// Optional color applied to every icon.
  ///
  /// Defaults to the active color scheme's on-surface color.
  final Color? tint;

  /// Space around the scrollable grid.
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final resolvedTint = tint ?? Theme.of(context).colorScheme.onSurface;

    return GridView.builder(
      padding: padding,
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 144,
        mainAxisExtent: 80,
        crossAxisSpacing: 8,
        mainAxisSpacing: 8,
      ),
      itemCount: CanopyGlyph.values.length,
      itemBuilder: (context, index) {
        final glyph = CanopyGlyph.values[index];

        return Tooltip(
          message: 'Icon: ${glyph.name}',
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              CanopyIcon(glyph: glyph, size: iconSize, tint: resolvedTint),
              const SizedBox(height: 8),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(
                  glyph.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
