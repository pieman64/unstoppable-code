import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// Model detail card, the mobile form of the desktop picker hover card:
/// a title, label / value facts, an optional description and a footer note.
class CanopyModelDetails extends StatelessWidget {
  const CanopyModelDetails({
    super.key,
    required this.title,
    required this.facts,
    this.description,
    this.footer,
  });

  final String title;
  final List<(String, String)> facts;
  final String? description;
  final String? footer;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final secondary = AppTypography.body.copyWith(
      color: colors.foregroundSecondary,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 12,
        children: [
          Text(
            title,
            style: AppTypography.title.copyWith(color: colors.foreground),
          ),
          // The label column fits its widest label (up to half the width), so
          // labels do not break mid-word at large text; values wrap instead.
          Table(
            columnWidths: const {
              0: MinColumnWidth(
                IntrinsicColumnWidth(),
                FractionColumnWidth(0.5),
              ),
            },
            children: [
              for (final (index, (label, value)) in facts.indexed)
                TableRow(
                  children: [
                    Padding(
                      padding: EdgeInsets.only(
                        top: index == 0 ? 0 : 12,
                        right: 12,
                      ),
                      child: Text(label, style: secondary),
                    ),
                    Padding(
                      padding: EdgeInsets.only(top: index == 0 ? 0 : 12),
                      child: Text(
                        value,
                        style: AppTypography.body.copyWith(
                          color: colors.foreground,
                        ),
                      ),
                    ),
                  ],
                ),
            ],
          ),
          if (description case final description?)
            Text(description, style: secondary),
          if (footer case final footer?)
            Text(
              footer,
              style: AppTypography.bodySmall.copyWith(
                color: colors.foregroundSecondary,
              ),
            ),
        ],
      ),
    );
  }
}
