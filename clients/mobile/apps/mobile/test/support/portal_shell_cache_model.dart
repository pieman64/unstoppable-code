/// A reference model of the server's Portal entity cache for the shell
/// entities, used to compute what an overview read returns after a delta
/// sequence. It follows `apps/web/src/lib/portal/state-cache-service.ts` and
/// `state-projection.ts` independently of the mobile reducer:
///
///  * Rows are keyed `(entityType, parentLocalId, localId)`; a missing
///    envelope parent is stored as `''`.
///  * A delta deletes its `removed` rows first, then upserts its entities.
///    A removal matches `entityType` and `localId`, and also `parentLocalId`
///    only when that is a nonempty string. Nothing cascades.
///  * The overview read returns the workspace, worktree, standalone_chat and
///    chat_summary rows ordered by `entityType`, then `localId`. It never
///    carries `chat_project` rows. Rows that share a local id keep the
///    order they were first written in.
///  * The projection applies the server's id and parent fallbacks and its
///    worktree PR status validation. Like the server's `readString`, an
///    empty string counts as absent.
///
/// The overview read leaves `pr_status` rows out, but the client overlays
/// them on the worktree's own `lastKnownPrStatus` until a newer worktree row
/// replaces it. [observedOverviewSnapshot] is the read with that overlay.
library;

import 'package:mobile/data/models/remote_session.dart';

typedef _RowKey = (String entityType, String parentLocalId, String localId);

const _overviewTypes = [
  'chat_summary',
  'standalone_chat',
  'workspace',
  'worktree',
];

/// The entity types a delta may remove (`PortalEntityType`), limited to the
/// ones this model reads back.
const _knownTypes = {
  'chat_project',
  'chat_summary',
  'pr_status',
  'standalone_chat',
  'workspace',
  'worktree',
};

final class PortalShellCacheModel {
  final Map<_RowKey, Map<String, dynamic>> _rows = {};

  /// The cursor of the delta that last wrote each row; 0 for seeded rows.
  final Map<_RowKey, int> _writtenAt = {};

  /// The cursor of the last event this model applied.
  int cursor = 0;

  /// Writes the rows of an overview read the client started from.
  void seed(List<Map<String, dynamic>> entities) => _upsert(entities, 0);

  /// Applies one `portal.state.delta` payload with its server row [cursor].
  void applyDelta(Map<String, dynamic> payload, {required int cursor}) {
    this.cursor = cursor;
    final removed = payload['removed'];
    if (removed is List) {
      for (final row in removed.whereType<Map<String, dynamic>>()) {
        final type = row['entityType'];
        final localId = row['localId'];
        final parent = row['parentLocalId'];
        if (type is! String || !_knownTypes.contains(type)) continue;
        if (localId is! String || localId.isEmpty) continue;
        bool matches(_RowKey key) =>
            key.$1 == type &&
            key.$3 == localId &&
            (parent is! String || parent.isEmpty || key.$2 == parent);
        _rows.removeWhere((key, _) => matches(key));
        _writtenAt.removeWhere((key, _) => matches(key));
      }
    }
    final entities = payload['entities'];
    if (entities is List) {
      _upsert(entities.whereType<Map<String, dynamic>>().toList(), cursor);
    }
  }

  void _upsert(List<Map<String, dynamic>> entities, int cursor) {
    for (final entity in entities) {
      final type = entity['entityType'];
      final localId = entity['localId'];
      if (type is! String || !_knownTypes.contains(type)) continue;
      if (localId is! String || localId.isEmpty) continue;
      final parent = entity['parentLocalId'];
      final payload = entity['payload'];
      final key = (type, parent is String ? parent : '', localId);
      _rows[key] = payload is Map<String, dynamic> ? payload : const {};
      _writtenAt[key] = cursor;
    }
  }

