import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// A small pill badge showing an [OrganizationRole] (Owner / Admin / Member).
class RoleBadge extends StatelessWidget {
  const RoleBadge({super.key, required this.role});

  final OrganizationRole role;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final statusColors = StatusColors.of(context);
    final (Color color, String label) = switch (role) {
      OrganizationRole.owner => (statusColors.special, 'Owner'),
      OrganizationRole.admin => (scheme.primary, 'Admin'),
      OrganizationRole.member => (scheme.onSurfaceVariant, 'Member'),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        color: color.withAlpha(30),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: AppTypography.emphasisWeight,
          fontVariations: AppTypography.emphasisVariations,
        ),
      ),
    );
  }
}
