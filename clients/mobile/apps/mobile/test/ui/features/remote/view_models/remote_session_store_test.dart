import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr_merge_queue.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/chat_transcript_store.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_store.dart';

import 'dart:math';

import '../../../../support/merge_queue_fixture.dart';
import '../../../../support/pr_checks_fixture.dart';
import '../../../../support/overview_snapshot_fixture.dart';
import '../../../../support/remote_store_sequences.dart';

void main() {
  const emptySnapshot = RemoteSessionSnapshot(
    workspaces: [],
    worktrees: [],
    standaloneChats: [],
  );
  final wt1 = remoteWorktreeKey('ws-1', 'wt-1');

  RemoteChatSummary summary(
    String chatId, {
    RemoteChatScope? scope = RemoteChatScope.worktree,
    String workspace = 'ws-1',
    String? worktree = 'wt-1',
    String? title,
    bool? unread,
    bool? running,
    List<AskUserQuestionState>? pendingQuestions,
  }) => RemoteChatSummary(
    chatId: chatId,
    scope: scope,
    title: title ?? chatId,
    workspaceLocalId: workspace,
    worktreeLocalId: worktree,
    hasUnread: unread,
    turnActive: running,
    pendingQuestions: pendingQuestions,
  );

  test('only a successful host observation supersedes an action-read PR', () {
    final harness = RemoteStoresHarness();
    const row = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature',
    );
    const live = RemoteWorktreePr(
      repoId: 'repo-app',
      prNumber: 42,
      state: 'open',
    );
    harness.applySnapshot(emptySnapshot.copyWith(worktrees: [row]));
    harness.session.applyPrStatuses({
      'ws-1:wt-1': [live],
    }, source: RemotePrObservationSource.actionRead);
    harness.session.applyPrStatuses({
      'ws-1:wt-1': [
        const RemoteWorktreePr(
          repoId: 'repo-app',
          state: '',
          lookupAvailable: false,
        ),
      ],
    });
    harness.session.applyWorktreeRows([row]);
    expect(harness.session.snapshot!.worktrees.single.prStatuses, [same(live)]);
    harness.session.applyPrStatuses({
      'ws-1:wt-1': [live],
    });
    harness.session.applyWorktreeRows([row]);
    expect(harness.session.snapshot!.worktrees.single.prStatuses, isEmpty);
  });

  test('a raced overview cannot erase an action-read PR on the next row', () {
    final harness = RemoteStoresHarness();
    const row = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature',
    );
    const live = RemoteWorktreePr(
      repoId: 'repo-app',
      prNumber: 42,
      state: 'open',
    );
    final overview = emptySnapshot.copyWith(worktrees: [row]);
    harness.applySnapshot(overview);
    final baseline = harness.session.captureReadBaseline();
    harness.session.applyPrStatuses({
      'ws-1:wt-1': [live],
    }, source: RemotePrObservationSource.actionRead);
    final read = harness.applySnapshot(overview, baseline: baseline);
    expect(
      read.overviewRefresh,
      RemoteOverviewRefreshRequest.readRacedLiveShell,
    );
    harness.session.applyWorktreeRows([row]);
    expect(harness.session.snapshot!.worktrees.single.prStatuses, [same(live)]);

    // A later overview that did not race still owns the host summary.
    harness.applySnapshot(overview);
    expect(harness.session.snapshot!.worktrees.single.prStatuses, isEmpty);
  });

  test('overview rows retain detailed checks for the same PR observation', () {
    final harness = RemoteStoresHarness();
    final detailed = RemoteWorktreePr.fromPortal(
      prChecksRepo(checks: legacyPrChecks())['status'] as Map<String, dynamic>,
      repoId: 'repo-app',
    );
    final row = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature',
      prStatuses: [detailed],
    );
    harness.applySnapshot(emptySnapshot.copyWith(worktrees: [row]));
    final overview = RemoteSessionSnapshot.fromJson({
      'workspaces': [],
      'standaloneChats': [],
      'worktrees': [
        {
          'localId': 'wt-1',
          'workspaceLocalId': 'ws-1',
          'branch': 'feature',
          'lastKnownPrStatus': {
            'repos': [
              {
                'repoId': 'repo-app',
                'status': {
                  'prNumber': 42,
                  'prUrl': detailed.url,
                  'state': 'open',
                  'checkStatus': 'failing',
                },
              },
            ],
          },
        },
      ],
    });
    harness.applySnapshot(overview);
    expect(
      harness.session.snapshot!.worktrees.single.prStatuses.single.checks,
      hasLength(4),
    );
  });

  test('a failed sibling lookup does not hide a pushed check update', () {
    final first = RemoteWorktreePr.fromPortal(
      prChecksRepo()['status'] as Map<String, dynamic>,
      repoId: 'repo-app',
    );
    final sibling = RemoteWorktreePr.fromPortal(
      prChecksRepo(repoId: 'repo-api')['status'] as Map<String, dynamic>,
      repoId: 'repo-api',
    );
    final harness = RemoteStoresHarness()
      ..applySnapshot(
        emptySnapshot.copyWith(
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'feature',
              prStatuses: [first, sibling],
            ),
          ],
        ),
      );
    harness.apply(
      RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.delta',
            'payload': {
              'scope': 'pr',
              'entities': [
                {
                  'entityType': 'pr_status',
                  'localId': 'wt-1',
                  'payload': {
                    'workspaceLocalId': 'ws-1',
                    'worktreeLocalId': 'wt-1',
                    'repos': [
                      prChecksRepo(
                        checkStatus: 'passing',
                        checks: settledPrChecks(),
                      ),
                      {
                        'repoId': 'repo-api',
                        'status': null,
                        'prLookupAvailable': false,
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }).events.single,
    );
    final statuses = harness.session.snapshot!.worktrees.single.prStatuses;
    expect(statuses.first.checkStatus, 'passing');
    expect(statuses.last, same(sibling));
  });

  group('worktree activity reconciliation', () {
    RemotePortalEventBatch summaryBatch({
      String workspace = 'ws-1',
      String chat = 'chat-1',
      bool? running,
      bool? unread,
      bool delta = false,
      RemoteChatScope scope = RemoteChatScope.worktree,
    }) => RemotePortalEventBatch.fromJson({
      'events': [
        {
          'type': delta ? 'portal.state.delta' : 'portal.state.snapshot',
          'payload': {
            'scope': delta ? 'worktree_chat_summaries' : 'chat',
            'entities': [
              {
                'entityType': 'chat_summary',
                'localId': chat,
                'parentLocalId': 'wt-1',
                'payload': {
                  'chatId': chat,
                  'scope': scope.wire,
                  'title': 'Chat',
                  'workspaceLocalId': workspace,
                  'worktreeLocalId': 'wt-1',
                  'turnActive': ?running,
                  'hasUnread': ?unread,
                },
              },
            ],
          },
        },
      ],
      'nextCursor': 1,
    });

    RemotePortalEventBatch worktreeRow(
      String localId, {
      bool streaming = false,
      bool unread = false,
    }) => overviewBatch(
      type: 'portal.state.delta',
      scope: 'worktree',
      entities: [
        {
          'entityType': 'worktree',
          'localId': localId,
          'parentLocalId': 'ws-1',
          'payload': {
            ...overviewWorktree(includeLocalId: false),
            'isStreaming': streaming,
            'hasUnread': unread,
          },
        },
      ],
    );

    void publish(RemoteStoresHarness harness, RemotePortalEventBatch batch) =>
        batch.events.forEach(harness.apply);

    test('fresh signals respect workspace, siblings, and newer host rows', () {
      final harness = RemoteStoresHarness()..applySnapshot(initialOverview());
      final session = harness.session;
      RemoteWorktree row() => session.allWorktrees.single;
      publish(
        harness,
        summaryBatch(workspace: 'other', running: true, unread: true),
      );
      publish(
        harness,
        summaryBatch(
          chat: 'standalone',
          scope: RemoteChatScope.standalone,
          running: true,
          unread: true,
        ),
      );
      expect(row().isWorking, isFalse);
      expect(row().hasUnread, isNot(true));
      // Continuation deltas must supplement the row just like the batch head.
      publish(harness, summaryBatch(running: true, unread: true, delta: true));
      expect(row().isWorking, isTrue);
      expect(row().hasUnread, isTrue);
      publish(
        harness,
        summaryBatch(chat: 'sibling', running: false, unread: false),
      );
      expect(row().isWorking, isTrue);
      expect(row().hasUnread, isTrue);
      // Older hosts omitting flags cannot erase a previous known signal.
      publish(harness, summaryBatch());
      expect(row().isWorking, isTrue);
      publish(harness, summaryBatch(running: false, unread: false));
      expect(row().isWorking, isFalse);
      expect(row().hasUnread, isFalse);
      publish(harness, summaryBatch(running: true, unread: true));
      final index = harness.apply(
        const RemoteStateSnapshotEvent(scope: 'worktree_chat_summaries'),
      );
      expect(index.summariesIndexHydrated, isTrue);
      expect(index.changed, isTrue);
      expect(
        row().isWorking,
        isFalse,
        reason: 'A full empty index retires removed chats',
      );
      expect(row().hasUnread, isNot(true));
      publish(harness, summaryBatch(running: true, unread: true));
      publish(harness, overviewBatch());
      expect(row().isWorking, isFalse);
      expect(row().hasUnread, isNot(true));
      expect(
        session
            .chatSummariesFor(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1')
            .any((s) => s.turnActive == true),
        isTrue,
        reason:
            'Cached tabs survive, but their old activity must not override a new worktree row',
      );
      publish(harness, worktreeRow('wt-1', streaming: true, unread: true));
      publish(harness, summaryBatch(running: false, unread: false));
      expect(
        row().isWorking,
        isTrue,
        reason: 'One idle chat cannot clear an active host aggregate',
      );
      expect(row().hasUnread, isTrue);
      publish(
        harness,
        overviewBatch(type: 'portal.state.delta', scope: 'worktree'),
      );
      expect(row().isWorking, isFalse);
      expect(row().hasUnread, isNot(true));
      harness.reset();
      harness.applySnapshot(initialOverview());
      expect(row().isWorking, isFalse);
    });

    test(
      'a concurrent sibling row cannot discard existing summary signals',
      () {
        final harness = RemoteStoresHarness()..applySnapshot(initialOverview());
        publish(harness, summaryBatch(running: true, unread: true));
        final baseline = harness.session.captureReadBaseline();
        publish(harness, worktreeRow('wt-2', streaming: true));
        final read = harness.applySnapshot(
          initialOverview(),
          baseline: baseline,
        );

        final worktrees = harness.session.allWorktrees;
        final first = worktrees.firstWhere((w) => w.localId == 'wt-1');
        expect(first.isWorking, isTrue);
        expect(first.hasUnread, isTrue);
        expect(worktrees, hasLength(2));
        expect(
          read.overviewRefresh,
          RemoteOverviewRefreshRequest.readRacedLiveShell,
        );
      },
    );

    for (final summaryDelivered in [false, true]) {
      test(
        'a slow cache read cannot erase newer ${summaryDelivered ? 'summary' : 'worktree'} activity',
        () {
          final harness = RemoteStoresHarness()
            ..applySnapshot(initialOverview());
          final baseline = harness.session.captureReadBaseline();
          publish(
            harness,
            summaryDelivered
                ? summaryBatch(running: true, unread: true)
                : worktreeRow('wt-1', streaming: true, unread: true),
          );
          expect(harness.session.allWorktrees.single.isWorking, isTrue);
          harness.applySnapshot(initialOverview(), baseline: baseline);
          expect(harness.session.allWorktrees.single.isWorking, isTrue);
          expect(harness.session.allWorktrees.single.hasUnread, isTrue);
        },
      );
    }
  });

  /// CAN-2318: the projected catalog and its authoritativeness must be
  /// derived from the SAME summaries in one pass.
  ///
  /// `mergeChatSummaries` upserts summaries individually, so an incremental
  /// policy refresh can leave a stale, unfiltered summary ahead of the newly
  /// filtered one. Deriving "first non-empty catalog" and "does any summary
  /// project?" independently produced a pair that never existed on the wire
  /// and kept offering a model the policy had just removed.
  group('projected model catalog', () {
    RemoteChatSummary projecting({
      required String chatId,
      required List<ModelOption> models,
    }) => RemoteChatSummary(
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      title: chatId,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      availableModels: models,
      // Wire-faithful: the desktop sets this whenever it sends the array.
      modelCatalogProjected: true,
    );

    const opus = ModelOption(
      id: 'claude-opus-5',
      label: 'Opus 5',
      provider: 'claude',
      kind: 'model',
      available: true,
    );
    const codex = ModelOption(
      id: 'gpt-6-codex',
      label: 'GPT-6 Codex',
      provider: 'codex',
      kind: 'model',
      available: true,
    );

    RemoteSessionStore withSummaries(List<RemoteChatSummary> summaries) =>
        (RemoteStoresHarness()
              ..applySnapshot(emptySnapshot.copyWith(chatSummaries: summaries)))
            .session;

    /// Delivers [summaries] as an incremental snapshot event so they are
    /// stamped with arrival order, the way a live policy refresh would be.
    void deliver(
      RemoteSessionStore session,
      List<RemoteChatSummary> summaries,
    ) => session.applySnapshotEvent(
      RemoteStateSnapshotEvent(chatSummaries: summaries),
    );

    List<String> ids(RemoteSessionStore session) => [
      for (final option in session.projectedModelCatalog) option.id,
    ];

    test('is the full catalog when every summary agrees', () {
      final session = withSummaries([
        projecting(chatId: 'a', models: const [opus, codex]),
        projecting(chatId: 'b', models: const [opus, codex]),
      ]);
      // The desktop attaches the same registry-wide catalog to every
      // summary, so the consistent case is unambiguous.
      expect(ids(session), const ['claude-opus-5', 'gpt-6-codex']);
    });

    /// Two summaries where only [updatedId] refreshes; the arrival stamps
    /// decide the winner.
    RemoteSessionStore deliverUpdate({
      required List<ModelOption> untouched,
      required String updatedId,
      required List<ModelOption> updated,
    }) {
      final session = withSummaries([
        projecting(chatId: 'untouched', models: untouched),
        projecting(chatId: updatedId, models: untouched),
      ]);
      deliver(session, [projecting(chatId: updatedId, models: updated)]);
      return session;
    }

    test('a later filtered projection supersedes a stale one', () {
      // An org policy lands and removes a model. Only one summary refreshes;
      // it wins even though the untouched one still offers more.
      final session = deliverUpdate(
        untouched: const [opus, codex],
        updatedId: 'filtered',
        updated: const [opus],
      );
      expect(session.projectedModelCatalogIsAuthoritative, isTrue);
      expect(ids(session), const ['claude-opus-5']);
    });

    test('a later all-blocked projection empties the catalog', () {
      // The policy blocks everything, so the refreshed summary is
      // authoritative AND empty. Preferring non-empty peers here would keep
      // offering models the policy just removed.
      final session = deliverUpdate(
        untouched: const [opus, codex],
        updatedId: 'blocked',
        updated: const [],
      );
      expect(session.projectedModelCatalogIsAuthoritative, isTrue);
      expect(session.projectedModelCatalog, isEmpty);
    });

    test('a healthy projection supersedes a startup-window empty', () {
      // The inverse: the desktop projects `[]` before its model registry
      // initializes, then the real catalog follows. Preferring the empty one
      // would permanently clear a legitimate pick.
      final session = deliverUpdate(
        untouched: const [],
        updatedId: 'healthy',
        updated: const [opus, codex],
      );
      expect(session.projectedModelCatalogIsAuthoritative, isTrue);
      expect(ids(session), const ['claude-opus-5', 'gpt-6-codex']);
    });

    test('a full snapshot does not resurrect a filtered-away model', () {
      // The regression: a full fetch used to leave incrementally-stamped
      // rows outranking its own fresh rows (when a group was preserved
      // wholesale), and then — once it stamped — a single shared stamp made
      // the winner fall out of list order. Either way a stale unfiltered
      // catalog could come back after a policy had already filtered it.
      // The stale row sorts FIRST, so list order favours the wrong answer.
      RemoteSessionSnapshot read(List<ModelOption> filtered) =>
          emptySnapshot.copyWith(
            chatSummaries: [
              projecting(chatId: 'stale', models: const [opus, codex]),
              projecting(chatId: 'filtered', models: filtered),
            ],
          );
      final harness = RemoteStoresHarness()
        ..applySnapshot(read(const [opus, codex]));
      final session = harness.session;

      // A policy lands and only the 'filtered' chat refreshes.
      deliver(session, [
        projecting(chatId: 'filtered', models: const [opus]),
      ]);
      expect(ids(session), const ['claude-opus-5']);

      // Now a full re-fetch lands carrying both rows. The filtered row is
      // still the newer projection and must stay the winner.
      harness.applySnapshot(
        read(const [opus]),
        baseline: session.captureReadBaseline(),
      );
      expect(session.projectedModelCatalogIsAuthoritative, isTrue);
      expect(ids(session), const ['claude-opus-5']);
    });

    test('drops everything when every projecting summary is empty', () {
      // The genuine all-blocked policy still has to fail closed.
      final session = withSummaries([
        projecting(chatId: 'a', models: const []),
        projecting(chatId: 'b', models: const []),
      ]);
      expect(session.projectedModelCatalogIsAuthoritative, isTrue);
      expect(session.projectedModelCatalog, isEmpty);
    });

    test('is not authoritative when no summary projected', () {
      final session = withSummaries([summary('chat-1')]);
      // "No models" and "we do not know yet" must stay distinguishable.
      expect(session.projectedModelCatalogIsAuthoritative, isFalse);
      expect(session.projectedModelCatalog, isEmpty);
    });

    test('a reset forgets arrival order and composer projections', () {
      final session = withSummaries([
        projecting(chatId: 'a', models: const [opus]),
      ]);
      deliver(session, [
        projecting(chatId: 'b', models: const [codex]),
      ]);
      final chat = (scope: RemoteChatScope.worktree, chatId: 'b');
      expect(session.composerProjectionSequenceFor(chat), isNotNull);
      session.reset();
      expect(session.snapshot, isNull);
      expect(session.composerProjectionSequenceFor(chat), isNull);
      expect(session.projectedModelCatalogIsAuthoritative, isFalse);
    });
  });

  group('pipeline run chat links (CAN-3619)', () {
    Map<String, dynamic> run(String id, {List<String>? turns}) => {
      'localId': id,
      'worktreeLocalId': 'wt-1',
      'status': 'running',
      if (turns != null)
        'chatTurns': [
          for (final turn in turns)
            {'chatId': 'chat-a', 'userMessageId': turn, 'relation': 'launched'},
        ],
    };
    RemoteSessionSnapshot read(List<Map<String, dynamic>> runs) =>
        emptySnapshot.copyWith(raw: {'pipelineRuns': runs});

    test('a re-read row without chatTurns keeps the held links; an explicit '
        'empty list clears them; a missing row stays removed', () {
      final harness = RemoteStoresHarness();
      final session = harness.session;
      List<dynamic> rows() => session.snapshot!.raw['pipelineRuns'] as List;

      harness.applySnapshot(
        read([
          run('exec-1', turns: ['u-1']),
          run('exec-2', turns: ['u-2']),
        ]),
      );
      harness.applySnapshot(read([run('exec-1'), run('exec-3')]));
      expect(rows().map((row) => row['localId']), ['exec-1', 'exec-3']);
      expect(rows().first['chatTurns'], [
        {'chatId': 'chat-a', 'userMessageId': 'u-1', 'relation': 'launched'},
      ]);
      expect((rows().last as Map).containsKey('chatTurns'), isFalse);

      harness.applySnapshot(read([run('exec-1', turns: const [])]));
      expect(rows().single['chatTurns'], isEmpty);
      harness.applySnapshot(read([run('exec-1')]));
      expect(rows().single['chatTurns'], isEmpty);
    });
  });

  group('chat summaries', () {
    test('summaries lost wholesale in a re-fetch are preserved', () {
      final harness = RemoteStoresHarness();
      final session = harness.session;
      List<RemoteChatSummary> tabs() => session.chatSummariesFor(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      RemoteSessionSnapshot read(List<RemoteChatSummary> summaries) =>
          emptySnapshot.copyWith(chatSummaries: summaries);

      harness.applySnapshot(
        read([summary('chat-a', title: 'Chat A'), summary('chat-b')]),
      );
      expect(tabs(), hasLength(2));

      // The server cache wipe (overview snapshot ingestion) surfaces as a
      // state re-fetch with the worktree's whole tab list missing: keep the
      // known tabs instead of flashing "no chats".
      harness.applySnapshot(read(const []));
      expect(tabs(), hasLength(2));

      // A partial/updated set for the worktree stays authoritative.
      harness.applySnapshot(
        read([summary('chat-a', title: 'Chat A (renamed)')]),
      );
      expect(tabs().single.title, 'Chat A (renamed)');
    });

    test('a re-fetch inherits pending questions it omits', () {
      const question = AskUserQuestionState(
        requestId: 'question-1',
        questions: [],
      );
      final harness = RemoteStoresHarness()
        ..applySnapshot(
          emptySnapshot.copyWith(
            chatSummaries: [
              summary('asked', pendingQuestions: const [question]),
              summary('cleared', pendingQuestions: const [question]),
            ],
          ),
        );
      harness.applySnapshot(
        emptySnapshot.copyWith(
          chatSummaries: [
            summary('asked'),
            summary('cleared', pendingQuestions: const []),
          ],
        ),
      );
      final byChat = {
        for (final s in harness.session.allChatSummaries)
          s.chatId: s.pendingQuestions,
      };
      expect(byChat['asked'], hasLength(1));
      expect(byChat['cleared'], isEmpty);
    });

    test('snapshot chat summaries render without waiting for a re-fetch', () {
      final harness = RemoteStoresHarness()..applySnapshot(emptySnapshot);
      final step = harness.apply(
        RemoteStateSnapshotEvent(
          scope: 'worktree',
          targetWorkspaceLocalId: 'ws-1',
          targetWorktreeLocalId: 'wt-1',
          chatSummaries: [summary('chat-1', title: 'Fix flaky test')],
        ),
      );
      // Tabs come straight from the event; the follow-up re-fetch the
      // facade queues for the resolved worktree only reconciles afterwards.
      expect(
        harness.session
            .chatSummariesFor(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1')
            .single
            .title,
        'Fix flaky test',
      );
      expect(step.resolvedWorktreeKeys, {wt1});
      expect(step.hydratedWorktreeTargets, {wt1});
      expect(step.chatHydrated, isNull);
    });

    test('a selected-chat snapshot replaces the worktree tabs it omits', () {
      final harness = RemoteStoresHarness()
        ..applySnapshot(
          emptySnapshot.copyWith(
            chatSummaries: [
              summary('closed'),
              summary('kept'),
              summary('other', worktree: 'wt-2'),
            ],
          ),
        );
      harness.apply(
        RemoteStateSnapshotEvent(
          scope: 'chat',
          selectedChatOnly: true,
          targetWorkspaceLocalId: 'ws-1',
          targetWorktreeLocalId: 'wt-1',
          chatSummaries: [summary('kept'), summary('opened')],
        ),
      );
      expect(
        [for (final s in harness.session.allChatSummaries) s.chatId],
        ['kept', 'other', 'opened'],
      );
    });

    test(
      'a selected-chat snapshot keeps tabs that arrived after its request',
      () {
        final harness = RemoteStoresHarness()
          ..applySnapshot(
            emptySnapshot.copyWith(
              chatSummaries: [summary('closed'), summary('kept')],
            ),
          );
        final requestedAt = harness.session.tabListMark;
        // The desktop read its tab list before this tab existed, but the tab's
        // delta landed first.
        harness.apply(
          RemoteStateDeltaEvent(chatSummaries: [summary('created')]),
        );
        harness.session.applySnapshotEvent(
          RemoteStateSnapshotEvent(
            scope: 'chat',
            selectedChatOnly: true,
            targetWorkspaceLocalId: 'ws-1',
            targetWorktreeLocalId: 'wt-1',
            chatSummaries: [summary('kept')],
          ),
          tabListBaseline: requestedAt,
        );
        expect(
          [for (final s in harness.session.allChatSummaries) s.chatId],
          ['kept', 'created'],
        );
      },
    );

    test('a snapshot read keeps tabs that arrived while it was in flight', () {
      final harness = RemoteStoresHarness()
        ..applySnapshot(
          emptySnapshot.copyWith(
            chatSummaries: [summary('closed'), summary('kept')],
          ),
        );
      final baseline = harness.session.captureReadBaseline();
      harness.apply(RemoteStateDeltaEvent(chatSummaries: [summary('created')]));
      final step = harness.applySnapshot(
        emptySnapshot.copyWith(chatSummaries: [summary('kept')]),
        baseline: baseline,
      );
      expect(
        [for (final s in harness.session.allChatSummaries) s.chatId],
        ['kept', 'created'],
      );
      expect(
        [for (final s in step.readsPrunedAgainst!.chatSummaries) s.chatId],
        ['kept', 'created'],
      );
    });

    test('merges report unread projections in delivery order', () {
      final harness = RemoteStoresHarness()..applySnapshot(emptySnapshot);
      final step = harness.apply(
        RemoteStateDeltaEvent(
          chatSummaries: [
            summary('a', unread: true),
            summary('b', scope: null, worktree: null),
          ],
        ),
      );
      expect(step.unreadProjections, [
        (chat: (scope: RemoteChatScope.worktree, chatId: 'a'), unread: true),
        (chat: (scope: RemoteChatScope.standalone, chatId: 'b'), unread: null),
      ]);
      expect(
        harness.session.composerProjectionSequenceFor((
          scope: RemoteChatScope.worktree,
          chatId: 'a',
        )),
        harness.session.composerProjectionSequence,
      );
    });
  });

  group('snapshot events', () {
    test('a targeted chat snapshot hands its own rows to the transcript', () {
      final harness = RemoteStoresHarness()..applySnapshot(emptySnapshot);
      final step = harness.session.applySnapshotEvent(
        RemoteStateSnapshotEvent(
          scope: 'chat',
          targetChatId: 'chat-1',
          targetChatScope: RemoteChatScope.worktree,
          chatMessagesTruncated: true,
          chatMessages: [
            wireRow('mine'),
            RemoteChatMessage.fromWireJson({
              'messageId': 'foreign',
              'chatId': 'chat-2',
              'role': 'assistant',
              'status': 'complete',
            }),
          ],
        ),
      );
      final update =
          step.transcriptUpdates.single as AuthoritativeTranscriptUpdate;
      expect(update.chat, sequenceChatKey);
      expect(update.truncated, isTrue);
      expect([for (final m in update.rows) m.messageId], ['mine']);
      expect(step.chatHydrated, sequenceChatKey);
      expect(step.changed, isTrue);
      // Chat snapshots carry their payload; no overview read follows them.
      expect(step.resolvedWorktreeKeys, isEmpty);
      expect(step.overviewRefresh, isNull);
    });

    test('a chat-scope snapshot resolves its foreground chat', () {
      final step = RemoteStoresHarness().apply(
        const RemoteStateSnapshotEvent(
          scope: 'chat',
          targetWorkspaceLocalId: 'ws-1',
          targetWorktreeLocalId: 'wt-1',
        ),
      );
      expect(step.foregroundHydrated, wt1);
      expect(step.resolvedWorktreeKeys, isEmpty);
      expect(step.hydratedWorktreeTargets, isEmpty);
      expect(step.changed, isTrue);
    });

    for (final (scope, resolvesPending) in [
      ('worktree', true),
      ('overview', false),
      ('chat', false),
    ]) {
      test('an untargeted $scope snapshot '
          '${resolvesPending ? 'resolves' : 'leaves'} pending worktrees', () {
        final step = RemoteStoresHarness().apply(
          RemoteStateSnapshotEvent(scope: scope),
        );
        expect(step.resolvesPendingWorktrees, resolvesPending);
        expect(step.resolvedWorktreeKeys, isEmpty);
      });
    }

    test(
      'a generic snapshot defers row resolution to its own session view',
      () {
        final harness = RemoteStoresHarness()..applySnapshot(emptySnapshot);
        final step = harness.session.applySnapshotEvent(
          RemoteStateSnapshotEvent(
            targetChatScope: RemoteChatScope.standalone,
            chatMessages: [wireRow('cached')],
            chatSummaries: [
              summary('chat-1', scope: RemoteChatScope.standalone),
            ],
          ),
        );
        final update = step.transcriptUpdates.single as IncomingChatRowsUpdate;
        expect(update.fallbackScope, RemoteChatScope.standalone);
        expect(update.preserveCacheProvenance, isTrue);
        expect(update.authoritativeSnapshot, isFalse);
        // Resolved before this event's summaries merged.
        expect(update.keySnapshot?.chatSummaries, isEmpty);
        expect(step.chatHydrated, isNull);
      },
    );

    test('PR statuses and progress travel with the snapshot', () {
      final harness = RemoteStoresHarness()..applySnapshot(initialOverview());
      const progress = {'ws-1:wt-1': RemotePrProgressState()};
      final step = harness.apply(
        RemoteStateSnapshotEvent(
          prProgress: progress,
          prStatuses: {
            'ws-1:wt-1': [
              const RemoteWorktreePr(prNumber: 3061, state: 'merged'),
            ],
          },
        ),
      );
      expect(step.prProgress, same(progress));
      expect(step.changed, isTrue);
      expect(
        harness.session.allWorktrees.single.prStatuses.single.state,
        'merged',
      );
    });
  });

  group('deltas', () {
    test('report setup failures, progress, and overview requests', () {
      final harness = RemoteStoresHarness()..applySnapshot(emptySnapshot);
      const progress = {'ws-1:wt-1': RemotePrProgressState()};
      final step = harness.apply(
        const RemoteStateDeltaEvent(
          requiresOverviewRefresh: true,
          prProgress: progress,
          worktreeSetupFailure: RemoteWorktreeSetupFailure(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-new',
            error: 'git worktree add failed',
          ),
        ),
      );
      expect(step.changed, isTrue);
      expect(step.worktreeSetupFailure, (
        worktree: remoteWorktreeKey('ws-1', 'wt-new'),
        error: 'git worktree add failed',
      ));
      expect(step.prProgress, same(progress));
      expect(step.overviewRefresh, RemoteOverviewRefreshRequest.deltaRequested);
    });

    test('worktree rows upsert and replace the snapshot object', () {
      final harness = RemoteStoresHarness()..applySnapshot(initialOverview());
      final before = harness.session.snapshot!;
      final beforeWorktrees = before.worktrees;
      final step = harness.apply(
        RemoteStateDeltaEvent(
          scope: 'worktree',
          worktrees: [sequenceWorktree('wt-2')],
        ),
      );
      expect(step.changed, isTrue);
      expect(harness.session.snapshot, isNot(same(before)));
      // The previous snapshot is never mutated: memoized reads key on it.
      expect(before.worktrees, same(beforeWorktrees));
      expect(before.worktrees, hasLength(1));
      expect(
        [for (final w in harness.session.allWorktrees) w.localId],
        ['wt-1', 'wt-2'],
      );
    });

    test('overview-scoped rows only apply as a chunk continuation', () {
      final harness = RemoteStoresHarness()..applySnapshot(initialOverview());
      final step = harness.apply(
        RemoteStateDeltaEvent(
          scope: 'overview',
          eventId: 'unrelated',
          workspaces: const [sequenceWorkspace],
          worktrees: [sequenceWorktree('wt-2')],
        ),
      );
      expect(step.changed, isFalse);
      expect(harness.session.allWorktrees, hasLength(1));
    });
  });

  group('HTTP snapshot reads', () {
    test('report pruned reads, unread projections, and every row', () {
      final harness = RemoteStoresHarness();
      final read = emptySnapshot.copyWith(
        standaloneChats: const [
          RemoteStandaloneChat(
            localId: 'solo',
            projectLocalId: 'ws-1',
            title: 'Solo',
            hasUnread: true,
          ),
        ],
        chatSummaries: [summary('chat-1', unread: false)],
        chatMessages: [wireRow('row')],
      );
      final step = harness.applySnapshot(read);
      expect(step.readsPrunedAgainst, same(read));
      expect(step.unreadProjections, [
        (
          chat: (scope: RemoteChatScope.worktree, chatId: 'chat-1'),
          unread: false,
        ),
        (
          chat: (scope: RemoteChatScope.standalone, chatId: 'solo'),
          unread: true,
        ),
      ]);
      final update = step.transcriptUpdates.single as IncomingChatRowsUpdate;
      expect(update.authoritativeSnapshot, isTrue);
      expect(update.keySnapshot, same(harness.session.snapshot));
      expect(step.overviewRefresh, isNull);
      expect(harness.rowIds(sequenceChat), ['row']);
    });

    test('a read racing a live shell patch keeps the patch', () {
      final harness = RemoteStoresHarness()..applySnapshot(initialOverview());
      final baseline = harness.session.captureReadBaseline();
      harness.apply(overviewHead('head', [sequenceWorktree('wt-live')]));
      final step = harness.applySnapshot(initialOverview(), baseline: baseline);
      expect(
        [for (final w in harness.session.allWorktrees) w.localId],
        ['wt-live'],
      );
      expect(
        step.overviewRefresh,
        RemoteOverviewRefreshRequest.readRacedLiveShell,
      );
      // The live head stays the anchor for its continuation chunks.
      harness.apply(overviewChunk('head:chunk-1', [sequenceWorktree('wt-2')]));
      expect(harness.session.allWorktrees, hasLength(2));
    });

    RemoteSessionSnapshot shellRead(List<String> worktreeIds, int cursor) =>
        RemoteSessionSnapshot(
          workspaces: const [sequenceWorkspace],
          worktrees: [for (final id in worktreeIds) sequenceWorktree(id)],
          standaloneChats: const [],
          eventCursor: cursor,
        );

    List<String> worktreeIds(RemoteStoresHarness harness) => [
      for (final w in harness.session.allWorktrees) w.localId,
    ];

    test('a replay the read already covers cannot roll the shell back', () {
      final harness = RemoteStoresHarness()..applySnapshot(initialOverview());
      harness.applySnapshot(shellRead(['wt-1', 'wt-2', 'wt-3'], 100));

      // A backlog page from before the read: an older overview, its chunk,
      // a stale worktree row, and a stale PR status.
      final covered = harness.applyBatch([
        overviewHead('old', [sequenceWorktree('wt-1', label: 'stale')]),
        overviewChunk('old:chunk-1', [sequenceWorktree('wt-2', label: 'old')]),
        RemoteStateDeltaEvent(
          scope: 'worktree',
          worktrees: [sequenceWorktree('wt-3', label: 'stale')],
        ),
        RemoteStateDeltaEvent(
          prStatuses: {
            'ws-1:wt-1': [RemoteWorktreePr(prNumber: 1, state: 'open')],
          },
        ),
      ], cursor: 60);
      expect(worktreeIds(harness), ['wt-1', 'wt-2', 'wt-3']);
      expect(
        [for (final w in harness.session.allWorktrees) w.label],
        [null, null, null],
      );
      expect(harness.session.allWorktrees.first.prStatuses, isEmpty);
      expect(covered.any((step) => step.changed), isFalse);

      // The page that crosses the read's cursor applies in event order, so a
      // newer overview inside it lands.
      harness.applyBatch([
        overviewHead('new', [
          for (final id in ['wt-1', 'wt-2', 'wt-3', 'wt-4'])
            sequenceWorktree(id),
        ], cursor: 101),
      ], cursor: 101);
      expect(worktreeIds(harness), ['wt-1', 'wt-2', 'wt-3', 'wt-4']);
    });

    test('a mixed replay page keeps the shell from the newer read', () {
      final harness = RemoteStoresHarness()
        ..applySnapshot(shellRead(['wt-1', 'wt-2'], 100));

      harness.applyBatch([
        overviewHead('old', [sequenceWorktree('wt-stale')], cursor: 99),
        liveRow(wireRow('new-chat-row')),
        RemoteStateDeltaEvent(
          cursor: 101,
          scope: 'worktree',
          worktrees: [sequenceWorktree('wt-2', label: 'fresh')],
        ),
      ], cursor: 101);

      expect(worktreeIds(harness), ['wt-1', 'wt-2']);
      expect(harness.session.allWorktrees.last.label, 'fresh');
      expect(
        harness.transcripts.projectedRows(sequenceChatKey),
        contains(
          predicate<RemoteChatMessage>(
            (row) => row.messageId == 'new-chat-row',
          ),
        ),
      );
    });

    test('an uncursored shell event requests a read on a mixed page', () {
      final harness = RemoteStoresHarness()
        ..applySnapshot(shellRead(['wt-1', 'wt-2'], 100));
      final steps = harness.applyBatch([
        overviewHead('old', [sequenceWorktree('wt-stale')]),
        liveRow(wireRow('new-chat-row')),
      ], cursor: 101);

      expect(worktreeIds(harness), ['wt-1', 'wt-2']);
      expect(
        steps.first.overviewRefresh,
        RemoteOverviewRefreshRequest.uncursoredShellEvent,
      );
    });

    test('a chunk of a covered head still extends a later page', () {
      final harness = RemoteStoresHarness()
        ..applySnapshot(shellRead(['wt-1'], 100));
      harness.applyBatch([
        overviewHead('head', [sequenceWorktree('wt-1')]),
      ], cursor: 100);
      // The server cache upserts the chunk past the read's cursor too.
      harness.applyBatch([
        overviewChunk('head:chunk-1', [sequenceWorktree('wt-2')], cursor: 101),
      ], cursor: 101);
      expect(worktreeIds(harness), ['wt-1', 'wt-2']);
    });

    for (final (cursor, keepsLive) in [(50, false), (120, true)]) {
      test('a read raced by a page at cursor $cursor '
          '${keepsLive ? 'keeps the live shell' : 'adopts the read'}', () {
        final harness = RemoteStoresHarness()
          ..applySnapshot(shellRead(['wt-1'], 10));
        final baseline = harness.session.captureReadBaseline();
        harness.applyBatch([
          overviewHead('replayed', [
            sequenceWorktree('wt-live'),
          ], cursor: cursor),
        ], cursor: cursor);
        final step = harness.applySnapshot(
          shellRead(['wt-1', 'wt-2', 'wt-3'], 100),
          baseline: baseline,
        );
        expect(
          worktreeIds(harness),
          keepsLive ? ['wt-live'] : ['wt-1', 'wt-2', 'wt-3'],
        );
        expect(
          step.overviewRefresh,
          keepsLive ? RemoteOverviewRefreshRequest.readRacedLiveShell : isNull,
        );
      });
    }

    test('a read without a cursor covers no page', () {
      final harness = RemoteStoresHarness()..applySnapshot(initialOverview());
      harness.applyBatch([
        RemoteStateDeltaEvent(
          scope: 'worktree',
          worktrees: [sequenceWorktree('wt-1', label: 'live')],
        ),
      ], cursor: 0);
      expect(harness.session.allWorktrees.single.label, 'live');
    });

    test('a reset forgets the covered cursor', () {
      final harness = RemoteStoresHarness()
        ..applySnapshot(shellRead(['wt-1'], 100));
      harness.reset();
      harness.applySnapshot(shellRead(['wt-1'], 5));
      harness.applyBatch([
        overviewHead('head', [
          sequenceWorktree('wt-1'),
          sequenceWorktree('wt-2'),
        ], cursor: 6),
      ], cursor: 6);
      expect(worktreeIds(harness), ['wt-1', 'wt-2']);
    });
  });

  group('incoming chat ids', () {
    RemoteSessionStore store({
      List<RemoteChatSummary> summaries = const [],
      List<RemoteStandaloneChat> standalone = const [],
      List<RemoteChatKey> known = const [],
    }) =>
        RemoteSessionStore(
          orderWorktrees: List.unmodifiable,
          knownChatKeys: () => known,
          isLocallyRead: (_, _) => false,
          hasLocalReads: () => false,
        )..applySnapshot(
          emptySnapshot.copyWith(
            chatSummaries: summaries,
            standaloneChats: standalone,
          ),
        );

    test('an explicit scope wins', () {
      expect(store().chatKeyForIncoming('chat-1', RemoteChatScope.standalone), (
        scope: RemoteChatScope.standalone,
        chatId: 'chat-1',
      ));
      expect(store().chatKeyForIncoming('', RemoteChatScope.worktree), isNull);
    });

    test('a bare id resolves only when exactly one namespace knows it', () {
      expect(
        store(
          summaries: [summary('chat-1')],
        ).chatKeyForIncoming('chat-1', null),
        (scope: RemoteChatScope.worktree, chatId: 'chat-1'),
      );
      expect(
        store(
          known: [(scope: RemoteChatScope.standalone, chatId: 'chat-1')],
        ).chatKeyForIncoming('chat-1', null),
        (scope: RemoteChatScope.standalone, chatId: 'chat-1'),
      );
      expect(
        store(
          summaries: [summary('chat-1')],
          standalone: const [
            RemoteStandaloneChat(
              localId: 'chat-1',
              projectLocalId: 'ws-1',
              title: 'Solo',
            ),
          ],
        ).chatKeyForIncoming('chat-1', null),
        isNull,
      );
      expect(store().chatKeyForIncoming('chat-1', null), isNull);
    });
  });

  group('derived reads', () {
    test('local read receipts clear unread overlays', () {
      final read = <String>{};
      final session =
          RemoteSessionStore(
            orderWorktrees: List.unmodifiable,
            knownChatKeys: () => const [],
            isLocallyRead: (_, chatId) => read.contains(chatId),
            hasLocalReads: () => read.isNotEmpty,
          )..applySnapshot(
            RemoteSessionSnapshot(
              workspaces: const [sequenceWorkspace],
              worktrees: [sequenceWorktree('wt-1').withUnread(true)],
              standaloneChats: const [
                RemoteStandaloneChat(
                  localId: 'solo',
                  projectLocalId: 'ws-1',
                  title: 'Solo',
                  hasUnread: true,
                ),
              ],
              chatSummaries: [
                summary('a', unread: true),
                summary('b', unread: true),
              ],
            ),
          );
      read.add('a');
      expect(
        session.allWorktrees.single.hasUnread,
        isTrue,
        reason: 'An unread sibling keeps the aggregate',
      );
      read.addAll(['b', 'solo']);
      expect(session.allWorktrees.single.hasUnread, isFalse);
      expect(
        session.allChatSummaries.every((s) => s.hasUnread == false),
        isTrue,
      );
      expect(session.standaloneChatById('solo')?.hasUnread, isFalse);
    });

    test('worktrees read in the injected order', () {
      final session =
          RemoteSessionStore(
            orderWorktrees: (worktrees) => List.unmodifiable(
              worktrees.toList()
                ..sort((a, b) => b.localId.compareTo(a.localId)),
            ),
            knownChatKeys: () => const [],
            isLocallyRead: (_, _) => false,
            hasLocalReads: () => false,
          )..applySnapshot(
            RemoteSessionSnapshot(
              workspaces: const [sequenceWorkspace],
              worktrees: [sequenceWorktree('a'), sequenceWorktree('b')],
              standaloneChats: const [],
            ),
          );
      expect([for (final w in session.allWorktrees) w.localId], ['b', 'a']);
      expect(
        [for (final w in session.worktreesFor('ws-1')) w.localId],
        ['b', 'a'],
      );
    });
  });

  group('deterministic sequences', () {
    test(cachedHistoryThenAuthoritative.name, () async {
      final harness = RemoteStoresHarness();
      await harness.run(cachedHistoryThenAuthoritative.steps);

      final worktrees = harness.session.allWorktrees;
      expect([
        for (final w in worktrees) w.localId,
      ], cachedHistoryThenAuthoritative.expectedWorktreeIds);
      expect(worktrees.first.label, 'renamed');
      final chunks = [
        for (final step in harness.effects.skip(3).take(3)) step.changed,
      ];
      expect(chunks, [true, false, false]);
      expect(harness.effects[2].chatHydrated, sequenceChatKey);
    });

    test(sessionResetBetweenBatches.name, () async {
      final harness = RemoteStoresHarness();
      await harness.run(sessionResetBetweenBatches.steps);

      final worktrees = harness.session.allWorktrees;
      expect([
        for (final w in worktrees) w.localId,
      ], sessionResetBetweenBatches.expectedWorktreeIds);
      expect(worktrees.single.isWorking, isFalse);
      expect(
        harness.session.composerProjectionSequenceFor(sequenceChatKey),
        isNull,
      );
      expect(harness.session.allChatSummaries, isEmpty);
      expect(
        harness.effects.last.changed,
        isFalse,
        reason: "The old head's continuation is foreign to the new session",
      );
    });

    test(lateStreamingAfterTerminal.name, () async {
      final harness = RemoteStoresHarness();
      await harness.run(lateStreamingAfterTerminal.steps);
      expect(
        harness.effects.every(
          (step) =>
              step.overviewRefresh == null && step.resolvedWorktreeKeys.isEmpty,
        ),
        isTrue,
      );
    });
  });
  group('merge queue carry-over (CAN-4454)', () {
    final url = mergeQueuePrUrl(4454);
    Map<String, dynamic> rowEntity(Map<String, dynamic>? mergeQueue) => {
      'entityType': 'worktree',
      'localId': 'wt-1',
      'parentLocalId': 'ws-1',
      'payload': {
        ...overviewWorktree(includeLocalId: false),
        'lastKnownPrStatus': {
          'repos': [mergeQueueRepo(4454, mergeQueue: mergeQueue)],
        },
      },
    };
    Map<String, dynamic> prStatusEntity({
      int number = 4454,
      String state = 'open',
      String? prUrl,
    }) => {
      'entityType': 'pr_status',
      'localId': 'wt-1',
      'parentLocalId': 'ws-1:wt-1',
      'payload': {
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
        'repos': [
          {
            'repoId': 'repo-app',
            'status': {'number': number, 'state': state, 'url': ?prUrl},
          },
        ],
      },
    };
    RemotePortalEvent delta(List<Map<String, dynamic>> entities) =>
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.state.delta',
              'payload': {'scope': 'worktree', 'entities': entities},
            },
          ],
        }).events.single;
    RemoteStoresHarness seeded() => RemoteStoresHarness()
      ..applySnapshot(
        RemoteSessionSnapshot.fromJson({
          'workspaces': [overviewWorkspace()],
          'worktrees': [overviewWorktree()],
          'standaloneChats': <Object>[],
        }),
      );
    RemoteWorktreePr prOf(RemoteStoresHarness harness) =>
        harness.session.snapshot!.worktrees.single.prStatuses.single;

    test('a pr_status update keeps the row queue state until a row clears '
        'it', () {
      final harness = seeded()
        ..apply(delta([rowEntity(queued(position: 2, phase: 'locked'))]))
        ..apply(delta([prStatusEntity(prUrl: url)]));
      expect(prOf(harness).isInMergeQueue, isTrue);
      expect(prOf(harness).mergeQueue!.position, 2);
      expect(prOf(harness).mergeQueue!.phase, RemotePrMergeQueuePhase.locked);

      harness
        ..apply(
          delta([
            rowEntity(const {'inQueue': false}),
          ]),
        )
        ..apply(delta([prStatusEntity(prUrl: url)]));
      expect(prOf(harness).isInMergeQueue, isFalse);
    });

    test('a row and pr_status in one delta keep the row value', () {
      final harness = seeded()
        ..apply(
          delta([rowEntity(queued(position: 1)), prStatusEntity(prUrl: url)]),
        );
      expect(prOf(harness).mergeQueue!.position, 1);
    });

    test(
      'seeded row and pr_status sequences hold the carry-over invariant',
      () {
        // Model: rows are the only queue source; an open or draft pr_status
        // for the same PR (URL, or number without URL) keeps the value, and
        // anything else drops it.
        for (var seed = 1; seed <= 40; seed++) {
          final random = Random(seed);
          final harness = seeded();
          RemotePrMergeQueue? expected;
          var expectedState = 'open';
          (int, String?) previous = (3061, null);
          final steps = <String>[];
          void row(Map<String, dynamic>? mergeQueue) {
            harness.apply(delta([rowEntity(mergeQueue)]));
            expected = RemotePrMergeQueue.tryParse(mergeQueue);
            expectedState = 'open';
            previous = (4454, url);
          }

          void prStatus(int number, String state, String? prUrl) {
            harness.apply(
              delta([
                prStatusEntity(number: number, state: state, prUrl: prUrl),
              ]),
            );
            final same = prUrl != null
                ? prUrl == previous.$2
                : number == previous.$1;
            if (!(same && (state == 'open' || state == 'draft'))) {
              expected = null;
            }
            expectedState = state;
            previous = (number, prUrl);
          }

          for (var step = 0; step < 30; step++) {
            final choice = random.nextInt(8);
            steps.add('$choice');
            switch (choice) {
              case 0:
                row(
                  queued(
                    position: random.nextBool() ? random.nextInt(5) + 1 : null,
                    phase: const [
                      'queued',
                      'awaiting_checks',
                      'unmergeable',
                      'future',
                    ][random.nextInt(4)],
                  ),
                );
              case 1:
                row(const {'inQueue': false});
              case 2:
                row(null);
              case 3:
                prStatus(4454, random.nextBool() ? 'open' : 'draft', url);
              case 4:
                prStatus(4454, random.nextBool() ? 'merged' : 'closed', url);
              case 5:
                prStatus(4454, 'open', null);
              case 6:
                prStatus(99, 'open', mergeQueuePrUrl(99));
              case 7:
                harness.apply(
                  delta([
                    rowEntity(queued(position: 3)),
                    prStatusEntity(prUrl: url),
                  ]),
                );
                expected = const RemotePrMergeQueue(inQueue: true, position: 3);
                expectedState = 'open';
                previous = (4454, url);
            }
            final pr = prOf(harness);
            final reason = 'seed $seed steps ${steps.join(',')}';
            expect(pr.state, expectedState, reason: reason);
            expect(pr.mergeQueue?.inQueue, expected?.inQueue, reason: reason);
            expect(pr.mergeQueue?.position, expected?.position, reason: reason);
            expect(pr.mergeQueue?.phase, expected?.phase, reason: reason);
            expect(
              pr.isInMergeQueue,
              expectedState == 'open' && expected?.inQueue == true,
              reason: reason,
            );
          }
        }
      },
    );
  });
}
