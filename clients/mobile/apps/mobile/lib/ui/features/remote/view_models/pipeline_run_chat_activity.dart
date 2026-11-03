import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_session.dart';

/// The pipeline runs a desktop attributes to each turn of one worktree chat,
/// as shown by that chat's Agent activity panels (CAN-3619).
///
/// Pure: the desktop decides attribution (`PortalPipelineRun.chatTurns`);
/// this only keeps the rows the phone can show and orders them.
final class PipelineRunChatActivity {
  const PipelineRunChatActivity(this.runsByTurn);

  static const empty = PipelineRunChatActivity({});

  /// Turn key (the opening user message id) -> its runs, oldest start first,
  /// the order the desktop lists them in as they launch.
  final Map<String, List<RemotePipelineRun>> runsByTurn;

  bool get isEmpty => runsByTurn.isEmpty;

  /// The newest of [turnKeys] (transcript order, oldest first) that has a
  /// panel; it is the one panel that starts expanded.
  String? latestTurnKey(Iterable<String> turnKeys) {
    String? latest;
    for (final key in turnKeys) {
      if (runsByTurn.containsKey(key)) latest = key;
    }
    return latest;
  }
}

/// Whether [worktree]'s chats show Agent activity panels: worktree chats do,
/// cowork entries do not. Standalone chats have no worktree and show none.
bool showsPipelineRunChatActivity(
  RemoteWorktree worktree,
  Iterable<RemoteWorkspace> workspaces,
) => !workspaces.any(
  (workspace) =>
      workspace.localId == worktree.workspaceLocalId &&
      workspace.type == RemoteWorkspaceType.cowork,
);

/// Groups [runs] by the turns of [chatId] they are linked to.
///
/// [runs] are the worktree's merged rows, so a link to a run with no row is
/// already gone. Hidden and child runs never get a card, matching the
/// desktop's activity list and the root-only run controls; a row from
/// another worktree claims nothing here, whatever its links say.
PipelineRunChatActivity selectPipelineRunChatActivity({
  required String chatId,
  required String worktreeLocalId,
  required Iterable<RemotePipelineRun> runs,
}) {
  final byTurn = <String, List<RemotePipelineRun>>{};
  for (final run in runs) {
    if (run.hidden || !run.isRoot) continue;
    if (run.worktreeLocalId != null && run.worktreeLocalId != worktreeLocalId) {
      continue;
    }
    final turns = <String>{
      for (final link in run.chatTurns ?? const <RemotePipelineRunChatTurn>[])
        if (link.chatId == chatId) link.userMessageId,
    };
    for (final turn in turns) {
      (byTurn[turn] ??= []).add(run);
    }
  }
  if (byTurn.isEmpty) return PipelineRunChatActivity.empty;
  return PipelineRunChatActivity({
    for (final MapEntry(:key, :value) in byTurn.entries)
      key: List.unmodifiable(value..sort(_byStart)),
  });
}

int _byStart(RemotePipelineRun a, RemotePipelineRun b) {
  final left = DateTime.tryParse(a.startedAt ?? '');
  final right = DateTime.tryParse(b.startedAt ?? '');
  final byTime = switch ((left, right)) {
    (null, null) => 0,
    (null, _) => 1,
    (_, null) => -1,
    (final l?, final r?) => l.compareTo(r),
  };
  return byTime != 0 ? byTime : a.localId.compareTo(b.localId);
}
