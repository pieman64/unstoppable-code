import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/features/remote/view_models/pr_state_tracker.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_store.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/remote_store_harness.dart';
import '../../../../support/pr_checks_fixture.dart';

void main() {
  test('joined PR cache keeps identity until its inputs change', () async {
    final repository = FakeRemoteControlRepository();
    addTearDown(repository.eventsController.close);
    final store = _prStore();
    final tracker = PrStateTracker(
      repository: repository,
      store: store,
      notify: () {},
      isConnected: () => true,
      sessionGeneration: () => 0,
      submit: (action) => action(),
      awaitCommandResult: (_) async => prChecksState([prChecksRepo()]),
    );
    addTearDown(tracker.dispose);
    final worktree = store.snapshot!.worktrees.single;
    await tracker.refreshPrState(worktree);
    final initial = tracker.cachedPrReposFor('ws', 'wt');
    expect(tracker.cachedPrReposFor('ws', 'wt'), same(initial));
    store.applyWorktreeRows(const [
      RemoteWorktree(localId: 'other', workspaceLocalId: 'ws', branch: 'main'),
    ]);
    expect(tracker.cachedPrReposFor('ws', 'wt'), same(initial));
    store.applyWorktreeRows([
      RemoteWorktree(
        localId: 'wt',
        workspaceLocalId: 'ws',
        branch: worktree.branch,
        label: 'Updated activity',
        prStatuses: [...store.snapshot!.worktrees.first.prStatuses],
      ),
    ]);
    expect(store.snapshot!.worktrees.first.label, 'Updated activity');
    expect(tracker.cachedPrReposFor('ws', 'wt'), same(initial));
    store.applyPrStatuses({
      'ws:wt': [
        RemotePrRepo.fromJson(prChecksRepo(checkStatus: 'passing')).pr!,
      ],
    });
    final pushed = tracker.cachedPrReposFor('ws', 'wt');
    expect(pushed, isNot(same(initial)));
    expect(pushed!.single.pr!.checkStatus, 'passing');
    expect(tracker.cachedPrReposFor('ws', 'wt'), same(pushed));
    await tracker.refreshPrState(worktree);
    final refreshed = tracker.cachedPrReposFor('ws', 'wt');
    expect(refreshed, isNot(same(pushed)));
    expect(refreshed!.single.pr!.checkStatus, 'failing');
    tracker.reset();
    expect(tracker.cachedPrReposFor('ws', 'wt'), isNull);
  });

  for (final responseKind in [
    'unchanged',
    'failed lookup',
    'single-repo alias',
  ]) {
    test(
      '$responseKind action read does not invalidate an overview read',
      () async {
        final repository = FakeRemoteControlRepository();
        addTearDown(repository.eventsController.close);
        final store = _prStore();
        var response = prChecksState([prChecksRepo(checks: settledPrChecks())]);
        final tracker = PrStateTracker(
          repository: repository,
          store: store,
          notify: () {},
          isConnected: () => true,
          sessionGeneration: () => 0,
          submit: (action) => action(),
          awaitCommandResult: (_) async => response,
        );
        addTearDown(tracker.dispose);
        final worktree = store.snapshot!.worktrees.single;
        await tracker.refreshPrState(worktree);
        final baseline = store.captureReadBaseline();
        final current = store.snapshot!;
        if (responseKind == 'failed lookup') {
          response = prChecksState([
            {
              'repoId': 'repo-app',
              'createBlockedReason': 'pr_status_unavailable',
            },
          ]);
        } else if (responseKind == 'single-repo alias') {
          response = prChecksState([
            {
              ...prChecksRepo(checks: settledPrChecks()),
              'repoId': '__single_repo__',
            },
          ]);
        }
        await tracker.refreshPrState(worktree);
        final effect = store.applySnapshot(
          current.copyWith(
            worktrees: [
              RemoteWorktree(
                localId: worktree.localId,
                workspaceLocalId: worktree.workspaceLocalId,
                branch: worktree.branch,
                label: 'Updated overview label',
                prStatuses: current.worktrees.single.prStatuses,
              ),
            ],
          ),
          baseline: baseline,
        );
        expect(effect.overviewRefresh, isNull);
        expect(
          store.snapshot!.worktrees.single.label,
          'Updated overview label',
        );
      },
    );
  }

  test(
    'reset discards an in-flight refresh before the next session caches state',
    () async {
      final repository = FakeRemoteControlRepository();
      addTearDown(repository.eventsController.close);
      final pending = Completer<Map<String, dynamic>>();
      var generation = 0;
      var notifications = 0;
      final tracker = PrStateTracker(
        repository: repository,
        store: _prStore(),
        notify: () => notifications++,
        isConnected: () => true,
        sessionGeneration: () => generation,
        submit: (action) => action(),
        awaitCommandResult: (RemotePortalCommandResult response) =>
            generation == 0 ? pending.future : Future.value(response.result!),
      );
      addTearDown(tracker.dispose);
      const worktree = RemoteWorktree(
        localId: 'wt',
        workspaceLocalId: 'ws',
        branch: 'main',
      );
      final oldRefresh = tracker.runPrAction(worktree, RemotePrAction.refresh);
      await Future<void>.delayed(Duration.zero);
      generation++;
      tracker.reset();
      pending.complete({'repos': [], 'busy': true});
      expect(await oldRefresh, remotePrActionDiscardedResult);
      expect(tracker.cachedPrReposFor('ws', 'wt'), isNull);
      expect(notifications, 0);
      await tracker.refreshPrState(worktree);
      expect(tracker.cachedPrReposFor('ws', 'wt'), isEmpty);
      expect(tracker.cachedPrBusyFor('ws', 'wt'), isFalse);
      expect(notifications, 1);
      tracker.dispose();
      expect(tracker.cachedPrReposFor('ws', 'wt'), isNull);
    },
  );

  test('caches each refresh with its checks for the drawer', () async {
    final repository = FakeRemoteControlRepository();
    addTearDown(repository.eventsController.close);
    var hostState = prChecksState([prChecksRepo(checks: nineStatePrChecks())]);
    final tracker = PrStateTracker(
      repository: repository,
      store: _prStore(),
      notify: () {},
      isConnected: () => true,
      sessionGeneration: () => 0,
      submit: (action) => action(),
      awaitCommandResult: (RemotePortalCommandResult _) =>
          Future.value(hostState),
    );
    addTearDown(tracker.dispose);
    const worktree = RemoteWorktree(
      localId: 'wt',
      workspaceLocalId: 'ws',
      branch: 'main',
    );

    await tracker.refreshPrState(worktree);
    final first = tracker.cachedPrReposFor('ws', 'wt')!.single.pr!;
    expect(first.checks, hasLength(9));
    expect(first.checks[1].executionState, 'running');

    hostState = prChecksState([
      prChecksRepo(
        checkStatus: 'passing',
        checks: [
          prCheckDetail(
            'build-android',
            status: 'success',
            executionState: 'success',
          ),
        ],
      ),
    ]);
    await tracker.refreshPrState(worktree);
    final second = tracker.cachedPrReposFor('ws', 'wt')!.single.pr!;
    expect(second.checkStatus, 'passing');
    expect(second.checks.single.executionState, 'success');
  });

  test('a pushed PR status wins over an older in-flight action read', () async {
    final repository = FakeRemoteControlRepository();
    addTearDown(repository.eventsController.close);
    final pending = Completer<Map<String, dynamic>>();
    final store = _prStore();
    final tracker = PrStateTracker(
      repository: repository,
      store: store,
      notify: () {},
      isConnected: () => true,
      sessionGeneration: () => 0,
      submit: (action) => action(),
      awaitCommandResult: (_) => pending.future,
    );
    addTearDown(tracker.dispose);
    const worktree = RemoteWorktree(
      localId: 'wt',
      workspaceLocalId: 'ws',
      branch: 'main',
    );
    final refresh = tracker.runPrAction(worktree, RemotePrAction.refresh);
    await Future<void>.delayed(Duration.zero);
    final newer = RemotePrRepo.fromJson(
      prChecksRepo(checkStatus: 'passing', checks: settledPrChecks()),
    ).pr!;
    store.applyPrStatuses({
      'ws:wt': [newer],
    });
    pending.complete(prChecksState([prChecksRepo(checks: legacyPrChecks())]));
    expect(await refresh, remotePrActionDiscardedResult);
    expect(tracker.cachedPrReposFor('ws', 'wt')!.single.pr, same(newer));
  });

  for (final repoId in <String?>[null, 'repo-app']) {
    test(
      'failed lookup preserves the remembered PR on refresh ($repoId)',
      () async {
        final repository = FakeRemoteControlRepository();
        addTearDown(repository.eventsController.close);
        final store = _prStore();
        final remembered = RemoteWorktreePr(
          repoId: repoId,
          state: 'open',
          prNumber: 42,
        );
        store.applyPrStatuses({
          'ws:wt': [remembered],
        });
        final tracker = PrStateTracker(
          repository: repository,
          store: store,
          notify: () {},
          isConnected: () => true,
          sessionGeneration: () => 0,
          submit: (action) => action(),
          awaitCommandResult: (_) async => prChecksState([
            {
              'repoId': 'repo-app',
              'status': null,
              'createBlockedReason': 'pr_status_unavailable',
            },
          ]),
        );
        addTearDown(tracker.dispose);
        await tracker.refreshPrState(store.snapshot!.worktrees.single);
        expect(
          store.snapshot!.worktrees.single.prStatuses.single,
          same(remembered),
        );
        expect(
          tracker.cachedPrReposFor('ws', 'wt')!.single.pr,
          same(remembered),
        );
      },
    );
  }
  test(
    'unrelated worktree update does not discard an in-flight refresh',
    () async {
      final repository = FakeRemoteControlRepository();
      addTearDown(repository.eventsController.close);
      final pending = Completer<Map<String, dynamic>>();
      final store = _prStore();
      store.applyPrStatuses({
        'ws:wt': [RemotePrRepo.fromJson(prChecksRepo()).pr!],
      });
      final tracker = PrStateTracker(
        repository: repository,
        store: store,
        notify: () {},
        isConnected: () => true,
        sessionGeneration: () => 0,
        submit: (action) => action(),
        awaitCommandResult: (_) => pending.future,
      );
      addTearDown(tracker.dispose);
      final refresh = tracker.runPrAction(
        store.snapshot!.worktrees.single,
        RemotePrAction.refresh,
      );
      await Future<void>.delayed(Duration.zero);
      store.applyWorktreeRows([
        RemoteWorktree(
          localId: 'wt',
          workspaceLocalId: 'ws',
          branch: 'main',
          isStreaming: true,
          insertions: 12,
          prStatuses: [RemotePrRepo.fromJson(prChecksRepo()).pr!],
        ),
      ]);
      pending.complete(
        prChecksState([prChecksRepo(checks: settledPrChecks())]),
      );
      expect(isRemotePrActionResultDiscarded(await refresh), isFalse);
      expect(
        store.snapshot!.worktrees.single.prStatuses.single.checks,
        hasLength(4),
      );
      expect(store.snapshot!.worktrees.single.isStreaming, isTrue);
    },
  );

  group('PrStatePoll', () {
    const worktree = RemoteWorktree(
      localId: 'wt',
      workspaceLocalId: 'ws',
      branch: 'main',
    );

    /// A tracker whose refreshes the test answers one by one.
    ({
      PrStateTracker tracker,
      FakeRemoteControlRepository repository,
      List<Completer<Map<String, dynamic>>> requests,
      void Function() replaceSession,
    })
    harness({DateTime Function()? clock}) {
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true;
      final requests = <Completer<Map<String, dynamic>>>[];
      var generation = 0;
      final tracker = PrStateTracker(
        repository: repository,
        store: _prStore(),
        notify: () {},
        isConnected: () => true,
        sessionGeneration: () => generation,
        submit: (action) => action(),
        clock: clock,
        awaitCommandResult: (RemotePortalCommandResult _) {
          final request = Completer<Map<String, dynamic>>();
          requests.add(request);
          return request.future;
        },
      );
      return (
        tracker: tracker,
        repository: repository,
        requests: requests,
        replaceSession: () => generation++,
      );
    }

    void answerAll(List<Completer<Map<String, dynamic>>> requests) {
      for (final request in requests) {
        if (!request.isCompleted) {
          request.complete({'repos': [], 'busy': false});
        }
      }
    }

    test('refreshes on becoming visible, then every minute', () {
      fakeAsync((async) {
        final (:tracker, :requests, repository: _, replaceSession: _) =
            harness();
        final poll = tracker.pollPrState(worktree)..setVisible(true);
        async.flushMicrotasks();
        expect(requests, hasLength(1));
        answerAll(requests);

        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(2));
        answerAll(requests);
        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(3));
        answerAll(requests);
        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(4));

        poll.dispose();
        answerAll(requests);
        async.elapse(kRemotePrRefreshInterval * 3);
        expect(requests, hasLength(4));
        tracker.dispose();
      });
    });

    test(
      'push hosts refresh stale opens, retain Retry, and never poll idle',
      () {
        fakeAsync((async) {
          final (:tracker, :requests, :repository, replaceSession: _) = harness(
            clock: () => DateTime(2026).add(async.elapsed),
          );
          repository.supportsPrStatusPush = true;
          final poll = tracker.pollPrState(worktree)..setVisible(true);
          async.flushMicrotasks();
          answerAll(requests);
          async.flushMicrotasks();
          poll
            ..setVisible(false)
            ..setVisible(true);
          async.flushMicrotasks();
          expect(requests, hasLength(1));
          async.elapse(const Duration(minutes: 5));
          expect(requests, hasLength(1));
          poll
            ..setVisible(false)
            ..setVisible(true);
          async.flushMicrotasks();
          expect(requests, hasLength(2));
          answerAll(requests);
          async.flushMicrotasks();
          unawaited(tracker.runPrAction(worktree, RemotePrAction.refresh));
          async.flushMicrotasks();
          expect(requests, hasLength(3));
          answerAll(requests);
          tracker.dispose();
        });
      },
    );

    test('an unpublished branch without a PR skips automatic reopens', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness(
          clock: () => DateTime(2026).add(async.elapsed),
        );
        repository.supportsPrStatusPush = true;
        final poll = tracker.pollPrState(worktree)..setVisible(true);
        async.flushMicrotasks();
        requests.single.complete({
          'repos': [
            {
              'repoId': 'app',
              'repoName': 'App',
              'headBranch': 'main',
              'published': false,
            },
          ],
          'busy': false,
        });
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 5));
        poll
          ..setVisible(false)
          ..setVisible(true);
        async.flushMicrotasks();
        expect(requests, hasLength(1));
        tracker.store.applyWorktreeRows([
          const RemoteWorktree(
            localId: 'wt',
            workspaceLocalId: 'ws',
            branch: 'published',
          ),
        ]);
        poll
          ..setVisible(false)
          ..setVisible(true);
        async.flushMicrotasks();
        expect(requests, hasLength(2));
        answerAll(requests);
        async.flushMicrotasks();
        unawaited(tracker.runPrAction(worktree, RemotePrAction.refresh));
        async.flushMicrotasks();
        expect(requests, hasLength(3));
        answerAll(requests);
        tracker.dispose();
      });
    });

    test('unknown publication still refreshes on a stale reopen', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness(
          clock: () => DateTime(2026).add(async.elapsed),
        );
        repository.supportsPrStatusPush = true;
        final poll = tracker.pollPrState(worktree)..setVisible(true);
        async.flushMicrotasks();
        requests.single.complete(
          prChecksState([
            {'repoId': 'app', 'headBranch': 'main'},
          ]),
        );
        async.flushMicrotasks();
        async.elapse(kRemotePrRefreshInterval * 5);
        expect(requests, hasLength(1));
        poll
          ..setVisible(false)
          ..setVisible(true);
        async.flushMicrotasks();
        expect(requests, hasLength(2));
        answerAll(requests);
        async.flushMicrotasks();
        tracker.dispose();
      });
    });

    test('local work refreshes unpublished Create eligibility once', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness();
        repository.supportsPrStatusPush = true;
        tracker.pollPrState(
          worktree,
        ); // A hidden sibling must not consume updates.
        tracker.pollPrState(worktree).setVisible(true);
        async.flushMicrotasks();
        final noChanges = {
          'repoId': 'app',
          'headBranch': 'main',
          'published': false,
          'createBlockedReason': 'no_changes',
        };
        requests.single.complete(prChecksState([noChanges]));
        async.flushMicrotasks();
        tracker.store.applyWorktreeRows([
          const RemoteWorktree(
            localId: 'wt',
            workspaceLocalId: 'ws',
            branch: 'main',
            isStreaming: true,
          ),
        ]);
        tracker.onSessionChanged();
        async.flushMicrotasks();
        expect(requests, hasLength(1));
        tracker.store.applyWorktreeRows([
          const RemoteWorktree(
            localId: 'wt',
            workspaceLocalId: 'ws',
            branch: 'main',
            isStreaming: false,
            insertions: 12,
          ),
        ]);
        tracker.onSessionChanged();
        async.flushMicrotasks();
        expect(requests, hasLength(2));
        requests.last.complete(
          prChecksState([
            {...noChanges, 'canCreate': true, 'createBlockedReason': null},
          ]),
        );
        async.flushMicrotasks();
        expect(tracker.cachedPrReposFor('ws', 'wt')!.single.canCreate, isTrue);
        tracker.onSessionChanged();
        async.elapse(kRemotePrRefreshInterval * 5);
        expect(requests, hasLength(2));
        tracker.dispose();
      });
    });

    test(
      'editing during an opening read retains actions until work settles',
      () {
        fakeAsync((async) {
          final (:tracker, :requests, :repository, replaceSession: _) =
              harness();
          repository.supportsPrStatusPush = true;
          tracker.pollPrState(worktree).setVisible(true);
          async.flushMicrotasks();
          tracker.store.applyWorktreeRows([
            const RemoteWorktree(
              localId: 'wt',
              workspaceLocalId: 'ws',
              branch: 'main',
              isStreaming: true,
              insertions: 12,
            ),
          ]);
          tracker.onSessionChanged();
          requests.single.complete(prChecksState([prChecksRepo()]));
          async.flushMicrotasks();
          expect(tracker.cachedPrReposFor('ws', 'wt'), hasLength(1));
          expect(requests, hasLength(1));
          tracker.store.applyWorktreeRows([
            RemoteWorktree(
              localId: 'wt',
              workspaceLocalId: 'ws',
              branch: 'main',
              isStreaming: false,
              insertions: 12,
              prStatuses: tracker.store.snapshot!.worktrees.single.prStatuses,
            ),
          ]);
          tracker.onSessionChanged();
          async.flushMicrotasks();
          expect(requests, hasLength(2));
          requests.last.complete(prChecksState([prChecksRepo()]));
          async.flushMicrotasks();
          async.elapse(kRemotePrRefreshInterval * 5);
          expect(requests, hasLength(2));
          tracker.dispose();
        });
      },
    );

    test(
      'progress-discarded read is replaced and follows busy until settled',
      () {
        fakeAsync((async) {
          final (:tracker, :requests, :repository, replaceSession: _) =
              harness();
          repository.supportsPrStatusPush = true;
          tracker.pollPrState(worktree).setVisible(true);
          async.flushMicrotasks();
          tracker.applyPrProgress({
            'ws:wt': const RemotePrProgressState(
              creation: RemotePrCreationProgress(
                steps: [],
                currentPhase: RemotePrCreationPhase.pushing,
              ),
            ),
          });
          requests.single.complete(prChecksState([prChecksRepo()]));
          async.flushMicrotasks();
          expect(requests, hasLength(2));
          requests.last.complete({
            ...prChecksState([prChecksRepo()]),
            'busy': true,
          });
          async.flushMicrotasks();
          tracker.applyPrProgress({
            'ws:wt': const RemotePrProgressState(clearCreation: true),
          });
          async.elapse(kRemotePrRefreshInterval);
          expect(requests, hasLength(3));
          requests.last.complete(prChecksState([prChecksRepo()]));
          async.flushMicrotasks();
          expect(tracker.cachedPrReposFor('ws', 'wt'), hasLength(1));
          expect(tracker.cachedPrBusyFor('ws', 'wt'), isFalse);
          async.elapse(kRemotePrRefreshInterval * 5);
          expect(requests, hasLength(3));
          tracker.dispose();
        });
      },
    );

    test('an older failed read does not invalidate a newer confirmed read', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness();
        repository.supportsPrStatusPush = true;
        final poll = tracker.pollPrState(worktree)..setVisible(true);
        async.flushMicrotasks();
        final response = prChecksState([
          {...prChecksRepo(), 'headBranch': 'main'},
        ]);
        requests.single.complete(response);
        async.flushMicrotasks();
        unawaited(tracker.refreshPrState(worktree));
        unawaited(tracker.refreshPrState(worktree));
        async.flushMicrotasks();
        expect(requests, hasLength(3));
        requests.last.complete(response);
        async.flushMicrotasks();
        requests[1].completeError(StateError('older request failed'));
        async.flushMicrotasks();
        poll
          ..setVisible(false)
          ..setVisible(true);
        async.flushMicrotasks();
        expect(requests, hasLength(3));
        tracker.dispose();
      });
    });

    for (final recovers in [false, true]) {
      test(
        'failed readiness reads retry with cached actions, recovers=$recovers',
        () {
          fakeAsync((async) {
            final (:tracker, :requests, :repository, replaceSession: _) =
                harness();
            repository.supportsPrStatusPush = true;
            final poll = tracker.pollPrState(worktree)..setVisible(true);
            async.flushMicrotasks();
            requests.single.complete(prChecksState([prChecksRepo()]));
            async.flushMicrotasks();
            final ready = {
              ...prChecksRepo(checkStatus: 'passing'),
              'canMerge': true,
            };
            tracker.store.applyPrStatuses({
              'ws:wt': [RemotePrRepo.fromJson(ready).pr!],
            });
            tracker.onSessionChanged();
            async.flushMicrotasks();
            expect(requests, hasLength(2));
            requests.last.completeError(
              StateError('temporary command failure'),
            );
            async.flushMicrotasks();
            expect(
              tracker.cachedPrReposFor('ws', 'wt')!.single.canMerge,
              isFalse,
            );
            tracker.onSessionChanged();
            async.elapse(kRemotePrRefreshInterval);
            expect(requests, hasLength(3));
            if (recovers) {
              requests.last.complete(prChecksState([ready]));
            } else {
              requests.last.completeError(StateError('still unavailable'));
            }
            async.flushMicrotasks();
            async.elapse(kRemotePrRefreshInterval * 5);
            expect(requests, hasLength(3));
            if (!recovers) {
              poll
                ..setVisible(false)
                ..setVisible(true);
              async.flushMicrotasks();
              expect(requests, hasLength(4));
              requests.last.complete(prChecksState([ready]));
              async.flushMicrotasks();
            }
            expect(
              tracker.cachedPrReposFor('ws', 'wt')!.single.canMerge,
              isTrue,
            );
            // A later readiness transition gets its own bounded recovery budget.
            final before = requests.length;
            tracker.store.applyPrStatuses({
              'ws:wt': [RemotePrRepo.fromJson(prChecksRepo()).pr!],
            });
            tracker.onSessionChanged();
            async.flushMicrotasks();
            expect(requests, hasLength(before + 1));
            requests.last.completeError(
              StateError('another temporary failure'),
            );
            async.flushMicrotasks();
            async.elapse(kRemotePrRefreshInterval);
            expect(requests, hasLength(before + 2));
            requests.last.complete(prChecksState([prChecksRepo()]));
            async.flushMicrotasks();
            expect(
              tracker.cachedPrReposFor('ws', 'wt')!.single.canMerge,
              isFalse,
            );
            async.elapse(kRemotePrRefreshInterval * 5);
            expect(requests, hasLength(before + 2));
            tracker.dispose();
          });
        },
      );
    }

    for (final cached in [false, true]) {
      for (final recovers in [true, false]) {
        test('unavailable lookup gets a bounded retry and stays stale '
            '(cached=$cached, recovers=$recovers)', () {
          fakeAsync((async) {
            final (:tracker, :requests, :repository, replaceSession: _) =
                harness(clock: () => DateTime(2026).add(async.elapsed));
            repository.supportsPrStatusPush = true;
            final poll = tracker.pollPrState(worktree)..setVisible(true);
            async.flushMicrotasks();
            final ready = {
              'repoId': 'app',
              'headBranch': 'main',
              'published': false,
              'status': null,
              'canCreate': true,
            };
            final unavailable = {
              ...ready,
              'canCreate': false,
              'createBlockedReason': 'pr_status_unavailable',
            };
            if (cached) {
              requests.single.complete(prChecksState([ready]));
              async.flushMicrotasks();
              unawaited(tracker.refreshPrState(worktree));
              async.flushMicrotasks();
            }
            final initialReads = requests.length;
            requests.last.complete(prChecksState([unavailable]));
            async.flushMicrotasks();
            expect(
              tracker.cachedPrReposFor('ws', 'wt')!.single.canCreate,
              isFalse,
            );
            async.elapse(kRemotePrRefreshInterval);
            expect(requests, hasLength(initialReads + 1));
            requests.last.complete(
              prChecksState([recovers ? ready : unavailable]),
            );
            async.flushMicrotasks();
            async.elapse(kRemotePrRefreshInterval * 5);
            expect(requests, hasLength(initialReads + 1));
            if (!recovers) {
              poll
                ..setVisible(false)
                ..setVisible(true);
              async.flushMicrotasks();
              expect(requests, hasLength(initialReads + 2));
              requests.last.complete(prChecksState([ready]));
              async.flushMicrotasks();
            }
            expect(
              tracker.cachedPrReposFor('ws', 'wt')!.single.canCreate,
              isTrue,
            );
            async.elapse(kRemotePrRefreshInterval * 5);
            expect(requests, hasLength(initialReads + (recovers ? 1 : 2)));
            tracker.dispose();
          });
        });
      }
    }

    for (final recovers in [true, false]) {
      test(
        'a missing opening read gets one bounded retry, recovers=$recovers',
        () {
          fakeAsync((async) {
            final (:tracker, :requests, :repository, replaceSession: _) =
                harness();
            repository.supportsPrStatusPush = true;
            tracker.pollPrState(worktree).setVisible(true);
            async.flushMicrotasks();
            requests.single.completeError(StateError('host unavailable'));
            async.flushMicrotasks();
            async.elapse(kRemotePrRefreshInterval);
            expect(requests, hasLength(2));
            if (recovers) {
              requests.last.complete(prChecksState([prChecksRepo()]));
            } else {
              requests.last.completeError(StateError('still unavailable'));
            }
            async.flushMicrotasks();
            expect(tracker.cachedPrReposFor('ws', 'wt') != null, recovers);
            async.elapse(kRemotePrRefreshInterval * 5);
            expect(requests, hasLength(2));
            tracker.dispose();
          });
        },
      );
    }

    test('base-only retarget refreshes the cached Merge identity', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness();
        repository.supportsPrStatusPush = true;
        tracker.pollPrState(worktree).setVisible(true);
        async.flushMicrotasks();
        final repo = prChecksRepo(checkStatus: 'passing');
        final status = repo['status'] as Map<String, dynamic>;
        requests.single.complete(
          prChecksState([
            {
              ...repo,
              'status': {...status, 'baseRefName': 'develop'},
            },
          ]),
        );
        async.flushMicrotasks();
        final retargeted = {...status, 'baseRefName': 'release'};
        tracker.store.applyPrStatuses({
          'ws:wt': [
            RemoteWorktreePr.fromPortal(retargeted, repoId: 'repo-app'),
          ],
        });
        tracker.onSessionChanged();
        async.flushMicrotasks();
        expect(requests, hasLength(2));
        requests.last.complete(
          prChecksState([
            {
              ...repo,
              'status': retargeted,
              'baseBranch': 'release',
              'canMerge': true,
            },
          ]),
        );
        async.flushMicrotasks();
        final action = tracker.cachedPrReposFor('ws', 'wt')!.single;
        expect(action.baseBranch, 'release');
        expect(action.canMerge, isTrue);
        tracker.dispose();
      });
    });

    for (final projection in ['portal', 'overview']) {
      test('a mergeReady-only $projection update refreshes eligibility', () {
        fakeAsync((async) {
          final (:tracker, :requests, :repository, replaceSession: _) =
              harness();
          repository.supportsPrStatusPush = true;
          tracker.pollPrState(worktree).setVisible(true);
          async.flushMicrotasks();
          final repo = prChecksRepo(checkStatus: 'passing');
          final status = repo['status'] as Map<String, dynamic>;
          requests.single.complete(
            prChecksState([
              {
                ...repo,
                'status': {...status, 'mergeReady': false},
              },
            ]),
          );
          async.flushMicrotasks();
          final ready = {...status, 'mergeReady': true};
          if (projection == 'portal') {
            tracker.store.applyPrStatuses({
              'ws:wt': [RemoteWorktreePr.fromPortal(ready, repoId: 'repo-app')],
            });
          } else {
            tracker.store.applyWorktreeRows([
              RemoteWorktree.fromJson({
                'localId': 'wt',
                'workspaceLocalId': 'ws',
                'branch': 'main',
                'lastKnownPrStatus': {
                  'repos': [
                    {
                      'repoId': 'repo-app',
                      'status': {
                        ...ready,
                        'prNumber': ready['number'],
                        'prUrl': ready['url'],
                      },
                    },
                  ],
                },
              }),
            ]);
          }
          tracker.onSessionChanged();
          async.flushMicrotasks();
          expect(requests, hasLength(2));
          requests.last.complete(
            prChecksState([
              {...repo, 'status': ready, 'canMerge': true},
            ]),
          );
          async.flushMicrotasks();
          expect(tracker.cachedPrReposFor('ws', 'wt')!.single.canMerge, isTrue);
          tracker.dispose();
        });
      });
    }

    for (final difference in [
      'single-repo identity',
      'no-review spelling',
      'missing summary readiness',
    ]) {
      test('$difference does not cause another eligibility read', () {
        fakeAsync((async) {
          final (:tracker, :requests, :repository, replaceSession: _) =
              harness();
          repository.supportsPrStatusPush = true;
          tracker.pollPrState(worktree).setVisible(true);
          async.flushMicrotasks();
          final repo = prChecksRepo(
            reviewStatus: difference == 'no-review spelling' ? 'none' : null,
          );
          if (difference == 'missing summary readiness') {
            (repo['status'] as Map<String, dynamic>)['mergeReady'] = true;
          }
          requests.single.complete(
            prChecksState([
              {
                ...repo,
                'repoId': difference == 'single-repo identity'
                    ? '__single_repo__'
                    : 'repo-app',
              },
            ]),
          );
          async.flushMicrotasks();
          final status = {...repo['status'] as Map<String, dynamic>}
            ..remove('mergeReady'); // Current overview summaries omit it.
          for (var i = 0; i < 3; i++) {
            tracker.store.applyWorktreeRows([
              RemoteWorktree.fromJson({
                'localId': 'wt',
                'workspaceLocalId': 'ws',
                'branch': 'main',
                'lastKnownPrStatus': {
                  'repos': [
                    {
                      'repoId': 'repo-app',
                      'status': {
                        ...status,
                        'prNumber': status['number'],
                        'prUrl': status['url'],
                      },
                    },
                  ],
                },
              }),
            ]);
            tracker.onSessionChanged();
            async.flushMicrotasks();
            expect(requests, hasLength(1));
          }
          async.elapse(kRemotePrRefreshInterval * 5);
          expect(requests, hasLength(1));
          tracker.dispose();
        });
      });
    }

    test('push hosts follow a busy read until it settles, then stop', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness();
        repository.supportsPrStatusPush = true;
        tracker.pollPrState(worktree).setVisible(true);
        async.flushMicrotasks();
        requests.single.complete({'repos': [], 'busy': true});
        async.flushMicrotasks();
        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(2));
        answerAll(requests);
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 5));
        expect(requests, hasLength(2));
        tracker.dispose();
      });
    });

    test('reopening a fresh busy chat resumes follow-up until settled', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness(
          clock: () => DateTime(2026).add(async.elapsed),
        );
        repository.supportsPrStatusPush = true;
        final poll = tracker.pollPrState(worktree)..setVisible(true);
        async.flushMicrotasks();
        requests.single.complete({'repos': [], 'busy': true});
        async.flushMicrotasks();
        poll
          ..setVisible(false)
          ..setVisible(true);
        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(2));
        answerAll(requests);
        async.flushMicrotasks();
        expect(tracker.cachedPrBusyFor('ws', 'wt'), isFalse);
        async.elapse(kRemotePrRefreshInterval * 3);
        expect(requests, hasLength(2));
        tracker.dispose();
      });
    });

    test('push readiness changes coalesce behind an in-flight read', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness();
        repository.supportsPrStatusPush = true;
        tracker.pollPrState(worktree).setVisible(true);
        async.flushMicrotasks();
        requests.single.complete(prChecksState([prChecksRepo()]));
        async.flushMicrotasks();
        void push(String status) {
          tracker.store.applyPrStatuses({
            'ws:wt': [
              RemotePrRepo.fromJson(prChecksRepo(checkStatus: status)).pr!,
            ],
          });
          tracker.onSessionChanged();
          async.flushMicrotasks();
        }

        push('passing');
        expect(requests, hasLength(2));
        push('passing');
        expect(requests, hasLength(2));
        push('pending');
        push('failing');
        expect(requests, hasLength(2));
        requests[1].complete(
          prChecksState([
            {...prChecksRepo(checkStatus: 'passing'), 'canMerge': true},
          ]),
        );
        async.flushMicrotasks();
        expect(requests, hasLength(3));
        expect(tracker.cachedPrReposFor('ws', 'wt')!.single.canMerge, isFalse);
        requests[2].complete(prChecksState([prChecksRepo()]));
        async.flushMicrotasks();
        async.elapse(kRemotePrRefreshInterval * 5);
        expect(requests, hasLength(3));
        tracker.dispose();
      });
    });

    test('detailed check updates do not reread unchanged eligibility', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness();
        repository.supportsPrStatusPush = true;
        tracker.pollPrState(worktree).setVisible(true);
        async.flushMicrotasks();
        requests.single.complete(prChecksState([prChecksRepo()]));
        async.flushMicrotasks();
        tracker.store.applyPrStatuses({
          'ws:wt': [
            RemotePrRepo.fromJson(
              prChecksRepo(checks: nineStatePrChecks()),
            ).pr!,
          ],
        });
        tracker.onSessionChanged();
        async.flushMicrotasks();
        expect(requests, hasLength(1));
        expect(
          tracker.cachedPrReposFor('ws', 'wt')!.single.pr!.checks,
          hasLength(9),
        );
        async.elapse(kRemotePrRefreshInterval * 5);
        expect(requests, hasLength(1));
        tracker.dispose();
      });
    });

    test('hidden readiness changes refresh on a fresh reopen', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness(
          clock: () => DateTime(2026).add(async.elapsed),
        );
        repository.supportsPrStatusPush = true;
        final poll = tracker.pollPrState(worktree)..setVisible(true);
        async.flushMicrotasks();
        requests.single.complete(
          prChecksState([
            {...prChecksRepo(), 'headBranch': 'main'},
          ]),
        );
        async.flushMicrotasks();
        poll.setVisible(false);
        tracker.store.applyPrStatuses({
          'ws:wt': [
            RemotePrRepo.fromJson(prChecksRepo(checkStatus: 'passing')).pr!,
          ],
        });
        tracker.onSessionChanged();
        async.flushMicrotasks();
        expect(requests, hasLength(1));
        poll.setVisible(true);
        async.flushMicrotasks();
        expect(requests, hasLength(2));
        answerAll(requests);
        async.flushMicrotasks();
        tracker.dispose();
      });
    });

    test('stream recovery refreshes a visible push host once', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness();
        repository.supportsPrStatusPush = true;
        tracker.pollPrState(worktree).setVisible(true);
        async.flushMicrotasks();
        answerAll(requests);
        async.flushMicrotasks();
        tracker.onDeliveryRecovered();
        async.flushMicrotasks();
        expect(requests, hasLength(2));
        answerAll(requests);
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 5));
        expect(requests, hasLength(2));
        tracker.dispose();
      });
    });

    test('a hidden or unsupported poll schedules nothing', () {
      fakeAsync((async) {
        final (:tracker, :requests, :repository, replaceSession: _) = harness();
        final poll = tracker.pollPrState(worktree);
        async.elapse(kRemotePrRefreshInterval * 2);
        expect(requests, isEmpty);

        poll
          ..setVisible(true)
          ..setVisible(false);
        answerAll(requests);
        async.elapse(kRemotePrRefreshInterval * 2);
        expect(requests, hasLength(1));

        repository.supportsPrActions = false;
        poll.setVisible(true);
        async.elapse(kRemotePrRefreshInterval * 2);
        expect(requests, hasLength(1));
        tracker.dispose();
      });
    });

    test('one request runs at a time; a tick during it is skipped', () {
      fakeAsync((async) {
        final (:tracker, :requests, repository: _, replaceSession: _) =
            harness();
        tracker.pollPrState(worktree).setVisible(true);
        async.flushMicrotasks();
        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(1));

        answerAll(requests);
        async.flushMicrotasks();
        expect(requests, hasLength(1));
        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(2));
        tracker.dispose();
      });
    });

    test('reappearing mid-request queues exactly one trailing refresh', () {
      fakeAsync((async) {
        final (:tracker, :requests, repository: _, replaceSession: _) =
            harness();
        final poll = tracker.pollPrState(worktree)..setVisible(true);
        async.flushMicrotasks();
        for (var i = 0; i < 3; i++) {
          poll
            ..setVisible(false)
            ..setVisible(true);
        }
        expect(requests, hasLength(1));

        answerAll(requests);
        async.flushMicrotasks();
        expect(requests, hasLength(2));
        answerAll(requests);
        async.flushMicrotasks();
        expect(requests, hasLength(2));
        tracker.dispose();
      });
    });

    for (final change in ['hidden', 'replaced', 'disposed']) {
      test('a trailing refresh is dropped when the view is $change', () {
        fakeAsync((async) {
          final (:tracker, :requests, repository: _, :replaceSession) =
              harness();
          final poll = tracker.pollPrState(worktree)..setVisible(true);
          async.flushMicrotasks();
          poll
            ..setVisible(false)
            ..setVisible(true);
          switch (change) {
            case 'hidden':
              poll.setVisible(false);
            case 'replaced':
              replaceSession();
            case 'disposed':
              poll.dispose();
          }

          answerAll(requests);
          async.flushMicrotasks();
          expect(requests, hasLength(1));
          tracker.dispose();
        });
      });
    }

    test('one hidden view cannot stop another visible view', () {
      fakeAsync((async) {
        final (:tracker, :requests, repository: _, replaceSession: _) =
            harness();
        final shown = tracker.pollPrState(worktree)..setVisible(true);
        final hidden = tracker.pollPrState(worktree)
          ..setVisible(true)
          ..setVisible(false);
        async.flushMicrotasks();
        answerAll(requests);
        final afterStart = requests.length;

        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(afterStart + 1));

        hidden.dispose();
        answerAll(requests);
        async.elapse(kRemotePrRefreshInterval);
        expect(requests, hasLength(afterStart + 2));
        shown.dispose();
        tracker.dispose();
      });
    });

    test('disposing the tracker stops every poll', () {
      fakeAsync((async) {
        final (:tracker, :requests, repository: _, replaceSession: _) =
            harness();
        tracker.pollPrState(worktree).setVisible(true);
        async.flushMicrotasks();
        answerAll(requests);
        tracker.dispose();

        async.elapse(kRemotePrRefreshInterval * 3);
        expect(requests, hasLength(1));
      });
    });
  });
}

RemoteSessionStore _prStore() =>
    (RemoteStoresHarness()..applySnapshot(
          const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt',
                workspaceLocalId: 'ws',
                branch: 'main',
              ),
            ],
            standaloneChats: [],
          ),
        ))
        .session;
