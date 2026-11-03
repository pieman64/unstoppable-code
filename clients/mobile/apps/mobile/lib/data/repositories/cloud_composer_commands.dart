import 'dart:async';
import 'dart:convert';

import 'package:mobile/data/models/cloud_invocables.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';

/// The cloud composer's `/` suggestions (CAN-3921) and plugin selections
/// (CAN-3922): the chat and project invocable inventories and the capability
/// catalog, cached for the account session, and the chat capability writes.
///
/// A chat changes its capability selection through one write at a time. A
/// draft has no chat yet, so its owner saves the choice with the draft until
/// its first send creates the chat with it.
final class CloudComposerCommands {
  CloudComposerCommands(this._repository);

  final CloudChatRepository _repository;
  final Map<(String, String, String?, String), Future<CloudInvocableInventory>>
  _cache = {};
  final Map<String, Future<ComposerPluginCatalog>> _catalogs = {};
  final Map<String, Map<String, Object?>?> _draftDefaults = {};
  final Map<String, Map<String, Object?>> _chatSelections = {};
  // Refs a chat kept after a write that added them, but cannot use.
  final Map<String, List<Map<String, String>>> _heldBack = {};
  final Map<String, int> _chatRevisions = {};
  final Map<String, Future<void>> _writes = {};
  int _generation = 0;

  /// Host rows for an existing chat on [modelDefinitionId].
  Future<List<ComposerCommand>> chatCommands(
    String chatId, {
    String? modelDefinitionId,
  }) async => (await _cached(
    ('chat', chatId, modelDefinitionId, ''),
    () => _repository.listChatInvocables(
      chatId,
      modelDefinitionId: modelDefinitionId,
    ),
  )).rows;

  /// Host rows for a new chat in [workspaceId], with the draft's own
  /// [pluginSelections] when it has chosen some.
  Future<List<ComposerCommand>> draftCommands(
    String workspaceId, {
    String? modelDefinitionId,
    Map<String, Object?>? pluginSelections,
  }) async {
    final generation = _generation;
    final inventory = await _cached(
      (
        'workspace',
        workspaceId,
        modelDefinitionId,
        jsonEncode(pluginSelections),
      ),
      () => _repository.listWorkspaceInvocables(
        workspaceId,
        modelDefinitionId: modelDefinitionId,
        pluginSelections: pluginSelections,
      ),
    );
    if (generation == _generation) {
      _draftDefaults[workspaceId] = inventory.defaultPluginSelections;
    }
    return inventory.rows;
  }

  /// A draft's [selections] in [workspaceId] with [enableRef] added. A
  /// draft without its own selection starts from the project defaults.
  Map<String, Object?> draftSelectionsWith(
    String workspaceId,
    Map<String, Object?>? selections,
    Map<String, String> enableRef,
  ) => withCapabilityEnableRef(
    selections ?? _draftDefaults[workspaceId],
    enableRef,
  );

  /// Adds [enableRef] to the chat's effective selection and saves it.
  /// Completes with true only after the server accepts the write; writes for
  /// one chat run in order so neither drops the other's choice. Completes
  /// with false when [clear] ran after the request was queued: it is
  /// superseded, and writes nothing it has not already written.
  Future<bool> enableForChat(String chatId, Map<String, String> enableRef) =>
      _write(chatId, (generation) async {
        // The workspace summaries carry the effective selection; read it
        // when the write runs, after any earlier write for this chat.
        final current = await _readChatSelections(chatId, generation);
        if (current == null) return false;
        final result = await _save(
          chatId,
          withCapabilityEnableRef(current, enableRef),
          generation,
        );
        if (result == null) return false;
        if (!result.enables(enableRef)) {
          throw StateError('The chat did not enable the selected item.');
        }
        return true;
      });

  /// The chat's effective capability selection, read from the workspace
  /// summaries after any earlier write for the chat, so a complete write
  /// built from it keeps that write's choice. Throws when the server does not
  /// report it or [clear] ran after the request was queued.
  Future<Map<String, Object?>> chatSelections(String chatId) => _write(
    chatId,
    (generation) async =>
        await _readChatSelections(chatId, generation) ??
        (throw StateError('The account changed.')),
  );

  /// Saves [selections] as the chat's complete selection, after any earlier
  /// write for the chat. Completes with what the chat holds, and throws when
  /// the write fails, the server does not report the result, or it holds
  /// back a ref [selections] added. A ref an earlier write added and the
  /// chat held back counts as added again until a read reports the chat.
  Future<Map<String, Object?>> saveChatSelections(
    String chatId,
    Map<String, Object?> selections,
  ) => _write(chatId, (generation) async {
    final before = _chatSelections[chatId];
    final heldBack = _heldBack[chatId] ?? const [];
    final result = await _save(chatId, selections, generation);
    final accepted = result?.selections;
    if (result == null || accepted == null) {
      throw StateError('The chat selection is unknown.');
    }
    final rejected = <Map<String, String>>[];
    for (final kind in [
      ComposerPluginKind.skill,
      ComposerPluginKind.plugin,
      ComposerPluginKind.mcpServer,
    ]) {
      final refs = normalizePluginSelections(selections)[kind.selectionKey];
      if (refs is! List) continue;
      for (final ref in refs.whereType<Map>()) {
        final enableRef = ref.map((key, value) => MapEntry('$key', '$value'));
        final existing = before?[kind.selectionKey];
        final added =
            existing is! List ||
            !selectionRefsName(existing, enableRef) ||
            selectionRefsName(heldBack, enableRef);
        if (added && !result.enables(enableRef)) rejected.add(enableRef);
      }
    }
    _heldBack[chatId] = rejected;
    if (rejected.isNotEmpty) {
      throw StateError('The chat did not enable the selected item.');
    }
    return accepted;
  });