  /// The `state` object of `GET .../state?scope=overview`. With
  /// [prObservations], worktrees carry the client's PR status overlay.
  Map<String, dynamic> overviewState({bool prObservations = false}) {
    final ordered = _rows.entries.indexed.toList()
      ..sort((left, right) {
        final a = left.$2.key;
        final b = right.$2.key;
        final byType = a.$1.compareTo(b.$1);
        if (byType != 0) return byType;
        final byId = a.$3.compareTo(b.$3);
        return byId != 0 ? byId : left.$1.compareTo(right.$1);
      });
    final state = <String, List<Map<String, dynamic>>>{
      'workspaces': [],
      'worktrees': [],
      'chatProjects': [],
      'standaloneChats': [],
      'chatSummaries': [],
    };
    for (final (_, MapEntry(:key, value: payload)) in ordered) {
      final (type, parent, localId) = key;
      if (!_overviewTypes.contains(type)) continue;
      switch (type) {
        case 'workspace':
          state['workspaces']!.add(_workspace(localId, payload));
        case 'worktree':
          final worktree = _worktree(localId, parent, payload);
          final observed = prObservations
              ? _prObservation(worktree, _writtenAt[key]!)
              : null;
          state['worktrees']!.add({
            ...worktree,
            'lastKnownPrStatus': ?observed ?? worktree['lastKnownPrStatus'],
          });
        case 'standalone_chat':
          state['standaloneChats']!.add(_standalone(localId, parent, payload));
        case 'chat_summary':
          state['chatSummaries']!.add({...payload, 'localId': localId});
      }
    }
    return state;
  }

  /// The stored rows of [types] as the entities of a pushed snapshot.
  List<Map<String, dynamic>> entities(Set<String> types) => [
    for (final MapEntry(:key, value: payload) in _rows.entries)
      if (types.contains(key.$1))
        {
          'entityType': key.$1,
          'localId': key.$3,
          if (key.$2.isNotEmpty) 'parentLocalId': key.$2,
          'payload': payload,
        },
  ];

  /// The overview read as the mobile repository returns it.
  RemoteSessionSnapshot overviewSnapshot() => RemoteSessionSnapshot.fromJson(
    overviewState(),
  ).copyWith(eventCursor: cursor);

  /// [overviewSnapshot] with the PR observations a live client holds.
  RemoteSessionSnapshot observedOverviewSnapshot() =>
      RemoteSessionSnapshot.fromJson(
        overviewState(prObservations: true),
      ).copyWith(eventCursor: cursor);

  /// The `pr_status` row for [worktree] as a `lastKnownPrStatus`, when it
  /// was written no earlier than the worktree row ([worktreeWrittenAt]).
  /// The client applies a delta's worktree rows before its PR statuses.
  Map<String, dynamic>? _prObservation(
    Map<String, dynamic> worktree,
    int worktreeWrittenAt,
  ) {
    for (final MapEntry(:key, value: payload) in _rows.entries) {
      if (key.$1 != 'pr_status' ||
          payload['workspaceLocalId'] != worktree['workspaceLocalId'] ||
          (payload['worktreeLocalId'] ?? key.$3) != worktree['localId'] ||
          _writtenAt[key]! < worktreeWrittenAt) {
        continue;
      }
      final repos = payload['repos'];
      if (repos is! List) continue;
      return {
        'repos': [
          for (final repo in repos.whereType<Map<String, dynamic>>())
            if (repo['status'] case final Map<String, dynamic> status)
              {
                'status': {
                  'prNumber': status['number'],
                  'state': status['state'],
                },
              },
        ],
      };
    }
    return null;
  }

  static Map<String, dynamic> _workspace(
    String localId,
    Map<String, dynamic> payload,
  ) => {
    'localId': localId,
    'name': _string(payload['name']) ?? localId,
    'type': ?_string(payload['type']),
    'layout': ?_string(payload['layout']),
    'order': ?_number(payload['order']),
    'hidden': ?_bool(payload['hidden']),
    'alwaysShow': ?_bool(payload['alwaysShow']),
    'temporary': ?_bool(payload['temporary']),
  };

