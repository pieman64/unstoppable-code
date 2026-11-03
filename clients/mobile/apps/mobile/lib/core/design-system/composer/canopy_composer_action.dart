import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// Circular primary or stop action with a 32px surface.
///
/// The touch target matches that surface rather than inflating to the 48px
/// mobile grid, so the action sits on the composer row's own 4px spacing
/// beside the mic, attach, and toolbar chips instead of carrying 8px of
/// invisible padding per side.
class CanopyComposerAction extends StatelessWidget {
  const CanopyComposerAction({
    super.key,
    required this.onPressed,
    this.stopping = false,
    this.busy = false,
  });

  static const double diameter = 32;

  // Matches the custom stop-generation SVG in desktop ChatInput.tsx.
  static const _stopSvg = '''<svg xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10" />
    <rect x="9" y="9" width="6" height="6" rx="0.5"
      fill="currentColor" stroke="none" />
  </svg>''';

  final VoidCallback? onPressed;
  final bool stopping;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final error = Theme.of(context).colorScheme.error;
    final stopTint = error.withValues(alpha: 0.7);
    final enabled = onPressed != null;
    final surfaceColor = stopping
        ? error.withValues(alpha: 0.1)
        : enabled
        ? colors.accent
        : colors.surfaceRaised;
    final foregroundColor = stopping
        ? enabled
              ? stopTint
              : colors.disabledTint
        : enabled
        ? colors.onAccent
        : colors.disabledTint;
    return Material(
      type: MaterialType.transparency,
      child: IconButton(
        tooltip: stopping ? 'Stop' : 'Send',
        onPressed: onPressed,
        style: IconButton.styleFrom(
          fixedSize: const Size.square(diameter),
          minimumSize: const Size.square(diameter),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          visualDensity: VisualDensity.standard,
          backgroundColor: surfaceColor,
          disabledBackgroundColor: surfaceColor,
          foregroundColor: foregroundColor,
          disabledForegroundColor: foregroundColor,
          shape: const CircleBorder(),
        ),
        icon: busy
            ? const SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : stopping
            ? SvgPicture.string(
                _stopSvg,
                width: 16,
                height: 16,
                colorFilter: ColorFilter.mode(foregroundColor, BlendMode.srcIn),
              )
            : CanopyIcon(
                glyph: CanopyGlyph.arrowUp,
                size: 18,
                tint: foregroundColor,
              ),
      ),
    );
  }
}
