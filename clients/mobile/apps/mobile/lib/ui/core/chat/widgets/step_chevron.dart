import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// Desktop `StepRow`'s chevron after a step's words: tertiary ink, pointing
/// right, turning down while the step is open. Touch has no hover, so it
/// stays visible at rest.
class StepChevron extends StatelessWidget {
  const StepChevron({super.key, required this.open});

  final bool open;

  @override
  Widget build(BuildContext context) => AnimatedRotation(
    turns: open ? 0.25 : 0,
    duration: const Duration(milliseconds: 150),
    child: CanopyIcon(
      glyph: CanopyGlyph.chevronRightSmall,
      size: 14,
      tint: AppColors.of(context).foregroundMuted,
    ),
  );
}
