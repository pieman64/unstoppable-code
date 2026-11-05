/// Shared identity for a computer's worktree. Consumers that only need a
/// worktree scope must not depend on chat identity or presentation metadata.
abstract interface class DeviceWorktreeRef {
  String get projectId;
  String get worktreeId;
}
