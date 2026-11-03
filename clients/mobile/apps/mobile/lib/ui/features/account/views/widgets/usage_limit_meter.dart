import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_policy.dart';

/// A thin used-percentage bar coloured by the desktop thresholds: accent
/// below 80%, attention from 80%, destructive from 98%.
class UsageLimitMeter extends StatelessWidget {
  const UsageLimitMeter({
    required this.usedPercent,
    this.height = 6,
    super.key,
  });

  final num usedPercent;
  final double height;

  /// The semantic fill for [usedPercent]'s tone.
  static Color fillFor(AppColors colors, num usedPercent) =>
      switch (usageToneFor(usedPercent)) {
        UsageTone.normal => colors.accent,
        UsageTone.warning => colors['bg-attention'],
        UsageTone.critical => colors['bg-destructive'],
      };

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: BorderRadius.circular(height / 2),
        child: LinearProgressIndicator(
          value: usageBarFraction(usedPercent),
          minHeight: height,
          color: fillFor(colors, usedPercent),
          backgroundColor: colors['bg-tertiary'],
        ),
      ),
    );
  }
}
