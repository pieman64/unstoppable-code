import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// The composer's `+` control: a circle the size of Send, drawn as a 1px
/// border with no fill so it reads as secondary to the filled Send action.
///
/// Like [CanopyComposerAction], its touch target matches the visible circle
/// so it sits on the composer row's own spacing.
class CanopyComposerActionsButton extends StatelessWidget {
  const CanopyComposerActionsButton({
    super.key,
    required this.tooltip,
    required this.onPressed,
  });

  final String tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final tint = onPressed != null
        ? colors.foregroundSecondary
        : colors.disabledTint;
    return Material(
      type: MaterialType.transparency,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        style: IconButton.styleFrom(
          fixedSize: const Size.square(CanopyComposerAction.diameter),
          minimumSize: const Size.square(CanopyComposerAction.diameter),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          visualDensity: VisualDensity.standard,
          backgroundColor: Colors.transparent,
          disabledBackgroundColor: Colors.transparent,
          foregroundColor: tint,
          disabledForegroundColor: tint,
          highlightColor: colors.foreground.withValues(alpha: 0.12),
          side: BorderSide(color: colors.border),
          shape: const CircleBorder(),
        ),
        icon: CanopyIcon(glyph: CanopyGlyph.plusSmall, size: 20, tint: tint),
      ),
    );
  }
}
