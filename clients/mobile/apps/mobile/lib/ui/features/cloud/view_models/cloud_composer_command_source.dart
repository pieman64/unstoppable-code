import 'dart:convert';

import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/repositories/cloud_composer_commands.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';

/// The composer suggestion feed for an existing cloud chat on
/// [modelDefinitionId]. Enabling a row saves the chat's capability selection.
ComposerCommandSource cloudChatCommandSource(
  CloudComposerCommands commands, {
  required String chatId,
  required String? modelDefinitionId,
}) => ComposerCommandSource(
  scope: ('chat', chatId, modelDefinitionId),
  // A plugins change moves rows in and out of "Available to enable".
  revision: () => commands.chatRevision(chatId),
  load: () =>
      commands.chatCommands(chatId, modelDefinitionId: modelDefinitionId),
  enable: (command) async {
    final enableRef = command.enableRef;
    if (enableRef == null) return true;
    return commands.enableForChat(chatId, enableRef);
  },
);

/// The composer suggestion feed for a new chat in [workspaceId]. Enabling a
/// row saves it in the draft's selection in [drafts], with the draft's
/// text, until the first send creates the chat with it.
ComposerCommandSource cloudDraftCommandSource(
  CloudComposerCommands commands, {
  required ChatDraftPort drafts,
  required String workspaceId,
  required String? modelDefinitionId,
}) {
  final target = CloudNewChatDraftTarget(workspaceId);
  return ComposerCommandSource(
    scope: ('draft', workspaceId, modelDefinitionId),
    // Clearing the draft text discards its selection; rows loaded for the
    // old selection would offer a row as selected without enabling it.
    revision: () => jsonEncode(drafts.draftSelectionsFor(target)),
    load: () => commands.draftCommands(
      workspaceId,
      modelDefinitionId: modelDefinitionId,
      pluginSelections: drafts.draftSelectionsFor(target),
    ),
    enable: (command) async {
      final enableRef = command.enableRef;
      if (enableRef == null) return true;
      drafts.setDraftSelections(
        target,
        commands.draftSelectionsWith(
          workspaceId,
          drafts.draftSelectionsFor(target),
          enableRef,
        ),
      );
      return true;
    },
  );
}
