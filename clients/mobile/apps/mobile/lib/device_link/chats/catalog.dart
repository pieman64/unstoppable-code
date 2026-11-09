import '../desktop/ipc.dart';
import '../protocol.dart';
import 'dto.dart';
import 'models.dart';

typedef DeviceChatCatalog = ({
  List<DeviceChatRef> chats,
  List<DeviceChatWorkspace> workspaces,
});
typedef DeviceChatCatalogReader =
    Future<DeviceChatCatalog> Function(DesktopIpc ipc);

Future<DeviceChatCatalog> readDeviceChatCatalog(DesktopIpc ipc) async {
  final result = deviceLinkObject(
    deviceChatDto(await ipc.invoke('chat-search:catalog')),
  );
  final projects = deviceLinkObject(
    deviceChatDto(await ipc.invoke('chat-project:list')),
  );
  return (
    chats: (result['entries'] as List)
        .map(deviceLinkObject)
        .where(
          (e) =>
              e['source'] == 'live' &&
              (e['documentKind'] == null || e['documentKind'] == 'chat') &&
              e['archivedAt'] == null,
        )
        .map(DeviceChatRef.fromCatalog)
        .toList(),
    workspaces: (projects['projects'] as List)
        .map(deviceLinkObject)
        .map(
          (p) => DeviceChatWorkspace(
            deviceLinkString(p, 'id'),
            deviceLinkString(p, 'name'),
          ),
        )
        .toList(),
  );
}
