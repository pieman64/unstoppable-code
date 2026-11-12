import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import '../chats/models.dart';
import '../chats/presentation.dart';

/// Durable tool-result receipts belong to the tool's opening user turn, even
/// when the result arrives after another prompt. Never infer links from prose,
/// a tool's input, or an execution's initiator. Missing history stays unknown.
Map<String, List<RemotePipelineRun>> devicePipelineChatActivity({
  required DeviceChatRef ref,
  required Iterable<DeviceChatMessage> messages,
  required Iterable<RemotePipelineRun> runs,
}) {
  final byId = {
    for (final run in runs)
      if (!run.hidden &&
          run.isRoot &&
          run.workspaceLocalId == ref.projectId &&
          run.worktreeLocalId == ref.worktreeId)
        run.localId: run,
  };
  final result = <String, Map<String, RemotePipelineRun>>{};
  void link(String turn, RemotePipelineRun run) =>
      result.putIfAbsent(turn, () => {})[run.localId] = run;
  for (final run in byId.values) {
    for (final turn in run.chatTurns ?? const <RemotePipelineRunChatTurn>[]) {
      if (turn.chatId == ref.id) link(turn.userMessageId, run);
    }
  }
  final owners = <String, String>{};
  String? turn;
  for (final raw in messages.where((message) => !message.hidden)) {
    final message = deviceChatPresentation(ref.id, [raw]).single;
    if (message.role == ChatRole.user && !message.continuesTurn) {
      turn = message.messageId;
    }
    for (final block in raw.blocks) {
      final tool = block['toolUseId'];
      if (tool is! String || tool.isEmpty) continue;
      if (block['type'] == 'tool_use' && turn != null) owners[tool] = turn;
      final owner = owners[tool];
      if (block['type'] != 'tool_result' ||
          block['isError'] == true ||
          owner == null) {
        continue;
      }
      for (final id in _receiptIds(ref, block)) {
        final run = byId[id];
        if (run != null) link(owner, run);
      }
    }
  }
  return {
    for (final entry in result.entries)
      entry.key: entry.value.values.toList()
        ..sort((a, b) => comparePipelineRunRecency(b, a)),
  };
}

/// Chat-level tray attribution can survive a paged-out tool owner. A turn
/// footer cannot, so it uses the stricter tool-owner selection above.
Set<String> devicePipelineReceiptIds(
  DeviceChatRef ref,
  Iterable<DeviceChatMessage> messages,
) => {
  for (final message in messages.where((m) => !m.hidden))
    for (final block in message.blocks) ..._receiptIds(ref, block),
};

Iterable<String> _receiptIds(
  DeviceChatRef ref,
  Map<String, dynamic> block,
) sync* {
  if (block['type'] != 'tool_result' || block['isError'] == true) return;
  final receipts = block['agentArtifacts'];
  if (receipts is! List) return;
  for (final receipt in receipts.whereType<Map<String, dynamic>>()) {
    final id = receipt['executionId'], target = receipt['navigationTarget'];
    if (id is! String ||
        id.isEmpty ||
        receipt['version'] != 1 ||
        receipt['kind'] != 'pipeline_run' ||
        receipt['dedupeKey'] is! String ||
        (receipt['dedupeKey'] as String).isEmpty ||
        receipt['projectId'] != ref.projectId ||
        receipt['worktreeId'] != ref.worktreeId ||
        target is! Map ||
        target['kind'] != 'pipeline_execution' ||
        target['projectId'] != ref.projectId ||
        target['worktreeId'] != ref.worktreeId ||
        target['executionId'] != id) {
      continue;
    }
    yield id;
  }
}
