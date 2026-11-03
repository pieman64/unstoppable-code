import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// Colored pill for a raw turn-status enum value (`SUCCESS` / `FAILURE`...).
/// Success is always green and failure always red, matching the desktop
/// operational status vocabulary.
class StatusBadge extends StatelessWidget {
  const StatusBadge({super.key, required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final statusColors = StatusColors.of(context);
    final color = switch (status.toUpperCase()) {
      'SUCCESS' => statusColors.success,
      'FAILURE' || 'ERROR' => statusColors.failed,
      _ => statusColors.neutral,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha(30),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        _titleCase(status),
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: AppTypography.emphasisWeight,
          fontVariations: AppTypography.emphasisVariations,
        ),
      ),
    );
  }
}

String _titleCase(String value) {
  if (value.isEmpty) return value;
  return value[0].toUpperCase() + value.substring(1).toLowerCase();
}
