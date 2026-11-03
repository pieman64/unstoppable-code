import 'dart:convert';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_invocables.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_composer_commands.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';

/// The composer suggestion feed for a Remote Control chat, or null for a
/// standalone chat that has no id yet.
///
/// A desktop with the invocable inventory lists the rows of an existing
/// worktree chat, or of a standalone chat the desktop projects in
/// [standaloneProjectLocalId], and resolves a row before its text is
/// inserted. Those rows follow the chat's projected [pluginSelections] and
/// belong to the pairing [sessionGeneration] counts. A stale or rebuilding
/// inventory lists them again as the menu next opens. The desktop picks the
/// chat's harness for them, so a [providerType] change only lists them
/// again. Otherwise a worktree lists the slash commands the desktop
/// discovered for its provider. Before
/// the worktree has a chat no provider is known, so it has built-in actions
/// only, as does a standalone chat.
ComposerCommandSource? remoteComposerCommandSource(
  RemoteComposerCommands commands, {
  required RemoteWorktree? worktree,
  required String? chatId,
  required String? providerType,
  required int Function() sessionGeneration,
  required Map<String, Object?>? Function() pluginSelections,
  String? standaloneProjectLocalId,
}) {
  final chat = chatId == null || chatId.isEmpty ? null : chatId;
  if (chat != null && commands.supportsInvocableInventory) {
    final RemoteChatTarget target = worktree == null
        ? RemoteStandaloneChatTarget(
            chatId: chat,
            projectLocalId: standaloneProjectLocalId,
          )
        : RemoteWorktreeChatTarget(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.localId,
            chatId: chat,
          );
    if (remoteInvocableTarget(target) case final wire?) {
      final generation = sessionGeneration();
      return ComposerCommandSource(
        // Rows are not cached across pairings or chats, so a late answer
        // for another pairing or chat is dropped. A new pairing can keep
        // the server's session id.
        scope: (
          commands.sessionId,
          generation,
          wire.target.values.join('\n'),
          providerType,
        ),
        // A Plugins change moves rows in and out of "Available to enable".
        revision: () => jsonEncode(pluginSelections()),
        load: () async => (await commands.invocables(target)).commands,
        unsettled: () => commands.invocablesUnsettled(target),
        resolve: (command) async {
          final text = await commands.resolveInvocable(
            target,
            command.entryId!,
          );
          // A new pairing can answer before this source is replaced.
          return sessionGeneration() == generation ? text : null;
        },
      );
    }
  }
  if (worktree == null) {
    return chat == null
        ? null
        : ComposerCommandSource(scope: ('standalone', chat));
  }
  return ComposerCommandSource(
    scope: (worktree.workspaceLocalId, worktree.localId, chat, providerType),
    load: chat == null && providerType == null
        ? null
        : () => commands.list(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.localId,
            providerType: providerType,
          ),
  );
}
