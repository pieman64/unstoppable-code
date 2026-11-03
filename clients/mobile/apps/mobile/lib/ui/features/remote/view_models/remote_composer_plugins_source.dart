import 'dart:async';

import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_composer_commands.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';
import 'package:mobile/ui/features/remote/view_models/composer_overrides_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_chat_resolver.dart';

/// The plugin selection of a Remote Control worktree chat; standalone chats
/// use [remoteStandalonePluginsSource].
///
/// The selection is the chat's pending choice, else its projected
/// `pluginSelectionsDetail`. A load reads the chat [chats] resolves, so a
/// worktree before its first message creates its chat first and a new tab
/// is read once the desktop lists it. A load first waits for the desktop to
/// answer an earlier write, so it never starts from a choice the desktop
/// can still reject. Writes go only to the chat and session the last load
/// read; when that chat is no longer listed or the session changed, a write
/// fails. A write holds as a pending choice until the desktop settles it, so
/// a rejection returns the chat to its projection. [chatId] is the chat
/// shown now, for the count. [providerType] is a chat's effective provider,
/// which the desktop Plugins modal also scopes plugins by; the sheet uses
/// the provider of the chat the last load read, so a first chat scopes
/// plugins once it is created.
ComposerPluginsSource remoteComposerPluginsSource({
  required RemoteComposerCommands commands,
  required ComposerOverridesController overrides,
  required RemoteComposerChatResolver chats,
  required RemoteWorktree worktree,
  required String? chatId,
  required String? Function(String chatId) providerType,
  required RemoteChatSummary? Function(String chatId) summary,
}) {
  Map<String, Object?>? current(String chatId) =>
      overrides.valueOf(chatId, ComposerField.pluginSelections) ??
      switch (summary(chatId)) {
        null => null,
        final projected => projected.pluginSelectionsDetail ?? const {},
      };
  RemoteWorktreeChatTarget? loaded;
  int? loadedIn;
  return ComposerPluginsSource(
    providerType: () => switch (loaded?.chatId) {
      final chatId? => providerType(chatId),
      null => null,
    },
    loadCatalog: () => commands.pluginCatalog(
      workspaceLocalId: worktree.workspaceLocalId,
      worktreeLocalId: worktree.localId,
      providerType: chatId == null ? null : providerType(chatId),
    ),
    loadSelections: () async {
      loaded = null;
      final target = await chats.chatIn(worktree);
      final chatId = target.chatId!;
      await overrides.settled(chatId, ComposerField.pluginSelections);
      final selections =
          current(chatId) ??
          (throw const RemoteControlException('The chat is still loading.'));
      loaded = target;
      loadedIn = overrides.sessionGeneration();
      return selections;
    },
    save: (selections) async {
      final target = loaded;
      if (target == null ||
          summary(target.chatId!) == null ||
          loadedIn != overrides.sessionGeneration()) {
        throw const RemoteControlException('The chat changed.');
      }
      return _saveSelections(overrides, target, selections);
    },
    selectedCount: () => switch (chatId == null ? null : current(chatId)) {
      final selections? => countPluginSelections(selections),
      null => null,
    },
  );
}

/// The plugin selection of a standalone Remote Control chat the desktop
/// projects, or null when its desktop lacks the invocable inventory
/// (CAN-3923) or the chat is not projected yet.
///
/// The selection is the chat's pending choice, else the projected
/// [RemoteStandaloneChat.pluginSelectionsDetail]. Until the desktop projects
/// it the selection is unknown: the count is hidden and a load fails, so an
/// unknown selection is never overwritten. Writes go only to the chat and
/// session the last load read, and hold as a pending choice until the
/// desktop settles them. [standaloneChat] reads the live projection.
ComposerPluginsSource? remoteStandalonePluginsSource({
  required RemoteComposerCommands commands,
  required ComposerOverridesController overrides,
  required String? chatId,
  required String? providerType,
  required RemoteStandaloneChat? Function(String chatId) standaloneChat,
}) {
  if (chatId == null || !commands.supportsInvocableInventory) return null;
  final projected = standaloneChat(chatId);
  if (projected == null) return null;
  final target = RemoteStandaloneChatTarget(
    chatId: chatId,
    projectLocalId: projected.projectLocalId,
  );
  Map<String, Object?>? current() =>
      overrides.valueOf(chatId, ComposerField.pluginSelections) ??
      standaloneChat(chatId)?.pluginSelectionsDetail;
  int? loadedIn;
  return ComposerPluginsSource(
    providerType: () => providerType,
    loadCatalog: () => commands.standalonePluginCatalog(
      projectLocalId: projected.projectLocalId,
      chatId: chatId,
      providerType: providerType,
    ),
    loadSelections: () async {
      loadedIn = null;
      await overrides.settled(chatId, ComposerField.pluginSelections);
      final selections =
          current() ??
          (throw const RemoteControlException('The chat is still loading.'));
      loadedIn = overrides.sessionGeneration();
      return selections;
    },
    save: (selections) async {
      if (loadedIn != overrides.sessionGeneration() ||
          standaloneChat(chatId) == null) {
        throw const RemoteControlException('The chat changed.');
      }
      return _saveSelections(overrides, target, selections);
    },
    selectedCount: () => switch (current()) {
      final selections? => countPluginSelections(selections),
      null => null,
    },
  );
}

/// Holds [selections] as [target]'s pending choice and completes with them
/// once the desktop applies the write, or throws when it does not.
Future<Map<String, Object?>> _saveSelections(
  ComposerOverridesController overrides,
  RemoteChatTarget target,
  Map<String, Object?> selections,
) {
  final settled = Completer<Map<String, Object?>>();
  void settle(bool applied) {
    if (settled.isCompleted) return;
    if (applied) {
      settled.complete(selections);
    } else {
      settled.completeError(
        const RemoteControlException('The plugins were not saved.'),
      );
    }
  }

  unawaited(
    overrides
        .change(
          target,
          ComposerField.pluginSelections,
          selections,
          onSettled: settle,
        )
        .catchError((Object _) => settle(false)),
  );
  return settled.future;
}
