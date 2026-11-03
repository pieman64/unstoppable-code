/// Shell rows a Portal state event carries beyond workspaces, worktrees,
/// chat tabs and PR statuses: standalone chat upserts, entity removals, and
/// background process and watcher upserts and removals
/// (`PortalStateDeltaPayload.entities` / `removed`).
///
/// Parsing follows the server cache and overview projector
/// (`apps/web/src/lib/portal/state-cache-service.ts`, `state-projection.ts`),
/// so a client that reduces these rows itself ends where an overview read
/// would put it. `chat_project` rows are left out: the overview read never
/// carries them.
library;

import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_watcher.dart';

/// The shell entity types a removal can name.
enum RemoteShellEntityType {
  workspace('workspace'),
  worktree('worktree'),
  standaloneChat('standalone_chat'),
  chatSummary('chat_summary'),
  prStatus('pr_status'),
  backgroundProcess('background_process'),
  watcher('watcher');

  const RemoteShellEntityType(this.wire);

  final String wire;

  static RemoteShellEntityType? fromWire(Object? wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// One `removed` row. The server deletes every cached row of [type] with
/// [localId], and also [parentLocalId] when that is given; nothing cascades.
final class RemoteShellRemoval {
  const RemoteShellRemoval({
    required this.type,
    required this.localId,
    this.parentLocalId,
  });

  final RemoteShellEntityType type;
  final String localId;

  /// The envelope parent: the workspace of a worktree, the project of a
  /// standalone chat, `'<workspace>:<worktree>'` (or a legacy bare worktree
  /// id) for chat tabs and PR statuses. Null matches every parent.
  final String? parentLocalId;
}

/// The removals and upserts of one state event. A delta applies its
/// removals before its upserts, as the server does.
final class RemoteShellDelta {
  const RemoteShellDelta({
    this.removals = const [],
    this.standaloneChats = const [],
    this.backgroundProcessRemovals = const [],
    this.backgroundProcesses = const [],
    this.watcherRemovals = const [],
    this.watchers = const [],
  });

  factory RemoteShellDelta.fromPayload(Map<String, dynamic> payload) {
    final removals = _parseRemovals(payload['removed']);
    bool isBackgroundProcess(RemoteShellRemoval removal) =>
        removal.type == RemoteShellEntityType.backgroundProcess;
    return RemoteShellDelta(
      removals: [
        for (final removal in removals)
          if (!isBackgroundProcess(removal) &&
              removal.type != RemoteShellEntityType.watcher)
            removal,
      ],
      standaloneChats:
          parseStandaloneChatEntities(payload['entities']) ?? const [],
      backgroundProcessRemovals: [
        for (final removal in removals)
          if (isBackgroundProcess(removal)) removal,
      ],
      backgroundProcesses: _parseBackgroundProcesses(payload['entities']),
      watcherRemovals: [
        for (final row in removals)
          if (row.type == RemoteShellEntityType.watcher) row,
      ],
      watchers: [
        if (payload['entities'] case final List<Object?> entities)
          for (final row in entities.whereType<Map<String, dynamic>>())
            if (row case {
              'entityType': 'watcher',
              'payload': final Map<String, dynamic> body,
            })
              ?RemoteWatcher.fromJson(body, localId: _nonEmpty(row['localId'])),
      ],
    );
  }

  /// Removals of snapshot rows: never a background process or watcher.
  final List<RemoteShellRemoval> removals;
  final List<RemoteStandaloneChat> standaloneChats;

  /// Background processes live in the worktree activity slices, not the
  /// snapshot, so they are kept apart from [removals].
  final List<RemoteShellRemoval> backgroundProcessRemovals;
  final List<RemoteBackgroundProcess> backgroundProcesses;
  final List<RemoteShellRemoval> watcherRemovals;
  final List<RemoteWatcher> watchers;

  bool get changesWatchers => watcherRemovals.isNotEmpty || watchers.isNotEmpty;

  /// Whether the delta changes snapshot rows. Background processes and
  /// watchers do not count: an overview read never carries them.
  bool get isEmpty => removals.isEmpty && standaloneChats.isEmpty;

  bool get changesBackgroundProcesses =>
      backgroundProcessRemovals.isNotEmpty || backgroundProcesses.isNotEmpty;
}

/// The `background_process` rows of an entity list. The envelope id wins
/// over the payload's, as on the server.
List<RemoteBackgroundProcess> _parseBackgroundProcesses(Object? rawEntities) =>
    [
      if (rawEntities is List)
        for (final row in rawEntities.whereType<Map<String, dynamic>>())
          if (row case {
            'entityType': 'background_process',
            'payload': final Map<String, dynamic> payload,
          })
            ?RemoteBackgroundProcess.fromJson(
              payload,
              localId: _nonEmpty(row['localId']),
            ),
    ];

/// The `standalone_chat` rows of an entity list, projected with the
/// server's fallbacks: the project falls back to the envelope parent, and
/// the title to `name`, then to the local id. Like the server, an empty
/// string counts as absent. Null when [rawEntities] is not a list.
List<RemoteStandaloneChat>? parseStandaloneChatEntities(Object? rawEntities) {
  if (rawEntities is! List) return null;
  return [
    for (final row in rawEntities.whereType<Map<String, dynamic>>())
      if (row case {
        'entityType': 'standalone_chat',
        'payload': final Map<String, dynamic> payload,
      })
        if (_nonEmpty(row['localId']) case final localId?)
          RemoteStandaloneChat.fromJson({
            ...payload,
            'localId': localId,
            'projectLocalId':
                _nonEmpty(payload['projectLocalId']) ??
                _nonEmpty(row['parentLocalId']) ??
                '',
            'title':
                _nonEmpty(payload['title']) ??
                _nonEmpty(payload['name']) ??
                localId,
          }),
  ];
}

List<RemoteShellRemoval> _parseRemovals(Object? raw) => [
  if (raw is List)
    for (final row in raw.whereType<Map<String, dynamic>>())
      if (RemoteShellEntityType.fromWire(row['entityType']) case final type?)
        if (_nonEmpty(row['localId']) case final localId?)
          RemoteShellRemoval(
            type: type,
            localId: localId,
            parentLocalId: _nonEmpty(row['parentLocalId']),
          ),
];

String? _nonEmpty(Object? value) =>
    value is String && value.isNotEmpty ? value : null;
