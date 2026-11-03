import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';

import 'fake_remote_control_repository.dart';

/// CAN-3719 fixtures: a pipeline run owned by `wt-1` that saved a plan and a
/// report, inside a session where `wt-2` is another worktree with its own
/// chat. All ids, names and paths are invented.
const followUpExecutionId = 'exec-1';

Map<String, dynamic> followUpRunPayload({
  String status = 'success',
  Object? chatFollowUp = const {'planAvailable': true, 'reportAvailable': true},
  String workspaceLocalId = 'ws-1',
  String worktreeLocalId = 'wt-1',
}) => {
  'localId': followUpExecutionId,
  'pipelineId': 'pipeline-review',
  'pipelineName': 'Plan and review',
  'workspaceLocalId': workspaceLocalId,
  'worktreeLocalId': worktreeLocalId,
  'status': status,
  'startedAt': '2026-10-06T09:00:00.000Z',
  'finishedAt': '2026-10-06T09:04:12.000Z',
  'triggerSource': 'manual',
  'progress': {'completedSteps': 2, 'totalSteps': 2},
  'statusReasons': const <Map<String, dynamic>>[],
  'pendingPauses': const <Map<String, dynamic>>[],
  'jobs': [
    {
      'jobId': 'plan',
      'name': 'Plan',
      'status': 'success',
      'steps': [
        {
          'stepId': 'draft',
          'name': 'Draft plan',
          'status': 'success',
          'outputTail': 'Saved the plan for invoice rounding.\n',
        },
        {
          'stepId': 'report',
          'name': 'Write report',
          'status': 'success',
          'outputTail': 'Saved the review report.\n',
        },
      ],
    },
  ],
  'chatFollowUp': ?chatFollowUp,
};

RemotePortalEventBatch followUpRunEvent(
  Map<String, dynamic> payload, {
  int cursor = 1,
}) => RemotePortalEventBatch.fromJson({
  'events': [
    {
      'type': 'portal.pipeline.event',
      'payload': {
        'kind': 'upsert',
        'entity': {
          'entityType': 'pipeline_run',
          'localId': payload['localId'],
          'payload': payload,
        },
      },
    },
  ],
  'nextCursor': cursor,
});

RemoteChatSummary _chat(String id, String worktreeLocalId, String title) =>
    RemoteChatSummary(
      chatId: id,
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: worktreeLocalId,
      title: title,
      active: true,
    );

final followUpSnapshot = RemoteSessionSnapshot(
  workspaces: const [
    RemoteWorkspace(
      localId: 'ws-1',
      name: 'Billing',
      type: RemoteWorkspaceType.singleRepo,
    ),
  ],
  worktrees: const [
    RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature/invoice-rounding',
    ),
    RemoteWorktree(
      localId: 'wt-2',
      workspaceLocalId: 'ws-1',
      branch: 'docs/release-notes',
    ),
  ],
  standaloneChats: const [],
  chatSummaries: [
    _chat('chat-owner', 'wt-1', 'Invoice rounding'),
    _chat('chat-other', 'wt-2', 'Release notes'),
  ],
  chatMessages: const [],
);

/// A paired desktop session holding [followUpSnapshot].
base class PipelineFollowUpFixtureRepository
    extends FakeRemoteControlRepository {
  PipelineFollowUpFixtureRepository() {
    supportsForegroundChat = true;
    snapshotBuilder = () => followUpSnapshot;
  }
}
