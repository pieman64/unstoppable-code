import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/summary.dart';

CanopyGlyph backgroundTrayGlyph(BackgroundTrayKind kind) => switch (kind) {
  BackgroundTrayKind.agent => CanopyGlyph.agent,
  BackgroundTrayKind.bash => CanopyGlyph.console,
  BackgroundTrayKind.workflow => CanopyGlyph.agents,
  BackgroundTrayKind.task => CanopyGlyph.squareChecklist,
  BackgroundTrayKind.pipeline => CanopyGlyph.workflows,
  BackgroundTrayKind.github => CanopyGlyph.github,
  BackgroundTrayKind.githubPr => CanopyGlyph.pullRequest,
};

String _kindLabel(BackgroundTrayKind kind) => switch (kind) {
  BackgroundTrayKind.agent => 'Agents',
  BackgroundTrayKind.bash => 'Commands',
  BackgroundTrayKind.workflow => 'Workflows',
  BackgroundTrayKind.task => 'Tasks',
  BackgroundTrayKind.pipeline => 'Pipeline runs',
  BackgroundTrayKind.github => 'GitHub runs',
  BackgroundTrayKind.githubPr => 'Pull requests',
};

Color backgroundTrayIndicatorColor(
  StatusColors colors,
  BackgroundTrayIndicator? indicator,
) => switch (indicator) {
  BackgroundTrayIndicator.needsInput => colors.warning,
  BackgroundTrayIndicator.failed => colors.failed,
  BackgroundTrayIndicator.succeeded => colors.success,
  _ => colors.neutral,
};

String _indicatorLabel(BackgroundTraySummary summary) =>
    switch (summary.indicator) {
      BackgroundTrayIndicator.spinner =>
        '${summary.running} background tasks running',
      BackgroundTrayIndicator.needsInput => 'Needs input',
      BackgroundTrayIndicator.failed => 'A run failed',
      BackgroundTrayIndicator.cancelled => 'A run was cancelled',
      _ => 'Runs finished',
    };

class BackgroundTrayHeader extends StatelessWidget {
  const BackgroundTrayHeader({
    super.key,
    required this.summary,
    required this.expanded,
    required this.onToggle,
  });
  final BackgroundTraySummary summary;
  final bool expanded;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final label = expanded ? 'Hide background work' : 'Show background work';
    return Row(
      children: [
        Expanded(
          child: Semantics(
            button: true,
            explicitChildNodes: true,
            expanded: expanded,
            label: label,
            child: InkWell(
              onTap: onToggle,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Row(
                  children: [
                    Semantics(
                      container: true,
                      excludeSemantics: true,
                      label: _indicatorLabel(summary),
                      child: SizedBox(
                        width: 24,
                        child: Center(
                          child:
                              summary.indicator ==
                                  BackgroundTrayIndicator.spinner
                              ? RunSpinner(
                                  size: 14,
                                  color: colors.foregroundMuted,
                                )
                              : CanopyIcon(
                                  glyph: switch (summary.indicator) {
                                    BackgroundTrayIndicator.needsInput =>
                                      CanopyGlyph.circleQuestionmark,
                                    BackgroundTrayIndicator.failed =>
                                      CanopyGlyph.crossSmall,
                                    BackgroundTrayIndicator.cancelled =>
                                      CanopyGlyph.stop,
                                    _ => CanopyGlyph.checkmark1,
                                  },
                                  size: 14,
                                  tint: backgroundTrayIndicatorColor(
                                    StatusColors.of(context),
                                    summary.indicator,
                                  ),
                                ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        summary.text,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.bodySmall.copyWith(
                          color: colors.foregroundSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (!expanded && summary.kinds.isNotEmpty)
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * .45,
            ),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final kind in summary.kinds)
                    Semantics(
                      label: '${_kindLabel(kind.kind)}: ${kind.count}',
                      child: ExcludeSemantics(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Stack(
                                clipBehavior: Clip.none,
                                children: [
                                  CanopyIcon(
                                    glyph: backgroundTrayGlyph(kind.kind),
                                    size: 14,
                                    tint: colors.foregroundMuted,
                                  ),
                                  if (kind.cornerDot != null)
                                    Positioned(
                                      right: -2,
                                      top: -2,
                                      child: Container(
                                        width: 6,
                                        height: 6,
                                        decoration: BoxDecoration(
                                          shape: BoxShape.circle,
                                          color: backgroundTrayIndicatorColor(
                                            StatusColors.of(context),
                                            kind.cornerDot,
                                          ),
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                              if (kind.showsCount) ...[
                                const SizedBox(width: 2),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 4,
                                  ),
                                  decoration: BoxDecoration(
                                    color: colors['bg-tertiary'],
                                    borderRadius: BorderRadius.circular(
                                      AppRadii.full,
                                    ),
                                  ),
                                  child: Text(
                                    kind.count > 99 ? '99+' : '${kind.count}',
                                    style: AppTypography.bodySmall.copyWith(
                                      color: colors.foregroundSecondary,
                                    ),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        Semantics(
          button: true,
          explicitChildNodes: true,
          expanded: expanded,
          label: label,
          child: ExcludeSemantics(
            child: InkWell(
              key: const ValueKey('background-tray-toggle'),
              onTap: onToggle,
              child: SizedBox(
                width: 44,
                height: 44,
                child: Center(
                  child: CanopyIcon(
                    glyph: expanded
                        ? CanopyGlyph.chevronDownSmall
                        : CanopyGlyph.chevronTopSmall,
                    size: 14,
                    tint: colors.foregroundMuted,
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
