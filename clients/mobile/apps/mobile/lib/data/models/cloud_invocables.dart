/// Mirrors of the cloud slash-invocation inventory
/// (`apps/web/src/lib/capabilities/invocable-inventory-contract.ts`, contract
/// version 2) and the capability selections it enables into.
library;

import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/composer_plugins.dart';

/// The inventory contract version that carries marketplace enable refs.
const String kCloudInvocablesContractVersion = '2';

/// One validated inventory answer.
final class CloudInvocableInventory {
  const CloudInvocableInventory({
    required this.rows,
    this.defaultPluginSelections,
  });

  final List<ComposerCommand> rows;

  /// The project's default selections (workspace inventory only). A new
  /// chat inherits them unless the draft chooses its own.
  final Map<String, Object?>? defaultPluginSelections;

  /// Validates [json] once, at fetch time. Throws a [FormatException] for an
  /// answer that does not match the contract.
  factory CloudInvocableInventory.fromJson(
    Map<String, dynamic> json, {
    bool workspace = false,
  }) {
    final rows = json['rows'];
    if (rows is! List) throw const FormatException('Missing invocable rows');
    final defaults = json['defaultPluginSelections'];
    if (workspace && defaults != null && defaults is! Map<String, dynamic>) {
      throw const FormatException('Invalid default plugin selections');
    }
    return CloudInvocableInventory(
      rows: [for (final row in rows) _row(row)],
      defaultPluginSelections: workspace && defaults is Map<String, dynamic>
          ? defaults
          : null,
    );
  }
}

bool _nonEmpty(Object? value) => value is String && value.isNotEmpty;

/// An optional search identity: absent, or a non-blank string.
String? _identity(Map<String, dynamic> row, String key) => switch (row[key]) {
  null when !row.containsKey(key) => null,
  final String value when value.trim().isNotEmpty => value,
  _ => throw FormatException('Invalid invocable $key'),
};

ComposerCommand _row(Object? row) {
  if (row is! Map<String, dynamic> ||
      !_nonEmpty(row['name']) ||
      row['description'] is! String ||
      row['insertText'] is! String ||
      !(_nonEmpty(row['insertText']) || _nonEmpty(row['unavailableReason'])) ||
      (row['unavailableReason'] != null &&
          !_nonEmpty(row['unavailableReason']))) {
    throw const FormatException('Invalid invocable row');
  }
  final ref = row['enableRef'];
  final enableRef = switch (ref) {
    null => null,
    {'sourceId': final String sourceId, 'skillName': final String skillName}
        when sourceId.isNotEmpty && skillName.isNotEmpty =>
      {'sourceId': sourceId, 'skillName': skillName},
    {
      'marketplaceId': final String marketplaceId,
      'pluginName': final String pluginName,
    }
        when marketplaceId.isNotEmpty && pluginName.isNotEmpty =>
      {'marketplaceId': marketplaceId, 'pluginName': pluginName},
    _ => throw const FormatException('Invalid invocable enable ref'),
  };
  final insertText = row['insertText'] as String;
  return ComposerCommand(
    name: row['name'] as String,
    description: row['description'] as String,
    insertText: insertText,
    displayName: insertText.trim().isEmpty ? null : insertText.trim(),
    pluginName: _identity(row, 'pluginName'),
    memberName: _identity(row, 'memberName'),
    unavailableReason: row['unavailableReason'] as String?,
    enableRef: enableRef,
  );
}

/// Adds [enableRef] to [selections] (a `PortalChatTabPluginSelections`
/// object) and keeps every other choice. The legacy `bundleIds` alias is
/// folded into `collectionIds`. Throws a [FormatException] when
/// [selections] is malformed, so a write never drops choices it cannot read.
Map<String, Object?> withCapabilityEnableRef(
  Map<String, Object?>? selections,
  Map<String, String> enableRef,
) => withPluginSelection(
  selections,
  ComposerPluginItem(
    kind: enableRef.containsKey('sourceId')
        ? ComposerPluginKind.skill
        : ComposerPluginKind.plugin,
    ref: enableRef,
    name: '',
  ),
  on: true,
);

/// `CAPABILITY_UNAVAILABLE_REASONS` in `packages/protocol/src/capability-bundle`.
/// A record with any other reason reads as `degraded`.
const Set<String> _knownUnavailableReasons = {
  'deleted',
  'no_access',
  'removed_from_catalog',
  'catalog_disabled',
  'marketplace_sync_failed',
  'awaiting_rematerialization',
  'not_connected',
  'needs_reconnect',
  'turned_off',
  'connections_unavailable',
  'desktop_only',
  'invalid_skill',
  'invalid_ref',
  'limit_exceeded',
  'files_unavailable',
  'partial',
};

/// Dispositions that keep a selected capability out of the chat; only
/// `degraded` still carries it.
const Set<String> _unusableDispositions = {
  'gone',
  'unavailable',
  'unsupported',
};

/// The answer to `PUT /api/cloud/chats/{chatId}/capabilities`: what the chat
/// holds after the write. The server can answer 200 and still leave a ref
/// out, when it prunes a capability that is gone or the bundle cannot carry
/// it.
final class CloudCapabilityWriteResult {
  const CloudCapabilityWriteResult({
    required this.selections,
    this.unusableRefs = const [],
  });

  /// The chat's resulting effective selection (`capabilitySelections`);
  /// null when the answer names none.
  final Map<String, Object?>? selections;

  /// Refs of `capabilityUnavailable` records whose disposition is not
  /// `degraded`: selected, but the resulting bundle cannot use them.
  final List<Map<String, Object?>> unusableRefs;

  factory CloudCapabilityWriteResult.fromJson(Map<String, dynamic> json) {
    final selections = json['capabilitySelections'];
    final unavailable = json['capabilityUnavailable'];
    // The route answers a chat left with nothing selected and no bundle as
    // unchanged with no bundle and no selection: the selection is empty.
    final bundles = json['capabilityBundles'];
    final unchangedEmpty =
        !json.containsKey('capabilitySelections') &&
        json['outcome'] == 'unchanged' &&
        bundles is Map &&
        bundles.isEmpty;
    return CloudCapabilityWriteResult(
      selections: selections is Map<String, dynamic>
          ? selections
          : unchangedEmpty
          ? const <String, Object?>{}
          : null,
      unusableRefs: [
        if (unavailable is List)
          for (final record in unavailable)
            if (record
                case {
                  'ref': final Map<String, dynamic> ref,
                  'reason': final String reason,
                  'disposition': final String disposition,
                }
                when _knownUnavailableReasons.contains(reason) &&
                    _unusableDispositions.contains(disposition))
              ref,
      ],
    );
  }

  /// Whether the chat now carries [enableRef]: the resulting selection names
  /// it and no unavailability record holds it back. A pruned ref is absent
  /// from the selection.
  bool enables(Map<String, String> enableRef) {
    final key = enableRef.containsKey('sourceId')
        ? 'skillRefs'
        : enableRef.containsKey('serverId')
        ? 'mcpServerRefs'
        : 'pluginRefs';
    final refs = selections?[key];
    return refs is List &&
        selectionRefsName(refs, enableRef) &&
        !selectionRefsName(unusableRefs, enableRef);
  }
}
