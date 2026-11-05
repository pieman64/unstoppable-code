import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/computer_activity/pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'pipeline_unavailable.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/activity/pipeline_run_status.dart';

/// Shown on a finished run when the desktop confirms it saved no output.
const String kPipelineRunFollowUpNoOutput =
    'Chat follow-up needs a saved plan or report. This run has neither.';

/// The run screen's Chat follow-up action (CAN-3719): asks the run owner's
/// chat to review the run's saved plan or report.
///
/// Shown when the desktop confirms a saved output, whatever the run's
/// status. With both outputs saved, a sheet offers the choice; closing it
/// sends nothing. On finished runs, a desktop that cannot prepare follow-ups
/// gets an update hint instead of a button, and a confirmed absence of saved
/// output gets an explanation. Unknown availability shows nothing.
class PipelineRunChatFollowUp extends StatelessWidget {
  const PipelineRunChatFollowUp({
    super.key,
    required this.run,
    required this.supported,
    required this.pending,
    required this.error,
    required this.onSubmit,
    required this.onDismissError,
  });

  final RemotePipelineRun run;

  /// Whether the paired desktop prepares follow-ups.
  final bool supported;

  /// A follow-up for this run is being prepared or sent.
  final bool pending;

  /// Why the last follow-up did not reach a chat, until dismissed.
  final String? error;
  final void Function(RemotePipelineFollowUpOutput output) onSubmit;
  final VoidCallback onDismissError;

  Future<void> _choose(BuildContext context) async {
    final availability = run.chatFollowUp;
    if (availability == null) return;
    if (!availability.planAvailable || !availability.reportAvailable) {
      onSubmit(
        availability.planAvailable
            ? RemotePipelineFollowUpOutput.plan
            : RemotePipelineFollowUpOutput.report,
      );
      return;
    }
    final output = await showModalBottomSheet<RemotePipelineFollowUpOutput>(
      context: context,
      showDragHandle: true,
      builder: (context) => const _OutputChoiceSheet(),
    );
    if (output != null) onSubmit(output);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final error = this.error;
    final availability = run.chatFollowUp;
    final hasOutput = availability?.hasOutput ?? false;
    final finished = !isPipelineRunActive(run.status);
    final Widget? action;
    if (supported && hasOutput) {
      action = Align(
        alignment: AlignmentDirectional.centerStart,
        child: CanopyButton(
          key: const ValueKey('pipeline-run-chat-follow-up'),
          label: 'Chat follow-up',
          glyph: CanopyGlyph.bubbleText,
          loading: pending,
          semanticsLabel: 'Chat follow-up: review this run in a chat',
          onPressed: pending ? null : () => _choose(context),
        ),
      );
    } else if (!supported && finished) {
      action = _Hint(
        kRemotePipelineFollowUpUnsupported,
        key: const ValueKey('pipeline-run-chat-follow-up-unsupported'),
      );
    } else if (finished && availability != null) {
      action = _Hint(
        kPipelineRunFollowUpNoOutput,
        key: const ValueKey('pipeline-run-chat-follow-up-no-output'),
      );
    } else {
      action = null;
    }
    if (action == null && error == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ?action,
          if (error != null)
            Row(
              key: const ValueKey('pipeline-run-chat-follow-up-error'),
              children: [
                Expanded(
                  child: Text(
                    error,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: StatusColors.of(context).failed,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: onDismissError,
                  child: const Text('Dismiss'),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Text(
      text,
      style: theme.textTheme.bodySmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
      ),
    );
  }
}

class _OutputChoiceSheet extends StatelessWidget {
  const _OutputChoiceSheet();

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    Widget row(
      RemotePipelineFollowUpOutput output,
      CanopyGlyph glyph,
      String label,
    ) => ListTile(
      key: ValueKey('pipeline-run-chat-follow-up:${output.name}'),
      leading: CanopyIcon(
        glyph: glyph,
        size: 24,
        tint: colors.foregroundSecondary,
      ),
      title: Text(
        label,
        style: AppTypography.body.copyWith(color: colors.foreground),
      ),
      onTap: () => Navigator.of(context).pop(output),
    );
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          row(
            RemotePipelineFollowUpOutput.plan,
            CanopyGlyph.noteText,
            'Review plan',
          ),
          row(
            RemotePipelineFollowUpOutput.report,
            CanopyGlyph.pageSearch,
            'Review report',
          ),
        ],
      ),
    );
  }
}
