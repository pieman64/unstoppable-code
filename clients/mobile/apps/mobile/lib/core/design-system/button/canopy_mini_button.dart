import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

import '../icon/canopy_glyph.dart';
import '../icon/canopy_icon.dart';

/// Compact text action for section headers and small toolbars, with an
/// optional leading icon.
/// Keeps a 48px touch target around a 32px visual control. Text scaling can
/// increase the control height without clipping the label.
class CanopyMiniButton extends StatelessWidget {
  const CanopyMiniButton({
    super.key,
    required this.label,
    this.glyph,
    required this.onPressed,
    this.semanticsLabel,
  });

  final String label;
  final CanopyGlyph? glyph;
  final VoidCallback? onPressed;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final foreground = onPressed == null ? colors.disabledTint : colors.accent;
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        textStyle: AppTypography.compactLabel,
        foregroundColor: colors.accent,
        disabledForegroundColor: colors.disabledTint,
        minimumSize: const Size(48, 32),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        tapTargetSize: MaterialTapTargetSize.padded,
        visualDensity: VisualDensity.standard,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.md),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (glyph case final glyph?) ...[
            ExcludeSemantics(
              child: CanopyIcon(glyph: glyph, size: 16, tint: foreground),
            ),
            const SizedBox(width: 4),
          ],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              semanticsLabel: semanticsLabel,
            ),
          ),
        ],
      ),
    );
  }
}
