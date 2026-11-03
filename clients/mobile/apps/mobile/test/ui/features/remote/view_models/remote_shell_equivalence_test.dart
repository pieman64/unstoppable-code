// CAN-4874: shell deltas the client reduces locally must leave the session
// store where an overview read after them would. Each prefix of a recorded
// synthetic sequence, and of fixed seeded sequences, is compared with a
// fresh store built from the reference server cache's overview read, and
// with the same local store after it applies that read and then a replay of
// the recent events the read already covers, including the stale snapshots
// pushed before them. Reads carry no PR progress, so both stores must also
// show the progress the stream ordered.
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/features/home/view_models/recent_chats.dart';
import 'package:mobile/ui/features/remote/view_models/pr_state_tracker.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/remote_overview_sections.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_store.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/remote_store_harness.dart';
import '../../../../support/portal_shell_cache_model.dart';

void main() {
  test('the recorded delta sequence matches an overview read after every '
      'prefix', () {
    final fixture =
        jsonDecode(
              File(
                'test/fixtures/remote_shell_delta_sequence.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;
    final initial = fixture['initial'] as Map<String, dynamic>;
    final run = _EquivalenceRun(
      seed: (initial['entities'] as List).cast<Map<String, dynamic>>(),
      cursor: initial['cursor'] as int,
    );
    for (final batch
        in (fixture['batches'] as List).cast<Map<String, dynamic>>()) {
      final name = batch['name'] as String;
      run.apply(
        (batch['events'] as List).cast<Map<String, dynamic>>(),
        nextCursor: batch['nextCursor'] as int,
      );
      // The reference model agrees with the hand-written server result.
      expect(
        _summaryOf(_storeFrom(run.cache.overviewSnapshot())),
        batch['expected'],
        reason: 'reference read after "$name"',
      );
      run.expectEquivalent(name);
    }
  });

  for (final seed in const [4874, 3150, 6265]) {
    test('seeded delta sequence $seed matches an overview read after every '
        'prefix', () {
      final random = Random(seed);
      // Progress feeds draw from their own stream, so the shell sequences
      // of earlier seeded failures stay the same.
      final generator = _DeltaGenerator(random, Random(seed + 1));
      final run = _EquivalenceRun(
        seed: generator.initialEntities(),
        cursor: 100,
      );
      var cursor = 100;
      for (var step = 0; step < 120; step++) {
        final events = [
          for (var i = 0; i < 1 + random.nextInt(3); i++)
            {
              'type': 'portal.state.delta',
              'eventId': 'ev-${cursor += 1 + random.nextInt(9)}',
              'cursor': cursor,
              'payload': generator.nextPayload(),
            },
        ];
        run.apply(events, nextCursor: cursor);
        run.expectEquivalent('seed $seed, step $step: ${jsonEncode(events)}');
      }
    });
  }
}

/// One local store fed the deltas, one that also applies the overview read
/// after each batch, and the reference cache both are compared with. After
/// each read the second store also replays the latest batches, as the event
/// stream does after a long background: the read covers all of them. Each
/// replayed batch starts with the snapshots the server held before it.
final class _EquivalenceRun {
  _EquivalenceRun({
    required List<Map<String, dynamic>> seed,
    required int cursor,
  }) {
    cache
      ..seed(seed)
      ..cursor = cursor;
    local.applySnapshot(cache.overviewSnapshot());
    reconciled.applySnapshot(cache.overviewSnapshot());
  }

  final cache = PortalShellCacheModel();
  final progress = _ProgressModel();
  final reconciledProgress = _ProgressModel();
  final local = _store();
  final reconciled = _store();
  final localPrs = _tracker();
  final reconciledPrs = _tracker();
  final overviewRequests = <RemoteOverviewRefreshRequest>[];
  final _batches = <(RemotePortalEventBatch, List<Map<String, dynamic>>)>[];

  void apply(List<Map<String, dynamic>> events, {required int nextCursor}) {
    final payloads = [
      for (final event in events) event['payload'] as Map<String, dynamic>,
    ];
    final stale = _staleSnapshots();
    for (final (index, event) in events.indexed) {
      final held = cache.overviewSnapshot().worktrees;
      progress.apply(payloads[index], held);
      reconciledProgress.apply(payloads[index], held);
      cache.applyDelta(payloads[index], cursor: event['cursor'] as int);
    }
    final batch = RemotePortalEventBatch.fromJson({
      'events': events,
      'nextCursor': nextCursor,
    });
    _batches.add((
      RemotePortalEventBatch.fromJson({
        'events': [...stale, ...events],
        'nextCursor': nextCursor,
      }),
      payloads,
    ));
    _applyBatch(local, localPrs, batch);
    _applyBatch(reconciled, reconciledPrs, batch);
    final read = cache.overviewSnapshot();
    reconciled.applySnapshot(read);
    for (final (covered, payloads) in _batches.skip(
      max(0, _batches.length - 3),
    )) {
      _applyBatch(reconciled, reconciledPrs, covered);
      // The replay matches parentless removals against the read's rows.
      for (final payload in payloads) {
        reconciledProgress.apply(payload, read.worktrees);
      }
    }
  }

  void _applyBatch(
    RemoteSessionStore store,
    PrStateTracker prs,
    RemotePortalEventBatch batch,
  ) {
    store.beginEventBatch(batch.nextCursor);
    for (final event in batch.events) {
      final effects = switch (event) {
        RemoteStateDeltaEvent() => store.applyDelta(event),
        RemoteStateSnapshotEvent() => store.applySnapshotEvent(event),
        _ => null,
      };
      if (effects == null) continue;
      overviewRequests.addAll([?effects.overviewRefresh]);
      prs.applyPrProgress(effects.prProgress);
    }
    store.endEventBatch();
  }

  /// An overview head and a tab index of the cache before the next batch,
  /// at the cursor of the last event the cache applied.
  List<Map<String, dynamic>> _staleSnapshots() => [
    for (final (scope, types) in const [
      ('overview', {'standalone_chat', 'workspace', 'worktree'}),
      ('worktree', {'chat_summary'}),
    ])
      {
        'type': 'portal.state.snapshot',
        'eventId': 'stale-$scope-${cache.cursor}',
        'cursor': cache.cursor,
        'payload': {'scope': scope, 'entities': cache.entities(types)},
      },
  ];

  void expectEquivalent(String reason) {
    final read = _shellView(_storeFrom(cache.overviewSnapshot()));
    // The live store also holds the PR observations the read leaves out.
    final observed = _shellView(_storeFrom(cache.observedOverviewSnapshot()));
    expect(_shellView(local), observed, reason: 'local after $reason');
    expect(
      _shellView(reconciled),
      read,
      reason: 'local + read + covered replay after $reason',
    );
    expect(
      _progressView(localPrs),
      progress.view,
      reason: 'local PR progress after $reason',
    );
    expect(
      _progressView(reconciledPrs),
      reconciledProgress.view,
      reason: 'local + read + covered replay PR progress after $reason',
    );
    expect(overviewRequests, isEmpty, reason: 'overview reads after $reason');
  }
}

/// The PR progress the stream leaves, as the client applies it: a delta
/// removes rows first, keeps the last feeds per worktree, and a parentless
/// `pr_status` removal clears the worktrees the store holds at that point.
/// Reads carry no progress, so a covered replay applies again in order.
final class _ProgressModel {
  final Map<String, String> view = {};

  void apply(Map<String, dynamic> payload, List<RemoteWorktree> worktrees) {
    final held = {for (final row in worktrees) remoteWorktreeKeyOf(row)};
    for (final row
        in (payload['removed'] as List? ?? const [])
            .cast<Map<String, dynamic>>()) {
      final localId = row['localId'] as String;
      final parent = row['parentLocalId'] as String?;
      switch (row['entityType']) {
        case 'worktree':
          held.removeWhere(
            (key) =>
                key.worktreeLocalId == localId &&
                (parent == null || key.workspaceLocalId == parent),
          );
        case 'pr_status' when parent == null:
          for (final key in held) {
            if (key.worktreeLocalId == localId) {
              view.remove('${key.workspaceLocalId}:$localId');
            }
          }
        case 'pr_status' when parent!.endsWith(':$localId'):
          view.remove(parent);
      }
    }
    final feeds = {
      for (final row
          in (payload['entities'] as List? ?? const [])
              .cast<Map<String, dynamic>>())
        if (row['entityType'] == 'pr_status')
          if (row['payload'] as Map<String, dynamic> case final data
              when data.containsKey('creationProgress') ||
                  data.containsKey('mergeProgress'))
            '${data['workspaceLocalId']}:${data['worktreeLocalId']}': data,
    };
    for (final MapEntry(:key, value: data) in feeds.entries) {
      final [creation, merge] = (view[key] ?? 'null|null').split('|');
      String phase(String feed, String current) => data.containsKey(feed)
          ? '${(data[feed] as Map<String, dynamic>?)?['currentPhase']}'
          : current;
      final next =
          '${phase('creationProgress', creation)}|'
          '${phase('mergeProgress', merge)}';
      if (next == 'null|null') {
        view.remove(key);
      } else {
        view[key] = next;
      }
    }
  }
}

PrStateTracker _tracker() {
  final repository = FakeRemoteControlRepository();
  addTearDown(repository.eventsController.close);
  final tracker = PrStateTracker(
    repository: repository,
    store: RemoteStoresHarness().session,
    notify: () {},
    isConnected: () => true,
    sessionGeneration: () => 0,
    submit: (action) => action(),
    awaitCommandResult: (RemotePortalCommandResult response) =>
        Future.value(response.result!),
  );
  addTearDown(tracker.dispose);
  return tracker;
}

/// Each worktree's live PR progress as `'<creation>|<merge>'` phases.
Map<String, String> _progressView(PrStateTracker prs) => {
  for (final workspace in _DeltaGenerator._workspaces)
    for (final worktree in _DeltaGenerator._worktrees)
      if (prs.prProgressFor(workspace, worktree) case final state?)
        '$workspace:$worktree':
            '${state.creation?.currentPhase.wireValue}|'
            '${state.merge?.currentPhase.wireValue}',
};

/// Chats this device has read; the overlay must match on both paths.
const _locallyRead = {'sc-1', 'chat-1'};

RemoteSessionStore _store() => RemoteSessionStore(
  orderWorktrees: orderedRemoteWorktrees,
  knownChatKeys: () => const [],
  isLocallyRead: (_, chatId) => _locallyRead.contains(chatId),
  hasLocalReads: () => true,
);

RemoteSessionStore _storeFrom(RemoteSessionSnapshot snapshot) =>
    _store()..applySnapshot(snapshot);

/// The fixture's compact expectation of a store.
Map<String, Object?> _summaryOf(RemoteSessionStore store) => {
  'workspaces': [
    for (final workspace in store.workspaces)
      '${workspace.localId}:${workspace.name}',
  ],
  'worktrees': [
    for (final worktree in store.allWorktrees)
      '${worktree.workspaceLocalId}/${worktree.localId}'
          '${_prsOf(worktree).map((pr) => ' #$pr').join()}',
  ]..sort(),
  'standaloneChats': [
    for (final chat in store.allStandaloneChats)
      '${chat.projectLocalId}/${chat.localId}:${chat.title}'
          '@${chat.lastMessageAt}',
  ],
  'chatSummaries': [
    for (final summary in store.allChatSummaries) summary.chatId,
  ]..sort(),
};

List<String> _prsOf(RemoteWorktree worktree) => [
  for (final pr in worktree.prStatuses) '${pr.prNumber}:${pr.state}',
];

/// What the sidebar, Recents and Needs attention read from the store.
Map<String, Object?> _shellView(RemoteSessionStore store) {
  final workspaces = store.workspaces;
  List<Object?> chat(RemoteStandaloneChat chat) => [
    chat.projectLocalId,
    chat.localId,
    chat.displayTitle,
    if (chat.workEntryId case final id? when id.isNotEmpty) id,
    chat.lastMessageAt,
    chat.archived == true,
    chat.hasActiveChat == true,
    chat.hasUnread == true,
  ];
  final visible = visibleRemoteWorkspaces(
    workspaces: workspaces,
    worktreesFor: store.worktreesFor,
  );
  return {
    'workspaces': [
      for (final workspace in workspaces)
        [
          workspace.localId,
          workspace.name,
          workspace.order,
          workspace.hidden,
          workspace.alwaysShow,
          workspace.resolvedLayout.name,
        ],
    ],
    'worktrees': [
      for (final worktree in store.allWorktrees)
        [
          worktree.workspaceLocalId,
          worktree.localId,
          worktree.branch,
          worktree.label,
          worktree.hidden == true,
          worktree.isStreaming == true,
          worktree.hasUnread == true,
          _prsOf(worktree),
        ],
    ],
    'standalone chats': [for (final row in store.allStandaloneChats) chat(row)],
    'sidebar standalone chats': {
      for (final workspace in workspaces)
        workspace.localId: [
          for (final row in store.standaloneChatsFor(workspace.localId))
            chat(row),
        ],
    },
    'unmatched standalone chats': [
      for (final row in store.unmatchedStandaloneChats) chat(row),
    ],
    'chat tabs': [
      for (final summary in store.allChatSummaries)
        [
          summary.scope?.name,
          summary.workspaceLocalId,
          summary.worktreeLocalId,
          summary.chatId,
          summary.title,
          summary.hasUnread == true,
        ],
    ]..sort((a, b) => a.join('/').compareTo(b.join('/'))),
    'recents': [
      for (final entry in buildRecentChats(
        cloudWorkspaces: const [],
        remoteWorkspaces: workspaces,
        remoteWorktrees: store.allWorktrees,
        remoteStandaloneChats: store.allStandaloneChats,
        remoteChatSummaries: store.allChatSummaries,
      ))
        [entry.key, entry.title, entry.attention.name, entry.activityAt],
    ],
    'needs attention': [
      for (final entry in computeAttentionSections(
        workspaces: visible,
        worktreesFor: store.worktreesFor,
      ).attentionEntries)
        '${entry.workspaceName}/${entry.worktree.localId}',
    ],
  };
}

/// Random but valid shell deltas over a small id space, so removals,
/// re-adds, shared local ids under different parents and no-op removals
/// recur often.
final class _DeltaGenerator {
  _DeltaGenerator(this._random, this._progress);

  final Random _random;
  final Random _progress;
  var _revision = 0;

  static const _workspaces = ['ws-1', 'ws-2', 'ws-cowork'];
  static const _projects = ['ws-cowork', 'ws-2', 'ws-other'];
  static const _standalone = ['sc-1', 'sc-2', 'sc-3'];
  static const _worktrees = ['wt-1', 'wt-2'];
  static const _chats = {
    'chat-1': ('ws-1', 'wt-1'),
    'chat-2': ('ws-1', 'wt-1'),
    'chat-3': ('ws-2', 'wt-2'),
  };

  T _pick<T>(List<T> values) => values[_random.nextInt(values.length)];

  String? _maybe(String value) => _random.nextBool() ? value : null;

  List<Map<String, dynamic>> initialEntities() => [
    for (final workspace in _workspaces) _workspace(workspace),
    _worktree('ws-1', 'wt-1'),
    _worktree('ws-2', 'wt-2'),
    for (final project in _projects) _chat(project, 'sc-1'),
    for (final MapEntry(:key, :value) in _chats.entries)
      _summary(key, value.$1, value.$2),
  ];

  Map<String, dynamic> nextPayload() {
    final removed = <Map<String, dynamic>>[];
    final entities = <Map<String, dynamic>>[];
    for (var i = 0; i < 1 + _random.nextInt(3); i++) {
      if (_random.nextInt(5) < 2) {
        removed.add(_removal());
      } else {
        entities.add(_upsert());
      }
    }
    return {
      'scope': _pick(const ['standalone_chat', 'workspace', 'worktree', 'pr']),
      if (removed.isNotEmpty) 'removed': removed,
      if (entities.isNotEmpty) 'entities': entities,
    };
  }

  Map<String, dynamic> _upsert() => switch (_random.nextInt(7)) {
    0 => _workspace(_pick(_workspaces)),
    1 => _worktree(_pick(const ['ws-1', 'ws-2']), _pick(_worktrees)),
    2 => {
      'entityType': 'chat_project',
      'localId': _pick(_projects),
      'payload': {'name': 'Project ${++_revision}'},
    },
    3 => () {
      final chat = _pick(_chats.keys.toList());
      final (workspace, worktree) = _chats[chat]!;
      return _summary(chat, workspace, worktree);
    }(),
    4 => _prStatus(_pick(const ['ws-1', 'ws-2']), _pick(_worktrees)),
    _ => _chat(_pick(_projects), _pick(_standalone)),
  };

  Map<String, dynamic> _removal() {
    final type = _pick(const [
      'workspace',
      'worktree',
      'chat_project',
      'standalone_chat',
      'standalone_chat',
      'chat_summary',
      'pr_status',
    ]);
    final (String localId, String? parent) = switch (type) {
      'workspace' => (_pick(_workspaces), null),
      'worktree' => (_pick(_worktrees), _maybe(_pick(const ['ws-1', 'ws-2']))),
      'chat_project' => (_pick(_projects), null),
      'standalone_chat' => (_pick(_standalone), _maybe(_pick(_projects))),
      'chat_summary' => () {
        final chat = _pick(_chats.keys.toList());
        final (workspace, worktree) = _chats[chat]!;
        return (
          chat,
          // One desktop writes and removes tabs with the same parent form;
          // these rows use the canonical one.
          _maybe(_pick(['$workspace:$worktree', 'ws-1:wt-9'])),
        );
      }(),
      _ => (_pick(_worktrees), _maybe('ws-1:${_pick(_worktrees)}')),
    };
    return {'entityType': type, 'localId': localId, 'parentLocalId': ?parent};
  }

  Map<String, dynamic> _workspace(String localId) => {
    'entityType': 'workspace',
    'localId': localId,
    'payload': {
      'name': 'Workspace $localId ${++_revision}',
      'type': localId == 'ws-cowork' ? 'cowork' : 'single-repo',
      'order': _random.nextInt(4),
      if (_random.nextInt(4) == 0) 'hidden': true,
    },
  };

  Map<String, dynamic> _worktree(String workspace, String localId) => {
    'entityType': 'worktree',
    'localId': localId,
    'parentLocalId': workspace,
    'payload': {
      'workspaceLocalId': workspace,
      'branch': 'feature/$localId',
      'label': 'Label ${++_revision}',
      'status': 'active',
      if (_random.nextBool()) 'hasUnread': true,
      if (_random.nextInt(4) == 0) 'awaitingApproval': true,
      if (_random.nextBool())
        'lastKnownPrStatus': {
          'repos': [
            {
              'repoId': '__workspace_root__',
              'repoName': 'canopy',
              'status': {
                'prNumber': 4874,
                'prUrl': 'https://github.com/example/canopy/pull/4874',
                'state': _prState(),
              },
            },
          ],
          'lastCheckedAt': DateTime.utc(
            2026,
            10,
            25,
          ).add(Duration(minutes: _revision)).toIso8601String(),
        },
    },
  };

  String _prState() => _pick(const ['open', 'draft', 'merged', 'closed']);

  Map<String, dynamic> _prStatus(String workspace, String localId) => {
    'entityType': 'pr_status',
    'localId': localId,
    'parentLocalId': '$workspace:$localId',
    'payload': {
      'workspaceLocalId': workspace,
      'worktreeLocalId': localId,
      'repos': [
        {
          'repoId': '__workspace_root__',
          'status': {'number': 4874, 'state': _prState()},
        },
      ],
      ..._progressFeeds(),
    },
  };

  /// Creation and merge progress feeds; a null feed clears it. Merge
  /// generations only grow, as each new attempt on the host.
  Map<String, dynamic> _progressFeeds() => {
    if (_progress.nextInt(3) == 0)
      'creationProgress': _progress.nextInt(4) == 0
          ? null
          : {
              'currentPhase': const [
                'gathering_changes',
                'pushing',
                'creating_pr',
                'done',
              ][_progress.nextInt(4)],
            },
    if (_progress.nextInt(3) == 0)
      'mergeProgress': _progress.nextInt(4) == 0
          ? null
          : {
              'currentPhase': const [
                'queued',
                'merging',
                'done',
              ][_progress.nextInt(3)],
              'generation': ++_mergeGeneration,
            },
  };

  var _mergeGeneration = 0;

  /// A string the server treats as absent about one time in four.
  String _orEmpty(String value) => _random.nextInt(4) == 0 ? '' : value;

  Map<String, dynamic> _chat(String project, String localId) => {
    'entityType': 'standalone_chat',
    'localId': localId,
    'parentLocalId': project,
    'payload': {
      if (_random.nextInt(4) > 0) 'projectLocalId': _orEmpty(project),
      if (_random.nextInt(5) > 0) 'title': _orEmpty('Chat ${++_revision}'),
      if (_random.nextInt(3) == 0) 'name': _orEmpty('Name ${++_revision}'),
      'lastMessageAt': DateTime.utc(
        2026,
        10,
        25,
      ).add(Duration(minutes: ++_revision)).toIso8601String(),
      if (_random.nextBool()) 'hasActiveChat': _random.nextBool(),
      if (_random.nextBool()) 'hasUnread': _random.nextBool(),
      if (_random.nextInt(6) == 0) 'archived': true,
      if (_random.nextInt(4) == 0) 'workEntryId': 'entry-$project',
    },
  };

  Map<String, dynamic> _summary(
    String chatId,
    String workspace,
    String worktree,
  ) => {
    'entityType': 'chat_summary',
    'localId': chatId,
    'parentLocalId': '$workspace:$worktree',
    'payload': {
      'chatId': chatId,
      'scope': RemoteChatScope.worktree.wire,
      'workspaceLocalId': workspace,
      'worktreeLocalId': worktree,
      'title': 'Tab ${++_revision}',
      'lastMessageAt': DateTime.utc(
        2026,
        10,
        24,
      ).add(Duration(minutes: ++_revision)).toIso8601String(),
    },
  };
}
