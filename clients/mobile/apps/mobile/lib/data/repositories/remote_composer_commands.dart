import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_invocables.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

/// Submits one targeted Portal command on the paired session and returns the
/// server's answer, throwing a [RemoteControlException] when it is rejected.
typedef RemotePortalCommandSubmit =
    Future<RemotePortalCommandResult> Function({
      required String type,
      required Map<String, String> target,
      required Map<String, dynamic> payload,
    });

/// The composer inventories the paired desktop offers a worktree: its
/// discovered slash commands (`portal.editor.list_slash_commands`) and its
/// plugin catalog (`portal.chat.list_plugin_catalog`). Both are small RPCs
/// the server waits on.
///
/// Answers are cached for the paired session, per worktree and provider, so
/// reopening a chat does not ask the desktop again. A failed request is not
/// cached, so Retry asks again.
///
/// A desktop that announces `invocable_inventory` (CAN-3923) also lists the
/// rows of one worktree or standalone chat, including "Available to
/// enable", and resolves a row before its text is inserted. Those answers
/// follow the chat's selection, so they are not cached. Whether a chat's
/// last answer came from a stale or rebuilding inventory is kept, so the
/// composer lists the chat again as its menu next opens.
final class RemoteComposerCommands {
  RemoteComposerCommands({
    required this._sessionId,
    required this._submit,
    required this._supportsInvocableInventory,
  });

  final String? Function() _sessionId;
  final RemotePortalCommandSubmit _submit;
  final bool Function() _supportsInvocableInventory;
  final Map<(String?, String, String, String?), Future<List<ComposerCommand>>>
  _cache = {};
  final Map<(String?, String, String?, String?), Future<ComposerPluginCatalog>>
  _catalogs = {};
  final Set<String> _unsettled = {};

  /// Whether the paired desktop serves the chat inventory commands.
  bool get supportsInvocableInventory => _supportsInvocableInventory();

  /// The paired session the answers belong to.
  String? get sessionId => _sessionId();

  /// The rows the desktop composer offers [chat]
  /// (`portal.editor.list_invocables`), in desktop menu order. The desktop
  /// lists the chat's own harness and rejects any other provider, so none
  /// is sent: a model's provider, such as Ollama, is not a harness.
  Future<RemoteInvocableList> invocables(RemoteChatTarget chat) async {
    final list = parseRemoteInvocables(
      await _invocableCommand('portal.editor.list_invocables', chat),
    );
    final key = _invocableKey(chat);
    if (list.stale || list.rebuilding) {
      _unsettled.add(key);
    } else {
      _unsettled.remove(key);
    }
    return list;
  }

  /// Whether the last [invocables] answer for [chat] came from a stale or
  /// rebuilding inventory.
  bool invocablesUnsettled(RemoteChatTarget chat) =>
      _unsettled.contains(_invocableKey(chat));

  String _invocableKey(RemoteChatTarget chat) =>
      remoteInvocableTarget(chat)?.target.values.join('\n') ?? '';

  /// Enables [entryId] for [chat] and returns the text the desktop says to
  /// insert (`portal.editor.resolve_invocable`).
  Future<String> resolveInvocable(
    RemoteChatTarget chat,
    String entryId,
  ) async => parseRemoteInvocableInsertText(
    await _invocableCommand(
      'portal.editor.resolve_invocable',
      chat,
      extra: {'entryId': entryId},
    ),
  );

  Future<List<ComposerCommand>> list({
    required String workspaceLocalId,
    required String worktreeLocalId,
    String? providerType,
  }) => _cached(_cache, (
    _sessionId(),
    workspaceLocalId,
    worktreeLocalId,
    providerType,
  ), () => _fetch(workspaceLocalId, worktreeLocalId, providerType));

  /// The plugins, skills, collections, and MCP servers the desktop can
  /// offer the worktree's chats.
  Future<ComposerPluginCatalog> pluginCatalog({
    required String workspaceLocalId,
    required String worktreeLocalId,
    String? providerType,
  }) => _cached(
    _catalogs,
    (_sessionId(), workspaceLocalId, worktreeLocalId, providerType),
    () => _catalog(
      target: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      payload: {
        'projectId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'providerType': ?providerType,
      },
    ),
  );

  /// The same catalog for a standalone chat in [projectLocalId].
  Future<ComposerPluginCatalog> standalonePluginCatalog({
    required String projectLocalId,
    required String chatId,
    String? providerType,
  }) => _cached(
    _catalogs,
    (_sessionId(), projectLocalId, null, providerType),
    () => _catalog(
      target: {'standaloneChatLocalId': chatId},
      payload: {'projectId': projectLocalId, 'providerType': ?providerType},
    ),
  );

  Future<ComposerPluginCatalog> _catalog({
    required Map<String, String> target,
    required Map<String, dynamic> payload,
  }) async => ComposerPluginCatalog.fromJson(
    await _answer('portal.chat.list_plugin_catalog', target, payload),
  );

  Future<Map<String, dynamic>?> _invocableCommand(
    String type,
    RemoteChatTarget chat, {
    Map<String, dynamic> extra = const {},
  }) {
    final wire = remoteInvocableTarget(chat);
    if (wire == null) {
      throw const RemoteControlException('The chat is still loading.');
    }
    return _answer(type, wire.envelope, {'target': wire.target, ...extra});
  }

  /// Submits one waited command and returns its result, throwing when the
  /// desktop rejected it.
  Future<Map<String, dynamic>?> _answer(
    String type,
    Map<String, String> target,
    Map<String, dynamic> payload,
  ) async {
    final response = await _submit(
      type: type,
      target: target,
      payload: payload,
    );
    if (response.error case final error? when error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    return response.result;
  }

  Future<T> _cached<K, T>(
    Map<K, Future<T>> cache,
    K key,
    Future<T> Function() fetch,
  ) {
    final cached = cache[key];
    if (cached != null) return cached;
    final request = fetch();
    cache[key] = request;
    request.then<void>(
      (_) {},
      onError: (Object _) {
        if (identical(cache[key], request)) cache.remove(key);
      },
    );
    return request;
  }

  // An older desktop that does not answer in time leaves no result.
  Future<List<ComposerCommand>> _fetch(
    String workspaceLocalId,
    String worktreeLocalId,
    String? providerType,
  ) async => parseRemoteSlashCommands(
    await _answer(
      'portal.editor.list_slash_commands',
      {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      {
        'projectId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'providerType': ?providerType,
      },
    ),
  );
}

/// Parses a `list_slash_commands` result (`{commands: [...]}`). Throws a
/// [FormatException] when the answer is absent or malformed, so the composer
/// offers Retry instead of showing an empty list.
List<ComposerCommand> parseRemoteSlashCommands(Map<String, dynamic>? result) {
  final rows = result?['commands'];
  if (rows is! List) {
    throw const FormatException('Missing slash commands');
  }
  String? optional(Map<String, dynamic> row, String key) {
    final value = row[key];
    if (value == null) return null;
    if (value is! String) throw FormatException('Invalid slash command $key');
    return value.isEmpty ? null : value;
  }

  return [
    for (final row in rows)
      if (row is Map<String, dynamic> &&
          row['name'] is String &&
          (row['name'] as String).isNotEmpty)
        ComposerCommand(
          name: row['name'] as String,
          description: optional(row, 'description') ?? '',
          displayName: optional(row, 'displayName'),
          insertText: optional(row, 'insertText'),
          category: optional(row, 'category'),
        )
      else
        throw const FormatException('Invalid slash command row'),
  ];
}
