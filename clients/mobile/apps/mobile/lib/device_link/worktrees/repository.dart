import '../chats/title.dart';
import '../chats/dto.dart';
import '../chats/models.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'row_projection.dart';
import 'models.dart';
import 'package:mobile/data/models/remote_session.dart';

export 'models.dart';

/// Reads the existing desktop workspace and chat authorities. No local writer.
final class DeviceWorktreesRepository {
  DeviceWorktreesRepository(this.ipc, {this.onChanged});
  final DesktopIpc ipc;
  final void Function()? onChanged;
  List<DeviceWorktree> worktrees = [];
  List<DeviceProject> projects = [];
  Set<String> codeProjectIds = {};
  bool hasInventory = false;
  // Keep only the latest roster's chat summaries, local to this computer.
  // Invalidated ownership still hides all public rows until a fresh read.
  Map<String, DeviceWorktree> _cachedWorktrees = {};

  /// Worktree keys with a code-graph build in flight. Desktop also learns
  /// this only from `code-graph:build-status-changed` pushes.
  final codeGraphBuilding = <String>{};
  int _generation = 0;

  /// Keeps the last roster for display while reconnecting. It is not fresh
  /// ownership evidence, and replies from the old connection cannot change it.
  void pause() {
    _generation++;
    codeGraphBuilding.clear();
  }

  /// Drops in-flight reads and push-only state. Builds that finish while
  /// disconnected would otherwise stay marked as building.
  void invalidate() {
    codeGraphBuilding.clear();
    invalidateInventory();
  }

  /// Retires ownership evidence without losing live build transitions.
  void invalidateInventory() {
    _generation++;
    hasInventory = false;
    projects = [];
    worktrees = [];
    codeProjectIds = {};
  }

  /// Applies a `code-graph:build-status-changed` push. Returns whether a
  /// row changed.
  bool applyCodeGraphStatus(Object? event) {
    if (event is! Map) return false;
    final key = '${event['projectId']}/${event['worktreeId']}';
    return event['status'] == 'building'
        ? codeGraphBuilding.add(key)
        : codeGraphBuilding.remove(key);
  }

  Future<void> refresh() async {
    final generation = ++_generation;
    final reads = await Future.wait([
      ipc.invoke('projects:load'),
      _optional('desktop:session-snapshot'),
      _optional('pipelines:list-executions'),
    ]);
    if (generation != _generation) return;
    final result = deviceLinkObject(deviceChatDto(reads[0]));
    final snapshot = _map(deviceChatDto(reads[1]));
    final workspaceOwners = {
      for (final row
          in (snapshot['workspaces'] as List? ?? const [])
              .whereType<Map<String, dynamic>>())
        row['localId']: RemoteWorkspace.fromJson(row),
    };
    final projections = {
      for (final row
          in (snapshot['worktrees'] as List? ?? const [])
              .whereType<Map<String, dynamic>>())
        '${row['workspaceLocalId']}/${row['localId']}': row,
    };
    final executions = _map(deviceChatDto(reads[2]));
    final pipelines = devicePipelineStatuses(
      executions['success'] == true
          ? (executions['data'] as List? ?? const [])
                .whereType<Map<String, dynamic>>()
          : const [],
      {
        for (final project in (result['items'] as List).map(deviceLinkObject))
          for (final row
              in (project['worktrees'] as List? ?? const [])
                  .whereType<Map<String, dynamic>>())
            '${project['id']}/${row['id']}': {
              ...(row['seenPipelineExecutionIds'] as List? ?? const [])
                  .whereType<String>(),
            },
      },
    );
    final codeProjects = {
      for (final project in (result['items'] as List).map(deviceLinkObject))
        if (project['type'] != 'cowork') deviceLinkString(project, 'id'),
    };
    final next = <DeviceWorktree>[];
    final nextProjects = <DeviceProject>[];
    for (final project in (result['items'] as List).map(deviceLinkObject)) {
      if (project['hidden'] == true || project['archivedAt'] != null) continue;
      final workspace = workspaceOwners[project['id']];
      if (workspace?.placeholder == true || workspace?.hidden == true) continue;
      nextProjects.add(
        DeviceProject(
          id: deviceLinkString(project, 'id'),
          name: deviceLinkString(project, 'name'),
          type: project['type'] as String? ?? 'single-repo',
          color: project['color'] as String?,
          temporary: project['temporary'] == true,
          alwaysShow: project['alwaysShow'] != false,
          // An absent owner in an existing legacy workspace row is Personal.
          // An absent row, failed snapshot or unrecognized owner stays unknown.
          ownerContext: workspace?.ownerContext,
        ),
      );
      for (final row in (project['worktrees'] as List? ?? []).map(
        deviceLinkObject,
      )) {
        if (row['hidden'] == true || row['archivedAt'] != null) continue;
        final key =
            '${deviceLinkString(project, 'id')}/${deviceLinkString(row, 'id')}';
        final projection = projections[key];
        final worktree = DeviceWorktree(
          projectId: deviceLinkString(project, 'id'),
          projectName: deviceLinkString(project, 'name'),
          id: deviceLinkString(row, 'id'),
          // The projection applies desktop's title rules ("New worktree",
          // branch display mappings).
          name:
              (projection?['label'] ??
                      projection?['branch'] ??
                      row['label'] ??
                      row['branchName'] ??
                      'Worktree')
                  as String,
          savedStatus: row['status'] as String?,
          projection: projection,
          pipelineStatus: pipelines[key],
        );
        final cached = _cachedWorktrees[key];
        if (cached != null) {
          worktree
            ..chats = List.of(cached.chats)
            ..activeChatId = cached.activeChatId
            ..status = cached.status
            ..unread = cached.unread
            ..pendingQuestion = cached.pendingQuestion
            ..pendingApproval = cached.pendingApproval
            ..isStreaming = cached.isStreaming;
          worktree.workingChats.addAll(cached.workingChats);
        }
        next.add(worktree);
      }
    }
    // Fresh inventory and owner evidence are enough to display the roster.
    // Chat details can take many round trips on computers with many worktrees.
    worktrees = next;
    projects = nextProjects;
    codeProjectIds = codeProjects;
    hasInventory = true;
    _cachedWorktrees = {for (final worktree in next) worktree.key: worktree};
    onChanged?.call();
    // Respect the session's eight-request limit and avoid unbounded fan-out.
    for (var offset = 0; offset < next.length; offset += 3) {
      if (generation != _generation) return;
      await Future.wait(next.skip(offset).take(3).map(load));
      if (generation != _generation) return;
      onChanged?.call();
    }
  }

