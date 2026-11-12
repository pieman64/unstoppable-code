import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/core/pipelines/pipeline_run_agent_activity.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_run_chat_activity_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';

/// The chat feed's per-turn rows for [chatId]: one Agent activity panel for
/// each turn the desktop links visible runs to (CAN-3619). [messages] are
/// the transcript, oldest first; the newest turn with activity starts
/// expanded. A card opens its run's screen. A null [controller] (a chat
/// without panels) or one bound to another chat yields none.
Map<String, Widget> pipelineRunAgentActivityFooters(
  BuildContext context, {
  required PipelineRunChatActivityController? controller,
  required String chatId,
  required Iterable<RemoteChatMessage> messages,
}) {
  if (controller == null || controller.chatId != chatId) return const {};
  final activity = controller.activity;
  if (activity.isEmpty) return const {};
  final latest = activity.latestTurnKey([
    for (final message in messages)
      if (message.role == ChatRole.user) message.messageId,
  ]);
  void openRun(RemotePipelineRun run) => pushRemotePipelineRunScreen(
    context,
    workspaceLocalId: controller.workspaceLocalId,
    worktreeLocalId: controller.worktreeLocalId,
    run: run,
  );
  return {
    for (final MapEntry(key: turnKey, value: runs)
        in activity.runsByTurn.entries)
      turnKey: PipelineRunAgentActivityPanel(
        key: ValueKey('agent-activity:$turnKey'),
        expanded: controller.isExpanded(chatId, turnKey, latestTurnKey: latest),
        onToggle: () =>
            controller.toggle(chatId, turnKey, latestTurnKey: latest),
        pendingAction: controller.pendingAction,
        actionError: controller.actionError,
        onCancel: (id) => controller.cancel(id),
        turnKey: turnKey,
        runs: runs,
        onOpenRun: openRun,
      ),
  };
}
