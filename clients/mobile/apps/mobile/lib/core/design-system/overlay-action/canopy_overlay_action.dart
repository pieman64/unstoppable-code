import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// The single attention dot a [CanopyOverlayAction] may carry.
///
/// One dot, never a cluster: the control is a 40px visual circle, and the
/// sidebar's trailing cluster already settled that stacking attention states
/// reads as noise. Callers resolve their own precedence and hand over the
/// winner.
@immutable
class CanopyOverlayActionBadge {
  const CanopyOverlayActionBadge({
    required this.color,
    required this.label,
    this.dotKey,
  });

  final Color color;

  /// Accessible name for the signal, e.g. `'Unread'`.
  final String label;

  /// Identifies which signal won, so tests and captures can tell the states
  /// apart rather than only seeing that some dot is present.
  final Key? dotKey;
}

/// Circular action that floats over scrolling content: a raised surface with
/// the transcript's own border, one glyph, and an optional badge dot.
///
/// It exists so every affordance parked in a scroll view's bottom-right
/// corner — the transcript's scroll-to-bottom control, the conversation-list
/// button — is one control at one size on one gutter, instead of two
/// hand-rolled circles that disagree by four pixels.
///
/// Callers place it with [gutter] on every free edge, so its right edge lines
/// up with the composer below it. Stacked actions offset by [stackOffset].
class CanopyOverlayAction extends StatelessWidget {
  const CanopyOverlayAction({
    super.key,
    required this.glyph,
    required this.label,
    required this.onPressed,
    this.badge,
  });

  /// Control diameter, matching the small FAB and the composer's own row of
  /// circular actions.
  static const double diameter = 40;

  /// Interactive footprint around the compact visual circle.
  static const double tapTargetSize = 44;

  /// Distance from the surrounding content's edges. Matches the composer's
  /// outer padding, so the two share one vertical edge.
  static const double gutter = 8;

  /// Vertical space one of these claims when another sits above it: the
  /// control plus the gutter between them.
  static const double stackOffset = tapTargetSize + gutter;

  final CanopyGlyph glyph;

  /// Accessible name and tooltip for the action.
  final String label;
  final VoidCallback onPressed;

  /// Aggregate attention dot overhanging the top-right edge, or null when the
  /// action has nothing to flag.
  final CanopyOverlayActionBadge? badge;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Stack(
      // The badge deliberately overhangs the button's circle.
      clipBehavior: Clip.none,
      children: [
        Tooltip(
          message: label,
          excludeFromSemantics: true,
          child: Semantics(
            button: true,
            label: label,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onPressed,
              child: SizedBox.square(
                dimension: tapTargetSize,
                child: Center(
                  child: Material(
                    color: colors.surfaceRaised,
                    shape: CircleBorder(side: BorderSide(color: colors.border)),
                    elevation: 2,
                    shadowColor: Theme.of(context).shadowColor,
                    child: InkWell(
                      customBorder: const CircleBorder(),
                      excludeFromSemantics: true,
                      onTap: onPressed,
                      child: SizedBox.square(
                        dimension: diameter,
                        child: Center(
                          child: CanopyIcon(
                            glyph: glyph,
                            size: 20,
                            tint: colors.foreground,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (badge case final CanopyOverlayActionBadge badge)
          Positioned(
            top: (tapTargetSize - diameter) / 2 - 1,
            right: (tapTargetSize - diameter) / 2 - 1,
            child: IgnorePointer(
              child: Semantics(
                label: badge.label,
                child: Container(
                  key: badge.dotKey,
                  width: 12,
                  height: 12,
                  decoration: BoxDecoration(
                    color: badge.color,
                    shape: BoxShape.circle,
                    // Reads as a badge rather than a smudge where the dot
                    // overlaps the button's own edge.
                    border: Border.all(color: colors.background, width: 2),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
