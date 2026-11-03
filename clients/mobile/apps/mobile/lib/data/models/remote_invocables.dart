/// Wire mapping for the Portal invocable inventory (CAN-3923):
/// `portal.editor.list_invocables` and `portal.editor.resolve_invocable`.
library;

import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/remote_chat.dart';

/// The command envelope target and the nested `PortalInvocableChatTarget`
/// for [chat], or null when [chat] is not an existing chat the inventory
/// can name: a worktree chat needs its id, a standalone chat its project.
({Map<String, String> envelope, Map<String, String> target})?
remoteInvocableTarget(RemoteChatTarget chat) => switch (chat) {
  RemoteWorktreeChatTarget(
    :final workspaceLocalId,
    :final worktreeLocalId,
    chatId: final chatId?,
  )
      when chatId.isNotEmpty =>
    (
      envelope: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      target: {
        'kind': 'worktree',
        'projectId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'chatId': chatId,
      },
    ),
  RemoteStandaloneChatTarget(:final chatId, projectLocalId: final project?)
      when chatId.isNotEmpty && project.isNotEmpty =>
    (
      envelope: {'standaloneChatLocalId': chatId},
      target: {
        'kind': 'standalone',
        'projectLocalId': project,
        'chatId': chatId,
      },
    ),
  _ => null,
};

/// A `list_invocables` answer: the [commands] in host order, and whether the
/// desktop served them from a [stale] or [rebuilding] inventory, so a later
/// answer can list other rows.
typedef RemoteInvocableList = ({
  List<ComposerCommand> commands,
  bool stale,
  bool rebuilding,
});

/// Parses a `list_invocables` result (`{commands: [...], stale, rebuilding}`),
/// keeping host order. Throws a [FormatException] when the answer is absent
/// or malformed, so the composer offers Retry instead of an empty or unusable
/// list.
RemoteInvocableList parseRemoteInvocables(Map<String, dynamic>? result) {
  final rows = result?['commands'];
  if (rows is! List) throw const FormatException('Missing invocables');
  bool flag(String key) => switch (result?[key]) {
    null => false,
    final bool value => value,
    _ => throw FormatException('Invalid invocables $key'),
  };
  return (
    commands: [for (final row in rows) _invocable(row)],
    stale: flag('stale'),
    rebuilding: flag('rebuilding'),
  );
}

ComposerCommand _invocable(Object? row) {
  if (row is! Map<String, dynamic>) {
    throw const FormatException('Invalid invocable row');
  }
  String? text(String key) {
    final value = row[key];
    if (value == null) return null;
    if (value is! String) throw FormatException('Invalid invocable $key');
    return value.isEmpty ? null : value;
  }

  final name = text('name');
  final available = switch (row['section']) {
    'discovered' => false,
    'available' => true,
    _ => throw const FormatException('Invalid invocable section'),
  };
  final requiresResolution = switch (row['requiresResolution']) {
    null => available,
    true => true,
    _ => throw const FormatException('Invalid invocable requiresResolution'),
  };
  String? identity(String key) {
    final value = row[key];
    if (!row.containsKey(key)) return null;
    if (value is! String || value.trim().isEmpty) {
      throw FormatException('Invalid invocable $key');
    }
    return value;
  }

  final entryId = text('entryId');
  if (name == null || (requiresResolution && entryId == null)) {
    throw const FormatException('Incomplete invocable row');
  }
  return ComposerCommand(
    name: name,
    description: text('description') ?? '',
    displayName: text('displayName'),
    insertText: text('insertText'),
    category: text('category'),
    pluginName: identity('pluginName'),
    memberName: identity('memberName'),
    entryId: entryId,
    requiresResolution: requiresResolution,
    availableToEnable: available,
  );
}

/// The authoritative text a `resolve_invocable` result inserts. Throws a
/// [FormatException] when the answer is absent or carries no text.
String parseRemoteInvocableInsertText(Map<String, dynamic>? result) =>
    switch (result?['insertText']) {
      final String text when text.isNotEmpty => text,
      _ => throw const FormatException('Missing invocable insert text'),
    };
