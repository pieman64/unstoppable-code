/// Mobile side of `portal.pipeline.chat_follow_up.prepare` (CAN-3719,
/// `PortalPipelineChatFollowUpPrepareResult` in
/// `packages/protocol/src/portal/index.ts`).
library;

/// The saved output a chat follow-up reviews.
enum RemotePipelineFollowUpOutput {
  plan,
  report;

  static RemotePipelineFollowUpOutput? fromWire(Object? value) =>
      switch (value) {
        'plan' => plan,
        'report' => report,
        _ => null,
      };
}

/// The desktop's answer to a follow-up preparation: the review prompt it
/// built from the run's saved reference, and the owner chat to send it to.
/// A null [chatId] means the owner has no writable chat, so the send
/// creates one.
class RemotePipelineFollowUpPreparation {
  const RemotePipelineFollowUpPreparation({
    required this.executionId,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.output,
    required this.prompt,
    this.chatId,
  });

  final String executionId;
  final String workspaceLocalId;
  final String worktreeLocalId;
  final RemotePipelineFollowUpOutput output;
  final String prompt;
  final String? chatId;

  /// Null when a required field is missing or malformed.
  static RemotePipelineFollowUpPreparation? fromJson(
    Map<String, dynamic> json,
  ) {
    final output = RemotePipelineFollowUpOutput.fromWire(json['output']);
    final chatId = json['chatId'];
    if (json
        case {
          'executionId': final String executionId,
          'projectId': final String projectId,
          'worktreeId': final String worktreeId,
          'prompt': final String prompt,
        }
        when output != null &&
            prompt.trim().isNotEmpty &&
            (chatId == null || (chatId is String && chatId.isNotEmpty))) {
      return RemotePipelineFollowUpPreparation(
        executionId: executionId,
        workspaceLocalId: projectId,
        worktreeLocalId: worktreeId,
        output: output,
        prompt: prompt,
        chatId: chatId is String ? chatId : null,
      );
    }
    return null;
  }
}
