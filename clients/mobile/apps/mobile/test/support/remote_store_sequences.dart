/// Deterministic input sequences for the Remote Control stores, replayed by
/// the store suites through [RemoteStoresHarness] and reusable by engine
/// suites. Each sequence documents the state it must end in.
library;

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';

import 'remote_store_harness.dart';

export 'remote_store_harness.dart';

const sequenceWorkspace = RemoteWorkspace(
  localId: 'ws-1',
  name: 'Repository',
  type: RemoteWorkspaceType.singleRepo,
);

const sequenceChat = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  chatId: 'chat-1',
);
final RemoteChatKey sequenceChatKey = remoteChatKeyForTarget(sequenceChat)!;

RemoteWorktree sequenceWorktree(String localId, {String? label}) =>
    RemoteWorktree(
      localId: localId,
      workspaceLocalId: 'ws-1',
      branch: 'feature/$localId',
      label: label,
    );

/// A live-wire row of [sequenceChat].
RemoteChatMessage wireRow(
  String messageId, {
  String role = 'assistant',
  String status = 'complete',
  String text = '',
  int? createdAtMs,
  int? updatedAtMs,
}) => RemoteChatMessage.fromWireJson({
  'messageId': messageId,
  'chatId': sequenceChat.chatId,
  'scope': 'worktree',
  'role': role,
  'status': status,
  'text': text,
  'createdAtMs': ?createdAtMs,
  'updatedAtMs': ?updatedAtMs,
});

RemoteChatMessageEvent liveRow(RemoteChatMessage message) =>
    RemoteChatMessageEvent(
      chatId: message.chatId,
      scope: RemoteChatScope.worktree,
      message: message,
    );

/// A chat-targeted snapshot of [sequenceChat].
RemoteStateSnapshotEvent chatSnapshot(
  List<RemoteChatMessage> rows, {
  bool truncated = false,
}) => RemoteStateSnapshotEvent(
  scope: 'chat',
  targetChatId: sequenceChat.chatId,
  targetChatScope: RemoteChatScope.worktree,
  chatMessages: rows,
  chatMessagesTruncated: truncated,
);

RemoteStateSnapshotEvent overviewHead(
  String eventId,
  List<RemoteWorktree> worktrees, {
  int? cursor,
}) => RemoteStateSnapshotEvent(
  eventId: eventId,
  cursor: cursor,
  scope: 'overview',
  workspaces: const [sequenceWorkspace],
  worktrees: worktrees,
);

RemoteStateDeltaEvent overviewChunk(
  String eventId,
  List<RemoteWorktree> worktrees, {
  int? cursor,
}) => RemoteStateDeltaEvent(
  eventId: eventId,
  cursor: cursor,
  scope: 'overview',
  workspaces: const [sequenceWorkspace],
  worktrees: worktrees,
);

final class RemoteStoreSequence {
  const RemoteStoreSequence({
    required this.name,
    required this.steps,
    this.expectedRowIds,
    this.expectedWorktreeIds,
  });

  final String name;
  final List<RemoteStoreStep> steps;

  /// [sequenceChat]'s rendered row ids after the sequence.
  final List<String>? expectedRowIds;

  /// Every worktree id, in snapshot order, after the sequence.
  final List<String>? expectedWorktreeIds;

  @override
  String toString() => name;
}

/// A terminal answer receives late streaming revisions — live, from a full
/// chat snapshot, and from a truncated tail, each stamped at or after the
/// terminal revision — then a complete revision older than it. The answer
/// must end as the terminal `Final` revision stamped 3000.
final lateStreamingAfterTerminal = RemoteStoreSequence(
  name: 'late streaming after a terminal row',
  steps: [
    ApplyEvents([
      liveRow(
        wireRow('answer', text: 'Final', createdAtMs: 1000, updatedAtMs: 3000),
      ),
    ]),
    for (final (index, event) in [
      liveRow,
      (RemoteChatMessage row) => chatSnapshot([row]),
      (RemoteChatMessage row) => chatSnapshot([row], truncated: true),
    ].indexed)
      ApplyEvents([
        event(
          wireRow(
            'answer',
            status: 'streaming',
            text: 'Partial',
            createdAtMs: 1000,
            updatedAtMs: 3000 + index * 500,
          ),
        ),
      ]),
    ApplyEvents([
      liveRow(
        wireRow(
          'answer',
          text: 'Rewound',
          createdAtMs: 1000,
          updatedAtMs: 2000,
        ),
      ),
    ]),
  ],
  expectedRowIds: const ['answer'],
);

