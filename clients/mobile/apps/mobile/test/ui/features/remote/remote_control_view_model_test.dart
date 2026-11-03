import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_diff_cache.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show kRemoteFreshResumeAfter, kRemoteSessionCacheBudget;
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/memory_remote_transcript_storage.dart';
import '../../../support/overview_snapshot_fixture.dart';
import '../../../support/remote_hydration_fixture.dart';

/// Repository test double that always fails [connect] with the given error.
final class _FailingRepository extends FakeRemoteControlRepository {
  @override
  Future<RemoteConnection> connect(String pairingCode) =>
      throw const RemoteControlException('nope');

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() =>
      throw const RemoteControlException('nope');
}

final class _SlowConnectRepository extends FakeRemoteControlRepository {
  final connectCompleter = Completer<RemoteConnection>();

  @override
  Future<RemoteConnection> connect(String pairingCode) =>
      connectCompleter.future;
}

final class _SlowForegroundRepository extends FakeRemoteControlRepository {
  final metadata = Completer<RemoteConnection?>();

  @override
  Future<RemoteConnection?> refreshSessionMetadata() => metadata.future;
}

final class _GatedHydrationRepository extends FakeRemoteControlRepository {
  final request = Completer<String?>();
  final cache = Completer<List<RemoteChatMessage>>();

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) =>
      request.future;

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) => cache.future;
}

final class _UnknownSessionProbeRepository extends FakeRemoteControlRepository {
  @override
  Future<RemoteSessionProbe> probeSession() async =>
      const (outcome: RemoteSessionProbeOutcome.unknown, connection: null);
}

final class _SequencedActivityRepository extends FakeRemoteControlRepository {
  final reads = <Completer<({Map<String, dynamic> slices, bool refreshing})>>[];

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreeStateSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    final read = Completer<({Map<String, dynamic> slices, bool refreshing})>();
    reads.add(read);
    return read.future;
  }
}

final class _SnapshotRetryRepository extends FakeRemoteControlRepository {
  var failNextSnapshot = true;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    snapshotFetches += 1;
    if (failNextSnapshot) {
      failNextSnapshot = false;
      throw const RemoteControlException('snapshot unavailable');
    }
    return const RemoteSessionSnapshot(
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-recovered',
          name: 'Recovered workspace',
          rootPath: '~/code/recovered',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: [],
      standaloneChats: [],
    );
  }
}

final class _TerminalBeforeAckPrRepository extends FakeRemoteControlRepository {
  @override
  Future<RemotePortalCommandResult> runPrAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required RemotePrAction action,
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) async {
    eventsController.add(
      const RemotePortalEventBatch(
        events: [
          RemoteCommandCompletedEvent(
            commandId: 'pr-before-ack',
            result: {'repos': []},
          ),
        ],
        nextCursor: 1,
      ),
    );
    await Future<void>.delayed(Duration.zero);
    return const RemotePortalCommandResult(commandId: 'pr-before-ack');
  }
}

/// A background that outlasts a pending chat load's watchdog yet stays under
/// [kRemoteFreshResumeAfter], so the return resumes the event stream.
const Duration _warmBackground = Duration(seconds: 59);

