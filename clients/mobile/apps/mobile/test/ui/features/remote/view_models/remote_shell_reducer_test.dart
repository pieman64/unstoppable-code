// CAN-4874: standalone chat, chat project, workspace and removal deltas
// apply to the session store locally. While per-event cursors are present,
// none of them asks for an overview read.
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/features/remote/view_models/pr_state_tracker.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_store.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/remote_store_harness.dart';
import '../../../../support/remote_store_sequences.dart';

void main() {
  Map<String, dynamic> chatEntity(
    String localId, {
    String project = 'ws-cowork',
    String title = 'Plan launch',
    bool? active,
    bool? unread,
    String? lastMessageAt,
  }) => {
    'entityType': 'standalone_chat',
    'localId': localId,
    'parentLocalId': project,
    'payload': {
      'projectLocalId': project,
      'title': title,
      'hasActiveChat': ?active,
      'hasUnread': ?unread,
      'lastMessageAt': ?lastMessageAt,
    },
  };

  Map<String, dynamic> removal(
    String type,
    String localId, [
    String? parentLocalId,
  ]) => {
    'entityType': type,
    'localId': localId,
    'parentLocalId': ?parentLocalId,
  };

  Map<String, dynamic> summaryEntity(
    String chatId,
    String worktree, {
    bool? unread,
  }) => {
    'entityType': 'chat_summary',
    'localId': chatId,
    'parentLocalId': 'ws-1:$worktree',
    'payload': {
      'chatId': chatId,
      'scope': 'worktree',
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': worktree,
      'title': 'Tab $chatId',
      'hasUnread': ?unread,
    },
  };

  /// One cursored `portal.state.delta` envelope.
  Map<String, dynamic> delta(
    int? cursor, {
    String scope = 'standalone_chat',
    List<Map<String, dynamic>>? entities,
    List<Map<String, dynamic>>? removed,
  }) => {
    'type': 'portal.state.delta',
    'eventId': 'ev-${cursor ?? 'legacy'}',
    'cursor': ?cursor,
    'payload': {'scope': scope, 'entities': ?entities, 'removed': ?removed},
  };

  List<RemotePortalEvent> parse(List<Map<String, dynamic>> events) =>
      RemotePortalEventBatch.fromJson({
        'events': events,
        'nextCursor': 0,
      }).events;

  RemoteSessionSnapshot read({
    List<Map<String, dynamic>> standaloneChats = const [],
    List<Map<String, dynamic>> chatSummaries = const [],
    int? cursor = 100,
  }) => RemoteSessionSnapshot.fromJson({
    'workspaces': [
      {'localId': 'ws-1', 'name': 'Repository', 'order': 1},
      {'localId': 'ws-cowork', 'name': 'Cowork', 'type': 'cowork', 'order': 2},
    ],
    'worktrees': [
      {
        'localId': 'wt-1',
        'workspaceLocalId': 'ws-1',
        'branch': 'feature/koala',
        'lastKnownPrStatus': {
          'repos': [
            {
              'repoId': '__workspace_root__',
              'status': {'prNumber': 4874, 'state': 'open'},
            },
          ],
        },
      },
      {'localId': 'wt-2', 'workspaceLocalId': 'ws-1', 'branch': 'feature/lynx'},
    ],
    'standaloneChats': standaloneChats,
    'chatSummaries': chatSummaries,
  }).copyWith(eventCursor: cursor);

  Map<String, dynamic> chatRow(
    String localId, {
    String project = 'ws-cowork',
    String title = 'Plan launch',
  }) => {'localId': localId, 'projectLocalId': project, 'title': title};

  Map<String, dynamic> summaryRow(String chatId, String worktree) => {
    'chatId': chatId,
    'scope': 'worktree',
    'workspaceLocalId': 'ws-1',
    'worktreeLocalId': worktree,
    'title': 'Tab $chatId',
  };

  List<String> chats(RemoteStoresHarness harness) => [
    for (final chat in harness.session.allStandaloneChats)
      '${chat.projectLocalId}/${chat.localId}:${chat.title}',
  ];

  List<String> tabs(RemoteStoresHarness harness) => [
    for (final summary in harness.session.allChatSummaries) summary.chatId,
  ];

  List<String> prs(RemoteStoresHarness harness) => [
    for (final pr in harness.session.worktreesFor('ws-1').first.prStatuses)
      '${pr.prNumber}:${pr.state}',
  ];

  Map<String, dynamic> prStatusEntity(String worktree, String state) => {
    'entityType': 'pr_status',
    'localId': worktree,
    'parentLocalId': 'ws-1:$worktree',
    'payload': {
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': worktree,
      'repos': [
        {
          'repoId': '__workspace_root__',
          'status': {'number': 4874, 'state': state},
        },
      ],
    },
  };

  RemoteStoresHarness hydrated({
    List<Map<String, dynamic>> standaloneChats = const [],
    List<Map<String, dynamic>> chatSummaries = const [],
  }) => RemoteStoresHarness()
    ..applySnapshot(
      read(standaloneChats: standaloneChats, chatSummaries: chatSummaries),
    );

  List<RemoteSessionEffects> applyBatch(
    RemoteStoresHarness harness,
    List<Map<String, dynamic>> events, {
    required int cursor,
  }) => harness.applyBatch(parse(events), cursor: cursor);

  RemoteOverviewRefreshRequest? refreshOf(List<RemoteSessionEffects> steps) =>
      steps.map((step) => step.overviewRefresh).nonNulls.firstOrNull;

  group('upserts', () {
    test('an active standalone chat updates in place without a read', () {
      final harness = hydrated(standaloneChats: [chatRow('sc-1')]);
      final steps = applyBatch(harness, [
        delta(
          101,
          entities: [
            chatEntity(
              'sc-1',
              title: 'Plan launch, revised',
              active: true,
              unread: true,
            ),
          ],
        ),
      ], cursor: 101);
      expect(refreshOf(steps), isNull);
      expect(steps.single.changed, isTrue);
      expect(chats(harness), ['ws-cowork/sc-1:Plan launch, revised']);
      final chat = harness.session.standaloneChatById('sc-1')!;
      expect(chat.hasActiveChat, isTrue);
      // The row's unread flag reaches read receipts, as a read's would.
      expect(steps.single.unreadProjections, [
        (
          chat: (scope: RemoteChatScope.standalone, chatId: 'sc-1'),
          unread: true,
        ),
      ]);
      expect(
        harness.session.composerProjectionSequenceFor((
          scope: RemoteChatScope.standalone,
          chatId: 'sc-1',
        )),
        harness.session.composerProjectionSequence,
      );
    });

    test('new standalone chats land where an overview read orders them', () {
      final harness = hydrated(
        standaloneChats: [chatRow('sc-1'), chatRow('sc-3')],
      );
      final steps = applyBatch(harness, [
        delta(
          101,
          entities: [
            chatEntity('sc-2', title: 'Second'),
            chatEntity('sc-0', title: 'First'),
          ],
        ),
      ], cursor: 101);
      expect(refreshOf(steps), isNull);
      expect(chats(harness), [
        'ws-cowork/sc-0:First',
        'ws-cowork/sc-1:Plan launch',
        'ws-cowork/sc-2:Second',
        'ws-cowork/sc-3:Plan launch',
      ]);
    });

    test('a standalone payload falls back to the envelope id and parent', () {
      final harness = hydrated();
      applyBatch(harness, [
        delta(
          101,
          entities: [
            {
              'entityType': 'standalone_chat',
              'localId': 'sc-1',
              'parentLocalId': 'ws-cowork',
              'payload': {'name': 'Named only'},
            },
            {
              'entityType': 'standalone_chat',
              'localId': 'sc-2',
              'parentLocalId': 'ws-cowork',
              'payload': <String, dynamic>{},
            },
          ],
        ),
      ], cursor: 101);
      expect(chats(harness), [
        'ws-cowork/sc-1:Named only',
        'ws-cowork/sc-2:sc-2',
      ]);
      expect(
        [
          for (final chat in harness.session.standaloneChatsFor('ws-cowork'))
            chat.localId,
        ],
        ['sc-1', 'sc-2'],
      );
    });

    test('empty standalone strings fall back like the server projector', () {
      final harness = hydrated(standaloneChats: [chatRow('sc-1')]);
      applyBatch(harness, [
        delta(
          101,
          entities: [
            {
              'entityType': 'standalone_chat',
              'localId': 'sc-1',
              'parentLocalId': 'ws-cowork',
              'payload': {'projectLocalId': '', 'title': '', 'name': 'Named'},
            },
            {
              'entityType': 'standalone_chat',
              'localId': 'sc-2',
              'parentLocalId': 'ws-cowork',
              'payload': {'projectLocalId': '', 'title': '', 'name': ''},
            },
          ],
        ),
      ], cursor: 101);
      // The empty project falls back to the parent, so sc-1 updates in
      // place instead of adding a second row under an empty project.
      expect(chats(harness), ['ws-cowork/sc-1:Named', 'ws-cowork/sc-2:sc-2']);
    });

    test('chat project rows need no overview read', () {
      final harness = hydrated();
      final before = harness.session.snapshot;
      final steps = applyBatch(harness, [
        delta(
          101,
          entities: [
            {
              'entityType': 'chat_project',
              'localId': 'cp-1',
              'payload': {'name': 'Launch'},
            },
          ],
        ),
        delta(102, removed: [removal('chat_project', 'cp-1')]),
      ], cursor: 102);
      expect(refreshOf(steps), isNull);
      // The overview read carries no chat projects, so nothing changes.
      expect(harness.session.snapshot, same(before));
    });

    test('workspace rows outside the overview scope upsert', () {
      final harness = hydrated();
      final steps = applyBatch(harness, [
        delta(
          101,
          scope: 'workspace',
          entities: [
            {
              'entityType': 'workspace',
              'localId': 'ws-1',
              'payload': {'name': 'Repository renamed', 'order': 1},
            },
            {
              'entityType': 'workspace',
              'localId': 'ws-0',
              'payload': {'name': 'New first', 'order': 0},
            },
          ],
        ),
      ], cursor: 101);
      expect(refreshOf(steps), isNull);
      expect(
        [
          for (final workspace in harness.session.workspaces)
            '${workspace.localId}:${workspace.name}',
        ],
        ['ws-0:New first', 'ws-1:Repository renamed', 'ws-cowork:Cowork'],
      );
    });
  });

  group('removals', () {
    test('each shell entity type is removed locally', () {
      final harness = hydrated(
        standaloneChats: [chatRow('sc-1'), chatRow('sc-2')],
        chatSummaries: [
          summaryRow('chat-1', 'wt-1'),
          summaryRow('chat-2', 'wt-1'),
        ],
      );
      final steps = applyBatch(harness, [
        delta(101, removed: [removal('standalone_chat', 'sc-1', 'ws-cowork')]),
        delta(
          102,
          scope: 'chat',
          removed: [removal('chat_summary', 'chat-2', 'ws-1:wt-1')],
        ),
        delta(
          103,
          scope: 'worktree',
          removed: [removal('worktree', 'wt-2', 'ws-1')],
        ),
        delta(104, scope: 'workspace', removed: [removal('workspace', 'ws-1')]),
        delta(105, removed: [removal('chat_project', 'cp-1')]),
      ], cursor: 105);
      expect(refreshOf(steps), isNull);
      expect(chats(harness), ['ws-cowork/sc-2:Plan launch']);
      expect(tabs(harness), ['chat-1']);
      expect(
        [for (final worktree in harness.session.allWorktrees) worktree.localId],
        ['wt-1'],
      );
      expect(
        [for (final workspace in harness.session.workspaces) workspace.localId],
        ['ws-cowork'],
      );
      // Removed rows no longer back a local read receipt.
      expect(steps.first.readsPrunedAgainst, isNotNull);
      expect(
        steps.first.readsPrunedAgainst!.standaloneChats.map((c) => c.localId),
        ['sc-2'],
      );
    });

    test('a pr_status removal clears progress but keeps the worktree PR', () {
      final harness = hydrated();
      final steps = applyBatch(harness, [
        delta(
          101,
          scope: 'pr',
          removed: [removal('pr_status', 'wt-1', 'ws-1:wt-1')],
        ),
      ], cursor: 101);
      expect(refreshOf(steps), isNull);
      final progress = steps.single.prProgress!['ws-1:wt-1']!;
      expect(progress.clearCreation, isTrue);
      expect(progress.clearMerge, isTrue);
      expect(
        harness.session.worktreesFor('ws-1').first.prStatuses.single.prNumber,
        4874,
      );
    });

    test(
      'a pr_status removal restores the status its observation replaced',
      () {
        final harness = hydrated();
        applyBatch(harness, [
          delta(101, scope: 'pr', entities: [prStatusEntity('wt-1', 'merged')]),
        ], cursor: 101);
        expect(prs(harness), ['4874:merged']);
        final steps = applyBatch(harness, [
          delta(
            102,
            scope: 'pr',
            removed: [removal('pr_status', 'wt-1', 'ws-1:wt-1')],
          ),
        ], cursor: 102);
        expect(refreshOf(steps), isNull);
        // An overview read returns the worktree row's own status.
        expect(prs(harness), ['4874:open']);
        // A parentless removal restores it the same way.
        applyBatch(harness, [
          delta(103, scope: 'pr', entities: [prStatusEntity('wt-1', 'closed')]),
          delta(104, scope: 'pr', removed: [removal('pr_status', 'wt-1')]),
        ], cursor: 104);
        expect(prs(harness), ['4874:open']);
      },
    );

    test('a parent constrains a removal only when it is supplied', () {
      final harness = hydrated(
        standaloneChats: [
          chatRow('sc-1'),
          chatRow('sc-1', project: 'ws-other', title: 'Other'),
          chatRow('sc-2'),
          chatRow('sc-2', project: 'ws-other', title: 'Other'),
        ],
        chatSummaries: [summaryRow('chat-1', 'wt-1')],
      );
      final steps = applyBatch(harness, [
        delta(101, removed: [removal('standalone_chat', 'sc-1', 'ws-other')]),
        delta(102, removed: [removal('standalone_chat', 'sc-2')]),
        // Nothing matches these parents, so nothing is removed.
        delta(
          103,
          removed: [
            removal('standalone_chat', 'sc-1', 'ws-1'),
            removal('workspace', 'ws-1', 'unrelated'),
            removal('chat_summary', 'chat-1', 'ws-1:wt-2'),
            removal('worktree', 'wt-1', 'ws-cowork'),
            removal('standalone_chat', ''),
            removal('unknown_kind', 'sc-1'),
          ],
        ),
      ], cursor: 103);
      expect(refreshOf(steps), isNull);
      expect(chats(harness), ['ws-cowork/sc-1:Plan launch']);
      expect(tabs(harness), ['chat-1']);
      expect(harness.session.allWorktrees, hasLength(2));
      expect(harness.session.workspaces, hasLength(2));
    });

    test('a legacy bare worktree parent still removes its chat tab', () {
      final harness = hydrated(chatSummaries: [summaryRow('chat-1', 'wt-1')]);
      applyBatch(harness, [
        delta(101, removed: [removal('chat_summary', 'chat-1', 'wt-1')]),
      ], cursor: 101);
      expect(tabs(harness), isEmpty);
    });

    test('removals apply before the same delta re-adds a row', () {
      final harness = hydrated(
        standaloneChats: [chatRow('sc-1')],
        chatSummaries: [summaryRow('chat-1', 'wt-1')],
      );
      applyBatch(harness, [
        delta(
          101,
          removed: [
            removal('standalone_chat', 'sc-1'),
            removal('chat_summary', 'chat-1'),
            removal('worktree', 'wt-1'),
          ],
          entities: [
            chatEntity('sc-1', title: 'Re-added'),
            summaryEntity('chat-1', 'wt-1'),
            {
              'entityType': 'worktree',
              'localId': 'wt-1',
              'parentLocalId': 'ws-1',
              'payload': {
                'workspaceLocalId': 'ws-1',
                'branch': 'feature/re-added',
              },
            },
          ],
        ),
      ], cursor: 101);
      expect(chats(harness), ['ws-cowork/sc-1:Re-added']);
      expect(tabs(harness), ['chat-1']);
      expect(
        harness.session.allWorktrees.map((worktree) => worktree.branch),
        containsAll(['feature/re-added', 'feature/lynx']),
      );
    });

    test('removing the last tab of a worktree removes it', () {
      final harness = hydrated(chatSummaries: [summaryRow('chat-3', 'wt-2')]);
      applyBatch(harness, [
        delta(101, removed: [removal('chat_summary', 'chat-3')]),
      ], cursor: 101);
      expect(tabs(harness), isEmpty);
      // A later overview read without the tab does not bring it back.
      harness.applySnapshot(read(cursor: 101));
      expect(tabs(harness), isEmpty);
    });
  });

  group('cursors and reads', () {
    test('global cursor jumps are not gaps', () {
      final harness = hydrated(standaloneChats: [chatRow('sc-1')]);
      final steps = [
        ...applyBatch(harness, [
          delta(5000, entities: [chatEntity('sc-1', title: 'Jumped')]),
        ], cursor: 5000),
        ...applyBatch(harness, [
          delta(90210, removed: [removal('standalone_chat', 'sc-1')]),
        ], cursor: 90210),
      ];
      expect(refreshOf(steps), isNull);
      expect(chats(harness), isEmpty);
    });

    test('replayed events the read already covers change nothing', () {
      final harness = RemoteStoresHarness()
        ..applySnapshot(
          read(
            standaloneChats: [chatRow('sc-1', title: 'Current')],
            chatSummaries: [summaryRow('chat-1', 'wt-1')],
            cursor: 200,
          ),
        );
      final before = harness.session.snapshot;
      final steps = applyBatch(harness, [
        delta(150, removed: [removal('standalone_chat', 'sc-1')]),
        delta(160, entities: [chatEntity('sc-0', title: 'Removed later')]),
        delta(170, removed: [removal('chat_summary', 'chat-1')]),
        delta(
          180,
          scope: 'workspace',
          removed: [removal('workspace', 'ws-cowork')],
        ),
      ], cursor: 200);
      expect(refreshOf(steps), isNull);
      expect(harness.session.snapshot, same(before));
      expect(chats(harness), ['ws-cowork/sc-1:Current']);
      expect(tabs(harness), ['chat-1']);
    });

    test(
      'a replayed tab upsert cannot restore a tab closed before the read',
      () {
        final harness = RemoteStoresHarness()
          ..applySnapshot(
            read(chatSummaries: [summaryRow('chat-2', 'wt-1')], cursor: 200),
          );
        final before = harness.session.snapshot;
        bool? worktreeUnread() =>
            harness.session.worktreesFor('ws-1').first.hasUnread;
        // The stream replays the backlog in two pages: chat-1 opened at 150
        // and closed at 180, both before the read.
        final firstPage = applyBatch(harness, [
          delta(
            150,
            scope: 'chat',
            entities: [summaryEntity('chat-1', 'wt-1', unread: true)],
          ),
        ], cursor: 160);
        expect(tabs(harness), ['chat-2'], reason: 'after the first page');
        expect(worktreeUnread(), isNot(isTrue), reason: 'after the first page');
        final secondPage = applyBatch(harness, [
          delta(
            180,
            scope: 'chat',
            removed: [removal('chat_summary', 'chat-1', 'ws-1:wt-1')],
          ),
        ], cursor: 200);
        expect(refreshOf([...firstPage, ...secondPage]), isNull);
        expect(tabs(harness), ['chat-2']);
        expect(worktreeUnread(), isNot(isTrue));
        expect(harness.session.snapshot, same(before));
      },
    );

    for (final (name, snapshotPayload) in [
      ('worktree', <String, dynamic>{'scope': 'worktree'}),
      (
        'selected chat',
        <String, dynamic>{
          'scope': 'chat',
          'selectedChatOnly': true,
          'target': {
            'workspaceLocalId': 'ws-1',
            'worktreeLocalId': 'wt-1',
            'chatLocalId': 'chat-2',
          },
        },
      ),
    ]) {
      test(
        'a replayed $name snapshot cannot restore a tab closed before the read',
        () {
          final harness = RemoteStoresHarness()
            ..applySnapshot(
              read(chatSummaries: [summaryRow('chat-2', 'wt-1')], cursor: 200),
            );
          final before = harness.session.snapshot;
          final firstPage = applyBatch(harness, [
            {
              'type': 'portal.state.snapshot',
              'eventId': 'snapshot-150',
              'cursor': 150,
              'payload': {
                ...snapshotPayload,
                'entities': [
                  summaryEntity('chat-1', 'wt-1', unread: true),
                  summaryEntity('chat-2', 'wt-1'),
                ],
              },
            },
          ], cursor: 160);
          expect(tabs(harness), ['chat-2'], reason: 'after the first page');
          final secondPage = applyBatch(harness, [
            delta(
              180,
              scope: 'chat',
              removed: [removal('chat_summary', 'chat-1', 'ws-1:wt-1')],
            ),
          ], cursor: 200);
          expect(refreshOf([...firstPage, ...secondPage]), isNull);
          expect(tabs(harness), ['chat-2']);
          expect(
            harness.session.worktreesFor('ws-1').first.hasUnread,
            isNot(isTrue),
          );
          expect(harness.session.snapshot, same(before));
        },
      );
    }

    test('a replayed overview head cannot replace a newer read', () {
      final harness = RemoteStoresHarness()
        ..applySnapshot(read(standaloneChats: [chatRow('sc-2')], cursor: 200));
      final before = harness.session.snapshot;
      final steps = applyBatch(harness, [
        {
          'type': 'portal.state.snapshot',
          'eventId': 'head-150',
          'cursor': 150,
          'payload': {
            'scope': 'overview',
            'entities': [
              {
                'entityType': 'workspace',
                'localId': 'ws-cowork',
                'payload': {'name': 'Cowork', 'type': 'cowork'},
              },
              chatEntity('sc-1', title: 'Closed'),
              chatEntity('sc-2', title: 'Stale'),
            ],
          },
        },
        delta(180, removed: [removal('standalone_chat', 'sc-1')]),
      ], cursor: 200);
      expect(refreshOf(steps), isNull);
      expect(chats(harness), ['ws-cowork/sc-2:Plan launch']);
      expect(harness.session.snapshot, same(before));
    });

    test('PR progress follows the stream through a covered replay', () {
      // Overview reads carry no PR progress, so only the stream orders it.
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
      final harness = RemoteStoresHarness()..applySnapshot(read(cursor: 200));
      final before = harness.session.snapshot;
      List<RemoteSessionEffects> page(
        List<Map<String, dynamic>> events, {
        required int cursor,
      }) {
        final steps = applyBatch(harness, events, cursor: cursor);
        for (final step in steps) {
          tracker.applyPrProgress(step.prProgress);
        }
        return steps;
      }

      Map<String, dynamic> progressEntity(Map<String, dynamic> feeds) => {
        'entityType': 'pr_status',
        'localId': 'wt-1',
        'parentLocalId': 'ws-1:wt-1',
        'payload': {
          'workspaceLocalId': 'ws-1',
          'worktreeLocalId': 'wt-1',
          ...feeds,
        },
      };
      String? creation() =>
          tracker.prProgressFor('ws-1', 'wt-1')?.creation?.currentPhase.name;
      String? merge() =>
          tracker.prProgressFor('ws-1', 'wt-1')?.merge?.currentPhase.name;

      // The backlog replays in two pages: PR creation started at 150, and
      // its pr_status row was removed at 180, both before the read.
      final firstPage = page([
        delta(
          150,
          scope: 'pr',
          entities: [
            progressEntity({
              'creationProgress': {'currentPhase': 'pushing'},
            }),
          ],
        ),
      ], cursor: 160);
      expect(creation(), 'pushing', reason: 'after the first page');
      final secondPage = page([
        delta(
          180,
          scope: 'pr',
          removed: [removal('pr_status', 'wt-1', 'ws-1:wt-1')],
        ),
      ], cursor: 200);
      expect(refreshOf([...firstPage, ...secondPage]), isNull);
      expect(tracker.prProgressFor('ws-1', 'wt-1'), isNull);
      expect(harness.session.snapshot, same(before));

      // Newer progress after the read applies, and a covered removal
      // replayed in a later page clears live progress the same way.
      page([
        delta(
          210,
          scope: 'pr',
          entities: [
            progressEntity({
              'mergeProgress': {'currentPhase': 'merging', 'generation': 1},
            }),
          ],
        ),
      ], cursor: 210);
      expect(merge(), 'merging');
      harness.applySnapshot(read(cursor: 300));
      page([
        delta(250, scope: 'pr', removed: [removal('pr_status', 'wt-1')]),
      ], cursor: 260);
      expect(tracker.prProgressFor('ws-1', 'wt-1'), isNull);
      page([
        delta(
          310,
          scope: 'pr',
          entities: [
            progressEntity({
              'creationProgress': {'currentPhase': 'creating_pr'},
            }),
          ],
        ),
      ], cursor: 310);
      expect(creation(), 'creatingPr');
      expect(merge(), isNull);
    });

    test('an older read cannot restore rows removed while it ran', () {
      final harness = hydrated(
        standaloneChats: [chatRow('sc-1'), chatRow('sc-2')],
        chatSummaries: [
          summaryRow('chat-1', 'wt-1'),
          summaryRow('chat-2', 'wt-1'),
        ],
      );
      final baseline = harness.session.captureReadBaseline();
      applyBatch(harness, [
        delta(
          120,
          removed: [
            removal('standalone_chat', 'sc-1'),
            removal('chat_summary', 'chat-2'),
          ],
          entities: [chatEntity('sc-3', title: 'Live')],
        ),
      ], cursor: 120);
      // The read started before the delta and reports an older cursor.
      final step = harness.applySnapshot(
        read(
          standaloneChats: [chatRow('sc-1'), chatRow('sc-2')],
          chatSummaries: [
            summaryRow('chat-1', 'wt-1'),
            summaryRow('chat-2', 'wt-1'),
          ],
          cursor: 110,
        ),
        baseline: baseline,
      );
      expect(chats(harness), [
        'ws-cowork/sc-2:Plan launch',
        'ws-cowork/sc-3:Live',
      ]);
      expect(tabs(harness), ['chat-1']);
      expect(
        step.overviewRefresh,
        RemoteOverviewRefreshRequest.readRacedLiveShell,
      );
    });

    test('a newer read covers live changes, including a re-add', () {
      final harness = hydrated(standaloneChats: [chatRow('sc-1')]);
      final baseline = harness.session.captureReadBaseline();
      applyBatch(harness, [
        delta(120, removed: [removal('standalone_chat', 'sc-1')]),
      ], cursor: 120);
      final step = harness.applySnapshot(
        read(
          standaloneChats: [chatRow('sc-1', title: 'Re-added on the desktop')],
          cursor: 130,
        ),
        baseline: baseline,
      );
      expect(step.overviewRefresh, isNull);
      expect(chats(harness), ['ws-cowork/sc-1:Re-added on the desktop']);
      // A live re-add after the read still applies.
      applyBatch(harness, [
        delta(131, removed: [removal('standalone_chat', 'sc-1')]),
        delta(132, entities: [chatEntity('sc-1', title: 'Re-added live')]),
      ], cursor: 132);
      expect(chats(harness), ['ws-cowork/sc-1:Re-added live']);
    });

    test('a reset forgets the tabs the old session removed', () {
      final harness = hydrated(chatSummaries: [summaryRow('chat-1', 'wt-1')]);
      applyBatch(harness, [
        delta(101, removed: [removal('chat_summary', 'chat-1')]),
      ], cursor: 101);
      harness.reset();
      final baseline = harness.session.captureReadBaseline();
      harness.applySnapshot(
        read(chatSummaries: [summaryRow('chat-1', 'wt-1')], cursor: 50),
        baseline: baseline,
      );
      expect(tabs(harness), ['chat-1']);
    });

    test('older servers without event cursors keep the overview fallback', () {
      final harness = hydrated(standaloneChats: [chatRow('sc-1')]);
      final before = harness.session.snapshot;
      final events = parse([
        delta(null, entities: [chatEntity('sc-1', title: 'Unordered')]),
        delta(null, removed: [removal('standalone_chat', 'sc-1')]),
      ]);
      for (final event in events.cast<RemoteStateDeltaEvent>()) {
        expect(event.requiresOverviewRefresh, isTrue);
      }
      final steps = harness.applyBatch(events, cursor: 101);
      expect(refreshOf(steps), RemoteOverviewRefreshRequest.deltaRequested);
      expect(harness.session.snapshot, same(before));
      // The same rows outside any read cursor fall back as well.
      final legacy = RemoteStoresHarness()
        ..applySnapshot(read(standaloneChats: [chatRow('sc-1')], cursor: null));
      expect(
        refreshOf([for (final event in events) legacy.apply(event)]),
        RemoteOverviewRefreshRequest.deltaRequested,
      );
    });

    test('an overview head replaces the standalone chats it carries', () {
      final harness = hydrated(
        standaloneChats: [chatRow('sc-1'), chatRow('sc-2')],
      );
      final events = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.snapshot',
            'eventId': 'head-1',
            'cursor': 101,
            'payload': {
              'scope': 'overview',
              'entities': [
                {
                  'entityType': 'workspace',
                  'localId': 'ws-cowork',
                  'payload': {'name': 'Cowork', 'type': 'cowork'},
                },
                chatEntity('sc-2', title: 'Kept'),
              ],
            },
          },
          {
            'type': 'portal.state.delta',
            'eventId': 'head-1:chunk-1',
            'cursor': 102,
            'payload': {
              'scope': 'overview',
              'entities': [chatEntity('sc-3', title: 'Continued')],
            },
          },
        ],
        'nextCursor': 102,
      }).events;
      final steps = harness.applyBatch(events, cursor: 102);
      expect(refreshOf(steps), isNull);
      expect(chats(harness), [
        'ws-cowork/sc-2:Kept',
        'ws-cowork/sc-3:Continued',
      ]);
    });
  });

  test('the store never mutates an earlier snapshot', () {
    final harness = hydrated(
      standaloneChats: [chatRow('sc-1')],
      chatSummaries: [summaryRow('chat-1', 'wt-1')],
    );
    final before = harness.session.snapshot!;
    final standalone = List.of(before.standaloneChats);
    final summaries = List.of(before.chatSummaries);
    final workspaces = List.of(before.workspaces);
    applyBatch(harness, [
      delta(
        101,
        removed: [
          removal('standalone_chat', 'sc-1'),
          removal('chat_summary', 'chat-1'),
          removal('workspace', 'ws-1'),
        ],
        entities: [chatEntity('sc-2')],
      ),
    ], cursor: 101);
    expect(before.standaloneChats, standalone);
    expect(before.chatSummaries, summaries);
    expect(before.workspaces, workspaces);
    expect(harness.session.snapshot, isNot(same(before)));
    expect(
      remoteWorktreeKeyOf(harness.session.allWorktrees.first),
      remoteWorktreeKey('ws-1', 'wt-1'),
    );
  });
}
