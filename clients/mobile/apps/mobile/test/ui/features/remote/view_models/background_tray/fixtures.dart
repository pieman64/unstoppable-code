import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';

const target = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws',
  worktreeLocalId: 'wt',
  chatId: 'chat',
);

BackgroundTrayTask task(
  String id, {
  RemoteBackgroundProcessKind kind = RemoteBackgroundProcessKind.bash,
  RemoteBackgroundProcessStatus status = RemoteBackgroundProcessStatus.running,
  String? toolUseId,
}) => BackgroundTrayTask(
  RemoteBackgroundProcess(
    localId: id,
    workspaceLocalId: 'ws',
    worktreeLocalId: 'wt',
    chatId: 'chat',
    toolUseId: toolUseId ?? 'tool-$id',
    taskId: 'provider-$id',
    kind: kind,
    description: 'Task $id',
    status: status,
    startedAt: 1000,
    updatedAt: 2000,
    lastDescription: 'Compiling',
    canStop: true,
  ),
);

BackgroundTrayAgent agent(
  String id, {
  BackgroundTrayAgentKind kind = BackgroundTrayAgentKind.delegate,
  BackgroundTrayAgentStatus status = BackgroundTrayAgentStatus.running,
  String? taskId,
}) => BackgroundTrayAgent(
  id: id,
  title: 'Agent $id',
  kind: kind,
  status: status,
  taskId: taskId,
);

BackgroundTrayRun run(
  String id,
  BackgroundTrayRunStatus status, {
  BackgroundTrayRunKind kind = BackgroundTrayRunKind.pipeline,
}) => BackgroundTrayRun(id: id, title: id, kind: kind, status: status);

RemoteChatMessage message(List<ChatPart> parts, {String chatId = 'chat'}) =>
    RemoteChatMessage(
      messageId: 'message',
      chatId: chatId,
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: '',
      parts: parts,
    );

ChatPart nativeAgent({
  String toolUseId = 'tool-agent',
  bool running = true,
  bool background = true,
  String? provider,
  List<Map<String, dynamic>> subBlocks = const [],
}) => ChatPart(
  kind: 'agent',
  data: {
    'toolUseId': toolUseId,
    'description': 'Review the diff',
    'subagentType': 'reviewer',
    'prompt': 'Review it.',
    'isRunning': running,
    'runInBackground': background,
    'provider': ?provider,
    'model': 'gpt-6-sol',
    'reasoningEffort': 'high',
    'subBlocks': subBlocks,
  },
);

ChatPart delegate({
  String id = 'd1',
  String status = 'running',
  bool approval = false,
  String executionMode = 'background',
}) => ChatPart(
  kind: 'agent',
  data: {
    'delegation': {
      'delegationId': id,
      'parentHarnessId': 'claude',
      'description': 'Fix flaky e2e',
      'prompt': 'Fix the flaky checkout e2e.',
      'status': status,
      'approvalPending': approval,
      'executionMode': executionMode,
      'routeSnapshot': {'selectedModelLabel': 'GPT-6 Sol'},
    },
  },
);

RemotePipelineRun pipeline(
  String id, {
  String status = 'running',
  String workspace = 'ws',
  String worktree = 'wt',
  String chatId = 'chat',
  bool linked = true,
  bool hidden = false,
  String? parent,
  List<RemotePipelinePauseCheckpoint> pauses = const [],
}) => RemotePipelineRun(
  localId: id,
  pipelineName: 'Pipeline $id',
  status: status,
  workspaceLocalId: workspace,
  worktreeLocalId: worktree,
  hidden: hidden,
  parentExecutionId: parent,
  startedAt: '2026-10-25T10:00:00Z',
  pendingPauses: pauses,
  chatTurns: linked
      ? [
          RemotePipelineRunChatTurn(
            chatId: chatId,
            userMessageId: 'u1',
            relation: 'launched',
          ),
          RemotePipelineRunChatTurn(
            chatId: chatId,
            userMessageId: 'u2',
            relation: 'watching',
          ),
        ]
      : null,
);

ChatPart receipt(String id, {bool folded = false, bool error = false}) {
  final result = {
    'isError': error,
    'agentArtifacts': [
      {
        'version': 1,
        'kind': 'pipeline_run',
        'executionId': id,
        'dedupeKey': 'canopy:pipeline_run:execution:$id',
        'pipelineName': 'Receipt $id',
        'queuedAt': '2026-10-25T09:59:00Z',
      },
    ],
  };
  return ChatPart(
    kind: folded ? 'tool_use' : 'tool_result',
    data: {
      'toolUseId': 'tool-$id',
      if (folded) 'result': result else ...result,
    },
  );
}
