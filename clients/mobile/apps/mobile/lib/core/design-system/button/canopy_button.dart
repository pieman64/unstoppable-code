import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';

import '../icon/canopy_glyph.dart';
import '../icon/canopy_icon.dart';

enum CanopyButtonVariant {
  /// Solid accent action: the one button a surface uses for its primary move.
  primary,

  /// Unfilled action for compact cards and action lists.
  inline,
}

/// Shared labeled action with primary and compact inline treatments.
///
/// It exists so feature code stops hand-rolling
/// `FilledButton.styleFrom(backgroundColor: colors.accent, ...)` per call
/// site, which is how the same action ended up with three heights and two
/// corner radii across the app. Height and radius match the sign-in screen's
/// deliberate 48/12 pairing — 48 clears the 44px touch-target floor, and 12 is
/// the app's card corner.
class CanopyButton extends StatelessWidget {
  const CanopyButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.glyph,
    this.expand = false,
    this.variant = CanopyButtonVariant.primary,
    this.foregroundColor,
    this.loading = false,
    this.semanticsLabel,
  });

  /// Control height, comfortably above the mobile touch-target minimum.
  static const double height = 48;

  /// Leading glyph size. Reads alongside the label without competing with it.
  static const double _glyphSize = 20;

  final String label;

  /// A null callback disables the button.
  final VoidCallback? onPressed;

  /// Optional leading glyph from the CanopyGlyph catalog.
  final CanopyGlyph? glyph;

  /// Stretch to the parent's full width, for a sheet's or form's pinned
  /// action.
  final bool expand;

  /// Visual treatment. Inline actions retain the same 48px touch target.
  final CanopyButtonVariant variant;

  /// Semantic action color for an inline button. Primary buttons always use
  /// the theme accent and its paired foreground color.
  final Color? foregroundColor;

  /// Keeps the active treatment, disables taps, and adds a trailing spinner.
  final bool loading;

  /// Spoken name when a short visible [label] needs context, such as "Run"
  /// announced as "Run a pipeline". Defaults to [label].
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final enabled = onPressed != null && !loading;
    final isInline = variant == CanopyButtonVariant.inline;
    final foreground = isInline
        ? (foregroundColor ?? colors.accent)
        : colors.onAccent;
    final minimumSize = Size(expand ? double.infinity : 64, height);
    final ButtonStyle style = isInline
        ? TextButton.styleFrom(
            textStyle: Theme.of(context).textTheme.titleMedium,
            foregroundColor: foreground,
            disabledForegroundColor: loading ? foreground : colors.disabledTint,
            minimumSize: minimumSize,
          )
        : FilledButton.styleFrom(
            // The 16px emphasis step of the shared scale. Material's default label
            // role is 14, which left the primary action reading smaller than the
            // content it acts on.
            textStyle: Theme.of(context).textTheme.titleMedium,
            backgroundColor: colors.accent,
            foregroundColor: foreground,
            // Dim the whole control rather than swapping in a grey fill: the accent
            // still identifies which action this is while it is unavailable.
            disabledBackgroundColor: loading
                ? colors.accent
                : colors.accent.withValues(alpha: 0.4),
            disabledForegroundColor: loading
                ? foreground
                : foreground.withValues(alpha: 0.7),
            minimumSize: minimumSize,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadii.defaultRadius),
            ),
          );
    final disabledForeground = isInline
        ? colors.disabledTint
        : foreground.withValues(alpha: 0.7);
    final content = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        // The label names the action; the glyph is decoration.
        if (glyph case final glyph?) ...[
          ExcludeSemantics(
            child: CanopyIcon(
              glyph: glyph,
              size: _glyphSize,
              tint: enabled || loading ? foreground : disabledForeground,
            ),
          ),
          const SizedBox(width: 8),
        ],
        Flexible(
          child: Text(
            label,
            overflow: TextOverflow.ellipsis,
            semanticsLabel: semanticsLabel,
          ),
        ),
        if (loading) ...[
          const SizedBox(width: 8),
          SizedBox.square(
            dimension: 16,
            child: ExcludeSemantics(
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: foreground,
              ),
            ),
          ),
        ],
      ],
    );
    return isInline
        ? TextButton(
            onPressed: enabled ? onPressed : null,
            style: style,
            child: content,
          )
        : FilledButton(
            onPressed: enabled ? onPressed : null,
            style: style,
            child: content,
          );
  }
}
