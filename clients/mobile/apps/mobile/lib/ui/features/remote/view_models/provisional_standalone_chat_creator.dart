import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

/// Creates a provisional Cowork (standalone) chat on the desktop before its
/// first attachment upload or send, keeping that policy out of the chat
/// screen.
///
/// Only desktops that announce `standalone_chat_create` accept the create
/// command. Older desktops announce `chat_attachments` without it, and their
/// first text send creates the chat instead, so this is then a no-op.
final class ProvisionalStandaloneChatCreator {
  ProvisionalStandaloneChatCreator({
    required this.supportsCreate,
    required this.create,
  });

  /// Whether the paired desktop announces `standalone_chat_create`.
  final bool Function() supportsCreate;

  /// Asks the desktop to create the chat and waits for its confirmation.
  final Future<void> Function(RemoteStandaloneChatTarget target) create;

  /// Creates [chatId] in [projectLocalId] when both are known and the desktop
  /// supports creation. Throws [RemoteControlException] when the screen that
  /// owns the chat is no longer open, so no upload or send proceeds.
  Future<void> ensureCreated({
    required String? chatId,
    required String? projectLocalId,
    required bool isOpen,
  }) async {
    if (chatId == null || projectLocalId == null || !supportsCreate()) return;
    if (!isOpen) {
      throw const RemoteControlException('The chat is no longer open.');
    }
    await create(
      RemoteStandaloneChatTarget(
        chatId: chatId,
        projectLocalId: projectLocalId,
      ),
    );
  }
}
