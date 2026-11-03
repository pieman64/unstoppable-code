import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';

import 'remote_identity.dart';
import 'remote_shell_reducer.dart';

/// [slices] with [delta]'s background process changes for [worktree]
/// applied (CAN-5253). [slices] must come from a read of [worktree]'s
/// workspace: worktree ids can repeat across workspaces.
Map<String, dynamic> withBackgroundProcessDelta(
  Map<String, dynamic> slices,
  RemoteWorktreeKey worktree,
  RemoteShellDelta delta,
) {
  bool owned(RemoteBackgroundProcess row) =>
      row.workspaceLocalId == worktree.workspaceLocalId &&
      row.worktreeLocalId == worktree.worktreeLocalId;
  final held = [
    if (slices['backgroundProcesses'] case final List<Object?> rows)
      for (final row in rows) ?RemoteBackgroundProcess.fromJson(row),
  ];
  final next = reduceBackgroundProcesses(
    held,
    removals: delta.backgroundProcessRemovals,
    upserts: [
      for (final row in delta.backgroundProcesses)
        if (owned(row)) row,
    ],
  );
  if (identical(next, held)) return slices;
  return {
    ...slices,
    'backgroundProcesses': [for (final row in next) row.toJson()],
  };
}