  static Map<String, dynamic> _worktree(
    String localId,
    String parent,
    Map<String, dynamic> payload,
  ) => {
    'localId': localId,
    'workspaceLocalId':
        _string(payload['workspaceLocalId']) ??
        _nonEmpty(parent) ??
        _string(payload['projectId']) ??
        '',
    'branch': _string(payload['branch']) ?? _string(payload['name']) ?? '',
    'label': ?_string(payload['label']),
    'status': ?_string(payload['status']),
    'hidden': ?_bool(payload['hidden']),
    'order': ?_number(payload['order']),
    'isStreaming': ?_bool(payload['isStreaming']),
    'hasUnread': ?_bool(payload['hasUnread']),
    'awaitingApproval': ?_bool(payload['awaitingApproval']),
    'lastKnownPrStatus': ?_lastKnownPrStatus(payload['lastKnownPrStatus']),
  };

  /// The server's `readLastKnownPrStatus`: it drops a status without
  /// `lastCheckedAt`, a repo without `repoId` or `repoName`, and nulls a
  /// repo status without `prNumber` or `prUrl`. An unknown state reads as
  /// `open`. It keeps the fields the client reads, except `mergeQueue`.
  static Map<String, dynamic>? _lastKnownPrStatus(Object? raw) {
    if (raw is! Map<String, dynamic> || raw['repos'] is! List) return null;
    final lastCheckedAt = _nonEmpty(_string(raw['lastCheckedAt']));
    if (lastCheckedAt == null) return null;
    return {
      'repos': [
        for (final repo in (raw['repos'] as List).whereType<Map>())
          if ((
                _nonEmpty(_string(repo['repoId'])),
                _nonEmpty(_string(repo['repoName'])),
              )
              case (final repoId?, final repoName?))
            {
              'repoId': repoId,
              'repoName': repoName,
              'status': _prStatus(repo['status']),
            },
      ],
      'lastCheckedAt': lastCheckedAt,
    };
  }

  static Map<String, dynamic>? _prStatus(Object? raw) {
    if (raw is! Map) return null;
    final prNumber = _number(raw['prNumber']);
    final prUrl = _nonEmpty(_string(raw['prUrl']));
    if (prNumber == null || prUrl == null) return null;
    String known(Object? value, List<String> values, String fallback) =>
        values.contains(value) ? value! as String : fallback;
    return {
      'prNumber': prNumber,
      'prUrl': prUrl,
      'state': known(raw['state'], const ['merged', 'closed', 'draft'], 'open'),
      'title': _nonEmpty(_string(raw['title'])) ?? '',
      'checkStatus': known(raw['checkStatus'], const [
        'passing',
        'failing',
        'pending',
        'neutral',
      ], 'none'),
      'reviewStatus': known(raw['reviewStatus'], const [
        'approved',
        'changes_requested',
        'pending',
      ], 'none'),
      'hasConflicts': _bool(raw['hasConflicts']) ?? false,
      'commentCount': _number(raw['commentCount']) ?? 0,
      'unresolvedReviewThreadCount': ?_number(
        raw['unresolvedReviewThreadCount'],
      ),
    };
  }

  static Map<String, dynamic> _standalone(
    String localId,
    String parent,
    Map<String, dynamic> payload,
  ) => {
    'localId': localId,
    'projectLocalId':
        _nonEmpty(_string(payload['projectLocalId'])) ??
        _nonEmpty(parent) ??
        '',
    'title':
        _nonEmpty(_string(payload['title'])) ??
        _nonEmpty(_string(payload['name'])) ??
        localId,
    'workEntryId': ?_nonEmpty(_string(payload['workEntryId'])),
    'workEntryTitle': ?_nonEmpty(_string(payload['workEntryTitle'])),
    'description': ?_nonEmpty(_string(payload['description'])),
    'lastMessageAt': ?_nonEmpty(_string(payload['lastMessageAt'])),
    'archived': ?_bool(payload['archived']),
    'hasActiveChat': ?_bool(payload['hasActiveChat']),
    'hasUnread': ?_bool(payload['hasUnread']),
  };

  static String? _string(Object? value) => value is String ? value : null;

  static String? _nonEmpty(String? value) =>
      value == null || value.isEmpty ? null : value;

  static bool? _bool(Object? value) => value is bool ? value : null;

  static num? _number(Object? value) =>
      value is num && value.isFinite ? value : null;
}
