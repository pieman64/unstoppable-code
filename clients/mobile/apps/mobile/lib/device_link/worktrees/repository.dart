import '../chats/title.dart';
import '../chats/dto.dart';
import '../chats/models.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';

final class DeviceProject {
  DeviceProject({
    required this.id,
    required this.name,
    required this.type,
    this.color,
    this.temporary = false,
    this.alwaysShow = true,
  });
  final String id, name, type;
  final String? color;
  final bool temporary, alwaysShow;
}

final class DeviceWorktree {
  DeviceWorktree({
    required this.projectId,
    required this.projectName,
    required this.id,
    required this.name,
    required this.savedStatus,
  });
  final String projectId, projectName, id, name;
  final String? savedStatus;
  List<DeviceChatRef> chats = [];
  String status = 'Loading';
  String? activeChatId;
  bool unread = false;
  final workingChats = <String>{};
  Map<String, dynamic> get scope => {'projectId': projectId, 'worktreeId': id};
  String get key => '$projectId/$id';
}

/// Reads the existing desktop workspace and chat authorities. No local writer.
final class DeviceWorktreesRepository {
  DeviceWorktreesRepository(this.ipc);
  final DesktopIpc ipc;
  List<DeviceWorktree> worktrees = [];
  List<DeviceProject> projects = [];
  Set<String> codeProjectIds = {};
  int _generation = 0;
  void invalidate() {
    _generation++;
  }

  Future<void> refresh() async {
    final generation = ++_generation;
    final result = deviceLinkObject(
      deviceChatDto(await ipc.invoke('projects:load')),
    );
    final codeProjects = {
      for (final project in (result['items'] as List).map(deviceLinkObject))
        if (project['type'] != 'cowork') deviceLinkString(project, 'id'),
    };
    final next = <DeviceWorktree>[];
    final nextProjects = <DeviceProject>[];
    for (final project in (result['items'] as List).map(deviceLinkObject)) {
      if (project['hidden'] == true || project['archivedAt'] != null) continue;
      nextProjects.add(
        DeviceProject(
          id: deviceLinkString(project, 'id'),
          name: deviceLinkString(project, 'name'),
          type: project['type'] as String? ?? 'single-repo',
          color: project['color'] as String?,
          temporary: project['temporary'] == true,
          alwaysShow: project['alwaysShow'] != false,
        ),
      );
      for (final row in (project['worktrees'] as List? ?? []).map(
        deviceLinkObject,
      )) {
        if (row['hidden'] == true || row['archivedAt'] != null) continue;
        next.add(
          DeviceWorktree(
            projectId: deviceLinkString(project, 'id'),
            projectName: deviceLinkString(project, 'name'),
            id: deviceLinkString(row, 'id'),
            name: (row['label'] ?? row['branchName'] ?? 'Worktree') as String,
            savedStatus: row['status'] as String?,
          ),
        );
      }
    }
    // Respect the session's eight-request limit and avoid unbounded fan-out.
    for (var offset = 0; offset < next.length; offset += 3) {
      if (generation != _generation) return;
      await Future.wait(next.skip(offset).take(3).map(load));
    }
    if (generation == _generation) {
      worktrees = next;
      projects = nextProjects;
      codeProjectIds = codeProjects;
    }
  }

  Future<void> load(DeviceWorktree worktree) async {
    try {
      final snapshot = deviceLinkObject(
        deviceChatDto(await ipc.invoke('chat:get-state', [worktree.scope])),
      );
      final tabs = deviceLinkObject(snapshot['tabsFile']);
      worktree.chats = (tabs['tabs'] as List)
          .map(deviceLinkObject)
          .where((t) => t['kind'] != 'file' && t['archivedAt'] == null)
          .map(
            (t) => DeviceChatRef(
              projectId: worktree.projectId,
              worktreeId: worktree.id,
              id: deviceLinkString(t, 'id'),
              title: deviceChatTitle(t),
            ),
          )
          .toList();
      worktree.activeChatId = tabs['activeTabId'] as String?;
      worktree.unread = (tabs['tabs'] as List).whereType<Map>().any(
        (t) => t['kind'] != 'file' && t['unread'] == true,
      );
      worktree.workingChats
        ..clear()
        ..addAll([
          for (final entry in deviceLinkObject(
            snapshot['runtimeByChatId'],
          ).entries)
            if (entry.value is Map &&
                const [
                  'queued',
                  'starting',
                  'streaming',
                  'awaiting_input',
                  'completing',
                ].contains((entry.value as Map)['status']))
              entry.key,
        ]);
      final states = deviceLinkObject(
        snapshot['runtimeByChatId'],
      ).values.whereType<Map>().map((r) => r['status']).toSet();
      final pending = [
        ...(tabs['pendingApprovals'] as List? ?? []),
        ...(tabs['pendingQuestions'] as List? ?? [])
            .map(deviceLinkObject)
            .where(
              (question) =>
                  question['answeredAt'] == null &&
                  question['dismissedAt'] == null,
            ),
      ];
      final plan = (tabs['tabs'] as List).whereType<Map>().any(
        (t) => t['pendingPlanExit'] != null,
      );
      worktree.status =
          states.contains('awaiting_input') || pending.isNotEmpty || plan
          ? 'Needs input'
          : states.any(
              ['queued', 'starting', 'streaming', 'completing'].contains,
            )
          ? 'Working'
          : states.contains('failed')
          ? 'Failed'
          : worktree.savedStatus == 'done'
          ? 'Done'
          : 'Idle';
    } catch (_) {
      worktree.status = 'Unavailable';
    }
  }
}
