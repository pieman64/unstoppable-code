import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/data/models/computer_activity/pr_check.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/activity/pr_check_display.dart';
import 'package:url_launcher/url_launcher.dart';

/// Material's minimum touch target; also keeps rows tappable at large text.
const double _minRowHeight = 48;

/// Status icons share one slot so check names align.
const double _iconSlot = 16;

/// A PR's CI checks under its line in Activity & files (CAN-3618): a
/// `Checks (X/Y passed)` disclosure header and one row per check.
///
/// The drawer owns [expanded] so a user's toggle outlives this widget while
/// the list leaves the tree (a failed refresh, the Files tab) and resets when
/// the drawer closes.
class PrChecksList extends StatelessWidget {
  const PrChecksList({
    super.key,
    required this.checks,
    required this.expanded,
    required this.onExpandedChanged,
  });

  final List<RemotePrCheck> checks;
  final bool expanded;
  final ValueChanged<bool> onExpandedChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final header = prChecksHeaderLabel(checks);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MergeSemantics(
          child: Semantics(
            button: true,
            expanded: expanded,
            child: InkWell(
              onTap: () => onExpandedChanged(!expanded),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: _minRowHeight),
                child: Row(
                  children: [
                    // The expanded state is announced; the chevron is not.
                    ExcludeSemantics(
                      child: CanopyIcon(
                        glyph: expanded
                            ? CanopyGlyph.chevronDownSmall
                            : CanopyGlyph.chevronRightSmall,
                        size: _iconSlot,
                        tint: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(width: AppDimens.padding8),
                    Expanded(
                      child: Text(
                        header,
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (expanded)
          for (final check in checks) _PrCheckRow(check: check),
      ],
    );
  }
}

class _PrCheckRow extends StatelessWidget {
  const _PrCheckRow({required this.check});

  final RemotePrCheck check;

  Future<void> _open(BuildContext context, Uri uri) async {
    try {
      if (await launchUrl(uri, mode: LaunchMode.externalApplication)) return;
    } catch (_) {
      /* Report a launch failure without losing the drawer. */
    }
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not open the check.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final state = prCheckDisplayState(check);
    final color = state.color(StatusColors.of(context));
    final uri = check.detailsUri;
    final glyph = state.glyph;
    final icon = SizedBox.square(
      dimension: _iconSlot,
      child: Center(
        child: glyph == null
            ? RunSpinner(size: 12, color: color)
            : CanopyIcon(glyph: glyph, size: _iconSlot, tint: color),
      ),
    );
    final name = Text(
      check.name,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: theme.textTheme.bodySmall,
    );
    final status = Text(
      state.label,
      style: theme.textTheme.labelSmall?.copyWith(color: color),
    );
    // At large text the status moves under the name rather than squeezing
    // it; the name always stays on one line.
    final stacked = MediaQuery.textScalerOf(context).scale(1) > 1.5;
    return MergeSemantics(
      child: Semantics(
        label: prCheckSemanticsLabel(check),
        link: uri != null,
        child: InkWell(
          onTap: uri == null ? null : () => _open(context, uri),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: _minRowHeight),
            child: ExcludeSemantics(
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: AppDimens.padding4,
                ),
                child: stacked
                    ? Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Row(
                            children: [
                              icon,
                              const SizedBox(width: AppDimens.padding8),
                              Expanded(child: name),
                            ],
                          ),
                          Padding(
                            padding: const EdgeInsets.only(
                              left: _iconSlot + AppDimens.padding8,
                            ),
                            child: status,
                          ),
                        ],
                      )
                    : Row(
                        children: [
                          icon,
                          const SizedBox(width: AppDimens.padding8),
                          Expanded(child: name),
                          const SizedBox(width: AppDimens.padding8),
                          status,
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
