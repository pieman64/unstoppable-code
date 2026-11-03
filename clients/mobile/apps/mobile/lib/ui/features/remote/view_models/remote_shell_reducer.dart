/// Pure reduction of shell removals and standalone chat or workspace
/// upserts onto a session snapshot (CAN-4874). It follows the server cache,
/// so the result matches what an overview read returns after the same delta:
///
///  * A removal matches the type and local id, and also the parent when one
///    is given. It removes nothing else: no cascade to child rows. A removed
///    `pr_status` takes its observation off the worktree row, which keeps
///    its own `lastKnownPrStatus`, as the read returns it.
///  * Upserts replace a row in place. A new row goes where the overview read
///    orders it: by local id, after rows that share that id.
///  * Collections a step leaves unchanged keep their identity, so read-race
///    checks and memoized reads see no change.
///
/// Background processes (CAN-5253) reduce the same way, onto the held
/// worktree activity slices instead of the snapshot.
library;

import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';

import 'remote_identity.dart';

/// What [removeShellRows] removed besides the rows themselves.
typedef RemoteShellRemovals = ({
  RemoteSessionSnapshot snapshot,
  List<RemoteChatSummary> removedSummaries,
  Set<RemoteWorktreeKey> prProgressRemoved,
});

/// Removes the rows [removals] match from [snapshot].
RemoteShellRemovals removeShellRows(
  RemoteSessionSnapshot snapshot,
  List<RemoteShellRemoval> removals,
) {
  var workspaces = snapshot.workspaces;
  var worktrees = snapshot.worktrees;
  var standaloneChats = snapshot.standaloneChats;
  var summaries = snapshot.chatSummaries;
  final removedSummaries = <RemoteChatSummary>[];
  final prProgressRemoved = <RemoteWorktreeKey>{};
  for (final RemoteShellRemoval(:type, :localId, :parentLocalId) in removals) {
    switch (type) {
      case RemoteShellEntityType.workspace:
        // Workspace rows have no parent, so a parent matches none of them.
        if (parentLocalId == null) {
          workspaces = _without(workspaces, (row) => row.localId == localId);
        }
      case RemoteShellEntityType.worktree:
        worktrees = _without(
          worktrees,
          (row) =>
              row.localId == localId &&
              (parentLocalId == null || row.workspaceLocalId == parentLocalId),
        );
      case RemoteShellEntityType.standaloneChat:
        standaloneChats = _without(
          standaloneChats,
          (row) =>
              row.localId == localId &&
              (parentLocalId == null || row.projectLocalId == parentLocalId),
        );
      case RemoteShellEntityType.chatSummary:
        bool matches(RemoteChatSummary row) =>
            row.chatId == localId &&
            _matchesWorktreeParent(
              parentLocalId,
              row.workspaceLocalId,
              row.worktreeLocalId,
            );
        removedSummaries.addAll(summaries.where(matches));
        summaries = _without(summaries, matches);
      case RemoteShellEntityType.prStatus:
        final parent = parentLocalId == null
            ? null
            : remoteWorktreeKeyFromEvent(parentLocalId);
        final keys = parent != null
            ? {if (parent.worktreeLocalId == localId) parent}
            : {
                for (final row in worktrees)
                  if (row.localId == localId &&
                      _matchesWorktreeParent(
                        parentLocalId,
                        row.workspaceLocalId,
                        row.localId,
                      ))
                    remoteWorktreeKeyOf(row),
              };
        prProgressRemoved.addAll(keys);
        worktrees = _withoutPrObservations(worktrees, keys);
      case RemoteShellEntityType.watcher:
      case RemoteShellEntityType.backgroundProcess:
        // Held in the worktree slices; see [reduceBackgroundProcesses].
        break;
    }
  }
  return (
    snapshot: _withCollections(
      snapshot,
      workspaces: workspaces,
      worktrees: worktrees,
      standaloneChats: standaloneChats,
      chatSummaries: summaries,
    ),
    removedSummaries: removedSummaries,
    prProgressRemoved: prProgressRemoved,
  );
}

/// The PR progress patches of a delta whose `pr_status` removals cleared
/// [removed]. A removed worktree's progress clears; a patch the same delta
/// upserts afterwards carries only its own feeds.
Map<String, RemotePrProgressState>? prProgressAfterRemovals(
  Map<String, RemotePrProgressState>? patches,
  Set<RemoteWorktreeKey> removed,
) {
  if (removed.isEmpty) return patches;
  final keys = {
    for (final key in removed) '${key.workspaceLocalId}:${key.worktreeLocalId}',
  };
  return {
    for (final key in keys)
      key: const RemotePrProgressState(clearCreation: true, clearMerge: true),
    for (final MapEntry(:key, value: patch) in (patches ?? const {}).entries)
      key: keys.contains(key)
          ? RemotePrProgressState(
              creation: patch.creation,
              merge: patch.merge,
              clearCreation: patch.creation == null,
              clearMerge: patch.merge == null,
            )
          : patch,
  };
}

