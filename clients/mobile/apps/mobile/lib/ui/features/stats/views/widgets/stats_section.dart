import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/protocol/generated/usage.dart';

/// Small bold section header reused across stat tabs.
class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      style: Theme.of(context).textTheme.titleSmall?.copyWith(
        fontWeight: AppTypography.emphasisWeight,
        fontVariations: AppTypography.emphasisVariations,
      ),
    );
  }
}

/// `Last 7 days` / `Today` label for a usage [range].
String rangeLabel(TeamUsageResponseRange range) {
  final start = DateTime.tryParse(range.startIso);
  final end = DateTime.tryParse(range.endIso);
  if (start == null || end == null) return '';
  final days = end.difference(start).inDays;
  return days > 0 ? 'Last $days days' : 'Today';
}
