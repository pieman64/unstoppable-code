import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

enum CanopyComposerControlTone { neutral, statusActive }

/// Compact composer control with a 32px touch target and catalog glyphs.
/// Labels can be used alone for effort, or hidden for tint-only toggles.
class CanopyComposerControl extends StatelessWidget {
  const CanopyComposerControl({
    super.key,
    required this.label,
    required this.glyph,
    required this.onTap,
    this.selected = false,
    this.activeTint,
    this.showChevron = false,
    this.showLabel = true,
    this.showGlyph = true,
    this.leading,
    this.tooltip,
    this.tone = CanopyComposerControlTone.neutral,
  });

  final String label;
  final CanopyGlyph glyph;
  final VoidCallback? onTap;
  final bool selected;
  final Color? activeTint;
  final bool showChevron;
  final bool showLabel;
  final bool showGlyph;
  final Widget? leading;
  final CanopyComposerControlTone tone;

  /// Hover and long-press text, and the spoken name, when [label] alone does
  /// not say what the control does, such as a bare count.
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final statusActive = tone == CanopyComposerControlTone.statusActive;
    final fg = onTap == null
        ? colors.disabledTint
        : statusActive
        ? colors['fg-info']
        : selected
        ? activeTint ?? colors.foreground
        : colors.foregroundSecondary;
    final tooltip = this.tooltip;
    return Tooltip(
      message: tooltip ?? label,
      excludeFromSemantics: tooltip != null,
      child: Semantics(
        label: tooltip ?? (showLabel ? null : label),
        selected: selected,
        child: TextButton(
          onPressed: onTap,
          style: TextButton.styleFrom(
            foregroundColor: fg,
            backgroundColor: statusActive ? colors['bg-info-subtle'] : null,
            alignment: showLabel ? Alignment.centerLeft : Alignment.center,
            minimumSize: Size(statusActive ? 32 : 0, 32),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            visualDensity: VisualDensity.standard,
            padding: EdgeInsets.symmetric(
              horizontal: statusActive ? (showLabel ? 10 : 0) : 4,
            ),
            shape: statusActive
                ? const StadiumBorder()
                : RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppRadii.md),
                  ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (showGlyph)
                leading ?? CanopyIcon(glyph: glyph, size: 16, tint: fg),
              if (showLabel) ...[
                if (showGlyph) const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.bodySmall.copyWith(
                      color: fg,
                      fontFeatures: statusActive
                          ? [
                              ...AppTypography.features,
                              const FontFeature.tabularFigures(),
                            ]
                          : null,
                    ),
                  ),
                ),
              ],
              if (showChevron) ...[
                const SizedBox(width: 4),
                CanopyIcon(
                  glyph: CanopyGlyph.chevronDownSmall,
                  size: 12,
                  tint: fg,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