  /// The chat's selection as this session last read or saved it.
  Map<String, Object?>? knownChatSelections(String chatId) =>
      _chatSelections[chatId];

  /// Changes whenever a write changes the chat's inventory.
  int chatRevision(String chatId) => _chatRevisions[chatId] ?? 0;

  /// The capability catalog for chats in [workspaceId].
  Future<ComposerPluginCatalog> catalog(String workspaceId) {
    final cached = _catalogs[workspaceId];
    if (cached != null) return cached;
    final request = _repository.capabilityCatalog(workspaceId);
    _catalogs[workspaceId] = request;
    request.then<void>(
      (_) {},
      onError: (Object _) {
        if (identical(_catalogs[workspaceId], request)) {
          _catalogs.remove(workspaceId);
        }
      },
    );
    return request;
  }

  /// The project defaults a new chat in [workspaceId] inherits, loaded once
  /// so a draft's first change starts from them, never from an assumed
  /// empty selection.
  Future<Map<String, Object?>> draftDefaults(String workspaceId) async {
    if (_draftDefaults.containsKey(workspaceId)) {
      return _draftDefaults[workspaceId] ?? const {};
    }
    final generation = _generation;
    final inventory = await _cached((
      'workspace',
      workspaceId,
      null,
      jsonEncode(null),
    ), () => _repository.listWorkspaceInvocables(workspaceId));
    if (generation != _generation) throw StateError('The account changed.');
    _draftDefaults[workspaceId] = inventory.defaultPluginSelections;
    return inventory.defaultPluginSelections ?? const {};
  }

  /// The project defaults, when already loaded.
  Map<String, Object?>? knownDraftDefaults(String workspaceId) =>
      _draftDefaults.containsKey(workspaceId)
      ? _draftDefaults[workspaceId] ?? const {}
      : null;

  /// Runs [write] after the chat's earlier writes. A failed earlier write
  /// does not fail this one. [write] receives the account generation it was
  /// queued in.
  Future<T> _write<T>(String chatId, Future<T> Function(int generation) write) {
    final generation = _generation;
    final previous = _writes[chatId] ?? Future<void>.value();
    // Continue from a void tail. (`catchError` with a void handler cannot
    // recover a typed future.)
    final next = previous
        .then<void>((_) {}, onError: (Object _) {})
        .then((_) => write(generation));
    _writes[chatId] = next;
    return next;
  }

  /// The chat's effective selection, or null when [clear] ran since
  /// [generation]. Throws when the server does not report it.
  Future<Map<String, Object?>?> _readChatSelections(
    String chatId,
    int generation,
  ) async {
    if (generation != _generation) return null;
    final workspaces = await _repository.listWorkspaces();
    // A reset during the read: a newer request may already have written.
    if (generation != _generation) return null;
    final chat = workspaces
        .expand((workspace) => workspace.chats)
        .where((chat) => chat.externalId == chatId)
        .firstOrNull;
    final current = chat == null
        ? null
        : chat.capabilitySelections ??
              (chat.capabilityBundles == null
                  ? const <String, Object?>{}
                  : null);
    if (current == null) {
      throw StateError('The chat capability selection is unknown.');
    }
    _chatSelections[chatId] = current;
    _heldBack.remove(chatId);
    return current;
  }

  /// Saves [selections] unless [clear] ran since [generation], and forgets
  /// the chat's inventory, which the answer changes.
  Future<CloudCapabilityWriteResult?> _save(
    String chatId,
    Map<String, Object?> selections,
    int generation,
  ) async {
    if (generation != _generation) return null;
    final result = await _repository.setChatCapabilities(chatId, selections);
    if (generation != _generation) return null;
    // The answer is the chat's selection now, whether or not it took the
    // ref: the inventory reloads from it.
    _cache.removeWhere((key, _) => key.$1 == 'chat' && key.$2 == chatId);
    _chatRevisions[chatId] = chatRevision(chatId) + 1;
    if (result.selections case final accepted?) {
      _chatSelections[chatId] = accepted;
    }
    return result;
  }

  Future<CloudInvocableInventory> _cached(
    (String, String, String?, String) key,
    Future<CloudInvocableInventory> Function() fetch,
  ) {
    final cached = _cache[key];
    if (cached != null) return cached;
    final request = fetch();
    _cache[key] = request;
    request.then<void>(
      (_) {},
      onError: (Object _) {
        if (identical(_cache[key], request)) _cache.remove(key);
      },
    );
    return request;
  }

  /// Forgets everything; called when the account or organization changes.
  void clear() {
    _generation++;
    _cache.clear();
    _catalogs.clear();
    _draftDefaults.clear();
    _chatSelections.clear();
    _heldBack.clear();
    _writes.clear();
  }
}
