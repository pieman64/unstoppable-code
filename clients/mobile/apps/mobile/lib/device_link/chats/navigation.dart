import '../desktop/ipc.dart';
import 'models.dart';
import 'settings.dart';

/// Desktop-owned tab and read-state mutations, independent of chat delivery.
final class DeviceChatNavigation {
  DeviceChatNavigation(DesktopIpc ipc) : _commands = DeviceChatSettings(ipc);
  final DeviceChatSettings _commands;

  Future<void> markRead(DeviceChatRef ref) =>
      _commands.command(ref, {'type': 'chat.mark_read', 'chatId': ref.id});
  Future<void> archive(DeviceChatRef ref) => _commands.command(ref, {
    'type': 'chat.close_tab',
    'tabId': ref.id,
    'mode': 'archive',
  });
}