void main() {
  // CAN-4875: a PR action's effect arrives in its `pr` delta; the overview
  // carries no PR activity, so no overview read follows.
  test('inline PR mutation result reads no overview', () async {
    final repository = FakeRemoteControlRepository()
      ..supportsPrActions = true
      ..prCommandResponse = const RemotePortalCommandResult(
        commandId: 'pr-inline',
        result: {'repos': []},
      );
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    addTearDown(vm.dispose);
    addTearDown(repository.eventsController.close);
    await vm.connect('123456');
    final fetchesAfterConnect = repository.snapshotFetches;

    await vm.runPrAction(
      const RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feature',
      ),
      RemotePrAction.create,
      repoId: 'app',
    );
    await Future<void>.delayed(Duration.zero);

    expect(repository.snapshotFetches, fetchesAfterConnect);
  });

  test('terminal-before-ack PR mutation result reads no overview', () async {
    final repository = _TerminalBeforeAckPrRepository()
      ..supportsPrActions = true;
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    addTearDown(vm.dispose);
    addTearDown(repository.eventsController.close);
    await vm.connect('123456');
    final fetchesAfterConnect = repository.snapshotFetches;

    await vm.runPrAction(
      const RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feature',
      ),
      RemotePrAction.merge,
      repoId: 'app',
    );
    await Future<void>.delayed(Duration.zero);

    expect(repository.snapshotFetches, fetchesAfterConnect);
  });

  test(
    'PR acknowledgement stays pending until the desktop completes the command',
    () async {
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true
        ..prCommandResponse = const RemotePortalCommandResult(
          commandId: 'pr-1',
        );
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      var complete = false;
      final pending = vm
          .runPrAction(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'feature',
            ),
            RemotePrAction.refresh,
          )
          .then((value) {
            complete = true;
            return value;
          });
      await Future<void>.delayed(Duration.zero);
      expect(complete, isFalse);
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandCompletedEvent(
              commandId: 'pr-1',
              result: {'repos': [], 'busy': false},
            ),
          ],
          nextCursor: 1,
        ),
      );
      expect(await pending, {'repos': [], 'busy': false});
    },
  );

  test(
    'PR terminal failure racing ahead of the HTTP acknowledgement is surfaced',
    () async {
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true
        ..prCommandResponse = const RemotePortalCommandResult(
          commandId: 'pr-1',
        );
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              commandId: 'pr-1',
              message: 'Merge rejected',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await expectLater(
        vm.runPrAction(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature',
          ),
          RemotePrAction.merge,
          repoId: 'app',
        ),
        throwsA(isA<RemoteControlException>()),
      );
    },
  );

  test(
    'workspace order has a deterministic fallback across payload permutations',
    () async {
      var rows = <Map<String, dynamic>>[
        {'localId': 'z', 'order': 1},
        {'localId': 'b'},
        {'localId': 'a', 'order': 1},
        {'localId': 'c', 'order': -0.5},
        {'localId': 'd'},
      ];
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () =>
            RemoteSessionSnapshot.fromJson({'workspaces': rows});
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      expect(vm.workspaces.map((w) => w.localId), ['c', 'a', 'z', 'b', 'd']);
      rows = rows.reversed.toList();
      await vm.refresh();
      expect(vm.workspaces.map((w) => w.localId), ['c', 'a', 'z', 'b', 'd']);
    },
  );

  group('RemoteControlViewModel', () {
    RemoteControlViewModel build() => RemoteControlViewModel(
      repository: MockRemoteControlRepository(latency: Duration.zero),
    );

    test(
      'demo watcher deletion uses its session and removes the live row',
      () async {
        final vm = build();
        addTearDown(vm.dispose);
        await vm.connect('123456');
        final worktree = vm
            .worktreesFor('ws-app')
            .firstWhere((w) => w.localId == 'wt-feature-auth');
        await vm.refreshWorktreeActivity(
          workspaceLocalId: worktree.workspaceLocalId,
          worktreeLocalId: worktree.localId,
        );
        expect(
          vm
              .watchersForChat(
                worktree.localId,
                'chat-auth-plan',
                workspaceLocalId: worktree.workspaceLocalId,
              )
              .map((w) => w.id),
          contains('watch-pr'),
        );
        await vm.deleteWatcher('watch-pr', notifySubscriber: false);
        await Future<void>.delayed(Duration.zero);
        expect(
          vm
              .watchersForChat(
                worktree.localId,
                'chat-auth-plan',
                workspaceLocalId: worktree.workspaceLocalId,
              )
              .map((w) => w.id),
          isNot(contains('watch-pr')),
        );
        await vm.disconnect();
        await expectLater(
          vm.deleteWatcher('watch-ci', notifySubscriber: false),
          throwsA(
            isA<RemoteWatcherDeleteException>().having(
              (error) => error.failure,
              'failure',
              RemoteWatcherDeleteFailure.forbidden,
            ),
          ),
        );
      },
    );

    test(
      'active workspace and unmatched lists exclude archived chats',
      () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [
              {'localId': 'default', 'name': 'Default', 'type': 'cowork'},
            ],
            'worktrees': [],
            'standaloneChats': [
              {
                'localId': 'active',
                'projectLocalId': 'default',
                'title': 'ping',
                'description': 'Network connectivity test',
              },
              {
                'localId': 'archived',
                'projectLocalId': 'default',
                'title': 'New Chat',
                'archived': true,
              },
              {
                'localId': 'orphan',
                'projectLocalId': 'missing',
                'title': 'Old',
                'archived': true,
              },
            ],
          });
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        await vm.connect('123456');
        expect(vm.standaloneChatsFor('default').map((c) => c.localId), [
          'active',
        ]);
        expect(vm.unmatchedStandaloneChats, isEmpty);
      },
    );

    test(
      'overview replaces shell metadata and removals without resolving hydration',
      () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [
              overviewWorkspace(),
              {'localId': 'removed-workspace', 'name': 'Removed'},
            ],
            'worktrees': [
              overviewWorktree(),
              {...overviewWorktree(), 'localId': 'removed-worktree'},
            ],
          });
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        repository.eventsController.add(overviewBatch());
        await Future<void>.delayed(Duration.zero);
        expect(vm.workspaces.single.name, 'Renamed repository');
        expect(vm.allWorktrees.single.status, 'done');
        expect(vm.allWorktrees.single.prStatuses.single.state, 'merged');
        expect(
          vm.isWorktreeChatsLoading(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          isTrue,
        );
        repository.eventsController.add(
          overviewBatch(scope: 'chat', entities: []),
        );
        await Future<void>.delayed(Duration.zero);
        expect(vm.allWorktrees, hasLength(1));
        repository.eventsController.add(overviewBatch(entities: []));
        await Future<void>.delayed(Duration.zero);
        expect(vm.workspaces, isEmpty);
        expect(vm.allWorktrees, isEmpty);
        expect(repository.snapshotFetches, 1);
      },
    );

    test(
      'overview continuation chunks restore shell entities across batches',
      () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = initialOverview;
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        void send(String type, String id, List<Map<String, dynamic>> entities) {
          repository.eventsController.add(
            RemotePortalEventBatch.fromJson({
              'events': [
                {
                  'eventId': id,
                  'type': type,
                  'payload': {'scope': 'overview', 'entities': entities},
                },
              ],
              'nextCursor': 3,
            }),
          );
        }

        send('portal.state.snapshot', 'overview-1', [
          {
            'entityType': 'workspace',
            'localId': 'ws-1',
            'payload': overviewWorkspace(includeLocalId: false),
          },
        ]);
        await Future<void>.delayed(Duration.zero);
        send('portal.state.delta', 'overview-1:chunk-1', [
          {
            'entityType': 'worktree',
            'localId': 'wt-1',
            'parentLocalId': 'ws-1',
            'payload': overviewWorktree(state: 'merged', includeLocalId: false),
          },
        ]);
        await Future<void>.delayed(Duration.zero);
        expect(vm.workspaces.single.localId, 'ws-1');
        expect(vm.allWorktrees.single.prStatuses.single.state, 'merged');
        send('portal.state.snapshot', 'overview-2', []);
        await Future<void>.delayed(Duration.zero);
        send('portal.state.delta', 'overview-1:chunk-2', [
          {
            'entityType': 'worktree',
            'localId': 'wt-1',
            'parentLocalId': 'ws-1',
            'payload': overviewWorktree(includeLocalId: false),
          },
        ]);
        await Future<void>.delayed(Duration.zero);
        expect(vm.allWorktrees, isEmpty);
        expect(repository.snapshotFetches, 1);
      },
    );

    test(
      'groups entry chats within each workspace and aggregates activity',
      () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [
              {'localId': 'default', 'name': 'Default', 'type': 'cowork'},
            ],
            'standaloneChats': [
              {
                'localId': 'first',
                'projectLocalId': 'default',
                'title': 'First',
                'workEntryId': 'entry',
                'workEntryTitle': 'Renamed',
                'hasUnread': true,
              },
              {
                'localId': 'second',
                'projectLocalId': 'default',
                'title': 'Second',
                'workEntryId': 'entry',
                'workEntryTitle': 'Renamed',
                'hasActiveChat': true,
              },
              {
                'localId': 'third',
                'projectLocalId': 'missing',
                'title': 'Other workspace',
                'workEntryId': 'entry',
              },
              {
                'localId': 'legacy',
                'projectLocalId': 'default',
                'title': 'Legacy',
              },
            ],
          });
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        await vm.connect('123456');
        final rows = vm.standaloneChatsFor('default');
        expect(rows.map((chat) => chat.localId), ['first', 'legacy']);
        expect(rows.first.hasUnread, isTrue);
        expect(rows.first.hasActiveChat, isTrue);
        expect(vm.standaloneChatById('second')?.title, 'Second');
        expect(vm.unmatchedStandaloneChats.single.localId, 'third');
        await vm.disconnect();
        await vm.connect('123456');
        expect(vm.standaloneChatsFor('default').length, 2);
      },
    );

    test(
      'overview preserves syncing and refresh invalidates old chunks',
      () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot(
            workspaces: initialOverview().workspaces,
            worktrees: initialOverview().worktrees,
            standaloneChats: const [],
            refreshing: true,
          );
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        repository.eventsController.add(overviewBatch());
        await Future<void>.delayed(Duration.zero);
        expect(vm.isSyncing, isTrue);
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [],
        );
        await vm.refresh();
        repository.eventsController.add(
          overviewBatch(
            type: 'portal.state.delta',
            eventId: 'overview-1:chunk-1',
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(vm.allWorktrees, isEmpty);
        expect(vm.workspaces, isEmpty);
      },
    );

    test('applies pr_status progress without fetching the overview', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      final fetchesAfterConnect = repository.snapshotFetches;

      repository.eventsController.add(
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
                      'creationProgress': {
                        'currentPhase': 'summarizing',
                        'steps': [
                          {'phase': 'gathering_changes'},
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      await Future<void>.delayed(Duration.zero);

      expect(
        vm.prProgressFor('ws-1', 'wt-1')!.creation!.currentPhase,
        RemotePrCreationPhase.summarizing,
      );

      // Progress-only events do not invalidate the overview.
      await Future<void>.delayed(kRemoteStateRefreshDebounce * 2);
      expect(repository.snapshotFetches, fetchesAfterConnect);
    });

    test('reconciles a refresh discarded after a PR-status delta', () async {
      final repository = _GatedNextSnapshotRepository()
        ..snapshotBuilder = initialOverview;
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      final gate = Completer<void>();
      repository.gateNextSnapshot = gate;
      final refresh = vm.refresh();
      await Future<void>.delayed(Duration.zero);

      repository.eventsController.add(
        overviewBatch(
          type: 'portal.state.delta',
          scope: 'pr',
          entities: [
            {
              'entityType': 'pr_status',
              'localId': 'wt-1',
              'parentLocalId': 'ws-1:wt-1',
              'payload': {
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-1',
                'repos': [
                  {
                    'repoId': 'app',
                    'status': {'number': 42, 'state': 'merged'},
                  },
                ],
              },
            },
          ],
        ),
      );
      await Future<void>.delayed(Duration.zero);
      repository.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
        'workspaces': [overviewWorkspace(name: 'Renamed after refresh')],
        'worktrees': [overviewWorktree()],
        'standaloneChats': <Object>[],
      });
      gate.complete();
      await refresh;
      await Future<void>.delayed(const Duration(milliseconds: 100));

      expect(vm.workspaces.single.name, 'Renamed after refresh');
      expect(repository.snapshotFetches, 3);
    });

    test('retries pending overview reconciliation after a failed fetch', () {
      fakeAsync((time) {
        var renamed = false;
        final repository = _FailingNextSnapshotRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [
              overviewWorkspace(name: renamed ? 'Renamed' : 'Original'),
            ],
            'worktrees': [overviewWorktree()],
            'standaloneChats': <Object>[],
          });
        final vm = RemoteControlViewModel(
          repository: repository,
          clock: () => DateTime(2026).add(time.elapsed),
        );
        vm.connect('123456');
        time.flushMicrotasks();
        expect(vm.workspaces.single.name, 'Original');

        renamed = true;
        repository.failNextSnapshot = true;
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.delta',
                'payload': {
                  'scope': 'overview',
                  'removed': [
                    {'entityType': 'standalone_chat', 'localId': 'chat-1'},
                  ],
                },
              },
            ],
          }),
        );
        time.flushMicrotasks();
        time.elapse(kRemoteStateRefreshDebounce);
        time.flushMicrotasks();
        expect(vm.workspaces.single.name, 'Original');

        time.elapse(kRemoteStateRefreshDebounce * 2);
        time.flushMicrotasks();
        expect(vm.workspaces.single.name, 'Renamed');
        expect(repository.snapshotFetches, 2);
        vm.dispose();
        repository.eventsController.close();
        time.flushMicrotasks();
      });
    });

    test('backs off repeated failed overview reconciliation', () {
      fakeAsync((time) {
        final repository = _FailingNextSnapshotRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          clock: () => DateTime(2026).add(time.elapsed),
        );
        vm.connect('123456');
        time.flushMicrotasks();
        repository.failuresRemaining = 3;
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.delta',
                'payload': {
                  'scope': 'overview',
                  'removed': [
                    {'entityType': 'standalone_chat', 'localId': 'chat-1'},
                  ],
                },
              },
            ],
          }),
        );
        time.flushMicrotasks();
        time.elapse(kRemoteStateRefreshDebounce);
        time.flushMicrotasks();
        expect(repository.snapshotAttempts, 2);

        time.elapse(kRemoteStateRefreshDebounce);
        time.flushMicrotasks();
        expect(repository.snapshotAttempts, 2);
        time.elapse(kRemoteStateRefreshDebounce);
        time.flushMicrotasks();
        expect(repository.snapshotAttempts, 3);

        time.elapse(kRemoteStateRefreshDebounce * 3);
        time.flushMicrotasks();
        expect(repository.snapshotAttempts, 3);
        time.elapse(kRemoteStateRefreshDebounce);
        time.flushMicrotasks();
        expect(repository.snapshotAttempts, 4);
        vm.dispose();
        repository.eventsController.close();
        time.flushMicrotasks();
      });
    });

    test('explicit progress tombstones remove the remembered feed', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');

      repository.eventsController.add(
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
                      'mergeProgress': {
                        'currentPhase': 'merging',
                        'steps': [
                          {'phase': 'merging'},
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(vm.prProgressFor('ws-1', 'wt-1')?.merge, isNotNull);

      repository.eventsController.add(
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
                      'mergeProgress': null,
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      await Future<void>.delayed(Duration.zero);

      expect(vm.prProgressFor('ws-1', 'wt-1'), isNull);
    });

    group('merge progress ordering', () {
      Map<String, dynamic> mergeFeedEvent(
        String type,
        Map<String, dynamic> mergeProgress,
      ) => {
        'type': type,
        'payload': {
          'scope': type == 'portal.state.snapshot' ? 'worktree' : 'pr',
          'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
          'entities': [
            {
              'entityType': 'pr_status',
              'localId': 'wt-1',
              'payload': {
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-1',
                'mergeProgress': mergeProgress,
              },
            },
          ],
        },
      };

      const checking = {'phase': 'checking_mergeability', 'repoName': 'app'};
      const merging = {'phase': 'merging', 'repoName': 'app'};
      const repoDone = {'phase': 'done', 'repoName': 'app'};

      Future<RemoteControlViewModel> connectedViewModel(
        FakeRemoteControlRepository repository,
      ) async {
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        return vm;
      }

      test(
        'a late snapshot cannot rewind a live merge to an earlier phase',
        () async {
          final repository = FakeRemoteControlRepository();
          final vm = await connectedViewModel(repository);

          repository.eventsController.add(
            RemotePortalEventBatch.fromJson({
              'events': [
                mergeFeedEvent('portal.state.delta', {
                  'currentPhase': 'merging',
                  'steps': [checking, merging],
                }),
              ],
            }),
          );
          await Future<void>.delayed(Duration.zero);

          // The desktop reads the feed early in a worktree snapshot, but only
          // enqueues the snapshot once its slower sections finish.
          repository.eventsController.add(
            RemotePortalEventBatch.fromJson({
              'events': [
                mergeFeedEvent('portal.state.snapshot', {
                  'currentPhase': 'checking_mergeability',
                  'steps': [checking],
                }),
              ],
            }),
          );
          await Future<void>.delayed(Duration.zero);

          expect(
            vm.prProgressFor('ws-1', 'wt-1')?.merge?.currentPhase,
            RemoteMergePrPhase.merging,
          );
        },
      );

      test('a new merge replaces a settled feed', () async {
        final repository = FakeRemoteControlRepository();
        final vm = await connectedViewModel(repository);

        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              mergeFeedEvent('portal.state.delta', {
                'currentPhase': 'error',
                'steps': [
                  checking,
                  {'phase': 'error', 'repoName': 'app', 'error': 'Blocked'},
                ],
              }),
            ],
          }),
        );
        await Future<void>.delayed(Duration.zero);

        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              mergeFeedEvent('portal.state.delta', {
                'currentPhase': 'checking_mergeability',
                'steps': <Object>[],
              }),
            ],
          }),
        );
        await Future<void>.delayed(Duration.zero);

        expect(
          vm.prProgressFor('ws-1', 'wt-1')?.merge?.currentPhase,
          RemoteMergePrPhase.checkingMergeability,
        );
      });

      test('a late snapshot cannot rewind a completed merge', () async {
        final repository = FakeRemoteControlRepository();
        final vm = await connectedViewModel(repository);

        Future<void> send(String type, Map<String, dynamic> feed) async {
          repository.eventsController.add(
            RemotePortalEventBatch.fromJson({
              'events': [mergeFeedEvent(type, feed)],
            }),
          );
          await Future<void>.delayed(Duration.zero);
        }

        await send('portal.state.delta', {
          'generation': 10,
          'currentPhase': 'done',
          'steps': [
            checking,
            merging,
            {'phase': 'done'},
          ],
        });
        await send('portal.state.snapshot', {
          'generation': 10,
          'currentPhase': 'merging',
          'steps': [checking, merging],
        });
        expect(
          vm.prProgressFor('ws-1', 'wt-1')?.merge?.currentPhase,
          RemoteMergePrPhase.done,
        );

        await send('portal.state.delta', {
          'generation': 11,
          'currentPhase': 'checking_mergeability',
          'steps': <Object>[],
        });
        await send('portal.state.snapshot', {
          'generation': 10,
          'currentPhase': 'merging',
          'steps': [checking, merging],
        });
        expect(vm.prProgressFor('ws-1', 'wt-1')?.merge?.steps, isEmpty);
      });

      test('the live feed keeps advancing through later phases', () async {
        final repository = FakeRemoteControlRepository();
        final vm = await connectedViewModel(repository);

        for (final feed in [
          {
            'currentPhase': 'checking_mergeability',
            'steps': [checking],
          },
          {
            'currentPhase': 'merging',
            'steps': [checking, merging],
          },
          {
            'currentPhase': 'merging',
            'steps': [checking, merging, repoDone],
          },
        ]) {
          repository.eventsController.add(
            RemotePortalEventBatch.fromJson({
              'events': [mergeFeedEvent('portal.state.delta', feed)],
            }),
          );
          await Future<void>.delayed(Duration.zero);
        }

        final merge = vm.prProgressFor('ws-1', 'wt-1')?.merge;
        expect(merge?.currentPhase, RemoteMergePrPhase.merging);
        expect(merge?.steps, hasLength(3));
      });
    });

    test(
      'settled PR refresh retires stale progress, preserves failures, and caches state',
      () async {
        final repository = FakeRemoteControlRepository()
          ..supportsPrActions = true
          ..prActionRunner =
              (
                action, {
                repoId,
                identity,
                confirmUnresolvedComments = false,
              }) async => {
                'busy': false,
                'repos': [
                  {
                    'repoId': 'repo-1',
                    'repoName': 'app',
                    'status': {
                      'state': 'open',
                      'number': 42,
                      'url': 'https://github.com/acme/app/pull/42',
                    },
                  },
                ],
              };
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          standaloneChats: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'feature',
            ),
          ],
        );
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');

        repository.eventsController.add(
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
                        'creationProgress': {
                          'currentPhase': 'creating_pr',
                          'steps': [
                            {'phase': 'creating_pr', 'repoName': 'app'},
                          ],
                        },
                        'mergeProgress': {
                          'currentPhase': 'error',
                          'steps': [
                            {'phase': 'error', 'error': 'Merge failed'},
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
        await Future<void>.delayed(Duration.zero);
        expect(vm.prProgressFor('ws-1', 'wt-1')?.creation, isNotNull);
        expect(vm.prProgressFor('ws-1', 'wt-1')?.merge, isNotNull);

        await vm.refreshPrState(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature',
          ),
        );

        expect(vm.prProgressFor('ws-1', 'wt-1')?.creation, isNull);
        expect(
          vm.prProgressFor('ws-1', 'wt-1')?.merge?.currentPhase,
          RemoteMergePrPhase.error,
        );
        expect(vm.cachedPrReposFor('ws-1', 'wt-1')!.single.pr?.prNumber, 42);
      },
    );

    test('late PR refresh does not restore cache after disconnect', () async {
      final response = Completer<Map<String, dynamic>>();
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true
        ..prActionRunner =
            (action, {repoId, identity, confirmUnresolvedComments = false}) =>
                response.future;
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      const worktree = RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feature',
      );

      final refresh = vm.runPrAction(worktree, RemotePrAction.refresh);
      await Future<void>.delayed(Duration.zero);
      await vm.disconnect();
      response.complete({
        'busy': true,
        'repos': [
          {
            'repoId': 'repo-1',
            'repoName': 'app',
            'status': {
              'state': 'open',
              'number': 42,
              'url': 'https://github.com/acme/app/pull/42',
            },
          },
        ],
      });
      final result = await refresh;

      expect(vm.cachedPrReposFor('ws-1', 'wt-1'), isNull);
      expect(vm.cachedPrBusyFor('ws-1', 'wt-1'), isFalse);
      expect(result[remotePrActionDiscardedKey], isTrue);
    });

    test('stale PR refresh preserves newer progress and cache', () async {
      final response = Completer<Map<String, dynamic>>();
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true
        ..prActionRunner =
            (action, {repoId, identity, confirmUnresolvedComments = false}) =>
                response.future;
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      const worktree = RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feature',
      );

      final refresh = vm.runPrAction(worktree, RemotePrAction.refresh);
      await Future<void>.delayed(Duration.zero);
      repository.eventsController.add(
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
                      'creationProgress': {
                        'currentPhase': 'creating_pr',
                        'steps': [
                          {'phase': 'creating_pr', 'repoName': 'app'},
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      await Future<void>.delayed(Duration.zero);
      response.complete({'busy': false, 'repos': const []});
      final result = await refresh;

      expect(
        vm.prProgressFor('ws-1', 'wt-1')?.creation?.currentPhase,
        RemotePrCreationPhase.creatingPr,
      );
      expect(vm.cachedPrReposFor('ws-1', 'wt-1'), isNull);
      expect(vm.cachedPrBusyFor('ws-1', 'wt-1'), isFalse);
      expect(result[remotePrActionDiscardedKey], isTrue);
    });

    test(
      'older overlapping PR refresh cannot overwrite the latest result',
      () async {
        final first = Completer<Map<String, dynamic>>();
        final second = Completer<Map<String, dynamic>>();
        var requestCount = 0;
        final repository = FakeRemoteControlRepository()
          ..supportsPrActions = true
          ..prActionRunner =
              (action, {repoId, identity, confirmUnresolvedComments = false}) {
                requestCount += 1;
                return requestCount == 1 ? first.future : second.future;
              };
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        const worktree = RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
        );

        final older = vm.runPrAction(worktree, RemotePrAction.refresh);
        await Future<void>.delayed(Duration.zero);
        final latest = vm.runPrAction(worktree, RemotePrAction.refresh);
        await Future<void>.delayed(Duration.zero);
        second.complete({
          'busy': false,
          'repos': [
            {'repoId': 'new', 'repoName': 'Latest'},
          ],
        });
        expect((await latest)[remotePrActionDiscardedKey], isNot(true));
        first.complete({
          'busy': true,
          'repos': [
            {'repoId': 'old', 'repoName': 'Older'},
          ],
        });
        final olderResult = await older;

        expect(olderResult[remotePrActionDiscardedKey], isTrue);
        expect(vm.cachedPrReposFor('ws-1', 'wt-1')!.single.repoId, 'new');
        expect(vm.cachedPrBusyFor('ws-1', 'wt-1'), isFalse);
      },
    );

    test('unknown progress phases retire the remembered feed', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');

      repository.eventsController.add(
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
                      'creationProgress': {
                        'currentPhase': 'summarizing',
                        'steps': [
                          {'phase': 'gathering_changes'},
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(vm.prProgressFor('ws-1', 'wt-1')?.creation, isNotNull);

      repository.eventsController.add(
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
                      'creationProgress': {
                        'currentPhase': 'teleporting',
                        'steps': const [],
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      await Future<void>.delayed(Duration.zero);

      expect(vm.prProgressFor('ws-1', 'wt-1'), isNull);
    });

    test('streaming deltas do not poll the overview for 60 seconds', () {
      fakeAsync((time) {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = initialOverview;
        final vm = RemoteControlViewModel(repository: repository);
        vm.connect('123456');
        time.flushMicrotasks();
        final fetches = repository.snapshotFetches;
        for (var second = 0; second < 60; second += 2) {
          repository.eventsController.add(
            overviewBatch(
              type: 'portal.state.delta',
              scope: 'worktree',
              entities: [
                {
                  'entityType': 'worktree',
                  'localId': 'wt-1',
                  'payload': overviewWorktree(state: 'merged'),
                },
              ],
            ),
          );
          time.elapse(const Duration(seconds: 2));
        }
        expect(repository.snapshotFetches, fetches);
        expect(vm.allWorktrees.single.prStatuses.single.state, 'merged');
        vm.dispose();
        repository.eventsController.close();
        time.flushMicrotasks();
      });
    });

    test(
      'unapplied shell changes use at most two fallback reads per minute',
      () {
        fakeAsync((time) {
          final repository = FakeRemoteControlRepository();
          final vm = RemoteControlViewModel(
            repository: repository,
            clock: () => DateTime(2026).add(time.elapsed),
          );
          vm.connect('123456');
          time.flushMicrotasks();
          for (var second = 0; second < 60; second += 2) {
            repository.eventsController.add(
              RemotePortalEventBatch.fromJson({
                'events': [
                  {
                    'type': 'portal.state.delta',
                    'payload': {
                      'scope': 'overview',
                      'removed': [
                        {'entityType': 'standalone_chat', 'localId': 'chat-1'},
                      ],
                    },
                  },
                ],
              }),
            );
            time.elapse(const Duration(seconds: 2));
          }
          expect(repository.snapshotFetches, 3); // initial + two fallback reads
          // A local action can bypass the fallback delay; it is not ordinary
          // streamed traffic and the user needs its result promptly.
          vm.setHooksPaused(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            paused: true,
          );
          time.flushMicrotasks();
          time.elapse(kRemoteStateRefreshDebounce);
          expect(repository.snapshotFetches, 4);
          vm.dispose();
          repository.eventsController.close();
          time.flushMicrotasks();
        });
      },
    );

    for (final type in ['portal.state.delta', 'portal.state.snapshot']) {
      test(
        '$type applies authoritative PR fields without an overview fetch',
        () async {
          final repository = FakeRemoteControlRepository()
            ..snapshotBuilder = initialOverview;
          final vm = RemoteControlViewModel(repository: repository);
          addTearDown(vm.dispose);
          addTearDown(repository.eventsController.close);
          await vm.connect('123456');
          void publish(Map<String, dynamic> fields) =>
              repository.eventsController.add(
                overviewBatch(
                  type: type,
                  scope: 'pr',
                  entities: [
                    {
                      'entityType': 'pr_status',
                      'localId': 'wt-1',
                      'parentLocalId': 'ws-1:wt-1',
                      'payload': {
                        'workspaceLocalId': 'ws-1',
                        'worktreeLocalId': 'wt-1',
                        ...fields,
                      },
                    },
                  ],
                ),
              );
          repository.eventsController.add(
            overviewBatch(
              type: 'portal.state.delta',
              scope: 'worktree_chat_summaries',
              entities: [
                {
                  'entityType': 'chat_summary',
                  'localId': 'chat-1',
                  'payload': {
                    'chatId': 'chat-1',
                    'scope': 'worktree',
                    'title': 'Chat',
                    'workspaceLocalId': 'ws-1',
                    'worktreeLocalId': 'wt-1',
                    'turnActive': true,
                    'hasUnread': true,
                  },
                },
              ],
            ),
          );
          await Future<void>.delayed(Duration.zero);
          publish({
            'repos': [
              {
                'repoId': 'app',
                'status': {
                  'number': 42,
                  'url': 'https://github.com/acme/app/pull/42',
                  'state': 'merged',
                  'checkStatus': 'passing',
                  'reviewStatus': 'approved',
                  'unresolvedReviewThreadCount': 0,
                },
              },
              {
                'repoId': 'docs',
                'status': {'number': 43, 'state': 'open'},
              },
            ],
          });
          await Future<void>.delayed(Duration.zero);
          final row = vm.allWorktrees.single;
          expect(row.branch, 'feature/live-pr');
          expect(row.isWorking, isTrue);
          expect(row.hasUnread, isTrue);
          expect(row.prStatuses.map((pr) => pr.prNumber), [42, 43]);
          expect(row.prStatuses.first.state, 'merged');
          expect(row.prStatuses.first.checkStatus, 'passing');
          expect(row.prStatuses.first.unresolvedReviewThreadCount, 0);
          publish({'creationProgress': null});
          await Future<void>.delayed(Duration.zero);
          expect(vm.allWorktrees.single.prStatuses.length, 2);
          publish({
            'number': null,
            'creationProgress': {'phase': 'creating'},
          });
          await Future<void>.delayed(Duration.zero);
          expect(vm.allWorktrees.single.prStatuses.map((pr) => pr.prNumber), [
            42,
            43,
          ]);
          publish({
            'number': null,
            'mergeProgress': {'phase': 'merging'},
          });
          await Future<void>.delayed(Duration.zero);
          expect(vm.allWorktrees.single.prStatuses.map((pr) => pr.prNumber), [
            42,
            43,
          ]);
          publish({
            'repos': [
              {'repoId': 'app', 'status': null, 'prLookupAvailable': false},
            ],
          });
          await Future<void>.delayed(Duration.zero);
          expect(vm.allWorktrees.single.prStatuses.map((pr) => pr.prNumber), [
            42,
            43,
          ]);
          publish({'repos': []});
          await Future<void>.delayed(Duration.zero);
          expect(vm.allWorktrees.single.prStatuses, isEmpty);
          expect(repository.snapshotFetches, 1);
        },
      );
    }

    test('hydrates pr_status progress from a state snapshot', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');

      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.state.snapshot',
              'payload': {
                'scope': 'pr',
                'entities': [
                  {
                    'entityType': 'pr_status',
                    'localId': 'wt-1',
                    'payload': {
                      'workspaceLocalId': 'ws-1',
                      'worktreeLocalId': 'wt-1',
                      'creationProgress': {
                        'currentPhase': 'summarizing',
                        'steps': [
                          {'phase': 'gathering_changes'},
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      await Future<void>.delayed(Duration.zero);

      expect(
        vm.prProgressFor('ws-1', 'wt-1')!.creation!.currentPhase,
        RemotePrCreationPhase.summarizing,
      );
    });

    test('disconnect clears live pr_status progress', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');

      repository.eventsController.add(
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
                      'creationProgress': {
                        'currentPhase': 'summarizing',
                        'steps': [
                          {'phase': 'gathering_changes'},
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(vm.prProgressFor('ws-1', 'wt-1'), isNotNull);

      await vm.disconnect();

      expect(vm.prProgressFor('ws-1', 'wt-1'), isNull);
    });

    test('starts disconnected with no snapshot', () {
      final vm = build();

      expect(vm.status, RemoteConnectionStatus.disconnected);
      expect(vm.isConnected, isFalse);
      expect(vm.connection, isNull);
      expect(vm.snapshot, isNull);
      expect(vm.workspaces, isEmpty);
    });

    test('createChatTab throws while disconnected', () async {
      final vm = build();

      await expectLater(
        vm.createChatTab(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            chatId: 'chat-m1',
          ),
        ),
        throwsA(
          isA<RemoteControlException>().having(
            (error) => error.message,
            'message',
            'Remote Control is disconnected.',
          ),
        ),
      );
    });

    test(
      'connect transitions disconnected → connected and loads snapshot',
      () async {
        final vm = build();
        final statuses = <RemoteConnectionStatus>[];
        vm.addListener(() => statuses.add(vm.status));

        await vm.connect('123456');

        expect(statuses.first, RemoteConnectionStatus.connecting);
        expect(vm.status, RemoteConnectionStatus.connected);
        expect(vm.isConnected, isTrue);
        expect(vm.connection, isNotNull);
        expect(vm.workspaces, isNotEmpty);
        expect(vm.error, isNull);
      },
    );

    test('worktreesFor / standaloneChatsFor filter by workspace', () async {
      final vm = build();
      await vm.connect('123456');

      final ws = vm.workspaces.first;
      final worktrees = vm.worktreesFor(ws.localId);
      for (final wt in worktrees) {
        expect(wt.workspaceLocalId, ws.localId);
      }

      final cowork = vm.workspaces.firstWhere(
        (w) => w.type == RemoteWorkspaceType.cowork,
      );
      expect(vm.worktreesFor(cowork.localId), isEmpty);
      expect(vm.standaloneChatsFor(cowork.localId), isNotEmpty);
    });

    test(
      'connect fetches the snapshot before starting event delivery',
      () async {
        final repository = _OrderRecordingRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await vm.connect('123456');

        // The snapshot must seed the event cursor before the subscription
        // starts, or live delivery replays the whole session history over the
        // freshly-hydrated state (regression B1/B2).
        expect(repository.ops, ['snapshot', 'resume']);
      },
    );

    test('connect failure transitions to error', () async {
      final vm = RemoteControlViewModel(repository: _FailingRepository());

      await vm.connect('123456');

      expect(vm.status, RemoteConnectionStatus.error);
      expect(vm.error, isA<RemoteControlException>());
      expect(vm.connection, isNull);
      expect(vm.snapshot, isNull);
    });

    test('snapshot failure preserves a redeemed pairing for retry', () async {
      final repository = _SnapshotRetryRepository();
      final vm = RemoteControlViewModel(repository: repository);

      await vm.connect('123456');

      expect(vm.status, RemoteConnectionStatus.connected);
      expect(vm.connection, isNotNull);
      expect(vm.snapshot, isNull);
      expect(vm.error, isA<RemoteControlException>());

      await vm.refresh();

      expect(vm.status, RemoteConnectionStatus.connected);
      expect(vm.connection, isNotNull);
      expect(vm.workspaces.single.name, 'Recovered workspace');
      expect(vm.error, isNull);
    });

    test('the reserved error code drives the error state', () async {
      final vm = build();

      await vm.connect('000000');

      expect(vm.status, RemoteConnectionStatus.error);
      expect(vm.error, isA<RemoteControlException>());
    });

    test('disconnect resets to the disconnected state', () async {
      final vm = build();
      await vm.connect('123456');
      expect(vm.isConnected, isTrue);

      await vm.disconnect();

      expect(vm.status, RemoteConnectionStatus.disconnected);
      expect(vm.connection, isNull);
      expect(vm.snapshot, isNull);
      expect(vm.error, isNull);
      expect(vm.workspaces, isEmpty);
    });

    test('refresh is a no-op while disconnected', () async {
      final vm = build();

      await vm.refresh();

      expect(vm.status, RemoteConnectionStatus.disconnected);
      expect(vm.snapshot, isNull);
    });

    test('refresh re-fetches the snapshot while connected', () async {
      final vm = build();
      await vm.connect('123456');

      await vm.refresh();

      expect(vm.isConnected, isTrue);
      expect(vm.snapshot, isNotNull);
      expect(vm.error, isNull);
    });

    test('dispose discards an in-flight connect result', () async {
      final repository = _SlowConnectRepository();
      final vm = RemoteControlViewModel(repository: repository);

      final connectFuture = vm.connect('123456');
      expect(vm.status, RemoteConnectionStatus.connecting);

      vm.dispose();
      repository.connectCompleter.complete(
        RemoteConnection(deviceLabel: 'Test Desktop', pairedAt: DateTime(2026)),
      );
      await connectFuture;

      expect(repository.snapshotFetches, 0);
    });
  });

  group('RemoteControlViewModel worktree activity slices', () {
    test('backgroundProcessesFor returns one chat\'s processes '
        '(CAN-5253)', () async {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
      );
      repository.worktreeStateSlices = {
        'wt-1': {
          'backgroundProcesses': [
            backgroundProcessJson(localId: 'bg-a'),
            backgroundProcessJson(localId: 'bg-b', chatId: 'chat-2'),
            backgroundProcessJson(localId: 'bg-c', workspaceLocalId: 'ws-2'),
          ],
        },
      };
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      List<String> ids({
        String workspaceLocalId = 'ws-1',
        String worktreeLocalId = 'wt-1',
        String chatId = 'chat-1',
      }) => [
        for (final row in vm.backgroundProcessesFor(
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
          chatId: chatId,
        ))
          row.localId,
      ];

      expect(ids(), isEmpty);

      await vm.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );

      expect(ids(), ['bg-a']);
      expect(ids(chatId: 'chat-2'), ['bg-b']);
      expect(ids(workspaceLocalId: 'ws-2'), ['bg-c']);
      expect(ids(worktreeLocalId: 'wt-2'), isEmpty);
      vm.dispose();
    });

    test(
      'watchersForChat handles repeated worktree IDs across workspaces',
      () async {
        final repository = FakeRemoteControlRepository()
          ..supportsWatchers = true;
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-shared',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
            RemoteWorktree(
              localId: 'wt-shared',
              workspaceLocalId: 'ws-2',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
        repository.worktreeStateSlices = {
          'wt-shared': {
            'watchers': [
              watcherJson(
                id: 'ws-2-watcher',
                projectId: 'ws-2',
                worktreeId: 'wt-shared',
                chatId: 'chat-shared',
              ),
            ],
          },
        };
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        addTearDown(vm.dispose);
        await vm.connect('123456');
        await vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-2',
          worktreeLocalId: 'wt-shared',
        );
        expect(
          vm
              .watchersForChat(
                'wt-shared',
                'chat-shared',
                workspaceLocalId: 'ws-2',
              )
              .map((row) => row.id),
          ['ws-2-watcher'],
        );
        expect(
          vm.watchersForChat(
            'wt-shared',
            'chat-shared',
            workspaceLocalId: 'ws-1',
          ),
          isEmpty,
        );
        repository.worktreeStateSlices = {
          'wt-shared': {
            'watchers': [
              watcherJson(
                id: 'ws-1-watcher',
                projectId: 'ws-1',
                worktreeId: 'wt-shared',
                chatId: 'chat-shared',
              ),
            ],
          },
        };
        await vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-shared',
        );
        expect(
          vm
              .watchersForChat(
                'wt-shared',
                'chat-shared',
                workspaceLocalId: 'ws-1',
              )
              .map((row) => row.id),
          ['ws-1-watcher'],
        );
        expect(
          vm
              .watchersForChat(
                'wt-shared',
                'chat-shared',
                workspaceLocalId: 'ws-2',
              )
              .map((row) => row.id),
          ['ws-2-watcher'],
        );
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.delta',
                'cursor': 200,
                'payload': {
                  'scope': 'worktree',
                  'entities': [
                    for (final workspace in ['ws-1', 'ws-2'])
                      watcherEntityJson(
                        watcherJson(
                          id: '$workspace-watcher',
                          projectId: workspace,
                          worktreeId: 'wt-shared',
                          chatId: 'chat-shared',
                          status: 'delivery_failed',
                        ),
                      ),
                  ],
                },
              },
            ],
            'nextCursor': 200,
          }),
        );
        await Future<void>.delayed(Duration.zero);
        for (final workspace in ['ws-1', 'ws-2']) {
          final watchers = vm.watchersForChat(
            'wt-shared',
            'chat-shared',
            workspaceLocalId: workspace,
          );
          expect(watchers.single.id, '$workspace-watcher');
          expect(watchers.single.status, 'delivery_failed');
        }
      },
    );

    test(
      'watchersForChat gates the capability and scopes subscriber rows (CAN-5267)',
      () async {
        final repository = FakeRemoteControlRepository()
          ..supportsWatchers = true;
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
        repository.worktreeStateSlices = {
          'wt-1': {
            'watchers': [
              watcherJson(id: 'new', createdAt: '2026-10-28T12:00:00.000Z'),
              watcherJson(id: 'old', status: 'delivery_failed'),
              watcherJson(id: 'other-chat', chatId: 'chat-2'),
              watcherJson(id: 'other-project', projectId: 'ws-2'),
            ],
          },
        };
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await vm.connect('123456');
        expect(
          vm.watchersForChat('wt-1', 'chat-1', workspaceLocalId: 'ws-1'),
          isEmpty,
        );
        await vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        expect(vm.supportsChatWatchers, isTrue);
        expect(
          vm
              .watchersForChat('wt-1', 'chat-1', workspaceLocalId: 'ws-1')
              .map((row) => row.id),
          ['old', 'new'],
        );
        expect(
          vm.watchersForChat('wt-2', 'chat-1', workspaceLocalId: 'ws-1'),
          isEmpty,
        );
        repository.supportsWatchers = false;
        expect(vm.supportsChatWatchers, isFalse);
        expect(
          vm.watchersForChat('wt-1', 'chat-1', workspaceLocalId: 'ws-1'),
          isEmpty,
        );
        vm.dispose();
      },
    );

    test('scoped slices hydrate the activity even though the overview '
        'snapshot excludes those entity types', () async {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
        // Wire-faithful: the overview /state read carries NO changedFiles /
        // plans / todo entity types — they only exist on scoped reads.
        raw: {},
      );
      repository.worktreeStateSlices = {
        'wt-1': {
          'changedFiles': {
            'wt-1': {
              'uncommitted': [
                {'filePath': 'lib/a.dart', 'status': 'modified'},
              ],
              'committed': [],
            },
          },
        },
      };
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');

      expect(vm.worktreeActivityFor('wt-1').changedFiles, isEmpty);

      await vm.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      final files = vm.worktreeActivityFor('wt-1').changedFiles;
      expect(files, hasLength(1));
      expect(files.single.filePath, 'lib/a.dart');
      expect(repository.fetchWorktreeStateSlicesCalls, 1);

      // The slices survive an overview snapshot refresh replacing the base
      // raw map.
      await vm.refresh();
      expect(vm.worktreeActivityFor('wt-1').changedFiles, hasLength(1));
      vm.dispose();
    });

    test('a successful empty scoped read clears previously-cached '
        'slices', () async {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
      );
      repository.worktreeStateSlices = {
        'wt-1': {
          'changedFiles': {
            'wt-1': {
              'uncommitted': [
                {'filePath': 'lib/a.dart', 'status': 'modified'},
              ],
              'committed': [],
            },
          },
        },
      };
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      await vm.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      expect(vm.worktreeActivityFor('wt-1').changedFiles, hasLength(1));

      // The worktree's changes were all committed away: the next successful
      // read returns nothing and must NOT pin the stale list.
      repository.worktreeStateSlices = {};
      await vm.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      expect(vm.worktreeActivityFor('wt-1').changedFiles, isEmpty);
      vm.dispose();
    });

    test('activity slices do not survive a disconnect into the next '
        'session', () async {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
      );
      repository.worktreeStateSlices = {
        'wt-1': {
          'changedFiles': {
            'wt-1': {
              'uncommitted': [
                {'filePath': 'lib/stale.dart', 'status': 'modified'},
              ],
              'committed': [],
            },
          },
        },
      };
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      await vm.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      expect(vm.worktreeActivityFor('wt-1').changedFiles, hasLength(1));

      // Unpair, then pair again WITHOUT re-reading slices: worktree local
      // ids are stable per desktop, so a stale projection must not merge
      // over the fresh session's snapshot.
      await vm.disconnect();
      repository.worktreeStateSlices = {};
      await vm.connect('123456');
      expect(vm.worktreeActivityFor('wt-1').changedFiles, isEmpty);
      vm.dispose();
    });

    test('an in-flight activity read from an old session cannot update the '
        'reconnected session', () async {
      final repository = _SequencedActivityRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
      );
      final vm = RemoteControlViewModel(repository: repository);
      await vm.connect('123456');

      final oldSessionRead = vm.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      expect(repository.reads, hasLength(1));

      await vm.disconnect();
      await vm.connect('123456');

      repository.reads[0].complete((
        slices: const {
          'changedFiles': {
            'wt-1': {
              'uncommitted': [
                {'filePath': 'lib/stale.dart', 'status': 'modified'},
              ],
              'committed': [],
            },
          },
        },
        refreshing: false,
      ));
      await oldSessionRead;

      expect(vm.worktreeActivityFor('wt-1').changedFiles, isEmpty);
      vm.dispose();
    });

    test('ensureWorktreeState reads the slices back once the worktree '
        'snapshot lands', () async {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
      );
      repository.worktreeStateSlices = {
        'wt-1': {
          'changedFiles': {
            'wt-1': {
              'uncommitted': [
                {'filePath': 'lib/b.dart', 'status': 'added'},
              ],
              'committed': [],
            },
          },
        },
      };
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');

      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      // The command acknowledgement only means the projection was queued.
      expect(repository.fetchWorktreeStateSlicesCalls, 0);

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ],
          nextCursor: 7,
        ),
      );
      for (var i = 0; i < 3; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(repository.fetchWorktreeStateSlicesCalls, 1);
      expect(vm.worktreeActivityFor('wt-1').changedFiles, hasLength(1));
      vm.dispose();
    });

    test(
      'worktreeActivityFor is memoized on snapshot and slices identity',
      () async {
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
        repository.worktreeStateSlices = {
          'wt-1': {
            'changedFiles': {
              'wt-1': {
                'uncommitted': [
                  {'filePath': 'lib/a.dart', 'status': 'modified'},
                ],
                'committed': [],
              },
            },
          },
        };
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        addTearDown(vm.dispose);
        await vm.connect('123456');
        await vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );

        final first = vm.worktreeActivityFor('wt-1');
        // The chat screen's `context.watch` re-renders the whole view model
        // on every streaming chat delta, and the drawer + the run screen
        // both read this per worktree per frame; recomputing it (parsing
        // summaries, plans, todos, hooks, changed files and every pipeline
        // row) on each read is the cost being pinned here.
        expect(identical(first, vm.worktreeActivityFor('wt-1')), isTrue);

        // A fresh scoped read replaces the slices object with new content
        // and must bust the cache rather than serving a stale identical()
        // result forever.
        repository.worktreeStateSlices = {
          'wt-1': {
            'changedFiles': {
              'wt-1': {
                'uncommitted': [
                  {'filePath': 'lib/a.dart', 'status': 'modified'},
                  {'filePath': 'lib/b.dart', 'status': 'added'},
                ],
                'committed': [],
              },
            },
          },
        };
        await vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        final second = vm.worktreeActivityFor('wt-1');
        expect(identical(first, second), isFalse);
        expect(second.changedFiles, hasLength(2));
      },
    );

    test('worktree snapshot re-reads activity slices after a delayed desktop '
        'projection', () async {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');

      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // The command acknowledgement only means the projection was queued,
      // so nothing reads the cache before the snapshot (CAN-4875).
      expect(repository.fetchWorktreeStateSlicesCalls, 0);
      expect(vm.worktreeActivityFor('wt-1').changedFiles, isEmpty);

      repository.worktreeStateSlices = {
        'wt-1': {
          'changedFiles': {
            'wt-1': {
              'uncommitted': [
                {'filePath': 'lib/arrived_later.dart', 'status': 'modified'},
              ],
              'committed': [],
            },
          },
        },
      };
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ],
          nextCursor: 7,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(repository.fetchWorktreeStateSlicesCalls, 1);
      expect(
        vm.worktreeActivityFor('wt-1').changedFiles.single.filePath,
        'lib/arrived_later.dart',
      );
      vm.dispose();
    });
  });

  group('RemoteControlViewModel session caches', () {
    for (final background in [true, false]) {
      test(
        '${background ? 'background' : 'dispose'} flushes deferred diff writes',
        () {
          fakeAsync((async) {
            SharedPreferences.setMockInitialValues({});
            final cache = RemoteFileDiffCache(maxEntries: 4, persist: true);
            final vm = RemoteControlViewModel(
              repository: FakeRemoteControlRepository()
                ..connectedSessionId = 'session-1',
              fileDiffCache: cache,
            );
            vm.connect('123456');
            async.flushMicrotasks();
            late SharedPreferences prefs;
            SharedPreferences.getInstance().then((value) => prefs = value);
            async.flushMicrotasks();
            cache.put(
              const RemoteFileDiffCacheKey(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                repoId: null,
                path: 'a',
                source: RemoteDiffSource.uncommitted,
                status: 'modified',
                insertions: 1,
                deletions: 0,
                revision: 'revision-1',
              ),
              const RemoteFileDiff(filePath: 'a', patch: '+new'),
            );
            async.flushMicrotasks();
            expect(prefs.getKeys(), isEmpty);
            background ? vm.onAppBackgrounded() : vm.dispose();
            async.flushMicrotasks();
            expect(prefs.getKeys(), contains('remote-file-diffs-v1'));
            if (background) vm.dispose();
          });
        },
      );
    }

    test(
      'uses a memory-only diff cache unless the host injects persistence',
      () {
        final vm = RemoteControlViewModel(
          repository: MockRemoteControlRepository(latency: Duration.zero),
        );

        expect(vm.fileDiffCache.persist, isFalse);
      },
    );

    test(
      'restoreIfIdle clears persisted diffs when no session remains',
      () async {
        SharedPreferences.setMockInitialValues({});
        final key = RemoteFileDiffCacheKey(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          repoId: null,
          path: 'src/a.dart',
          source: RemoteDiffSource.committed,
          revision: 'revision-1',
          status: 'modified',
          insertions: 1,
          deletions: 0,
        );
        final first = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await first.restoreSession('session-1');
        first.put(
          key,
          const RemoteFileDiff(filePath: 'src/a.dart', patch: '+new'),
        );
        await first.flush();

        final disconnected = RemoteFileDiffCache(maxEntries: 4, persist: true);
        final vm = RemoteControlViewModel(
          repository: MockRemoteControlRepository(latency: Duration.zero),
          fileDiffCache: disconnected,
        );
        await vm.restoreIfIdle();
        await disconnected.flush();

        final oldSession = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await oldSession.restoreSession('session-1');
        expect(oldSession.get(key), isNull);
      },
    );

    test(
      'restoreIfIdle preserves persisted diffs when the session probe is unknown',
      () async {
        SharedPreferences.setMockInitialValues({});
        final key = RemoteFileDiffCacheKey(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          repoId: null,
          path: 'src/a.dart',
          source: RemoteDiffSource.committed,
          revision: 'revision-1',
          status: 'modified',
          insertions: 1,
          deletions: 0,
        );
        final first = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await first.restoreSession('session-1');
        first.put(
          key,
          const RemoteFileDiff(filePath: 'src/a.dart', patch: '+new'),
        );
        await first.flush();

        final disconnected = RemoteFileDiffCache(maxEntries: 4, persist: true);
        final vm = RemoteControlViewModel(
          repository: _UnknownSessionProbeRepository(),
          fileDiffCache: disconnected,
        );
        await vm.restoreIfIdle();
        await disconnected.flush();

        final restored = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await restored.restoreSession('session-1');
        expect(restored.get(key)?.patch, '+new');
      },
    );
  });

  group('RemoteControlViewModel composer controls', () {
    const worktree = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );

    Future<RemoteControlViewModel> connected(
      FakeRemoteControlRepository repository,
    ) async {
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      return vm;
    }

    test('forwards each setter and cancel to the repository', () async {
      final repository = FakeRemoteControlRepository();
      final vm = await connected(repository);

      await vm.setChatModel(worktree, 'gpt-5-codex');
      await vm.setChatPlanMode(worktree, true);
      await vm.setChatThinkingLevel(worktree, 'high');
      await vm.setChatFastMode(worktree, true);
      await vm.cancelChat(worktree);

      expect(repository.lastSetModel, 'gpt-5-codex');
      expect(repository.lastSetPlanMode, isTrue);
      expect(repository.lastSetThinkingLevel, 'high');
      expect(repository.lastSetFastMode, isTrue);
      expect(repository.lastCancelTarget, worktree);
    });

    test('an asynchronous cancel failure remains visible', () async {
      final repository = FakeRemoteControlRepository();
      final vm = await connected(repository);

      await vm.cancelChat(worktree);
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The cancel was rejected.',
              commandId: 'fake-cmd-1',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(vm.commandFailureMessage, 'The cancel was rejected.');
      expect(vm.hasCommandFailed('fake-cmd-1'), isTrue);
    });

    test('setters are no-ops until connected', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );

      await vm.setChatModel(worktree, 'gpt-5-codex');
      await vm.cancelChat(worktree);

      expect(repository.lastSetModel, isNull);
      expect(repository.lastCancelTarget, isNull);
    });
  });

  group('RemoteControlViewModel events', () {
    RemoteControlViewModel connectedVm(FakeRemoteControlRepository repository) {
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      return vm;
    }

    RemoteChatMessage message(
      String messageId, {
      String chatId = 'chat-1',
      ChatRole role = ChatRole.assistant,
      ChatMessageStatus status = ChatMessageStatus.complete,
      RemoteChatScope? scope,
      String text = 'hello',
    }) => RemoteChatMessage(
      messageId: messageId,
      chatId: chatId,
      role: role,
      status: status,
      scope: scope,
      text: text,
    );

    Future<void> pump() => Future<void>.delayed(Duration.zero);

    const worktreeChatTarget = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );
    const standaloneChatTarget = RemoteStandaloneChatTarget(chatId: 'chat-1');

    test(
      'cowork removal refreshes connected rows and stays absent after reconnect',
      () async {
        var removed = false;
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [
              {'localId': 'default', 'name': 'Default', 'type': 'cowork'},
            ],
            'worktrees': [],
            'standaloneChats': removed
                ? []
                : [
                    {
                      'localId': 'chat-1',
                      'projectLocalId': 'default',
                      'title': 'ping',
                      'workEntryId': 'entry-1',
                    },
                    {
                      'localId': 'chat-2',
                      'projectLocalId': 'default',
                      'title': 'New Chat',
                      'workEntryId': 'entry-1',
                    },
                  ],
          });
        final vm = connectedVm(repository);
        addTearDown(vm.dispose);
        await vm.connect('123456');
        expect(vm.standaloneChatsFor('default'), hasLength(1));
        removed = true;
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.delta',
                'payload': {
                  'scope': 'overview',
                  'removed': [
                    {
                      'entityType': 'standalone_chat',
                      'localId': 'chat-1',
                      'parentLocalId': 'default',
                    },
                    {
                      'entityType': 'standalone_chat',
                      'localId': 'chat-2',
                      'parentLocalId': 'default',
                    },
                  ],
                },
              },
            ],
          }),
        );
        await pump();
        await pump();
        expect(vm.standaloneChatsFor('default'), isEmpty);
        expect(vm.unmatchedStandaloneChats, isEmpty);
        await vm.disconnect();
        await vm.connect('123456');
        expect(vm.standaloneChatsFor('default'), isEmpty);
      },
    );

    test('overview preserves hydrated transcripts and tabs', () async {
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = initialOverview;
      final vm = connectedVm(repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetChatId: 'chat-1',
              targetChatScope: RemoteChatScope.worktree,
              chatMessages: [message('hydrated')],
              chatSummaries: const [
                RemoteChatSummary(
                  chatId: 'chat-1',
                  scope: RemoteChatScope.worktree,
                  title: 'Loaded chat',
                  workspaceLocalId: 'ws-1',
                  worktreeLocalId: 'wt-1',
                ),
              ],
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();
      final summaries = vm.snapshot!.chatSummaries;
      repository.eventsController.add(overviewBatch());
      await pump();
      expect(vm.snapshot!.chatSummaries, same(summaries));
      expect(vm.messagesFor(worktreeChatTarget).single.messageId, 'hydrated');
      vm.ensureChatTranscript(worktreeChatTarget);
      await pump();
      expect(repository.requestChatTranscriptCalls, 0);
      expect(repository.snapshotFetches, 1);
      for (final scope in ['workspace', 'chat', 'pr', 'unknown']) {
        repository.eventsController.add(
          overviewBatch(scope: scope, entities: []),
        );
      }
      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.state.snapshot',
              'payload': {'scope': 'overview'},
            },
          ],
        }),
      );
      await pump();
      expect(vm.allWorktrees.single.prStatuses.single.state, 'merged');
    });

    RemotePortalEventBatch revisionBatch(int count, int cursor) =>
        RemotePortalEventBatch(
          nextCursor: cursor,
          events: [
            for (var i = 0; i < count; i++)
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage.fromWireJson({
                  'messageId': 'answer',
                  'chatId': 'chat-1',
                  'role': 'assistant',
                  'status': 'streaming',
                  'text': 'revision $cursor-$i',
                  'createdAtMs': 1000,
                  'updatedAtMs': cursor * 100 + i,
                }),
              ),
          ],
        );

    test('the post-unlock backlog paints once, after it drains', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      vm.onAppBackgrounded();

      var paints = 0;
      vm.addListener(() => paints += 1);
      await vm.onAppForegrounded();
      // Foreground metadata can repaint before the first backlog batch.
      paints = 0;
      // Full server pages mean more backlog is queued behind them.
      for (var cursor = 1; cursor <= 3; cursor++) {
        repository.eventsController.add(
          revisionBatch(kRemotePortalEventBatchMaxCount, cursor),
        );
        await pump();
      }
      expect(paints, 0);

      repository.eventsController.add(revisionBatch(2, 4));
      await pump();
      expect(paints, 1);
      expect(vm.messagesFor(worktreeChatTarget).single.text, 'revision 4-1');

      // Live delivery after the catch-up paints every batch again.
      repository.eventsController.add(revisionBatch(1, 5));
      await pump();
      expect(paints, 2);
    });

    test('an empty post-unlock backlog does not hold user repaints', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      vm.onAppBackgrounded();

      var paints = 0;
      vm.addListener(() => paints += 1);
      await vm.onAppForegrounded();
      paints = 0;

      // The event stream has no batch to deliver after an idle unlock.
      final send = vm.sendChatMessage(worktreeChatTarget, 'hello');
      expect(paints, greaterThan(0));
      expect(vm.messagesFor(worktreeChatTarget).last.text, 'hello');
      await send;
    });

    test('a backlog that never drains still paints after the cap', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        unawaited(vm.connect('123456'));
        async.flushMicrotasks();
        vm.onAppBackgrounded();

        var paints = 0;
        vm.addListener(() => paints += 1);
        unawaited(vm.onAppForegrounded());
        repository.eventsController.add(
          revisionBatch(kRemotePortalEventBatchMaxCount, 1),
        );
        async.flushMicrotasks();
        expect(paints, 0);

        async.elapse(kRemoteEventCatchUpMaxHold);
        expect(paints, 1);
        repository.eventsController.add(
          revisionBatch(kRemotePortalEventBatchMaxCount, 2),
        );
        async.flushMicrotasks();
        expect(paints, 2);
        vm.dispose();
        unawaited(repository.eventsController.close());
        async.flushMicrotasks();
      });
    });

    RemoteWorktree shellWorktree(int index) => RemoteWorktree(
      localId: 'wt-$index',
      workspaceLocalId: 'ws-1',
      branch: 'feature/wt-$index',
    );

    const shellWorkspace = RemoteWorkspace(
      localId: 'ws-1',
      name: 'Repository',
      type: RemoteWorkspaceType.singleRepo,
    );

    RemoteSessionSnapshot shellRead(int worktrees, int cursor) =>
        RemoteSessionSnapshot(
          workspaces: const [shellWorkspace],
          worktrees: [for (var i = 1; i <= worktrees; i++) shellWorktree(i)],
          standaloneChats: const [],
          eventCursor: cursor,
        );

    /// One backlog page holding the overview the desktop pushed after its
    /// [worktrees]th worktree was created.
    RemotePortalEventBatch overviewPage(int worktrees, int cursor) =>
        RemotePortalEventBatch(
          nextCursor: cursor,
          events: [
            RemoteStateSnapshotEvent(
              eventId: 'overview-$cursor',
              cursor: cursor,
              scope: 'overview',
              workspaces: const [shellWorkspace],
              worktrees: [
                for (var i = 1; i <= worktrees; i++) shellWorktree(i),
              ],
            ),
          ],
        );

    test(
      'a foreground backlog cannot walk the sidebar back through history',
      () async {
        final repository = _GatedNextSnapshotRepository();
        var reads = 0;
        repository.snapshotBuilder = () =>
            ++reads == 1 ? shellRead(1, 10) : shellRead(5, 100);
        final vm = connectedVm(repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        vm.onAppBackgrounded();

        // Five worktrees were created while the phone was locked. The replay
        // starts from the old cursor before the fresh overview read returns.
        final readGate = Completer<void>();
        repository.gateNextSnapshot = readGate;
        final foreground = vm.onAppForegrounded();
        repository.eventsController.add(overviewPage(2, 20));
        await pump();
        readGate.complete();
        await foreground;
        expect(vm.allWorktrees, hasLength(5));

        final painted = <int>[];
        vm.addListener(() => painted.add(vm.allWorktrees.length));
        // The rest of the backlog the read already covers.
        for (var created = 3; created <= 5; created++) {
          repository.eventsController.add(overviewPage(created, created * 20));
          await pump();
          expect(vm.allWorktrees, hasLength(5));
        }
        // A worktree created after the read still lands live.
        repository.eventsController.add(overviewPage(6, 101));
        await pump();
        expect(vm.allWorktrees, hasLength(6));
        expect(painted.where((count) => count < 5), isEmpty);
      },
    );

    test('a foreground replay paints once the fresh read lands', () async {
      final repository = _GatedNextSnapshotRepository();
      var reads = 0;
      repository.snapshotBuilder = () =>
          ++reads == 1 ? shellRead(1, 10) : shellRead(5, 100);
      final vm = connectedVm(repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      vm.onAppBackgrounded();

      final painted = <int>[];
      vm.addListener(() => painted.add(vm.allWorktrees.length));
      final readGate = Completer<void>();
      repository.gateNextSnapshot = readGate;
      final foreground = vm.onAppForegrounded();
      // Pages of large overviews are cut by the byte budget, not the count.
      for (var created = 2; created <= 4; created++) {
        repository.eventsController.add(overviewPage(created, created * 10));
        await pump();
      }
      expect(painted.where((count) => count > 1), isEmpty);

      readGate.complete();
      await foreground;
      // Later unrelated repaints may repeat the state; none show history.
      expect(painted.where((count) => count > 1).toSet(), {5});

      // Live delivery after the read paints every batch again.
      repository.eventsController.add(overviewPage(6, 101));
      await pump();
      expect(painted.where((count) => count > 1).toSet(), {5, 6});
      expect(painted.last, 6);
    });

    test('a failed foreground read releases the replay hold', () async {
      final repository = _FailingNextSnapshotRepository();
      final vm = connectedVm(repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      vm.onAppBackgrounded();

      var paints = 0;
      vm.addListener(() => paints += 1);
      repository.failNextSnapshot = true;
      await vm.onAppForegrounded();
      paints = 0;
      repository.eventsController.add(overviewPage(2, 20));
      await pump();
      expect(paints, 1);
      expect(vm.allWorktrees, hasLength(2));
    });

    test('a foreground read that never lands still paints after the cap', () {
      fakeAsync((async) {
        final repository = _GatedNextSnapshotRepository();
        final vm = connectedVm(repository);
        unawaited(vm.connect('123456'));
        async.flushMicrotasks();
        vm.onAppBackgrounded();

        var paints = 0;
        vm.addListener(() => paints += 1);
        repository.gateNextSnapshot = Completer<void>();
        unawaited(vm.onAppForegrounded());
        async.flushMicrotasks();
        paints = 0;
        repository.eventsController.add(overviewPage(2, 20));
        async.flushMicrotasks();
        expect(paints, 0);

        async.elapse(kRemoteEventCatchUpMaxHold);
        expect(paints, 1);
        vm.dispose();
        unawaited(repository.eventsController.close());
        async.flushMicrotasks();
      });
    });

    test('live full batches without an unlock are not held', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');

      var paints = 0;
      vm.addListener(() => paints += 1);
      repository.eventsController.add(
        revisionBatch(kRemotePortalEventBatchMaxCount, 1),
      );
      await pump();
      expect(paints, 1);
    });

    test('optimistic sends render immediately and dedupe on echo', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      await vm.sendChatMessage(worktreeChatTarget, 'run the tests');

      var messages = vm.messagesFor(worktreeChatTarget);
      expect(messages.single.text, 'run the tests');
      expect(messages.single.role, ChatRole.user);

      // Desktop echoes the user message with its own id: the optimistic
      // bubble is consumed instead of duplicated.
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: message(
                'authoritative-1',
                role: ChatRole.user,
                text: 'run the tests',
              ),
            ),
          ],
          nextCursor: 3,
        ),
      );
      await pump();

      messages = vm.messagesFor(worktreeChatTarget);
      expect(messages, hasLength(1));
      expect(messages.single.messageId, 'authoritative-1');
    });

    test('an asynchronous command failure replaces its optimistic send with a '
        'not-sent row', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      await vm.sendChatMessage(worktreeChatTarget, 'run the tests');
      expect(vm.messagesFor(worktreeChatTarget), hasLength(1));

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The send was rejected.',
              commandId: 'fake-cmd',
            ),
          ],
          nextCursor: 4,
        ),
      );
      await pump();

      final row = vm.messagesFor(worktreeChatTarget).single;
      expect(row.delivery, ChatDelivery.notSent);
      expect(row.deliveryNote, 'The send was rejected.');
      expect(vm.hasCommandFailed('fake-cmd'), isTrue);
      expect(vm.commandFailureMessage, 'The send was rejected.');
      vm.clearCommandFailure();
      expect(vm.commandFailureMessage, isNull);
    });

    test(
      'a failure racing ahead of the submit response keeps a not-sent row',
      () async {
        final repository = _GatedSendRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');

        final send = vm.sendChatMessage(worktreeChatTarget, 'run the tests');
        final expectation = expectLater(
          send,
          throwsA(isA<RemoteChatSendNotSentException>()),
        );
        await pump();
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The send was rejected early.',
                commandId: 'cmd-race',
              ),
            ],
            nextCursor: 4,
          ),
        );
        await pump();
        expect(vm.messagesFor(worktreeChatTarget), hasLength(1));
        expect(vm.commandFailureMessage, isNull);
        repository.sendCompleter.complete(
          const RemoteChatSendResult(commandId: 'cmd-race', chatId: 'chat-1'),
        );
        await expectation;

        final row = vm.messagesFor(worktreeChatTarget).single;
        expect(row.delivery, ChatDelivery.notSent);
        expect(row.deliveryNote, 'The send was rejected early.');
        expect(vm.commandFailureMessage, 'The send was rejected early.');
      },
    );

    for (final mismatch in ['id', 'chat', 'scope', 'role']) {
      test(
        'uncertain send does not accept an echo with a different $mismatch',
        () async {
          final repository = FakeRemoteControlRepository();
          final vm = connectedVm(repository);
          await vm.connect('123456');
          repository.sendChatMessageHandler = () async {
            final id =
                repository.sendChatMessageCalls.single.options!.userMessageId!;
            repository.cachedChatMessages = [
              RemoteChatMessage(
                messageId: mismatch == 'id' ? 'older-message' : id,
                chatId: mismatch == 'chat' ? 'other-chat' : 'chat-1',
                scope: mismatch == 'scope'
                    ? RemoteChatScope.standalone
                    : RemoteChatScope.worktree,
                role: mismatch == 'role' ? ChatRole.assistant : ChatRole.user,
                text: 'run the tests',
                status: ChatMessageStatus.complete,
              ),
            ];
            throw const RemoteChatSendOutcomeUnknownException(
              'Connection interrupted',
            );
          };
          await expectLater(
            vm.sendChatMessage(worktreeChatTarget, 'run the tests'),
            throwsA(isA<RemoteChatSendNotSentException>()),
          );
          final row = vm.messagesFor(worktreeChatTarget).single;
          expect(row.delivery, ChatDelivery.uncertain);
          expect(row.messageId, isNot('older-message'));
          expect(repository.sendChatMessageCalls, hasLength(1));
          vm.dispose();
        },
      );
    }

    for (final dispose in [false, true]) {
      test(
        'background send recovery stops on ${dispose ? 'disposal' : 'disconnect'}',
        () async {
          final repository = FakeRemoteControlRepository();
          final vm = connectedVm(repository);
          await vm.connect('123456');
          repository.sendChatMessageHandler = () async {
            throw const RemoteChatSendOutcomeUnknownException(
              'Connection interrupted',
            );
          };
          vm.onAppBackgrounded();
          final send = vm.sendChatMessage(worktreeChatTarget, 'run the tests');
          final expectation = expectLater(
            send,
            throwsA(isA<RemoteControlException>()),
          );
          await pump();
          expect(repository.cachedChatFetches, 0);
          if (dispose) {
            vm.dispose();
          } else {
            await vm.disconnect();
          }
          await expectation;
          expect(repository.cachedChatFetches, 0);
          if (!dispose) vm.dispose();
        },
      );
    }

    test('a failed send keeps a not-sent row and throws', () async {
      final repository = _FailingSendRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      const target = RemoteStandaloneChatTarget(chatId: 'chat-1');
      await expectLater(
        vm.sendChatMessage(target, 'hello'),
        throwsA(isA<RemoteChatSendNotSentException>()),
      );
      final row = vm.messagesFor(target).single;
      expect(row.delivery, ChatDelivery.notSent);
      expect(row.deliveryNote, 'send failed');
    });

    test(
      'targeted chat snapshots seed transcripts without an overview refresh',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');
        final fetchesAfterConnect = repository.snapshotFetches;

        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                targetChatId: 'chat-1',
                targetChatScope: RemoteChatScope.worktree,
                chatMessages: [message('msg-h1'), message('msg-h2')],
              ),
            ],
            nextCursor: 4,
          ),
        );
        await pump();
        await pump();
        await pump();

        expect(vm.messagesFor(worktreeChatTarget), hasLength(2));
        expect(repository.snapshotFetches, fetchesAfterConnect);
      },
    );

    test(
      'a remote session end returns to the connect form with copy',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [RemoteSessionEndedEvent()],
            nextCursor: 5,
          ),
        );
        await pump();

        expect(vm.status, RemoteConnectionStatus.error);
        expect(vm.error, isA<RemoteControlException>());
        expect(vm.connection, isNull);
        expect(vm.messagesFor(standaloneChatTarget), isEmpty);
        expect(repository.pauseEventsCalls, greaterThan(0));
      },
    );

    test('an ended connection status terminates the paired session', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [],
          nextCursor: 6,
          connectionStatus: RemotePortalConnectionStatus.ended,
        ),
      );
      await pump();

      expect(vm.status, RemoteConnectionStatus.error);
      expect(vm.connection, isNull);
      expect(repository.pauseEventsCalls, greaterThan(0));
    });

    test(
      'a foreign command failure is ignored while shared session state updates',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message:
                    'Unsupported portal command: '
                    'portal.app_advisor.settings.get',
                commandId: 'web-client-command',
              ),
            ],
            nextCursor: 7,
            connectionStatus: RemotePortalConnectionStatus.inactive,
          ),
        );
        await pump();

        expect(vm.commandFailureMessage, isNull);
        expect(vm.hasCommandFailed('web-client-command'), isFalse);
        expect(
          vm.portalConnectionStatus,
          RemotePortalConnectionStatus.inactive,
        );
      },
    );

    test('isSyncing mirrors the snapshot refreshing flag', () async {
      final repository = FakeRemoteControlRepository();
      var refreshing = true;
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [],
        standaloneChats: const [],
        refreshing: refreshing,
      );
      final vm = connectedVm(repository);
      await vm.connect('123456');
      expect(vm.isSyncing, isTrue);

      refreshing = false;
      await vm.refresh();
      expect(vm.isSyncing, isFalse);
    });

    test('chat transcript hydration drives its loading state', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      const target = RemoteStandaloneChatTarget(chatId: 'chat-1');
      vm.ensureChatTranscript(target);
      await pump();
      expect(vm.isChatTranscriptLoading(target), isTrue);

      // The desktop answers with a (possibly empty) chat-scoped snapshot.
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetChatId: 'chat-1',
              targetChatScope: RemoteChatScope.standalone,
            ),
          ],
          nextCursor: 6,
        ),
      );
      await pump();
      expect(vm.isChatTranscriptLoading(target), isFalse);
    });

    test(
      'live messages do not suppress authoritative transcript hydration',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');

        const target = RemoteStandaloneChatTarget(chatId: 'chat-live');
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-live',
                scope: RemoteChatScope.standalone,
                message: message('live-1', chatId: 'chat-live'),
              ),
            ],
            nextCursor: 7,
          ),
        );
        await pump();

        vm.ensureChatTranscript(target);
        await pump();

        expect(repository.requestChatTranscriptCalls, 1);
      },
    );

    test(
      'generic snapshot messages do not suppress transcript hydration',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');

        const target = RemoteStandaloneChatTarget(chatId: 'chat-cached');
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'overview',
                chatMessages: [
                  message(
                    'cached-1',
                    chatId: 'chat-cached',
                    scope: RemoteChatScope.standalone,
                  ),
                ],
              ),
            ],
            nextCursor: 7,
          ),
        );
        await pump();

        vm.ensureChatTranscript(target);
        await pump();

        expect(vm.messagesFor(target), hasLength(1));
        expect(repository.requestChatTranscriptCalls, 1);
      },
    );

    test('failed transcript hydration exposes a retryable error', () {
      fakeAsync((async) {
        final repository = _FailingChatHydrationRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          clock: () => DateTime(2026).add(async.elapsed),
        );
        vm.connect('123456');
        async.flushMicrotasks();

        const target = RemoteStandaloneChatTarget(chatId: 'chat-failing');
        vm.ensureChatTranscript(target);
        async.flushMicrotasks();

        // CAN-3631: the first failure waits for the automatic retry.
        expect(vm.isChatTranscriptLoading(target), isTrue);
        expect(vm.chatHydrationError(target), isNull);
        expect(repository.requestChatTranscriptCalls, 1);

        async.elapse(kRemoteHydrationRetryWindow);
        expect(repository.requestChatTranscriptCalls, 2);
        expect(vm.isChatTranscriptLoading(target), isFalse);
        expect(vm.chatHydrationError(target), 'Transcript unavailable.');

        vm.retryChatTranscript(target);
        async.flushMicrotasks();
        expect(repository.requestChatTranscriptCalls, 3);
        expect(vm.chatHydrationError(target), isNull);
        async.elapse(kRemoteHydrationRetryWindow);
        expect(repository.requestChatTranscriptCalls, 4);
        expect(vm.chatHydrationError(target), 'Transcript unavailable.');
        vm.dispose();
      });
    });

    test('worktree chat-tab hydration drives its loading state', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      await pump();
      expect(
        vm.isWorktreeChatsLoading(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        isTrue,
      );

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ],
          nextCursor: 7,
        ),
      );
      // The loading state clears only after the follow-up state re-fetch, so
      // the tab list flips straight from loading to hydrated summaries.
      await pump();
      await pump();
      await pump();
      expect(
        vm.isWorktreeChatsLoading(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        isFalse,
      );
    });

    test(
      'cached chat tabs do not suppress worktree activity hydration',
      () async {
        final repository = FakeRemoteControlRepository();
        // Chat tabs reach the server cache through chat_summary deltas while
        // the desktop streams, so the connect-time /state fetch already knows
        // wt-1's tabs even though no worktree-scoped snapshot ever ran.
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [],
          chatSummaries: [
            RemoteChatSummary(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Streaming agent chat',
            ),
          ],
        );
        final vm = connectedVm(repository);
        await vm.connect('123456');
        expect(
          vm.chatSummariesFor(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          hasLength(1),
        );

        // The activity/files slices (scripts, plans, hooks, pipeline runs,
        // changed files, todos) only ever arrive via the worktree-scoped
        // snapshot, so opening the worktree must still request it.
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        await pump();
        expect(repository.requestWorktreeStateCalls, 1);
      },
    );

    test(
      'a resolved worktree hydration is not re-requested in the session',
      () async {
        final repository = FakeRemoteControlRepository();
        var now = DateTime(2026, 8, 5, 12);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationRetryWindow: const Duration(seconds: 15),
          clock: () => now,
        );
        await vm.connect('123456');

        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        await pump();
        expect(repository.requestWorktreeStateCalls, 1);

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ],
            nextCursor: 7,
          ),
        );
        await pump();
        await pump();
        await pump();

        // The snapshot answered this worktree: later visits rely on delta
        // events + state re-fetches, even after the retry window lapses and
        // even though the authoritative answer left the tab list empty.
        now = now.add(const Duration(seconds: 16));
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        await pump();
        expect(repository.requestWorktreeStateCalls, 1);
      },
    );

    test('chat snapshots do not mark worktree activity as hydrated', () async {
      final repository = FakeRemoteControlRepository();
      var now = DateTime(2026, 8, 6, 12);
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        hydrationRetryWindow: const Duration(seconds: 15),
        clock: () => now,
      );
      await vm.connect('123456');

      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      await pump();

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              targetChatId: 'chat-1',
              targetChatScope: RemoteChatScope.worktree,
            ),
          ],
          nextCursor: 8,
        ),
      );
      await pump();
      await pump();
      await pump();

      now = now.add(const Duration(seconds: 16));
      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      await pump();

      expect(repository.requestWorktreeStateCalls, 2);
    });

    test(
      'targetless worktree snapshots do not mark pending worktrees hydrated',
      () async {
        final repository = FakeRemoteControlRepository();
        var now = DateTime(2026, 8, 6, 12);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationRetryWindow: const Duration(seconds: 15),
          clock: () => now,
        );
        await vm.connect('123456');

        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-2',
        );
        await pump();

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [RemoteStateSnapshotEvent(scope: 'worktree')],
            nextCursor: 9,
          ),
        );
        await pump();
        await pump();
        await pump();

        now = now.add(const Duration(seconds: 16));
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-2',
        );
        await pump();

        expect(repository.requestWorktreeStateCalls, 4);
      },
    );

    test(
      'failed snapshot refresh leaves worktree hydration retryable',
      () async {
        final repository = _FailingNextSnapshotRepository();
        var now = DateTime(2026, 8, 6, 12);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationRetryWindow: const Duration(seconds: 15),
          hydrationTimeout: const Duration(milliseconds: 20),
          clock: () => now,
        );
        await vm.connect('123456');

        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        repository.failNextSnapshot = true;
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ],
            nextCursor: 10,
          ),
        );
        await pump();
        await pump();
        expect(
          vm.isWorktreeChatsLoading(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          isTrue,
        );

        await Future<void>.delayed(const Duration(milliseconds: 30));
        now = now.add(const Duration(seconds: 16));
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        await pump();

        expect(repository.requestWorktreeStateCalls, 2);
      },
    );

    test(
      'newer successful refresh resolves superseded worktree hydration',
      () async {
        final repository = _GatedNextSnapshotRepository();
        var now = DateTime(2026, 8, 6, 12);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationRetryWindow: const Duration(seconds: 15),
          clock: () => now,
        );
        await vm.connect('123456');

        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        final supersededRefresh = Completer<void>();
        repository.gateNextSnapshot = supersededRefresh;
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ],
            nextCursor: 11,
          ),
        );
        await pump();
        expect(
          vm.isWorktreeChatsLoading(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          isTrue,
        );

        // A manual refresh supersedes the snapshot-triggered fetch and
        // successfully applies a newer view of the same server cache.
        await vm.refresh();
        await pump();
        await pump();
        supersededRefresh.complete();
        await pump();
        await pump();

        expect(
          vm.isWorktreeChatsLoading(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          isFalse,
        );
        now = now.add(const Duration(seconds: 16));
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        await pump();
        expect(repository.requestWorktreeStateCalls, 1);
      },
    );

    test('session reset supersedes post-snapshot hydration writes', () async {
      final repository = _GatedSnapshotRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      repository.gate = Completer<void>();
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ],
          nextCursor: 11,
        ),
      );
      await pump();

      await vm.disconnect();
      repository.gate?.complete();
      await pump();
      await pump();
      repository.gate = null;

      await vm.connect('654321');
      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      await pump();

      expect(repository.requestWorktreeStateCalls, 2);
    });

    test(
      'a stuck worktree hydration stays "loading" to the 60s watchdog, not 25s',
      () {
        // Real desktop projections of large workspaces take 5–30s (matching
        // the web portal's own 60s max-wait), so the watchdog must not give up
        // at 25s and flash the misleading "No chats yet" empty state.
        fakeAsync((async) {
          final repository = FakeRemoteControlRepository();
          // Uses the shipped default hydration timeout (no test injection).
          final vm = connectedVm(repository);
          vm.connect('123456');
          async.flushMicrotasks();

          vm.ensureWorktreeState(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          );
          async.flushMicrotasks();
          expect(
            vm.isWorktreeChatsLoading(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
            ),
            isTrue,
          );

          // Still loading well past the old 25s watchdog.
          async.elapse(const Duration(seconds: 30));
          expect(
            vm.isWorktreeChatsLoading(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
            ),
            isTrue,
          );

          // Only the 60s watchdog finally clears it.
          async.elapse(const Duration(seconds: 31));
          expect(
            vm.isWorktreeChatsLoading(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
            ),
            isFalse,
          );

          vm.dispose();
        });
      },
    );

    test('overview snapshots do not resolve worktree loading states', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      await pump();

      // An unrelated overview snapshot (e.g. the connect-time refresh answer)
      // lands while the worktree hydration is still in flight.
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [RemoteStateSnapshotEvent(scope: 'overview')],
          nextCursor: 8,
        ),
      );
      await pump();
      await pump();
      await pump();

      expect(
        vm.isWorktreeChatsLoading(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        isTrue,
      );
    });

    test(
      'an empty authoritative transcript snapshot completes hydration',
      () async {
        final repository = FakeRemoteControlRepository();
        var now = DateTime(2026, 7, 17, 12);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationRetryWindow: const Duration(seconds: 15),
          clock: () => now,
        );
        await vm.connect('123456');

        const target = RemoteStandaloneChatTarget(chatId: 'chat-1');
        vm.ensureChatTranscript(target);
        await pump();
        expect(repository.requestChatTranscriptCalls, 1);

        // An empty chat-scoped snapshot is still an authoritative answer.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                targetChatId: 'chat-1',
                targetChatScope: RemoteChatScope.standalone,
              ),
            ],
            nextCursor: 9,
          ),
        );
        await pump();

        // Once answered, repeated builds never re-request merely because the
        // authoritative transcript is empty.
        vm.ensureChatTranscript(target);
        await pump();
        expect(repository.requestChatTranscriptCalls, 1);

        // Advancing past the retry window does not change that.
        now = now.add(const Duration(seconds: 16));
        vm.ensureChatTranscript(target);
        await pump();
        expect(repository.requestChatTranscriptCalls, 1);
      },
    );

    test('a stuck hydration times out instead of spinning forever', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        hydrationTimeout: const Duration(milliseconds: 20),
      );
      await vm.connect('123456');

      vm.ensureWorktreeState(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      expect(
        vm.isWorktreeChatsLoading(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        isTrue,
      );

      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(
        vm.isWorktreeChatsLoading(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        isFalse,
      );
    });

    test(
      'warm foreground resumes events before slow metadata finishes',
      () async {
        final repository = _SlowForegroundRepository();
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        await vm.connect('123456');
        vm.onAppBackgrounded();
        final resumed = repository.resumeEventsCalls;
        final foreground = vm.onAppForegrounded();
        await pump();
        expect(repository.resumeEventsCalls, resumed + 1);
        repository.metadata.complete(null);
        await foreground;
        expect(repository.resumeEventsCalls, resumed + 1);
      },
    );

    test(
      'transcript timeout retries once then remains explicitly retryable',
      () {
        fakeAsync((async) {
          final repository = FakeRemoteControlRepository();
          final vm = RemoteControlViewModel(
            repository: repository,
            hydrationTimeout: const Duration(seconds: 2),
            hydrationRetryWindow: const Duration(seconds: 1),
            clock: () => DateTime(2026).add(async.elapsed),
          );
          vm.connect('123456');
          async.flushMicrotasks();
          const target = RemoteStandaloneChatTarget(chatId: 'stalled');
          vm.ensureChatTranscript(target);
          async.elapse(const Duration(seconds: 2));
          // CAN-3631: no error while the automatic retry is still due.
          expect(vm.chatHydrationError(target), isNull);
          expect(vm.isChatTranscriptLoading(target), isTrue);
          async.elapse(const Duration(seconds: 1));
          expect(repository.requestChatTranscriptCalls, 2);
          expect(vm.chatHydrationError(target), isNull);
          async.elapse(const Duration(seconds: 2));
          expect(
            vm.chatHydrationError(target),
            'The conversation took too long to load. Try again.',
          );
          expect(vm.isChatTranscriptLoading(target), isFalse);
          async.elapse(const Duration(seconds: 1));
          expect(repository.requestChatTranscriptCalls, 2);
          vm.ensureChatTranscript(target);
          async.elapse(const Duration(minutes: 1));
          expect(repository.requestChatTranscriptCalls, 2);
          vm.retryChatTranscript(target);
          async.flushMicrotasks();
          expect(repository.requestChatTranscriptCalls, 3);
          vm.dispose();
        });
      },
    );

    group('CAN-3631 chat loads across the background', () {
      const timedOut = 'The conversation took too long to load. Try again.';
      const standalone = RemoteStandaloneChatTarget(chatId: 'chat-1');
      const worktreeChat = RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        chatId: 'chat-1',
      );
      final cases =
          <
            ({
              String name,
              bool foregroundChat,
              void Function(RemoteControlViewModel vm) open,
              bool Function(RemoteControlViewModel vm) loading,
              String? Function(RemoteControlViewModel vm) error,
              RemoteStateSnapshotEvent reply,
            })
          >[
            (
              name: 'standalone chat',
              foregroundChat: false,
              open: (vm) => vm.ensureChatTranscript(standalone),
              loading: (vm) => vm.isChatTranscriptLoading(standalone),
              error: (vm) => vm.chatHydrationError(standalone),
              reply: const RemoteStateSnapshotEvent(
                scope: 'chat',
                targetChatId: 'chat-1',
                targetChatScope: RemoteChatScope.standalone,
              ),
            ),
            (
              name: 'worktree chat',
              foregroundChat: false,
              open: (vm) => vm.ensureChatTranscript(worktreeChat),
              loading: (vm) => vm.isChatTranscriptLoading(worktreeChat),
              error: (vm) => vm.chatHydrationError(worktreeChat),
              reply: const RemoteStateSnapshotEvent(
                scope: 'chat',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
                targetChatId: 'chat-1',
                targetChatScope: RemoteChatScope.worktree,
              ),
            ),
            (
              name: "worktree's selected chat",
              foregroundChat: true,
              open: (vm) => vm.ensureForegroundWorktreeChat(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
              ),
              loading: (vm) => vm.isWorktreeChatsLoading(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
              ),
              error: (vm) => vm.foregroundChatError('ws-1', 'wt-1'),
              reply: const RemoteStateSnapshotEvent(
                scope: 'chat',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ),
          ];

      RemoteControlViewModel connectAt(
        FakeAsync async,
        FakeRemoteControlRepository repository,
      ) {
        final vm = RemoteControlViewModel(
          repository: repository,
          clock: () => DateTime(2026).add(async.elapsed),
        );
        vm.connect('123456');
        async.flushMicrotasks();
        return vm;
      }

      void foreground(FakeAsync async, RemoteControlViewModel vm) {
        unawaited(vm.onAppForegrounded());
        async.flushMicrotasks();
        async.elapse(Duration.zero);
      }

      for (final c in cases) {
        test('AC1 ${c.name}: a reply after returning loads the chat', () {
          fakeAsync((async) {
            final repository = FakeRemoteControlRepository()
              ..supportsForegroundChat = c.foregroundChat;
            final vm = connectAt(async, repository);
            c.open(vm);
            async.elapse(const Duration(seconds: 3));
            expect(repository.requestChatTranscriptCalls, 1);
            vm.onAppBackgrounded();
            async.elapse(_warmBackground);
            expect(c.error(vm), isNull);

            foreground(async, vm);
            expect(c.error(vm), isNull);
            expect(c.loading(vm), isTrue);
            async.elapse(const Duration(seconds: 30));
            expect(c.error(vm), isNull);
            expect(repository.requestChatTranscriptCalls, 1);

            repository.eventsController.add(
              RemotePortalEventBatch(events: [c.reply], nextCursor: 1),
            );
            async.flushMicrotasks();
            expect(c.error(vm), isNull);
            expect(c.loading(vm), isFalse);
            async.elapse(const Duration(minutes: 5));
            expect(repository.requestChatTranscriptCalls, 1);
            expect(c.error(vm), isNull);
            vm.dispose();
          });
        });

        test('AC1 ${c.name}: a reply sent while away lands on return', () {
          fakeAsync((async) {
            final repository = BufferingRemoteControlRepository()
              ..supportsForegroundChat = c.foregroundChat;
            final vm = connectAt(async, repository);
            c.open(vm);
            async.elapse(const Duration(seconds: 3));
            repository.onNextPause = () => repository.deliver(
              RemotePortalEventBatch(events: [c.reply], nextCursor: 1),
            );
            vm.onAppBackgrounded();
            async.elapse(_warmBackground);
            expect(repository.heldDeliveries, 1);
            expect(repository.replayedDeliveries, 0);
            expect(c.error(vm), isNull);
            expect(c.loading(vm), isTrue);

            foreground(async, vm);
            expect(repository.replayedDeliveries, 1);
            expect(c.error(vm), isNull);
            expect(c.loading(vm), isFalse);
            async.elapse(const Duration(minutes: 5));
            expect(repository.requestChatTranscriptCalls, 1);
            expect(c.error(vm), isNull);
            vm.dispose();
          });
        });

        test('AC2 ${c.name}: a silent desktop gets a fresh timeout', () {
          fakeAsync((async) {
            final repository = FakeRemoteControlRepository()
              ..supportsForegroundChat = c.foregroundChat;
            final vm = connectAt(async, repository);
            c.open(vm);
            async.elapse(const Duration(seconds: 3));
            vm
              ..onAppBackgrounded()
              // Hidden and paused both report the background.
              ..onAppBackgrounded();
            async.elapse(_warmBackground);
            foreground(async, vm);

            async.elapse(const Duration(seconds: 59));
            expect(c.error(vm), isNull);
            async.elapse(const Duration(seconds: 1));
            expect(c.error(vm), isNull);
            expect(c.loading(vm), isTrue);
            async.elapse(const Duration(seconds: 14));
            expect(repository.requestChatTranscriptCalls, 1);
            async.elapse(const Duration(seconds: 1));
            expect(repository.requestChatTranscriptCalls, 2);
            expect(c.error(vm), isNull);

            async.elapse(const Duration(seconds: 59));
            expect(c.error(vm), isNull);
            async.elapse(const Duration(seconds: 1));
            expect(c.error(vm), timedOut);
            expect(c.loading(vm), isFalse);
            async.elapse(const Duration(minutes: 5));
            expect(repository.requestChatTranscriptCalls, 2);
            vm.dispose();
          });
        });

        test('${c.name}: a load waiting through a long background is sent '
            'again after the reload', () {
          fakeAsync((async) {
            final repository = FakeRemoteControlRepository()
              ..supportsForegroundChat = c.foregroundChat;
            final vm = connectAt(async, repository);
            c.open(vm);
            async.elapse(const Duration(seconds: 3));
            vm.onAppBackgrounded();
            async.elapse(kRemoteFreshResumeAfter);

            foreground(async, vm);
            // The reload skipped the events the first reply could be in.
            expect(repository.discardEventCursorCalls, 1);
            expect(repository.requestChatTranscriptCalls, 2);
            expect(c.loading(vm), isTrue);

            repository.eventsController.add(
              RemotePortalEventBatch(events: [c.reply], nextCursor: 1),
            );
            async.flushMicrotasks();
            expect(c.error(vm), isNull);
            expect(c.loading(vm), isFalse);
            async.elapse(const Duration(minutes: 5));
            expect(repository.requestChatTranscriptCalls, 2);
            vm.dispose();
          });
        });

        test('AC5 ${c.name}: a retry due in the background waits', () {
          fakeAsync((async) {
            final repository = FakeRemoteControlRepository()
              ..supportsForegroundChat = c.foregroundChat;
            final vm = connectAt(async, repository);
            c.open(vm);
            async.elapse(const Duration(seconds: 65));
            vm.onAppBackgrounded();
            async.elapse(_warmBackground);
            expect(repository.requestChatTranscriptCalls, 1);

            foreground(async, vm);
            expect(repository.requestChatTranscriptCalls, 2);
            expect(c.error(vm), isNull);
            expect(c.loading(vm), isTrue);
            foreground(async, vm);
            expect(repository.requestChatTranscriptCalls, 2);

            async.elapse(const Duration(seconds: 59));
            expect(c.error(vm), isNull);
            async.elapse(const Duration(seconds: 1));
            expect(c.error(vm), timedOut);
            async.elapse(const Duration(minutes: 5));
            expect(repository.requestChatTranscriptCalls, 2);
            vm.dispose();
          });
        });
      }

      test('a short background keeps the rest of the retry delay', () {
        fakeAsync((async) {
          final repository = FakeRemoteControlRepository();
          final vm = connectAt(async, repository);
          vm.ensureChatTranscript(standalone);
          async.elapse(const Duration(seconds: 65));
          vm.onAppBackgrounded();
          async.elapse(const Duration(seconds: 5));
          foreground(async, vm);
          async.elapse(const Duration(seconds: 4));
          expect(repository.requestChatTranscriptCalls, 1);
          async.elapse(const Duration(seconds: 1));
          expect(repository.requestChatTranscriptCalls, 2);
          expect(vm.chatHydrationError(standalone), isNull);
          vm.dispose();
        });
      });

      test('returning without a background keeps the running timeout', () {
        fakeAsync((async) {
          final repository = FakeRemoteControlRepository();
          final vm = connectAt(async, repository);
          vm.ensureChatTranscript(standalone);
          async.elapse(const Duration(seconds: 30));
          // An inactive -> resumed transition reports a foreground only.
          foreground(async, vm);
          async.elapse(const Duration(seconds: 30 + 15));
          expect(repository.requestChatTranscriptCalls, 2);
          vm.dispose();
        });
      });
    });

    test(
      'missing snapshot displays cached chat without an overview refresh',
      () {
        fakeAsync((async) {
          final repo = FakeRemoteControlRepository()
            ..cachedChatMessages = const [
              RemoteChatMessage(
                messageId: 'cached',
                chatId: 'chat-1',
                scope: RemoteChatScope.standalone,
                role: ChatRole.assistant,
                status: ChatMessageStatus.complete,
                text: 'Cached answer',
              ),
              RemoteChatMessage(
                messageId: 'foreign',
                chatId: 'chat-2',
                scope: RemoteChatScope.standalone,
                role: ChatRole.assistant,
                status: ChatMessageStatus.complete,
                text: 'Wrong chat',
              ),
            ];
          final vm = RemoteControlViewModel(repository: repo);
          vm.connect('123456');
          async.flushMicrotasks();
          const target = RemoteStandaloneChatTarget(chatId: 'chat-1');
          vm.ensureChatTranscript(target);
          async.elapse(const Duration(seconds: 10));
          expect(vm.messagesFor(target).map((m) => m.text), ['Cached answer']);
          expect(repo.cachedChatFetches, 1);
          expect(repo.snapshotFetches, 1);
          expect(repo.requestChatTranscriptCalls, 1);
          vm.dispose();
        });
      },
    );

    for (final failureBeforeResponse in [false, true]) {
      test(
        'hydration command failure is correlated (before response: $failureBeforeResponse)',
        () async {
          final repo = _GatedHydrationRepository();
          final vm = RemoteControlViewModel(repository: repo);
          await vm.connect('123456');
          const target = RemoteStandaloneChatTarget(chatId: 'chat-1');
          vm.ensureChatTranscript(target);
          if (!failureBeforeResponse) {
            repo.request.complete('hydrate-1');
            await pump();
          }
          repo.eventsController.add(
            const RemotePortalEventBatch(
              nextCursor: 1,
              events: [
                RemoteCommandFailedEvent(
                  commandId: 'hydrate-1',
                  message: 'Desktop could not read the conversation.',
                ),
              ],
            ),
          );
          await pump();
          if (failureBeforeResponse) {
            repo.request.complete('hydrate-1');
            await pump();
          }
          // CAN-3631: the first failure waits for the automatic retry and
          // never reaches the global command-failure banner.
          expect(vm.chatHydrationError(target), isNull);
          expect(vm.isChatTranscriptLoading(target), isTrue);
          expect(vm.commandFailureMessage, isNull);
          vm.dispose();
        },
      );
    }

    test(
      'late hydration failure cannot poison a replacement session',
      () async {
        final repo = _GatedHydrationRepository();
        final vm = RemoteControlViewModel(repository: repo);
        await vm.connect('123456');
        const target = RemoteStandaloneChatTarget(chatId: 'chat-1');
        vm.ensureChatTranscript(target);
        await vm.disconnect();
        await vm.connect('123456');
        repo.request.completeError(
          const RemoteControlException('Old request failed'),
        );
        await pump();
        expect(vm.chatHydrationError(target), isNull);
        vm.dispose();
      },
    );

    for (final resetSession in [false, true]) {
      test(
        'late cache does not overwrite ${resetSession ? 'another session' : 'live messages'}',
        () {
          fakeAsync((async) {
            final repo = _GatedHydrationRepository();
            final vm = RemoteControlViewModel(repository: repo);
            vm.connect('123456');
            async.flushMicrotasks();
            const target = RemoteStandaloneChatTarget(chatId: 'chat-1');
            vm.ensureChatTranscript(target);
            async.elapse(const Duration(seconds: 9));
            if (resetSession) {
              vm.disconnect();
              async.flushMicrotasks();
              vm.connect('123456');
              async.flushMicrotasks();
            } else {
              repo.eventsController.add(
                const RemotePortalEventBatch(
                  nextCursor: 1,
                  events: [
                    RemoteChatMessageEvent(
                      chatId: 'chat-1',
                      scope: RemoteChatScope.standalone,
                      message: RemoteChatMessage(
                        messageId: 'msg',
                        chatId: 'chat-1',
                        scope: RemoteChatScope.standalone,
                        role: ChatRole.assistant,
                        status: ChatMessageStatus.complete,
                        text: 'Live answer',
                      ),
                    ),
                  ],
                ),
              );
              async.flushMicrotasks();
            }
            repo.cache.complete(const [
              RemoteChatMessage(
                messageId: 'msg',
                chatId: 'chat-1',
                scope: RemoteChatScope.standalone,
                role: ChatRole.assistant,
                status: ChatMessageStatus.complete,
                text: 'Stale answer',
              ),
            ]);
            async.flushMicrotasks();
            expect(
              vm.messagesFor(target).map((m) => m.text),
              resetSession ? isEmpty : ['Live answer'],
            );
            vm.dispose();
          });
        },
      );
    }

    test('app lifecycle pauses and resumes event delivery', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');
      final resumesAfterConnect = repository.resumeEventsCalls;
      final fetchesAfterConnect = repository.snapshotFetches;

      vm.onAppBackgrounded();
      expect(repository.pauseEventsCalls, 1);

      await vm.onAppForegrounded();
      expect(repository.resumeEventsCalls, resumesAfterConnect + 1);
      expect(repository.snapshotFetches, fetchesAfterConnect + 1);
    });

    test(
      'hidden Remote defers foreground catch-up and coalesces pending work',
      () {
        fakeAsync((time) {
          final repository = FakeRemoteControlRepository();
          final vm = RemoteControlViewModel(repository: repository);
          vm.connect('123456');
          time.flushMicrotasks();
          vm.setRemoteVisible(false);
          vm.setHooksPaused(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            paused: true,
          );
          time.flushMicrotasks();
          vm.onAppBackgrounded();
          vm.onAppForegrounded();
          time.flushMicrotasks();
          time.elapse(const Duration(minutes: 1));
          expect(repository.snapshotFetches, 1);
          expect(repository.resumeEventsCalls, 2);
          vm.setRemoteVisible(true);
          vm.setRemoteVisible(false);
          time.elapse(kRemoteStateRefreshDebounce);
          expect(repository.snapshotFetches, 1);
          vm.setRemoteVisible(true);
          time.elapse(kRemoteStateRefreshDebounce);
          expect(repository.snapshotFetches, 2);
          time.elapse(const Duration(minutes: 1));
          expect(repository.snapshotFetches, 2);
          vm.dispose();
          repository.eventsController.close();
          time.flushMicrotasks();
        });
      },
    );

    test(
      'manual refresh consumes deferred reconciliation while hidden',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');
        vm.setRemoteVisible(false);
        await vm.setHooksPaused(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          paused: true,
        );
        await vm.refresh();
        expect(repository.snapshotFetches, 2);
        vm.setRemoteVisible(true);
        await Future<void>.delayed(kRemoteStateRefreshDebounce * 2);
        expect(repository.snapshotFetches, 2);
      },
    );

    test(
      'snapshot refresh does not resume events after backgrounding',
      () async {
        final repository = _GatedNextSnapshotRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');
        final resumesAfterConnect = repository.resumeEventsCalls;
        final snapshotGate = Completer<void>();
        repository.gateNextSnapshot = snapshotGate;

        final refreshFuture = vm.refresh();
        await pump();
        vm.onAppBackgrounded();
        snapshotGate.complete();
        await refreshFuture;

        expect(repository.resumeEventsCalls, resumesAfterConnect);
      },
    );

    test(
      'foregrounding during initial loading subscribes before resuming events',
      () async {
        final repository = _GatedSnapshotRepository()..gate = Completer<void>();
        final vm = connectedVm(repository);

        final connectFuture = vm.connect('123456');
        await pump();
        expect(vm.isConnected, isTrue);

        final foregroundFuture = vm.onAppForegrounded();
        repository.gate?.complete();
        await Future.wait([connectFuture, foregroundFuture]);

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [],
            nextCursor: 1,
            connectionStatus: RemotePortalConnectionStatus.active,
          ),
        );
        await pump();

        expect(vm.portalConnectionStatus, RemotePortalConnectionStatus.active);
      },
    );
  });

  group('CAN-3369 server-cached chat tail', () {
    const target = RemoteStandaloneChatTarget(chatId: 'chat-1');

    RemoteChatMessage row(String id, String text) => RemoteChatMessage(
      messageId: id,
      chatId: 'chat-1',
      scope: RemoteChatScope.standalone,
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: text,
    );

    void emit(
      FakeRemoteControlRepository repo,
      int cursor,
      RemotePortalEvent event,
    ) {
      repo.eventsController.add(
        RemotePortalEventBatch(nextCursor: cursor, events: [event]),
      );
    }

    RemoteStateSnapshotEvent chatSnapshot(
      List<RemoteChatMessage> messages, {
      bool truncated = false,
    }) => RemoteStateSnapshotEvent(
      scope: 'chat',
      targetChatId: 'chat-1',
      targetChatScope: RemoteChatScope.standalone,
      chatMessages: messages,
      chatMessagesTruncated: truncated,
    );

    List<String> texts(RemoteControlViewModel vm) =>
        vm.messagesFor(target).map((m) => m.text).toList();

    test(
      'reads the cache when the chat opens, alongside the desktop request',
      () {
        fakeAsync((async) {
          final repo = FakeRemoteControlRepository()
            ..cachedChatMessages = [row('c1', 'Cached question')];
          final vm = RemoteControlViewModel(repository: repo);
          vm.connect('123456');
          async.flushMicrotasks();
          vm.ensureChatTranscript(target);
          async.flushMicrotasks();
          expect(repo.requestChatTranscriptCalls, 1);
          expect(repo.cachedChatFetches, 1);
          expect(texts(vm), ['Cached question']);
          expect(vm.isChatTranscriptLoading(target), isFalse);
          vm.dispose();
        });
      },
    );

    test('a cache read that loses the race to the snapshot is ignored', () {
      fakeAsync((async) {
        final repo = _GatedHydrationRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        async.flushMicrotasks();
        emit(repo, 1, chatSnapshot([row('s1', 'Authoritative')]));
        async.flushMicrotasks();
        repo.cache.complete([row('s1', 'Stale'), row('extra', 'Stale extra')]);
        async.flushMicrotasks();
        expect(texts(vm), ['Authoritative']);
        vm.dispose();
      });
    });

    test('an empty cache keeps the conversation loading', () {
      fakeAsync((async) {
        final repo = _GatedHydrationRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        async.flushMicrotasks();
        repo.cache.complete(const []);
        async.flushMicrotasks();
        expect(vm.messagesFor(target), isEmpty);
        expect(vm.isChatTranscriptLoading(target), isTrue);
        expect(vm.chatHydrationError(target), isNull);

        emit(repo, 1, chatSnapshot([row('s1', 'Authoritative')]));
        async.flushMicrotasks();
        expect(texts(vm), ['Authoritative']);
        vm.dispose();
      });
    });

    test('a failed cache read leaves the desktop request in charge', () {
      fakeAsync((async) {
        final repo = _GatedHydrationRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        async.flushMicrotasks();
        repo.cache.completeError(const RemoteControlException('cache down'));
        async.flushMicrotasks();
        expect(vm.isChatTranscriptLoading(target), isTrue);
        expect(vm.chatHydrationError(target), isNull);

        emit(repo, 1, chatSnapshot([row('s1', 'Authoritative')]));
        async.flushMicrotasks();
        expect(texts(vm), ['Authoritative']);
        expect(vm.chatHydrationError(target), isNull);
        vm.dispose();
      });
    });

    test('a hydrated transcript skips both reads on reopen', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        async.flushMicrotasks();
        emit(repo, 1, chatSnapshot([row('s1', 'Authoritative')]));
        async.flushMicrotasks();
        final fetches = repo.cachedChatFetches;

        vm.ensureChatTranscript(target);
        async.elapse(const Duration(seconds: 10));
        expect(repo.cachedChatFetches, fetches);
        expect(repo.requestChatTranscriptCalls, 1);
        expect(texts(vm), ['Authoritative']);
        vm.dispose();
      });
    });
  });

  group('CAN-3373 persisted chat tails', () {
    // These tests simulate a viewed chat: hydration alone no longer claims
    // foreground recency, so report activation as RemoteChatScreen does.
    const target = RemoteStandaloneChatTarget(chatId: 'chat-1');
    const chat = (scope: RemoteChatScope.standalone, chatId: 'chat-1');
    const owner = (accountScope: 'test:7', sessionId: 'session-1');
    late MemoryRemoteTranscriptStorage storage;

    setUp(() => storage = MemoryRemoteTranscriptStorage());

    RemoteChatMessage row(
      String id, {
      String? text,
      ChatMessageStatus status = ChatMessageStatus.complete,
    }) => RemoteChatMessage(
      messageId: id,
      chatId: 'chat-1',
      scope: RemoteChatScope.standalone,
      role: ChatRole.assistant,
      status: status,
      text: text ?? id,
    );

    void persist(List<RemoteChatMessage> rows, {RemoteTranscriptOwner? to}) =>
        storage.files[to ?? owner] = {
          chat: PersistedTranscript(chat: chat, openedAt: 1, rows: rows),
        };

    RemoteControlViewModel launch(FakeRemoteControlRepository repository) =>
        RemoteControlViewModel(
          repository: repository..connectedSessionId ??= 'session-1',
          transcriptCache: RemoteTranscriptCache(
            storage: storage,
            accountScope: 'test:7',
          ),
        );

    void emit(
      FakeRemoteControlRepository repo,
      int cursor,
      RemotePortalEvent event,
    ) {
      repo.eventsController.add(
        RemotePortalEventBatch(nextCursor: cursor, events: [event]),
      );
    }

    RemoteStateSnapshotEvent chatSnapshot(
      List<RemoteChatMessage> messages, {
      bool truncated = false,
    }) => RemoteStateSnapshotEvent(
      scope: 'chat',
      targetChatId: 'chat-1',
      targetChatScope: RemoteChatScope.standalone,
      chatMessages: messages,
      chatMessagesTruncated: truncated,
    );

    List<String> texts(RemoteControlViewModel vm) =>
        vm.messagesFor(target).map((m) => m.text).toList();

    List<String>? stored([RemoteTranscriptOwner to = owner]) =>
        storage.files[to]?[chat]?.rows.map((m) => m.text).toList();

    test('a persisted tail paints on open and the server tail, then the '
        'snapshot, replace it without a gap', () {
      fakeAsync((async) {
        persist([row('old-1'), row('old-2')]);
        final repo = _GatedHydrationRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);

        expect(texts(vm), ['old-1', 'old-2']);
        expect(vm.isChatTranscriptLoading(target), isFalse);
        // Provisional: the transcript request still runs.
        expect(repo.requestChatTranscriptCalls, 0);
        async.flushMicrotasks();

        repo.cache.complete([row('old-2'), row('server-3')]);
        async.flushMicrotasks();
        expect(texts(vm), ['old-2', 'server-3']);

        // A bounded snapshot sharing no row with the cache leaves no gap.
        emit(repo, 1, chatSnapshot([row('t9'), row('t10')], truncated: true));
        async.flushMicrotasks();
        expect(texts(vm), ['t9', 't10']);
        vm.dispose();
      });
    });

    test('the last revision of a streaming turn is persisted', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        async.flushMicrotasks();
        emit(repo, 1, chatSnapshot([row('q')]));
        for (var i = 1; i <= 6; i++) {
          emit(
            repo,
            1 + i,
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.standalone,
              message: row(
                'a',
                text: 'Answer $i',
                status: i == 6
                    ? ChatMessageStatus.complete
                    : ChatMessageStatus.streaming,
              ),
            ),
          );
          async.elapse(const Duration(milliseconds: 100));
        }
        // Written every write delay while streaming, not only at the end.
        expect(stored(), ['q', 'Answer 5']);
        async.elapse(const Duration(milliseconds: 500));
        expect(stored(), ['q', 'Answer 6']);
        vm.dispose();
      });
    });

    test('background traffic for a stored chat not opened this session '
        'keeps its persisted tail', () {
      fakeAsync((async) {
        const other = RemoteStandaloneChatTarget(chatId: 'chat-b');
        const otherChat = (scope: RemoteChatScope.standalone, chatId: 'chat-b');
        RemoteChatMessage otherRow(String id) => RemoteChatMessage(
          messageId: id,
          chatId: 'chat-b',
          scope: RemoteChatScope.standalone,
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: id,
        );
        final tailIds = [for (var i = 0; i < 50; i++) 'b$i'];
        storage.files[owner] = {
          otherChat: PersistedTranscript(
            chat: otherChat,
            openedAt: 1,
            rows: [for (final id in tailIds) otherRow(id)],
          ),
        };
        List<String>? storedOther() => storage.files[owner]?[otherChat]?.rows
            .map((m) => m.messageId)
            .toList();

        final repo = FakeRemoteControlRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        emit(repo, 1, chatSnapshot([row('q')]));
        async.flushMicrotasks();
        emit(
          repo,
          2,
          RemoteChatMessageEvent(
            chatId: 'chat-b',
            scope: RemoteChatScope.standalone,
            message: otherRow('b50'),
          ),
        );
        async.elapse(const Duration(milliseconds: 600));
        expect(storedOther(), tailIds);
        expect(stored(), ['q']);
        vm.dispose();
        async.flushMicrotasks();
        expect(storedOther(), tailIds);

        final relaunched = launch(FakeRemoteControlRepository());
        relaunched.connect('123456');
        async.flushMicrotasks();
        relaunched.ensureChatTranscript(other);
        relaunched.reopenChatTranscript(other);
        expect([
          for (final m in relaunched.messagesFor(other)) m.messageId,
        ], tailIds);
        relaunched.dispose();
      });
    });

    test('a stored chat that gets live rows before it opens paints and keeps '
        'its persisted tail', () {
      // CAN-3373 R7: the chat is still streaming on the desktop, so a live
      // row lands before the user reopens it after a cold start.
      fakeAsync((async) {
        const other = RemoteStandaloneChatTarget(chatId: 'chat-b');
        const otherChat = (scope: RemoteChatScope.standalone, chatId: 'chat-b');
        RemoteChatMessage otherRow(String id, {String? text}) =>
            RemoteChatMessage(
              messageId: id,
              chatId: 'chat-b',
              scope: RemoteChatScope.standalone,
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: text ?? id,
            );
        final tailIds = [for (var i = 0; i < 50; i++) 'b$i'];
        storage.files[owner] = {
          otherChat: PersistedTranscript(
            chat: otherChat,
            openedAt: 1,
            rows: [for (final id in tailIds) otherRow(id)],
          ),
        };
        List<String>? storedOther() => storage.files[owner]?[otherChat]?.rows
            .map((m) => m.messageId)
            .toList();
        RemoteChatMessageEvent live(String text) => RemoteChatMessageEvent(
          chatId: 'chat-b',
          scope: RemoteChatScope.standalone,
          message: otherRow('b50', text: text),
        );

        final repo = FakeRemoteControlRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        emit(repo, 1, live('Streaming'));
        async.flushMicrotasks();

        vm.ensureChatTranscript(other);
        vm.reopenChatTranscript(other);
        List<String> ids() => [
          for (final m in vm.messagesFor(other)) m.messageId,
        ];
        expect(ids(), [...tailIds, 'b50']);

        emit(repo, 2, live('Streaming more'));
        async.elapse(const Duration(milliseconds: 600));
        expect(ids(), [...tailIds, 'b50']);
        expect(storedOther(), [...tailIds.skip(1), 'b50']);
        vm.dispose();
        async.flushMicrotasks();

        final relaunchedRepo = FakeRemoteControlRepository();
        final relaunched = launch(relaunchedRepo);
        relaunched.connect('123456');
        async.flushMicrotasks();
        relaunched.ensureChatTranscript(other);
        relaunched.reopenChatTranscript(other);
        expect(
          [for (final m in relaunched.messagesFor(other)) m.messageId],
          [...tailIds.skip(1), 'b50'],
        );

        // The desktop's snapshot is authoritative: it may shrink the tail.
        emit(
          relaunchedRepo,
          1,
          RemoteStateSnapshotEvent(
            scope: 'chat',
            targetChatId: 'chat-b',
            targetChatScope: RemoteChatScope.standalone,
            chatMessages: [
              otherRow('b49'),
              otherRow('b50', text: 'Done'),
            ],
          ),
        );
        async.elapse(const Duration(milliseconds: 600));
        expect(storedOther(), ['b49', 'b50']);
        relaunched.dispose();
      });
    });

    test('a stored chat opened before its slow load finishes keeps its '
        'persisted tail', () {
      // CAN-3373 R8: the session stops waiting for the load after its
      // readiness budget, so the chat opens before its tail is in memory.
      fakeAsync((async) {
        final tail = [for (var i = 0; i < 50; i++) row('m$i')];
        persist(tail);
        storage.loadGate = Completer();
        final repo = _GatedHydrationRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.elapse(kRemoteSessionCacheBudget);
        expect(vm.status, RemoteConnectionStatus.connected);
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        expect(vm.messagesFor(target), isEmpty);

        storage.loadGate!.complete();
        async.flushMicrotasks();
        emit(
          repo,
          1,
          RemoteChatMessageEvent(
            chatId: 'chat-1',
            scope: RemoteChatScope.standalone,
            message: row('m50'),
          ),
        );
        async.elapse(const Duration(milliseconds: 600));
        final newest = [for (var i = 1; i <= 50; i++) 'm$i'];
        expect(stored(), newest);
        vm.dispose();
        async.flushMicrotasks();

        storage.loadGate = null;
        final relaunched = launch(_GatedHydrationRepository());
        relaunched.connect('123456');
        async.flushMicrotasks();
        relaunched.ensureChatTranscript(target);
        relaunched.reopenChatTranscript(target);
        expect(texts(relaunched), newest);
        relaunched.dispose();
      });
    });

    test('a live revision of a stored row that arrives after a slow load '
        'keeps its place after a relaunch', () {
      // CAN-3373 R10: the revision keeps its original position.
      fakeAsync((async) {
        final start = DateTime.utc(2026, 10, 4, 12);
        RemoteChatMessage dated(String id, int second, {String? text}) =>
            RemoteChatMessage(
              messageId: id,
              chatId: 'chat-1',
              scope: RemoteChatScope.standalone,
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: text ?? id,
              occurredAt: start.add(Duration(seconds: second)),
              updatedAt: start.add(
                Duration(seconds: text == null ? second : 60),
              ),
            );
        persist([dated('m0', 0), dated('m1', 1), dated('m2', 2)]);
        storage.loadGate = Completer();
        final repo = _GatedHydrationRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.elapse(kRemoteSessionCacheBudget);
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        storage.loadGate!.complete();
        async.flushMicrotasks();
        emit(
          repo,
          1,
          RemoteChatMessageEvent(
            chatId: 'chat-1',
            scope: RemoteChatScope.standalone,
            message: dated('m1', 1, text: 'm1 edited'),
          ),
        );
        async.elapse(const Duration(milliseconds: 600));
        expect(stored(), ['m0', 'm1 edited', 'm2']);
        vm.dispose();
        async.flushMicrotasks();

        storage.loadGate = null;
        final relaunched = launch(_GatedHydrationRepository());
        relaunched.connect('123456');
        async.flushMicrotasks();
        relaunched.ensureChatTranscript(target);
        relaunched.reopenChatTranscript(target);
        expect(texts(relaunched), ['m0', 'm1 edited', 'm2']);
        relaunched.dispose();
      });
    });

    group('CAN-3373 R12/R13: stored order survives non-monotonic times', () {
      // Timer revisions move a row's creation time, so desktop order is not
      // timestamp order.
      final start = DateTime.utc(2026, 10, 4, 12);
      RemoteChatMessage dated(String id, int second, {int? updated}) =>
          RemoteChatMessage(
            messageId: id,
            chatId: 'chat-1',
            scope: RemoteChatScope.standalone,
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: '$id ${second}s',
            occurredAt: start.add(Duration(seconds: second)),
            updatedAt: start.add(Duration(seconds: updated ?? second)),
          );

      test('an authoritative order is painted unchanged after a relaunch', () {
        fakeAsync((async) {
          final repo = FakeRemoteControlRepository();
          final vm = launch(repo);
          vm.connect('123456');
          async.flushMicrotasks();
          vm.ensureChatTranscript(target);
          vm.reopenChatTranscript(target);
          async.flushMicrotasks();
          final desktop = [
            dated('user', 1),
            dated('timer', 4),
            dated('answer', 2),
          ];
          emit(repo, 1, chatSnapshot(desktop));
          async.elapse(const Duration(milliseconds: 600));
          final order = ['user 1s', 'timer 4s', 'answer 2s'];
          expect(texts(vm), order);
          expect(stored(), order);
          vm.dispose();
          async.flushMicrotasks();

          final relaunchedRepo = _GatedHydrationRepository();
          final relaunched = launch(relaunchedRepo);
          relaunched.connect('123456');
          async.flushMicrotasks();
          relaunched.ensureChatTranscript(target);
          relaunched.reopenChatTranscript(target);
          expect(texts(relaunched), order);

          // The next snapshot confirms the order rather than reordering it.
          emit(relaunchedRepo, 1, chatSnapshot(desktop));
          async.flushMicrotasks();
          expect(texts(relaunched), order);
          relaunched.dispose();
        });
      });

      test('a revision that moves a stored row\'s time after a slow load '
          'keeps its place after a relaunch', () {
        fakeAsync((async) {
          persist([dated('m0', 0), dated('timer', 1), dated('m2', 2)]);
          storage.loadGate = Completer();
          final repo = _GatedHydrationRepository();
          final vm = launch(repo);
          vm.connect('123456');
          async.elapse(kRemoteSessionCacheBudget);
          vm.ensureChatTranscript(target);
          vm.reopenChatTranscript(target);
          storage.loadGate!.complete();
          async.flushMicrotasks();
          emit(
            repo,
            1,
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.standalone,
              message: dated('timer', 4),
            ),
          );
          async.elapse(const Duration(milliseconds: 600));
          final order = ['m0 0s', 'timer 4s', 'm2 2s'];
          expect(stored(), order);
          vm.dispose();
          async.flushMicrotasks();

          storage.loadGate = null;
          final relaunchedRepo = _GatedHydrationRepository();
          final relaunched = launch(relaunchedRepo);
          relaunched.connect('123456');
          async.flushMicrotasks();
          relaunched.ensureChatTranscript(target);
          relaunched.reopenChatTranscript(target);
          expect(texts(relaunched), order);

          // A new row lands by the stored anchors, not the moved time.
          emit(
            relaunchedRepo,
            1,
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.standalone,
              message: dated('next', 3),
            ),
          );
          async.flushMicrotasks();
          expect(texts(relaunched), [...order, 'next 3s']);
          relaunched.dispose();
        });
      });

      test('the server tail and then the snapshot keep the stored order', () {
        // CAN-3373 R14: the server orders its tail by creation time.
        fakeAsync((async) {
          persist([dated('user', 1), dated('timer', 4), dated('answer', 2)]);
          final repo = _GatedHydrationRepository();
          final vm = launch(repo);
          vm.connect('123456');
          async.flushMicrotasks();
          vm.ensureChatTranscript(target);
          vm.reopenChatTranscript(target);
          List<String> ids() => [
            for (final m in vm.messagesFor(target)) m.messageId,
          ];
          final order = ['user', 'timer', 'answer'];
          expect(ids(), order);
          async.flushMicrotasks();

          repo.cache.complete([
            dated('user', 1),
            dated('answer', 2),
            dated('timer', 5, updated: 6),
          ]);
          async.flushMicrotasks();
          expect(ids(), order);
          expect(texts(vm)[1], 'timer 5s');

          emit(
            repo,
            1,
            chatSnapshot([
              dated('user', 1),
              dated('timer', 5, updated: 6),
              dated('answer', 2),
            ]),
          );
          async.flushMicrotasks();
          expect(ids(), order);
          async.elapse(const Duration(milliseconds: 600));
          expect(stored(), ['user 1s', 'timer 5s', 'answer 2s']);
          vm.dispose();
        });
      });
    });

    test('backgrounding writes pending changes at once', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        emit(repo, 1, chatSnapshot([row('q')]));
        async.flushMicrotasks();
        expect(stored(), isNull);
        vm.onAppBackgrounded();
        async.flushMicrotasks();
        expect(stored(), ['q']);
        vm.dispose();
      });
    });

    test('closing the app keeps the tails for the next launch', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        emit(repo, 1, chatSnapshot([row('q')]));
        async.flushMicrotasks();
        vm.dispose();
        async.flushMicrotasks();
        expect(stored(), ['q']);
        expect(storage.log, isNot(contains('clear')));
      });
    });

    test('disconnecting deletes every persisted tail', () {
      fakeAsync((async) {
        persist([row('old')]);
        final repo = FakeRemoteControlRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        vm.disconnect();
        async.flushMicrotasks();
        expect(storage.files, isEmpty);

        // Nothing comes back when the same pairing reconnects.
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        expect(vm.messagesFor(target), isEmpty);
        vm.dispose();
      });
    });

    test('a session the desktop ended deletes every persisted tail', () {
      fakeAsync((async) {
        persist([row('old')]);
        final repo = FakeRemoteControlRepository();
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        emit(repo, 1, const RemoteSessionEndedEvent());
        async.flushMicrotasks();
        expect(storage.files, isEmpty);
        vm.dispose();
      });
    });

    test('a restore that finds no session deletes the tails; an unreachable '
        'server keeps them', () async {
      persist([row('old')]);
      final unknown = launch(_UnknownSessionProbeRepository());
      await unknown.restoreIfIdle();
      expect(stored(), ['old']);
      unknown.dispose();

      final gone = launch(FakeRemoteControlRepository());
      await gone.restoreIfIdle();
      expect(storage.files, isEmpty);
      gone.dispose();
    });

    test('another pairing session sees none of the previous tails', () {
      fakeAsync((async) {
        persist([row('old')]);
        final repo = FakeRemoteControlRepository()
          ..connectedSessionId = 'session-2';
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        expect(vm.messagesFor(target), isEmpty);
        expect(vm.isChatTranscriptLoading(target), isTrue);
        expect(storage.files.keys, isNot(contains(owner)));
        vm.dispose();
      });
    });

    // Verify found m250..m279 lost for good: cached tail m250..m299, a
    // history page m240..m284, then the desktop's bounded snapshot
    // m280..m301 dropped the cached rows the page had confirmed.
    for (final source in ['device', 'server']) {
      test('a $source-cached tail, an older page, and a bounded snapshot '
          'keep the transcript contiguous', () {
        fakeAsync((async) {
          List<RemoteChatMessage> span(int from, int to) => [
            for (var i = from; i < to; i++) row('m$i'),
          ];
          List<String> spanIds(int from, int to) => [
            for (var i = from; i < to; i++) 'm$i',
          ];
          if (source == 'device') persist(span(250, 300));
          final repo = _GatedHydrationRepository()
            ..fetchChatHistoryHandler = (before) async => before == null
                ? RemoteChatHistoryChunk(
                    messages: span(240, 285),
                    nextCursor: 'p1',
                  )
                : RemoteChatHistoryChunk(messages: span(190, 240));
          final vm = launch(repo);
          vm.connect('123456');
          async.flushMicrotasks();
          vm.ensureChatTranscript(target);
          vm.reopenChatTranscript(target);
          if (source == 'server') repo.cache.complete(span(250, 300));
          async.flushMicrotasks();
          List<String> ids() => [
            for (final m in vm.messagesFor(target)) m.messageId,
          ];
          expect(ids(), spanIds(250, 300));

          vm.loadOlderMessages(target);
          async.flushMicrotasks();
          expect(ids(), spanIds(240, 300));

          emit(repo, 1, chatSnapshot(span(280, 302), truncated: true));
          async.flushMicrotasks();
          expect(ids(), spanIds(240, 302));

          vm.loadOlderMessages(target);
          async.flushMicrotasks();
          expect(ids(), spanIds(190, 302));
          expect(
            [for (final call in repo.fetchChatHistoryCalls) call.before],
            [null, 'p1'],
          );
          vm.dispose();
        });
      });
    }

    test('a newer history page sharing no row with a stale persisted tail '
        'replaces it on screen and on disk', () {
      // CAN-3373 PF4.
      fakeAsync((async) {
        List<RemoteChatMessage> span(int from, int to) => [
          for (var i = from; i < to; i++) row('m$i'),
        ];
        List<String> spanIds(int from, int to) => [
          for (var i = from; i < to; i++) 'm$i',
        ];
        persist(span(0, 50));
        final repo = _GatedHydrationRepository()
          ..fetchChatHistoryHandler = (before) async => RemoteChatHistoryChunk(
            messages: span(100, 150),
            nextCursor: 'p1',
          );
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        async.flushMicrotasks();
        expect(stored(), spanIds(0, 50));

        vm.loadOlderMessages(target);
        async.flushMicrotasks();
        expect(texts(vm), spanIds(100, 150));
        async.elapse(const Duration(seconds: 1));
        expect(stored(), spanIds(100, 150));
        vm.dispose();
      });
    });

    // CAN-3373 R15: the server's tail takes over the persisted rows it
    // shares, and a newer history page must still replace them.
    for (final (name, persisted, server, shown, kept) in [
      (
        'a persisted tail, then the server tail',
        (0, 50),
        (0, 50),
        (100, 150),
        (100, 150),
      ),
      ('only the server tail', null, (0, 50), (100, 150), (100, 150)),
      ('overlapping tails', (102, 152), (102, 152), (100, 152), (102, 152)),
    ]) {
      test('a newer history page after $name shows and persists the server '
          'history, and a relaunch paints it', () {
        fakeAsync((async) {
          List<RemoteChatMessage> span((int, int) range) => [
            for (var i = range.$1; i < range.$2; i++) row('m$i'),
          ];
          List<String> spanIds((int, int) range) => [
            for (var i = range.$1; i < range.$2; i++) 'm$i',
          ];
          if (persisted != null) persist(span(persisted));
          final repo = _GatedHydrationRepository()
            ..fetchChatHistoryHandler = (before) async =>
                RemoteChatHistoryChunk(
                  messages: span((100, 150)),
                  nextCursor: 'p1',
                );
          final vm = launch(repo);
          vm.connect('123456');
          async.flushMicrotasks();
          vm.ensureChatTranscript(target);
          vm.reopenChatTranscript(target);
          async.flushMicrotasks();
          repo.cache.complete(span(server));
          async.flushMicrotasks();
          expect(texts(vm), spanIds(server));

          vm.loadOlderMessages(target);
          async.flushMicrotasks();
          expect(texts(vm), spanIds(shown));
          async.elapse(const Duration(seconds: 1));
          expect(stored(), spanIds(kept));
          vm.dispose();
          async.flushMicrotasks();

          final relaunched = launch(FakeRemoteControlRepository());
          relaunched.connect('123456');
          async.flushMicrotasks();
          relaunched.ensureChatTranscript(target);
          relaunched.reopenChatTranscript(target);
          expect(texts(relaunched), spanIds(kept));
          relaunched.dispose();
        });
      });
    }

    test('reopening an evicted chat persists the transcript it already '
        'shows, and a relaunch paints it', () {
      // CAN-3373 PF5: eviction deletes the file while the chat stays
      // hydrated, so reopening it requests nothing and changes nothing.
      fakeAsync((async) {
        const other = RemoteStandaloneChatTarget(chatId: 'chat-b');
        RemoteControlViewModel launchOne(FakeRemoteControlRepository repo) =>
            RemoteControlViewModel(
              repository: repo..connectedSessionId ??= 'session-1',
              transcriptCache: RemoteTranscriptCache(
                storage: storage,
                accountScope: 'test:7',
                maxChats: 1,
              ),
            );
        final repo = FakeRemoteControlRepository();
        final vm = launchOne(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        emit(repo, 1, chatSnapshot([row('q'), row('a')]));
        async.elapse(const Duration(seconds: 1));
        expect(stored(), ['q', 'a']);

        vm.ensureChatTranscript(other);
        vm.reopenChatTranscript(other);
        async.flushMicrotasks();
        expect(stored(), isNull);
        final requests = repo.requestChatTranscriptCalls;
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        async.elapse(const Duration(seconds: 1));
        expect(repo.requestChatTranscriptCalls, requests);
        expect(stored(), ['q', 'a']);
        vm.dispose();
        async.flushMicrotasks();

        final relaunched = launchOne(FakeRemoteControlRepository());
        relaunched.connect('123456');
        async.flushMicrotasks();
        relaunched.ensureChatTranscript(target);
        relaunched.reopenChatTranscript(target);
        expect(texts(relaunched), ['q', 'a']);
        relaunched.dispose();
      });
    });

    test('a pairing without a server session persists nothing', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository()..connectedSessionId = '';
        final vm = launch(repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(target);
        vm.reopenChatTranscript(target);
        emit(repo, 1, chatSnapshot([row('q')]));
        async.elapse(const Duration(seconds: 1));
        expect(storage.log.where((op) => op.startsWith('write')), isEmpty);
        vm.dispose();
      });
    });
  });

  group('pipeline run cache', () {
    RemotePortalEventBatch runBatch(
      Map<String, dynamic> runPayload, {
      String? commandId,
    }) => RemotePortalEventBatch.fromJson({
      'events': [
        {
          'type': 'portal.pipeline.event',
          'commandId': ?commandId,
          'payload': {
            'kind': 'upsert',
            'entity': {
              'entityType': 'pipeline_run',
              'localId': runPayload['localId'],
              'payload': runPayload,
            },
          },
        },
      ],
      'nextCursor': 1,
    });

    test('merges slice rows with live events, newest first', () async {
      final repository = FakeRemoteControlRepository();
      repository.worktreeStateSlices = {
        'wt-1': {
          'pipelineRuns': [
            {
              'localId': 'exec-1',
              'worktreeLocalId': 'wt-1',
              'pipelineName': 'CI',
              'status': 'running',
              'startedAt': '2026-09-16T10:00:00.000Z',
              'jobs': [
                {
                  'jobId': 'build',
                  'name': 'Build',
                  'status': 'running',
                  'steps': [
                    {'stepId': 's1', 'name': 'Compile', 'status': 'running'},
                  ],
                },
              ],
            },
          ],
        },
      };
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');
      await vm.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );

      expect(vm.pipelineRunsFor('wt-1').single.localId, 'exec-1');

      // A truncated live tick must update status without losing the tree.
      repository.eventsController.add(
        runBatch({
          'localId': 'exec-1',
          'worktreeLocalId': 'wt-1',
          'status': 'success',
          'truncated': true,
        }),
      );
      // A second run, started on the desktop, arrives with no slice row.
      repository.eventsController.add(
        runBatch({
          'localId': 'exec-2',
          'worktreeLocalId': 'wt-1',
          'pipelineName': 'Nightly',
          'status': 'running',
          'startedAt': '2026-09-16T11:00:00.000Z',
          'jobs': <Map<String, dynamic>>[],
        }),
      );
      await Future<void>.delayed(Duration.zero);

      final runs = vm.pipelineRunsFor('wt-1');
      expect(runs.map((r) => r.localId), ['exec-2', 'exec-1']);
      expect(runs.last.status, 'success');
      expect(runs.last.jobs!.single.jobId, 'build');
      expect(
        vm
            .pipelineRunFor(worktreeLocalId: 'wt-1', executionId: 'exec-1')!
            .jobs!
            .single
            .steps
            .single
            .name,
        'Compile',
      );
    });

    test('hidden child runs stay out of the list', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');
      repository.eventsController.add(
        runBatch({
          'localId': 'exec-child',
          'worktreeLocalId': 'wt-1',
          'status': 'running',
          'hidden': true,
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(vm.pipelineRunsFor('wt-1'), isEmpty);
    });

    test('a removal drops the run', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');
      repository.eventsController.add(
        runBatch({
          'localId': 'exec-9',
          'worktreeLocalId': 'wt-1',
          'status': 'running',
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(vm.pipelineRunsFor('wt-1'), hasLength(1));

      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.pipeline.event',
              'payload': {
                'kind': 'remove',
                'entityType': 'pipeline_run',
                'localId': 'exec-9',
              },
            },
          ],
          'nextCursor': 2,
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(vm.pipelineRunsFor('wt-1'), isEmpty);
    });

    test('a session reset clears the pipeline run cache, matching '
        '_worktreeStateSlices', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');

      // A run learned only from a live event (no slice row) and a pending
      // detail request, exactly like a run started on the desktop while
      // this screen is open.
      repository.eventsController.add(
        runBatch({
          'localId': 'exec-stale',
          'worktreeLocalId': 'wt-1',
          'status': 'running',
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(vm.pipelineRunsFor('wt-1'), hasLength(1));

      repository.pipelineExecutionError = const RemoteControlException(
        'Pipeline execution not found.',
      );
      await vm.requestPipelineRunDetail(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        executionId: 'exec-stale',
      );
      expect(vm.pipelineRunError('exec-stale'), isNotNull);

      // A re-pair (disconnect, then a fresh connect) must not merge the
      // previous desktop session's runs over the new one's, the same way
      // `_worktreeStateSlices` is already cleared for this reason.
      await vm.disconnect();

      expect(vm.pipelineRunsFor('wt-1'), isEmpty);
      expect(vm.pipelineRunError('exec-stale'), isNull);
      expect(vm.isPipelineRunPending('exec-stale'), isFalse);

      await vm.connect('123456');
      expect(vm.pipelineRunsFor('wt-1'), isEmpty);
    });
  });

  group('pipeline run requests', () {
    test('submits execution.get and settles when the run arrives', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');

      await vm.requestPipelineRunDetail(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        executionId: 'exec-1',
      );

      expect(repository.pipelineExecutionRequests, [
        (
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
        ),
      ]);
      expect(vm.isPipelineRunPending('exec-1'), isTrue);
      expect(vm.pipelineRunError('exec-1'), isNull);

      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.pipeline.event',
              'commandId': 'pipeline-execution-1',
              'payload': {
                'kind': 'upsert',
                'entity': {
                  'entityType': 'pipeline_run',
                  'localId': 'exec-1',
                  'payload': {
                    'localId': 'exec-1',
                    'worktreeLocalId': 'wt-1',
                    'status': 'running',
                    'jobs': <Map<String, dynamic>>[],
                  },
                },
              },
            },
          ],
          'nextCursor': 1,
        }),
      );
      await Future<void>.delayed(Duration.zero);

      expect(vm.isPipelineRunPending('exec-1'), isFalse);
      expect(
        vm.pipelineRunFor(worktreeLocalId: 'wt-1', executionId: 'exec-1'),
        isNotNull,
      );
    });

    test('a rejected command settles the request with its message', () async {
      final repository = FakeRemoteControlRepository();
      repository.pipelineExecutionError = const RemoteControlException(
        'The desktop did not accept the request.',
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');

      await vm.requestPipelineRunDetail(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        executionId: 'exec-1',
      );

      expect(vm.isPipelineRunPending('exec-1'), isFalse);
      expect(
        vm.pipelineRunError('exec-1'),
        'The desktop did not accept the request.',
      );
    });

    test('a run landing live clears a stale error from an earlier failed '
        'request', () async {
      final repository = FakeRemoteControlRepository();
      repository.pipelineExecutionError = const RemoteControlException(
        'The desktop did not accept the request.',
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');

      await vm.requestPipelineRunDetail(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        executionId: 'exec-1',
      );
      expect(vm.pipelineRunError('exec-1'), isNotNull);

      // The run's data lands live (e.g. a desktop-side retry, or an
      // otherwise-unrelated update to the same execution) without the
      // screen issuing a fresh explicit request. A stale error banner must
      // not sit above the freshly-landed data.
      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.pipeline.event',
              'payload': {
                'kind': 'upsert',
                'entity': {
                  'entityType': 'pipeline_run',
                  'localId': 'exec-1',
                  'payload': {
                    'localId': 'exec-1',
                    'worktreeLocalId': 'wt-1',
                    'status': 'running',
                    'jobs': <Map<String, dynamic>>[],
                  },
                },
              },
            },
          ],
          'nextCursor': 1,
        }),
      );
      await Future<void>.delayed(Duration.zero);

      expect(vm.pipelineRunError('exec-1'), isNull);
    });

    test('requesting detail while disconnected sets an explicit message', () {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      // Never connected: isConnected is false.

      unawaited(
        vm.requestPipelineRunDetail(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
        ),
      );

      expect(vm.isPipelineRunPending('exec-1'), isFalse);
      expect(vm.pipelineRunError('exec-1'), isNotNull);
    });

    test(
      'a rejection racing ahead of the submit response still settles',
      () async {
        final repository = _GatedPipelineExecutionRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        addTearDown(vm.dispose);
        await vm.connect('123456');

        final request = vm.requestPipelineRunDetail(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
        );

        // The desktop's rejection arrives for the not-yet-returned command
        // id, so it is buffered as unclaimed until requestPipelineExecution
        // resolves and _registerOwnedCommand reconciles it synchronously.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'Pipeline execution not found.',
                commandId: 'cmd-race',
              ),
            ],
            nextCursor: 4,
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(vm.isPipelineRunPending('exec-1'), isTrue);

        repository.executionCompleter.complete('cmd-race');
        await request;

        expect(vm.isPipelineRunPending('exec-1'), isFalse);
        expect(vm.pipelineRunError('exec-1'), 'Pipeline execution not found.');
      },
    );

    test('an asynchronous command failure settles the request', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');
      await vm.requestPipelineRunDetail(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        executionId: 'exec-1',
      );

      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.command.failed',
              'payload': {
                'commandId': 'pipeline-execution-1',
                'error': 'Pipeline execution not found.',
              },
            },
          ],
          'nextCursor': 1,
        }),
      );
      await Future<void>.delayed(Duration.zero);

      expect(vm.isPipelineRunPending('exec-1'), isFalse);
      expect(vm.pipelineRunError('exec-1'), 'Pipeline execution not found.');
    });

    test('a silent desktop settles the request on the timeout', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        addTearDown(vm.dispose);
        unawaited(vm.connect('123456'));
        async.flushMicrotasks();
        unawaited(
          vm.requestPipelineRunDetail(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            executionId: 'exec-1',
          ),
        );
        async.flushMicrotasks();
        expect(vm.isPipelineRunPending('exec-1'), isTrue);

        async.elapse(kRemotePipelineRunTimeout);
        expect(vm.isPipelineRunPending('exec-1'), isFalse);
        expect(vm.pipelineRunError('exec-1'), isNull);
      });
    });

    test('a run control is sent once until the desktop answers', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        addTearDown(vm.dispose);
        unawaited(vm.connect('123456'));
        async.flushMicrotasks();

        for (final action in [
          RemotePipelineRunAction.cancel,
          RemotePipelineRunAction.retry,
        ]) {
          unawaited(
            vm.submitPipelineRunAction(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              executionId: 'exec-1',
              action: action,
            ),
          );
          async.flushMicrotasks();
        }
        // The second tap lands while the first is in flight and is dropped.
        expect(
          repository.pipelineRunActions.single.action,
          RemotePipelineRunAction.cancel,
        );
        expect(
          vm.pendingPipelineRunAction('exec-1'),
          RemotePipelineRunAction.cancel,
        );
        // A control is not a detail load: the run screen keeps its content.
        expect(vm.isPipelineRunPending('exec-1'), isFalse);

        // A desktop that never answers re-offers the control, silently.
        async.elapse(kRemotePipelineActionTimeout);
        expect(vm.pendingPipelineRunAction('exec-1'), isNull);
        expect(vm.pipelineRunActionError('exec-1'), isNull);
      });
    });

    group('a pending cancel', () {
      Future<(FakeRemoteControlRepository, RemoteControlViewModel)>
      cancelling() async {
        final repository = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        addTearDown(vm.dispose);
        await vm.connect('123456');
        await vm.submitPipelineRunAction(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
          action: RemotePipelineRunAction.cancel,
        );
        expect(
          vm.pendingPipelineRunAction('exec-1'),
          RemotePipelineRunAction.cancel,
        );
        return (repository, vm);
      }

      Future<void> emit(
        FakeRemoteControlRepository repository,
        Map<String, dynamic> event,
      ) async {
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [event],
            'nextCursor': 1,
          }),
        );
        await Future<void>.delayed(Duration.zero);
      }

      Map<String, dynamic> runEvent(String status) => {
        'type': 'portal.pipeline.event',
        'payload': {
          'kind': 'upsert',
          'entity': {
            'entityType': 'pipeline_run',
            'localId': 'exec-1',
            'payload': {
              'localId': 'exec-1',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'pipelineName': 'CI',
              'status': status,
            },
          },
        },
      };

      test('settles on the authoritative cancelled run update', () async {
        final (repository, vm) = await cancelling();

        // The run update lands before the command's own result.
        await emit(repository, runEvent('cancelled'));

        expect(vm.pendingPipelineRunAction('exec-1'), isNull);
        expect(vm.pipelineRunActionError('exec-1'), isNull);
      });

      test('stays pending through a run update that is still active', () async {
        final (repository, vm) = await cancelling();

        await emit(repository, runEvent('running'));

        expect(
          vm.pendingPipelineRunAction('exec-1'),
          RemotePipelineRunAction.cancel,
        );
      });

      test('surfaces an asynchronous rejection and re-offers Cancel', () async {
        final (repository, vm) = await cancelling();

        await emit(repository, {
          'type': 'portal.command.failed',
          'payload': {
            'commandId': 'pipeline-action-1',
            'error': 'The run already finished.',
          },
        });

        expect(vm.pendingPipelineRunAction('exec-1'), isNull);
        expect(
          vm.pipelineRunActionError('exec-1'),
          'The run already finished.',
        );
      });
    });

    test('a run control that cannot be submitted says why', () async {
      final repository = FakeRemoteControlRepository();
      repository.pipelineRunActionError = const RemoteControlException(
        'The desktop is offline.',
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');

      await vm.submitPipelineRunAction(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        executionId: 'exec-1',
        action: RemotePipelineRunAction.resume,
      );

      expect(vm.pendingPipelineRunAction('exec-1'), isNull);
      expect(vm.pipelineRunActionError('exec-1'), 'The desktop is offline.');
      expect(vm.commandFailureMessage, isNull);
      vm.clearPipelineRunActionError('exec-1');
      expect(vm.pipelineRunActionError('exec-1'), isNull);
    });

    test('step log requests carry the physical job id', () async {
      final repository = FakeRemoteControlRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');

      await vm.requestPipelineStepLog(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        executionId: 'exec-1',
        jobId: 'test_0',
        stepId: 'run',
      );

      expect(repository.pipelineStepLogRequests.single.jobId, 'test_0');
      expect(repository.pipelineStepLogRequests.single.stepId, 'run');
    });
  });
}

