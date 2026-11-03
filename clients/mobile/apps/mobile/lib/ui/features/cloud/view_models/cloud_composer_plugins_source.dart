import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/repositories/cloud_composer_commands.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';

/// The plugin selection of an existing cloud chat in [workspaceId]. Each
/// toggle saves the chat's complete capability selection.
/// [summarySelections] is the chat list's last known selection, for the
/// Plugins row count before this session reads or writes it. [harness] is
/// the harness the chat runs on, which scopes plugins as the web picker
/// does.
ComposerPluginsSource cloudChatPluginsSource(
  CloudComposerCommands commands, {
  required String chatId,
  required String workspaceId,
  required Map<String, Object?>? summarySelections,
  required String? harness,
}) => ComposerPluginsSource(
  providerType: () => harness,
  loadCatalog: () => commands.catalog(workspaceId),
  loadSelections: () => commands.chatSelections(chatId),
  save: (selections) => commands.saveChatSelections(chatId, selections),
  selectedCount: () =>
      switch (commands.knownChatSelections(chatId) ?? summarySelections) {
        final selections? => countPluginSelections(selections),
        null => null,
      },
);

/// The plugin selection of a new chat in [workspaceId]. Choices stay with
/// the draft in [drafts] until its first send creates the chat with them;
/// until the first change the draft inherits the project defaults.
/// [harness] is the harness of the draft's model.
ComposerPluginsSource cloudDraftPluginsSource(
  CloudComposerCommands commands, {
  required ChatDraftPort drafts,
  required String workspaceId,
  required String? harness,
}) {
  final target = CloudNewChatDraftTarget(workspaceId);
  return ComposerPluginsSource(
    providerType: () => harness,
    loadCatalog: () => commands.catalog(workspaceId),
    loadSelections: () async =>
        drafts.draftSelectionsFor(target) ??
        await commands.draftDefaults(workspaceId),
    save: (selections) async {
      drafts.setDraftSelections(target, selections);
      return selections;
    },
    selectedCount: () => switch (drafts.draftSelectionsFor(target) ??
        commands.knownDraftDefaults(workspaceId)) {
      final selections? => countPluginSelections(selections),
      null => null,
    },
  );
}
