import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_mini_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/clock.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/presentation.dart';
import 'background_tray_header.dart';

/// View-only task and agent presentation. Run controls have their own row.
class BackgroundTrayActivityRow extends StatelessWidget {
  const BackgroundTrayActivityRow({
    super.key,
    required this.item,
    required this.now,
    required this.open,
    required this.onToggle,
    this.onOpenAgent,
  });

  final BackgroundTrayItem item;
  final int now;
  final bool open;
  final VoidCallback onToggle;
  final ValueChanged<BackgroundTrayAgentTarget>? onOpenAgent;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final agent = switch (item) {
      BackgroundTrayAgent agent => agent,
      _ => null,
    };
    final task = switch (item) {
      BackgroundTrayTask task => task,
      _ => null,
    };
    final inspectable = agent != null || task != null;
    final approval = agent?.status == BackgroundTrayAgentStatus.approval;
    final detail = agent != null
        ? backgroundTrayAgentActivity(agent)
        : task == null
        ? null
        : backgroundTrayTaskDetail(task);
    final start = agent?.startedAt ?? task?.process.startedAt;
    final trailing = approval
        ? 'Awaiting approval'
        : task?.process.status == RemoteBackgroundProcessStatus.queued
        ? 'Queued'
        : start == null
        ? null
        : formatBackgroundTrayElapsed(now - start);
    final status = agent == null
        ? null
        : switch (agent.status) {
            BackgroundTrayAgentStatus.queued => 'Queued',
            BackgroundTrayAgentStatus.approval => 'Awaiting approval',
            BackgroundTrayAgentStatus.running => 'Running',
          };
    final glyph = agent == null
        ? CanopyIcon(
            glyph: task?.kind == BackgroundTrayKind.workflow
                ? CanopyGlyph.workflows
                : backgroundTrayGlyph(task?.kind ?? BackgroundTrayKind.agent),
            size: 14,
            tint: colors.foregroundSecondary,
          )
        : Semantics(
            label: status,
            excludeSemantics: true,
            child: agent.status == BackgroundTrayAgentStatus.running
                ? RunSpinner(size: 14, color: colors.foregroundMuted)
                : CanopyIcon(
                    glyph: approval
                        ? CanopyGlyph.circleQuestionmark
                        : CanopyGlyph.circleDashed,
                    size: 14,
                    tint: approval
                        ? StatusColors.of(context).warning
                        : colors.foregroundMuted,
                  ),
          );
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ColoredBox(
          key: ValueKey('background-tray-activity-${item.id}'),
          color: approval ? colors['bg-attention-muted'] : colors['bg-depth'],
          child: Semantics(
            button: inspectable,
            expanded: inspectable ? open : null,
            child: InkWell(
              onTap: inspectable ? onToggle : null,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 8,
                  ),
                  child: Row(
                    children: [
                      if (inspectable) ...[
                        CanopyIcon(
                          glyph: open
                              ? CanopyGlyph.chevronDownSmall
                              : CanopyGlyph.chevronRightSmall,
                          size: 14,
                          tint: colors.foregroundMuted,
                        ),
                        const SizedBox(width: 4),
                      ],
                      glyph,
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 2,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              item.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppTypography.bodySmall.copyWith(
                                color: colors.foregroundSecondary,
                              ),
                            ),
                            if (detail != null)
                              Text(
                                detail,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppTypography.bodySmall.copyWith(
                                  color: colors.foregroundMuted,
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (trailing != null) ...[
                        const SizedBox(width: 8),
                        Flexible(
                          fit: FlexFit.tight,
                          child: Text(
                            trailing,
                            textAlign: TextAlign.end,
                            style: AppTypography.bodySmall.copyWith(
                              fontFeatures: const [
                                ...AppTypography.features,
                                FontFeature.tabularFigures(),
                              ],
                              color: colors.foregroundMuted,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        if (open && inspectable)
          Padding(
            key: ValueKey('background-tray-inspector-${item.id}'),
            padding: const EdgeInsets.fromLTRB(30, 0, 8, 12),
            child: DefaultTextStyle(
              style: AppTypography.bodySmall.copyWith(
                color: colors.foregroundMuted,
              ),
              child: switch (item) {
                BackgroundTrayTask task => _TaskInspector(task: task),
                BackgroundTrayAgent agent => _AgentInspector(
                  agent: agent,
                  onOpen: onOpenAgent,
                ),
                _ => const SizedBox.shrink(),
              },
            ),
          ),
      ],
    );
  }
}

class _TaskInspector extends StatelessWidget {
  const _TaskInspector({required this.task});
  final BackgroundTrayTask task;

  @override
  Widget build(BuildContext context) {
    final process = task.process;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (process.lastDescription case final description?) Text(description),
        if (process.summary case final summary?
            when summary != process.lastDescription)
          Text(summary, maxLines: 3, overflow: TextOverflow.ellipsis),
        if (process.lastDescription == null && process.summary == null)
          const Text('No updates yet'),
        if (process.kind == RemoteBackgroundProcessKind.bash)
          const Text('Output shows in the desktop app.'),
      ],
    );
  }
}

class _AgentInspector extends StatelessWidget {
  const _AgentInspector({required this.agent, this.onOpen});
  final BackgroundTrayAgent agent;
  final ValueChanged<BackgroundTrayAgentTarget>? onOpen;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (agent.steps.isNotEmpty)
        for (final step in agent.steps.skip(
          agent.steps.length > 20 ? agent.steps.length - 20 : 0,
        ))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text(
              backgroundTrayStepLabel(step),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          )
      else if (agent.prompt case final prompt?)
        Text(prompt, maxLines: 3, overflow: TextOverflow.ellipsis),
      if (agent.meta case final meta?)
        Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis),
      if (agent.target case final target? when onOpen != null)
        CanopyMiniButton(
          label: 'Open chat',
          onPressed: () => onOpen?.call(target),
        ),
    ],
  );
}
