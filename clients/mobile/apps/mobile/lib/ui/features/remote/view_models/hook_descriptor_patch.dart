import 'package:mobile/data/models/remote_portal_event.dart';

/// [slices] with [event]'s hook descriptor upserted or removed. Other rows
/// keep their order; a new hook goes last. [slices] must come from a read of
/// [event]'s workspace: worktree ids can repeat across workspaces.
Map<String, dynamic> withHookDescriptor(
  Map<String, dynamic> slices,
  RemoteHookDescriptorEvent event,
) {
  bool matches(Object? row) =>
      row is Map<String, dynamic> &&
      row['worktreeLocalId'] == event.worktreeLocalId &&
      row['hookKey'] == event.hookKey;
  final held = switch (slices['hookDescriptors']) {
    final List<Object?> rows => rows,
    _ => const <Object?>[],
  };
  final descriptor = event.descriptor;
  return {
    ...slices,
    'hookDescriptors': [
      for (final row in held)
        if (!matches(row)) row else ?descriptor,
      if (descriptor != null && !held.any(matches)) descriptor,
    ],
  };
}
