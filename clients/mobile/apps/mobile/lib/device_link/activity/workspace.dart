import '../chats/dto.dart';
import '../chats/models.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';

/// Select the requested workspace/worktree from the existing desktop read.
/// Never infer a target from collection order or another peer's cached ids.
Future<({Map<String, dynamic> project, Map<String, dynamic> worktree})>
readDeviceWorkspace(DesktopIpc ipc, DeviceChatRef ref) async {
  final result = deviceLinkObject(
    deviceChatDto(await ipc.invoke('projects:load')),
  );
  final project = (result['items'] as List? ?? const [])
      .map(deviceLinkObject)
      .where((row) => row['id'] == ref.projectId)
      .firstOrNull;
  final worktree = (project?['worktrees'] as List? ?? const [])
      .map(deviceLinkObject)
      .where((row) => row['id'] == ref.worktreeId)
      .firstOrNull;
  if (project == null || worktree == null) {
    throw const DeviceLinkException('This worktree is no longer available.');
  }
  return (project: project, worktree: worktree);
}

List<
  ({
    String target,
    String? repoId,
    String? repoName,
    Map<String, dynamic> values,
  })
>
deviceEffectiveSources(
  Map<String, dynamic> project,
  String worktreeId,
  String field,
) {
  final effective = project['worktreeEffective'];
  final local = effective is Map ? effective[worktreeId] : null;
  Map<String, dynamic> values(Object? value) =>
      value is Map<String, dynamic> ? value : {};
  final root = local is Map && local.containsKey(field)
      ? local[field]
      : project[field];
  return [
    (
      target: project['type'] == 'multi-repo' ? 'workspace-root' : 'project',
      repoId: null,
      repoName: null,
      values: values(root),
    ),
    if (project['type'] == 'multi-repo')
      for (final repo in (project['repos'] as List? ?? const []).map(
        deviceLinkObject,
      ))
        (
          target: 'workspace-repo',
          repoId: deviceLinkString(repo, 'id'),
          repoName: repo['name'] as String?,
          values: values(
            local is Map &&
                    local['repos'] is Map &&
                    (local['repos'] as Map)[repo['id']] is Map
                ? ((local['repos'] as Map)[repo['id']] as Map)[field]
                : repo[field],
          ),
        ),
  ];
}
