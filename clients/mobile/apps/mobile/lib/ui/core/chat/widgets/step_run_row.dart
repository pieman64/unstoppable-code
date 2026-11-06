import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/step_runs.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';
import 'package:mobile/ui/core/chat/widgets/agent_card.dart';
import 'package:mobile/ui/core/chat/widgets/message_bubble_surface.dart';
import 'package:mobile/ui/core/chat/widgets/step_chevron.dart';
import 'package:mobile/ui/core/chat/widgets/thinking_row.dart';
import 'package:mobile/ui/core/chat/widgets/tool_call_row.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/chat_glyph.dart';

/// The row of one agent step: a tool call, a thought or a helper agent.
/// Keys stay stable per message and part, so a row's expansion survives
/// the lists around it changing shape.
Widget stepPartRow(
  ChatMessage message,
  int index,
  Map<String, ToolCallResult> toolResults,
) {
  final part = message.parts[index];
  switch (part.kind) {
    case 'tool_use' when isAgentSpawn(part):
      final result = stepResult(RunStep(message, index), toolResults);
      return AgentCard(
        key: ValueKey('agent-${message.messageId}-${part.toolUseId ?? index}'),
        part: agentPartOfSpawn(
          part,
          result: result,
          running: message.isStreaming && result == null,
        ),
      );
    case 'tool_use':
      final id = part.toolUseId;
      return ToolCallRow(
        key: ValueKey('tool-${message.messageId}-${id ?? index}'),
        part: part,
        result: stepResult(RunStep(message, index), toolResults),
        pending: message.isStreaming,
      );
    case 'thinking':
      return ThinkingRow(
        key: ValueKey('thinking-${message.messageId}-$index'),
        part: part,
      );
    default:
      return AgentCard(
        key: ValueKey(
          'agent-${message.messageId}-${part.data?['taskId'] ?? part.data?['toolUseId'] ?? index}',
        ),
        part: part,
      );
  }
}

/// A run of agent steps between two replies, as desktop's clean
/// `ChatToolStepGroup`: one line in words ("Ran 2 commands, read a file")
/// leading with the run's kind icon, its errors said after the words, and a
/// chevron that opens the steps. Steps from [shownFrom] on (a running turn's
/// newest) stay in view under the line. A run of fewer than two calls draws
/// its steps as their own rows, with no line.
class StepRunRow extends StatelessWidget {
  const StepRunRow({
    super.key,
    required this.steps,
    required this.shownFrom,
    required this.expanded,
    required this.toolResults,
    required this.onToggle,
  });

  final List<RunStep> steps;
  final int shownFrom;
  final bool expanded;
  final Map<String, ToolCallResult> toolResults;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final folded = steps.sublist(0, shownFrom);
    final grouped = countedSteps(folded) >= 2;
    Widget row(RunStep step) =>
        stepPartRow(step.message, step.index, toolResults);
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: MessageBubbleSurface.textInset,
        vertical: 4,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!grouped)
            for (final step in steps) row(step)
          else ...[
            _RunLine(
              run: describeRun(folded, toolResults),
              expanded: expanded,
              onTap: onToggle,
            ),
            if (expanded)
              for (final step in folded) row(step),
            for (final step in steps.sublist(shownFrom)) row(step),
          ],
        ],
      ),
    );
  }
}

class _RunLine extends StatelessWidget {
  const _RunLine({
    required this.run,
    required this.expanded,
    required this.onTap,
  });

  final ({String label, int failed, StepKind? kind}) run;
  final bool expanded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final style = AppTypography.bodySmall.copyWith(
      color: colors.foregroundSecondary,
    );
    final failed = run.failed;
    final errors = failed == 0
        ? null
        : '· $failed ${failed == 1 ? 'error' : 'errors'}';
    return Semantics(
      button: true,
      expanded: expanded,
      label: errors == null ? run.label : '${run.label} $errors',
      child: InkWell(
        key: const ValueKey('step-run-line'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        child: ExcludeSemantics(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              children: [
                SizedBox.square(
                  dimension: 16,
                  child: Center(
                    child: _StepKindIcon(
                      kind: run.kind,
                      color: colors.foregroundSecondary,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    run.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: style,
                  ),
                ),
                if (errors != null) ...[
                  const SizedBox(width: 6),
                  Text(
                    errors,
                    key: const ValueKey('step-run-errors'),
                    style: style.copyWith(color: colors.foregroundMuted),
                  ),
                ],
                const SizedBox(width: 4),
                StepChevron(open: expanded),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Desktop `stepKindIcon`: the glyph a run's line leads with.
class _StepKindIcon extends StatelessWidget {
  const _StepKindIcon({required this.kind, required this.color});

  final StepKind? kind;
  final Color color;

  @override
  Widget build(BuildContext context) {
    if (kind == StepKind.plan) {
      return CanopyIcon(glyph: CanopyGlyph.map, size: 14, tint: color);
    }
    final glyph = switch (kind) {
      StepKind.thinking => ChatGlyph.thinking,
      StepKind.search => ChatGlyph.magnifyingGlass,
      StepKind.read => ChatGlyph.document,
      StepKind.edit => ChatGlyph.documentPencil,
      StepKind.command => ChatGlyph.terminal,
      StepKind.graph => ChatGlyph.graph,
      StepKind.web => ChatGlyph.globe,
      StepKind.tasks => ChatGlyph.task,
      StepKind.agent => ChatGlyph.agent,
      StepKind.question => ChatGlyph.questionMark,
      StepKind.plan || StepKind.other || null => ChatGlyph.wrench,
    };
    return ChatIcon(glyph: glyph, size: 14, color: color);
  }
}
