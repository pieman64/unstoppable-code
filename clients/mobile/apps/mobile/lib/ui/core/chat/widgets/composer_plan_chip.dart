import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// Selected plan mode, dismissed in one tap like the desktop Plan capsule.
class ComposerPlanChip extends StatelessWidget {
  const ComposerPlanChip({super.key, required this.onDisable});

  final VoidCallback onDisable;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final tint = colors['fg-attention'];
    return Semantics(
      label: 'Disable plan mode',
      selected: true,
      child: TextButton(
        onPressed: onDisable,
        style: TextButton.styleFrom(
          foregroundColor: tint,
          backgroundColor: colors['bg-attention-muted'],
          minimumSize: const Size(0, 32),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          shape: const StadiumBorder(),
        ),
        child: ExcludeSemantics(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            spacing: 6,
            children: [
              CanopyIcon(glyph: CanopyGlyph.map, size: 14, tint: tint),
              Text(
                'Plan',
                style: AppTypography.bodySmall.copyWith(color: tint),
              ),
              CanopyIcon(glyph: CanopyGlyph.crossSmall, size: 14, tint: tint),
            ],
          ),
        ),
      ),
    );
  }
}