/// The cached tail paints a chat, a live row lands, then the desktop's
/// truncated snapshot replaces the cached rows it no longer carries while the
/// live row survives. Overview chunk continuations append worktrees to their
/// head (replacing duplicates in place, ignoring foreign or malformed ids),
/// and two older-history pages that overlap what is loaded fill in the start
/// of the transcript without duplicating any row.
final cachedHistoryThenAuthoritative = RemoteStoreSequence(
  name: 'cached history, authoritative snapshots, and continuations',
  steps: [
    ApplyEvents([
      overviewHead('head-1', [sequenceWorktree('wt-1', label: 'first')]),
    ]),
    SeedCachedTail(sequenceChatKey, [
      wireRow('gone-before', text: 'Deleted before the first overlap'),
      wireRow('c1', text: 'First'),
      wireRow('gone', text: 'Deleted on the desktop'),
      wireRow('c2', text: 'Second (cached)'),
    ]),
    ApplyEvents([liveRow(wireRow('live', text: 'Live answer'))]),
    ApplyEvents([
      chatSnapshot([
        wireRow('c0', text: 'Older'),
        wireRow('c1', text: 'First'),
        wireRow('c2', text: 'Second'),
      ], truncated: true),
    ]),
    ApplyEvents([
      overviewChunk('head-1:chunk-1', [
        sequenceWorktree('wt-2'),
        sequenceWorktree('wt-1', label: 'renamed'),
      ]),
      overviewChunk('head-0:chunk-1', [sequenceWorktree('wt-foreign')]),
      overviewChunk('head-1:chunk-01', [sequenceWorktree('wt-malformed')]),
    ]),
    const BeginOlderHistory(sequenceChat),
    FinishOlderHistory(
      RemoteChatHistoryChunk(
        messages: [
          wireRow('h1', text: 'History'),
          wireRow('c0', text: 'Older'),
          wireRow('c1', text: 'First'),
        ],
        nextCursor: 'cursor-2',
      ),
    ),
    const BeginOlderHistory(sequenceChat),
    FinishOlderHistory(
      RemoteChatHistoryChunk(
        messages: [
          wireRow('h0', text: 'Start'),
          wireRow('h1', text: 'History'),
        ],
      ),
    ),
  ],
  expectedRowIds: const ['h0', 'h1', 'c0', 'c1', 'c2', 'live'],
  expectedWorktreeIds: const ['wt-1', 'wt-2'],
);

/// A session with a transcript, composer state, a summary signal, and an
/// overview head is discarded while an older-history read is in flight. The
/// read's page, and a continuation of the old head, then arrive in the new
/// session. None of the old session's state may apply to the new one.
final sessionResetBetweenBatches = RemoteStoreSequence(
  name: 'session reset between incoming batches',
  steps: [
    ApplyEvents([
      overviewHead('old-head', [sequenceWorktree('wt-1')]),
      chatSnapshot([wireRow('old-answer', text: 'Old session')]),
      const RemoteStateDeltaEvent(
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            title: 'Old chat',
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            turnActive: true,
          ),
        ],
      ),
    ]),
    const BeginOlderHistory(sequenceChat),
    const ResetSession(),
    ApplySnapshotRead(
      RemoteSessionSnapshot(
        workspaces: const [sequenceWorkspace],
        worktrees: [sequenceWorktree('wt-new')],
        standaloneChats: const [],
      ),
    ),
    FinishOlderHistory(
      RemoteChatHistoryChunk(
        messages: [wireRow('old-history', text: 'Old session history')],
      ),
    ),
    ApplyEvents([
      overviewChunk('old-head:chunk-1', [sequenceWorktree('wt-old-chunk')]),
    ]),
  ],
  expectedRowIds: const [],
  expectedWorktreeIds: const ['wt-new'],
);
