import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// The connected-computer title and status used by both mobile transports.
class ComputerConnectionTitle extends StatelessWidget {
  const ComputerConnectionTitle({
    super.key,
    required this.title,
    required this.label,
    this.statusColor,
    this.titleKey,
    this.labelKey,
  });
  final String title, label;
  final Color? statusColor;
  final Key? titleKey, labelKey;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    // The bar's height is fixed, so clamp scaling the same way Material's own
    // AppBar does for toolbar text. The semantic styles continue to own their
    // line heights.
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.34,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            title,
            key: titleKey,
            style: theme.textTheme.titleMedium?.copyWith(
              color: colors.foreground,
              fontWeight: AppTypography.emphasisWeight,
              fontVariations: AppTypography.emphasisVariations,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          Text(
            label,
            key: labelKey,
            style: theme.textTheme.labelSmall?.copyWith(
              color: statusColor ?? colors.foregroundSecondary,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}