  /// Reads that older hosts may refuse or lack. Rows then keep the
  /// projects-only presentation.
  Future<Object?> _optional(String channel) async {
    try {
      return await ipc.invoke(channel);
    } on DeviceLinkException {
      return null;
    }
  }

  static Map<String, dynamic> _map(Object? value) =>
      value is Map<String, dynamic> ? value : const {};

  Future<void> load(DeviceWorktree worktree) async {
    final generation = _generation;
    try {
      final snapshot = deviceLinkObject(
        deviceChatDto(await ipc.invoke('chat:get-state', [worktree.scope])),
      );
      if (generation != _generation) return;
      final tabs = deviceLinkObject(snapshot['tabsFile']);
      final openTabs = (tabs['tabs'] as List)
          .map(deviceLinkObject)
          .where((t) => t['kind'] != 'file' && t['archivedAt'] == null)
          .toList();
      worktree.chats = openTabs
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
      worktree.unread = openTabs.any((tab) => tab['unread'] == true);
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
      final approvals = tabs['pendingApprovals'] as List? ?? const [];
      final questions = (tabs['pendingQuestions'] as List? ?? [])
          .map(deviceLinkObject)
          .where(
            (question) =>
                question['answeredAt'] == null &&
                question['dismissedAt'] == null,
          )
          .toList();
      final pending = [...approvals, ...questions];
      final plan = (tabs['tabs'] as List).whereType<Map>().any(
        (t) => t['pendingPlanExit'] != null,
      );
      worktree.pendingQuestion = questions.isNotEmpty;
      worktree.pendingApproval =
          approvals.isNotEmpty || states.contains('awaiting_input');
      worktree.isStreaming = states.any(
        ['queued', 'starting', 'streaming', 'completing'].contains,
      );
      worktree.status =
          states.contains('awaiting_input') || pending.isNotEmpty || plan
          ? 'Needs input'
          : worktree.isStreaming
          ? 'Working'
          : states.contains('failed')
          ? 'Failed'
          : worktree.savedStatus == 'done'
          ? 'Done'
          : 'Idle';
    } catch (_) {
      if (generation == _generation) worktree.status = 'Unavailable';
    }
  }
}
