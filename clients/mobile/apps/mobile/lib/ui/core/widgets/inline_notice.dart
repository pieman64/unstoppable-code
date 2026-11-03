import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_mini_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// One action on an [InlineNotice].
typedef InlineNoticeAction = ({
  String label,
  CanopyGlyph glyph,
  VoidCallback onPressed,
});

/// A compact inline notice above a list: a state the user should know about
/// while they keep working (DESIGN.md, inline notices).
///
/// One neutral surface for every intent; the leading glyph carries the
/// meaning. The [state] leads at the heavier weight, then the [explanation]
/// in the tertiary ink on the same line, with optional actions below so long
/// copy and larger text never squeeze them.
class InlineNotice extends StatelessWidget {
  const InlineNotice({
    super.key,
    required this.glyph,
    required this.state,
    this.explanation,
    this.actions = const [],
  });

  final CanopyGlyph glyph;
  final String state;
  final String? explanation;
  final List<InlineNoticeAction> actions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final explanation = this.explanation;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(right: 8, bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  CanopyIcon(
                    glyph: glyph,
                    size: 20,
                    tint: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: state,
                            style: const TextStyle(
                              fontWeight: AppTypography.emphasisWeight,
                              fontVariations: AppTypography.emphasisVariations,
                            ),
                          ),
                          if (explanation != null)
                            TextSpan(
                              text: ' $explanation',
                              style: TextStyle(
                                color: AppColors.of(context).foregroundMuted,
                              ),
                            ),
                        ],
                      ),
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                ],
              ),
            ),
            if (actions.isNotEmpty)
              Wrap(
                alignment: WrapAlignment.end,
                children: [
                  for (final action in actions)
                    CanopyMiniButton(
                      label: action.label,
                      glyph: action.glyph,
                      onPressed: action.onPressed,
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