/// Upserts [chats], keyed by project and local id like the server cache.
RemoteSessionSnapshot upsertStandaloneChats(
  RemoteSessionSnapshot snapshot,
  List<RemoteStandaloneChat> chats,
) => _withCollections(
  snapshot,
  standaloneChats: _upsert(
    snapshot.standaloneChats,
    chats,
    key: (row) => (row.projectLocalId, row.localId),
    localId: (row) => row.localId,
  ),
);

/// Upserts workspace rows by local id.
RemoteSessionSnapshot upsertWorkspaces(
  RemoteSessionSnapshot snapshot,
  List<RemoteWorkspace> rows,
) => _withCollections(
  snapshot,
  workspaces: _upsert(
    snapshot.workspaces,
    rows,
    key: (row) => row.localId,
    localId: (row) => row.localId,
  ),
);

/// [rows] after [removals], then [upserts], keyed by workspace, worktree
/// and local id like the server cache. A removal's parent names the
/// worktree, `'<workspace>:<worktree>'`; without one it matches every
/// worktree.
List<RemoteBackgroundProcess> reduceBackgroundProcesses(
  List<RemoteBackgroundProcess> rows, {
  List<RemoteShellRemoval> removals = const [],
  List<RemoteBackgroundProcess> upserts = const [],
}) {
  var next = rows;
  for (final RemoteShellRemoval(:localId, :parentLocalId) in removals) {
    next = _without(
      next,
      (row) =>
          row.localId == localId &&
          _matchesWorktreeParent(
            parentLocalId,
            row.workspaceLocalId,
            row.worktreeLocalId,
          ),
    );
  }
  return _upsert(
    next,
    upserts,
    key: (row) => (row.workspaceLocalId, row.worktreeLocalId, row.localId),
    localId: (row) => row.localId,
  );
}

/// The worktrees whose background processes [delta] changes. A removal
/// whose parent names no workspace and worktree names none.
Set<RemoteWorktreeKey> backgroundProcessWorktrees(RemoteShellDelta delta) => {
  for (final row in delta.backgroundProcesses)
    remoteWorktreeKey(row.workspaceLocalId, row.worktreeLocalId),
  for (final removal in delta.backgroundProcessRemovals)
    if (removal.parentLocalId case final parent?)
      ?remoteWorktreeKeyFromEvent(parent),
};

/// Whether a chat tab or PR status parent names this worktree: the
/// canonical `'<workspace>:<worktree>'` form or a legacy bare worktree id.
bool _matchesWorktreeParent(
  String? parent,
  String? workspaceLocalId,
  String? worktreeLocalId,
) =>
    parent == null ||
    (worktreeLocalId != null &&
        (parent == worktreeLocalId ||
            parent == '$workspaceLocalId:$worktreeLocalId'));

List<RemoteWorktree> _withoutPrObservations(
  List<RemoteWorktree> rows,
  Set<RemoteWorktreeKey> keys,
) {
  bool observed(RemoteWorktree row) =>
      !identical(row.prStatuses, row.hostPrStatuses) &&
      keys.contains(remoteWorktreeKeyOf(row));
  return rows.any(observed)
      ? [
          for (final row in rows)
            observed(row) ? row.withoutPrObservation() : row,
        ]
      : rows;
}

List<T> _without<T>(List<T> rows, bool Function(T row) test) => rows.any(test)
    ? [
        for (final row in rows)
          if (!test(row)) row,
      ]
    : rows;

List<T> _upsert<T>(
  List<T> rows,
  List<T> incoming, {
  required Object Function(T row) key,
  required String Function(T row) localId,
}) {
  if (incoming.isEmpty) return rows;
  final next = List.of(rows);
  for (final row in incoming) {
    final index = next.indexWhere((existing) => key(existing) == key(row));
    if (index != -1) {
      next[index] = row;
      continue;
    }
    final id = localId(row);
    final before = next.indexWhere(
      (existing) => localId(existing).compareTo(id) > 0,
    );
    next.insert(before == -1 ? next.length : before, row);
  }
  return next;
}

RemoteSessionSnapshot _withCollections(
  RemoteSessionSnapshot snapshot, {
  List<RemoteWorkspace>? workspaces,
  List<RemoteWorktree>? worktrees,
  List<RemoteStandaloneChat>? standaloneChats,
  List<RemoteChatSummary>? chatSummaries,
}) {
  final unchanged =
      identical(workspaces ?? snapshot.workspaces, snapshot.workspaces) &&
      identical(worktrees ?? snapshot.worktrees, snapshot.worktrees) &&
      identical(
        standaloneChats ?? snapshot.standaloneChats,
        snapshot.standaloneChats,
      ) &&
      identical(
        chatSummaries ?? snapshot.chatSummaries,
        snapshot.chatSummaries,
      );
  return unchanged
      ? snapshot
      : snapshot.copyWith(
          workspaces: workspaces,
          worktrees: worktrees,
          standaloneChats: standaloneChats,
          chatSummaries: chatSummaries,
        );
}