/// Records the relative order of the snapshot fetch and the event-subscription
/// start, so a test can pin that live delivery begins only after the snapshot
/// has seeded the event cursor. Restores a benign connection so it drives both
/// the connect and restore paths.
final class _OrderRecordingRepository extends FakeRemoteControlRepository {
  final List<String> ops = [];

  @override
  Future<RemoteConnection?> restoreSession() async => RemoteConnection(
    deviceLabel: 'Restored Desktop',
    pairedAt: DateTime(2026),
  );

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() {
    ops.add('snapshot');
    return super.fetchSnapshot();
  }

  @override
  void resumeEvents() {
    ops.add('resume');
    super.resumeEvents();
  }
}

final class _FailingSendRepository extends FakeRemoteControlRepository {
  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) => throw const RemoteControlException('send failed');
}

final class _FailingChatHydrationRepository
    extends FakeRemoteControlRepository {
  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    requestChatTranscriptCalls += 1;
    throw const RemoteControlException('Transcript unavailable.');
  }
}

final class _GatedSendRepository extends FakeRemoteControlRepository {
  final Completer<RemoteChatSendResult> sendCompleter = Completer();

  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) => sendCompleter.future;
}

/// Gates [requestPipelineExecution] so a test can deliver the desktop's
/// terminal event for the not-yet-returned command id before the submit's
/// HTTP round trip resolves -- reproducing the race where
/// `_registerOwnedCommand` synchronously reconciles an already-buffered
/// failure.
final class _GatedPipelineExecutionRepository
    extends FakeRemoteControlRepository {
  final Completer<String> executionCompleter = Completer();

  @override
  Future<String> requestPipelineExecution({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
  }) => executionCompleter.future;
}

/// Lets a test hold the state re-fetch open (via [gate]) so fast-path
/// assertions can run while the refresh is still in flight.
final class _GatedSnapshotRepository extends FakeRemoteControlRepository {
  Completer<void>? gate;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    final pending = gate;
    if (pending != null) await pending.future;
    return super.fetchSnapshot();
  }
}

final class _GatedNextSnapshotRepository extends FakeRemoteControlRepository {
  Completer<void>? gateNextSnapshot;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    final gate = gateNextSnapshot;
    gateNextSnapshot = null;
    if (gate != null) await gate.future;
    return super.fetchSnapshot();
  }
}

final class _FailingNextSnapshotRepository extends FakeRemoteControlRepository {
  bool failNextSnapshot = false;
  int failuresRemaining = 0;
  int snapshotAttempts = 0;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    snapshotAttempts++;
    if (failNextSnapshot || failuresRemaining > 0) {
      failNextSnapshot = false;
      if (failuresRemaining > 0) failuresRemaining--;
      throw const RemoteControlException('snapshot unavailable');
    }
    return super.fetchSnapshot();
  }
}
