import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Maximum width the usage tabs let their content occupy.
///
/// Phone-sized type, 2-up cards and full-bleed rows spanning a ~1024px tablet
/// read as stretched and empty. Past this width the surplus becomes symmetric
/// gutters, so every tab renders as one centered, readable column on a tablet.
/// Phones never reach the cap and keep their existing 16px margins.
const double kStatsContentMaxWidth = 840;

/// The scrolling body shared by every usage tab: a vertical [ListView] with the
/// standard 16px insets, centered and width-capped on large screens, and always
/// over-scrollable so the screen-level pull-to-refresh can fire.
///
/// The cap is applied as horizontal padding rather than a nested
/// [ConstrainedBox] so the scrollbar and the over-scroll glow still span the
/// full viewport, and so the list stays the only [Scrollable] in the subtree —
/// `StatsScreen`'s `RefreshIndicator` matches its notifications at depth 1.
class StatsTabList extends StatelessWidget {
  const StatsTabList({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final gutter = math.max(
          16.0,
          (constraints.maxWidth - kStatsContentMaxWidth) / 2,
        );
        return ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.fromLTRB(gutter, 16, gutter, 16),
          children: children,
        );
      },
    );
  }
}
