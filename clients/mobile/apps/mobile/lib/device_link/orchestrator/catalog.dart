import '../chats/catalog.dart';
import '../chats/dto.dart';
import '../chats/models.dart';
import '../chats/title.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';

const orchestratorProjectId = 'app-advisor';

final class OrchestratorEntry {
  OrchestratorEntry({
    required this.id,
    required this.title,
    required this.chats,
    required this.running,
    required this.unread,
  });
  final String id, title;
  final List<DeviceChatRef> chats;
  final bool running, unread;
}

/// Registry order and status stay desktop-owned. The shared search index
/// provides lightweight chat identities, never permission to create a tab.
final class OrchestratorCatalog {
  List<OrchestratorEntry> entries = [];
  int _generation = 0;
  void invalidate() => _generation++;

  Future<DeviceChatCatalog> read(DesktopIpc ipc) async {
    final generation = ++_generation;
    final result = deviceLinkObject(
      deviceChatDto(
        await ipc.invoke('work-entries:list', [
          {'projectId': orchestratorProjectId},
        ]),
      ),
    );
    final catalog = deviceLinkObject(
      deviceChatDto(await ipc.invoke('chat-search:catalog')),
    );
    final chats = [
      for (final row in (catalog['entries'] as List).map(deviceLinkObject))
        if (row['projectId'] == orchestratorProjectId &&
            row['source'] == 'live' &&
            row['archivedAt'] == null &&
            (row['documentKind'] == null || row['documentKind'] == 'chat'))
          DeviceChatRef.fromCatalog(row),
    ];
    final next = [
      for (final row in (result['entries'] as List).map(deviceLinkObject))
        OrchestratorEntry(
          id: deviceLinkString(row, 'id'),
          title: row['title'] as String? ?? 'New chat',
          chats: chats.where((chat) => chat.worktreeId == row['id']).toList(),
          running: row['hasActiveChat'] == true,
          unread: (row['unreadChats'] as List? ?? const []).isNotEmpty,
        ),
    ];
    if (generation == _generation) entries = next;
    return (
      chats: chats,
      workspaces: [DeviceChatWorkspace(orchestratorProjectId, 'Orchestrator')],
    );
  }

  /// Resolve the actual active tab immediately before opening. A cold or
  /// stale search index must never turn an existing task into an empty one.
  Future<DeviceChatRef?> activeChat(
    DesktopIpc ipc,
    OrchestratorEntry entry,
  ) async {
    final snapshot = deviceLinkObject(
      deviceChatDto(
        await ipc.invoke('chat:get-state', [
          {'projectId': orchestratorProjectId, 'worktreeId': entry.id},
        ]),
      ),
    );
    final file = deviceLinkObject(snapshot['tabsFile']);
    final tabs = (file['tabs'] as List)
        .map(deviceLinkObject)
        .where((tab) => tab['kind'] != 'file' && tab['archivedAt'] == null)
        .toList();
    final tab =
        tabs.where((tab) => tab['id'] == file['activeTabId']).firstOrNull ??
        tabs.firstOrNull;
    if (tab == null) return null;
    return DeviceChatRef(
      projectId: orchestratorProjectId,
      worktreeId: entry.id,
      id: deviceLinkString(tab, 'id'),
      title: deviceChatTitle(tab),
    );
  }
}
