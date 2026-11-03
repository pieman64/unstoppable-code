import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/composer/canopy_model_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// Compact model picker row: vendor icon, label and an optional trailing
/// [tag], such as [aiCreditsTag]. A selected row is tinted and its icon takes the
/// vendor's brand hue; there is no checkmark. A disabled row stays tappable so
/// it can show [explanation] inline. A [glyph] replaces the vendor icon for a
/// row that is not a model, such as Auto.
class CanopyModelRow extends StatelessWidget {
  const CanopyModelRow({
    super.key,
    required this.vendor,
    required this.label,
    required this.onTap,
    this.selected = false,
    this.enabled = true,
    this.tag,
    this.explanation,
    this.onLongPress,
    this.glyph,
  });

  final String vendor;
  final CanopyGlyph? glyph;
  final String label;
  final bool selected;
  final bool enabled;

  /// Short trailing label: [aiCreditsTag] for a row billed to AI Credits, or
  /// the remedy for a locked row, such as `Sign in`.
  final String? tag;

  static const String aiCreditsTag = 'AI credits';

  /// Inline text under the label, such as why a disabled row cannot run.
  final String? explanation;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final foreground = enabled ? colors.foreground : colors.disabledTint;
    final secondary = enabled
        ? colors.foregroundSecondary
        : colors.disabledTint;
    final explanation = this.explanation;
    return Semantics(
      container: true,
      button: true,
      selected: selected,
      enabled: enabled,
      onLongPressHint: onLongPress == null ? null : 'Show details',
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          onLongPress: onLongPress,
          borderRadius: BorderRadius.circular(AppRadii.md),
          child: Ink(
            decoration: BoxDecoration(
              color: selected ? colors['bg-selected'] : null,
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                child: Row(
                  spacing: 12,
                  children: [
                    if (glyph case final glyph?)
                      CanopyIcon(
                        glyph: glyph,
                        size: 20,
                        tint: selected ? foreground : secondary,
                      )
                    else
                      CanopyModelIcon(
                        vendor: vendor,
                        size: 20,
                        tint: selected
                            ? CanopyModelIcon.selectedTint(vendor, foreground)
                            : secondary,
                      ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        spacing: 2,
                        children: [
                          Text(
                            label,
                            style: AppTypography.body.copyWith(
                              color: foreground,
                            ),
                          ),
                          if (explanation != null)
                            Text(
                              explanation,
                              style: AppTypography.bodySmall.copyWith(
                                color: colors.foregroundSecondary,
                              ),
                            ),
                        ],
                      ),
                    ),
                    if (tag case final tag?) _Tag(label: tag, color: secondary),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.of(context).border),
        borderRadius: BorderRadius.circular(AppRadii.sm),
      ),
      child: Text(
        label,
        style: AppTypography.compactLabel.copyWith(color: color),
      ),
    );
  }
}
