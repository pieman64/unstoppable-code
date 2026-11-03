import 'dart:async';
import 'dart:math' as math;

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_client_engine.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_create_coordinator.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/remote_engine_harness.dart';

void _completeCreate(RemoteClientEngine engine, String id) {
  engine.commands.handleCompleted('cmd-1', {'id': id}, projectionSequence: 0);
}

const _workspace = RemoteWorkspace(
  localId: 'ws-app',
  name: 'acme-web',
  type: RemoteWorkspaceType.singleRepo,
  rootPath: '~/code/acme-web',
);

RemoteWorktree _worktree(String id) =>
    RemoteWorktree(localId: id, workspaceLocalId: 'ws-app', branch: 'feat/$id');

void main() {
  group('pushed worktree creation', () {
    testWidgets(
      'refresh recovers a timed-out create when its completion event was lost',
      (tester) async {
        final repository = FakeRemoteControlRepository();
        final worktrees = <RemoteWorktree>[];
        repository.snapshotBuilder = () => RemoteSessionSnapshot(
          workspaces: const [_workspace],
          worktrees: List.of(worktrees),
          standaloneChats: const [],
        );
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-create');
        repository.commandStatusHandler = (id) async =>
            BrowserPortalCommandStatusResponse(
              commandId: id,
              status: BrowserPortalCommandStatus.delivered,
            );
        final engine = buildRemoteEngine(
          repository: repository,
          worktreeCreateRecoveryInterval: const Duration(seconds: 3),
          worktreeCreateTimeout: const Duration(seconds: 4),
        );
        addTearDown(engine.dispose);
        await engine.session.connect('123456');
        final attempt = RemoteWorktreeCreateAttempt();
        Object? error;
        unawaited(
          engine.worktreeCreates
              .createWorktree(workspaceLocalId: 'ws-app', attempt: attempt)
              .then((_) {}, onError: (Object failure) => error = failure),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 3));
        expect(repository.commandStatusReads, ['cmd-create']);
        await tester.pump(const Duration(seconds: 1));
        expect(error, isA<RemoteControlException>());
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);

        // The desktop finished, but no command-completed event was delivered.
        worktrees.add(_worktree('wt-created'));
        repository.commandStatusHandler = (id) async =>
            BrowserPortalCommandStatusResponse(
              commandId: id,
              status: BrowserPortalCommandStatus.completed,
              result: {'id': 'wt-created'},
            );
        expect(await engine.refresh(), isTrue);
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
        expect(repository.commandStatusReads, ['cmd-create', 'cmd-create']);
        expect(repository.createWorktreeCalls, hasLength(1));

        // The originating composer can still claim its result without submit.
        expect(
          (await engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          )).localId,
          'wt-created',
        );
        expect(repository.createWorktreeCalls, hasLength(1));
        worktrees.add(_worktree('wt-next'));
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(
              commandId: 'cmd-next',
              worktreeLocalId: 'wt-next',
            );
        await engine.refresh();
        expect(
          (await engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
          )).localId,
          'wt-next',
        );
        expect(repository.createWorktreeCalls, hasLength(2));
      },
    );

    testWidgets(
      'a stalled recovery read cannot hold the create past its timeout',
      (tester) async {
        final repository = FakeRemoteControlRepository();
        final recovery = Completer<void>();
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(
              commandId: 'cmd-create',
              worktreeLocalId: 'wt-created',
            );
        repository.requestOverviewStateHandler = () => recovery.future;
        final coordinator = WorktreeCreateCoordinator(
          repository: repository,
          commands: OwnedCommandRegistry(notify: () {}),
          notify: () {},
          isConnected: () => true,
          isDisposed: () => false,
          sessionGeneration: () => 1,
          worktreesFor: (_) => [],
          refreshSnapshot: () async => true,
          recoveryInterval: const Duration(seconds: 3),
          timeout: const Duration(seconds: 4),
        );
        addTearDown(() {
          coordinator.dispose();
          recovery.complete();
        });
        Object? error;
        unawaited(
          coordinator
              .createWorktree(workspaceLocalId: 'ws-app')
              .then((_) {}, onError: (Object failure) => error = failure),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 3));
        expect(repository.requestOverviewStateCalls, 1);
        await tester.pump(const Duration(seconds: 1));
        expect(error, isA<RemoteControlException>());
        expect(coordinator.isCreatingWorktree, isTrue);
      },
    );

    testWidgets(
      'deadline releases an unidentified create without adopting unrelated rows',
      (tester) async {
        final repository = FakeRemoteControlRepository();
        repository.createWorktreeHandler = () async =>
            throw const RemoteWorktreeCreateOutcomeUnknownException(
              'Response lost.',
            );
        final coordinator = WorktreeCreateCoordinator(
          repository: repository,
          commands: OwnedCommandRegistry(notify: () {}),
          notify: () {},
          isConnected: () => true,
          isDisposed: () => false,
          sessionGeneration: () => 1,
          worktreesFor: (_) => [_worktree('wt-unrelated')],
          refreshSnapshot: () async => true,
          timeout: const Duration(seconds: 4),
        );
        addTearDown(coordinator.dispose);
        Object? error;
        unawaited(
          coordinator
              .createWorktree(workspaceLocalId: 'ws-app')
              .then(
                (_) => fail('Must not adopt another create'),
                onError: (Object failure) => error = failure,
              ),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 3));
        expect(coordinator.isCreatingWorktree, isTrue);
        expect(error, isNull);
        await tester.pump(const Duration(seconds: 1));
        expect(error, isA<RemoteControlException>());
        expect(coordinator.isCreatingWorktree, isFalse);
        expect(coordinator.unidentifiedAttempt, isNull);
        expect(coordinator.worktreeCreatePhase, isNull);
        expect(repository.createWorktreeCalls, hasLength(1));
      },
    );

    test('submits without waiting for an overview baseline', () async {
      final repository = FakeRemoteControlRepository();
      final baseline = Completer<void>();
      final worktrees = <RemoteWorktree>[];
      repository.requestOverviewStateHandler = () => baseline.future;
      repository.createWorktreeHandler = () async {
        worktrees.add(_worktree('wt-created'));
        return const RemoteWorktreeCreateResult(
          commandId: 'cmd-create',
          worktreeLocalId: 'wt-created',
        );
      };
      final coordinator = WorktreeCreateCoordinator(
        repository: repository,
        commands: OwnedCommandRegistry(notify: () {}),
        notify: () {},
        isConnected: () => true,
        isDisposed: () => false,
        sessionGeneration: () => 1,
        worktreesFor: (_) => worktrees,
        refreshSnapshot: () async => true,
      );
      addTearDown(() {
        coordinator.dispose();
        if (!baseline.isCompleted) baseline.complete();
      });
      final create = coordinator.createWorktree(workspaceLocalId: 'ws-app');
      await Future<void>.delayed(Duration.zero);
      expect(repository.createWorktreeCalls, hasLength(1));
      expect((await create).localId, 'wt-created');
      expect(repository.requestOverviewStateCalls, 0);
    });

    test(
      'a ready push completes without another overview or poll delay',
      () async {
        final repository = FakeRemoteControlRepository();
        final worktrees = <RemoteWorktree>[];
        final recovery = Completer<void>();
        var snapshotReads = 0;
        repository.createWorktreeHandler = () async {
          worktrees.add(
            const RemoteWorktree(
              localId: 'wt-created',
              workspaceLocalId: 'ws-app',
              branch: 'feature',
              setupPhase: RemoteWorktreeSetupPhase.gitPending,
            ),
          );
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-created',
          );
        };
        repository.requestOverviewStateHandler = () => recovery.future;
        final coordinator = WorktreeCreateCoordinator(
          repository: repository,
          commands: OwnedCommandRegistry(notify: () {}),
          notify: () {},
          isConnected: () => true,
          isDisposed: () => false,
          sessionGeneration: () => 1,
          worktreesFor: (_) => worktrees,
          refreshSnapshot: () async {
            snapshotReads++;
            return true;
          },
          recoveryInterval: Duration.zero,
        );
        addTearDown(() {
          coordinator.dispose();
          if (!recovery.isCompleted) recovery.complete();
        });
        var completed = false;
        final create = coordinator.createWorktree(workspaceLocalId: 'ws-app')
          ..then((_) => completed = true);
        await pumpEventQueue();
        expect(repository.requestOverviewStateCalls, 1);
        worktrees[0] = _worktree('wt-created');
        coordinator.reconcileSnapshot();
        await Future<void>.delayed(Duration.zero);
        expect(
          completed,
          isTrue,
          reason: 'Git-ready must wake the create even while recovery is held.',
        );
        expect((await create).localId, 'wt-created');
        expect(repository.requestOverviewStateCalls, 1);
        recovery.complete();
        await pumpEventQueue();
        expect(
          snapshotReads,
          0,
          reason:
              'The detached recovery must stop before requesting a snapshot.',
        );
      },
    );

    test('the engine forwards ready deltas to the waiting create', () async {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [_workspace],
        worktrees: [],
        standaloneChats: [],
      );
      repository.createWorktreeHandler = () async =>
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-created',
          );
      final recovery = Completer<void>();
      repository.requestOverviewStateHandler = () async {
        if (repository.requestOverviewStateCalls > 1) await recovery.future;
      };
      final engine = buildRemoteEngine(repository: repository);
      addTearDown(() {
        engine.dispose();
        if (!recovery.isCompleted) recovery.complete();
      });
      await engine.session.connect('123456');
      var completed = false;
      final create = engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
      )..then((_) => completed = true);
      await Future<void>.delayed(Duration.zero);
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteStateDeltaEvent(worktrees: [_worktree('wt-created')]),
          ],
          nextCursor: 1,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(completed, isTrue);
      expect((await create).localId, 'wt-created');
      expect(repository.requestOverviewStateCalls, lessThanOrEqualTo(1));
    });
  });
  group('WorktreeCreateCoordinator.createWorktree', () {
    /// Fake whose snapshot is driven by a mutable worktree list, so a test can
    /// model the desktop publishing (or not publishing) the new worktree.
    FakeRemoteControlRepository repositoryWith(List<RemoteWorktree> worktrees) {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [_workspace],
        worktrees: List.of(worktrees),
        standaloneChats: const [],
      );
      return repository;
    }

    /// [createTimeout] defaults to zero so the pending-path tests observe a
    /// single reconcile round; polling tests raise it explicitly.
    RemoteClientEngine connectedVm(
      FakeRemoteControlRepository repository, {
      Duration createTimeout = Duration.zero,
      DateTime Function()? clock,
    }) => buildRemoteEngine(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      worktreeCreateRecoveryInterval: Duration.zero,
      worktreeCreateTimeout: createTimeout,
      clock: clock,
    );

    test(
      'sends existing worktree ids and returns the created worktree',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async {
          // The desktop creates it, so the next projection includes it.
          worktrees.add(_worktree('wt-2'));
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-2',
          );
        };
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );

        expect(created.localId, 'wt-2');
        expect(repository.createWorktreeCalls.single.existingWorktreeIds, [
          'wt-1',
        ]);
        expect(repository.createWorktreeCalls.single.baseWorktreeId, isNull);
      },
    );

    test(
      'holds the create open while the created worktree is git-pending',
      () async {
        // The desktop's deferred create path acknowledges the reservation
        // before running `git worktree add` in the background: the row lands
        // with setupPhase git-pending and may still roll back, so success is
        // not implied until the phase settles.
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async {
          worktrees.add(
            const RemoteWorktree(
              localId: 'wt-2',
              workspaceLocalId: 'ws-app',
              branch: 'feat/wt-2',
              setupPhase: RemoteWorktreeSetupPhase.gitPending,
            ),
          );
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-2',
          );
        };
        repository.requestOverviewStateHandler = () async {
          // The background git setup finishes while reconciliation polls:
          // the row leaves git-pending on the fourth projection.
          if (repository.requestOverviewStateCalls >= 4 &&
              worktrees.length > 1) {
            worktrees[1] = const RemoteWorktree(
              localId: 'wt-2',
              workspaceLocalId: 'ws-app',
              branch: 'feat/wt-2',
              setupPhase: RemoteWorktreeSetupPhase.idle,
            );
          }
        };
        final engine = connectedVm(
          repository,
          createTimeout: const Duration(minutes: 1),
        );
        await engine.session.connect('123456');

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );

        expect(created.localId, 'wt-2');
        expect(created.setupPhase, RemoteWorktreeSetupPhase.idle);
        expect(repository.requestOverviewStateCalls, greaterThanOrEqualTo(4));
      },
    );

    test(
      'reports the create phase from submit through the git-pending setup',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        final createResult = Completer<RemoteWorktreeCreateResult>();
        repository.createWorktreeHandler = () => createResult.future;
        final engine = connectedVm(
          repository,
          createTimeout: const Duration(minutes: 1),
        );
        await engine.session.connect('123456');
        expect(engine.worktreeCreates.worktreeCreatePhase, isNull);

        final created = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await pumpEventQueue();
        expect(
          engine.worktreeCreates.worktreeCreatePhase,
          RemoteWorktreeCreatePhase.submitting,
        );

        // The desktop reserves the worktree first; its background git setup
        // is still running when the id comes back.
        worktrees.add(
          const RemoteWorktree(
            localId: 'wt-2',
            workspaceLocalId: 'ws-app',
            branch: 'feat/wt-2',
            setupPhase: RemoteWorktreeSetupPhase.gitPending,
          ),
        );
        createResult.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-2',
          ),
        );
        await pumpEventQueue();
        expect(
          engine.worktreeCreates.worktreeCreatePhase,
          RemoteWorktreeCreatePhase.settingUp,
        );

        worktrees[1] = const RemoteWorktree(
          localId: 'wt-2',
          workspaceLocalId: 'ws-app',
          branch: 'feat/wt-2',
          setupPhase: RemoteWorktreeSetupPhase.idle,
        );
        expect((await created).localId, 'wt-2');
        expect(engine.worktreeCreates.worktreeCreatePhase, isNull);
      },
    );

    test(
      'reports an accepted create with no echoed id as awaiting the desktop',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(
          repository,
          createTimeout: const Duration(minutes: 1),
        );
        await engine.session.connect('123456');

        final created = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await pumpEventQueue();
        expect(
          engine.worktreeCreates.worktreeCreatePhase,
          RemoteWorktreeCreatePhase.awaitingDesktop,
        );

        worktrees.add(_worktree('wt-2'));
        _completeCreate(engine, 'wt-2');
        expect((await created).localId, 'wt-2');
        expect(engine.worktreeCreates.worktreeCreatePhase, isNull);
      },
    );

    test('a worktreeSetupFailure delta settles the pending create with the '
        'desktop error', () async {
      final worktrees = [_worktree('wt-1')];
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () async {
        worktrees.add(
          const RemoteWorktree(
            localId: 'wt-2',
            workspaceLocalId: 'ws-app',
            branch: 'feat/wt-2',
            setupPhase: RemoteWorktreeSetupPhase.gitPending,
          ),
        );
        return const RemoteWorktreeCreateResult(
          commandId: 'cmd-1',
          worktreeLocalId: 'wt-2',
        );
      };
      final engine = connectedVm(
        repository,
        createTimeout: const Duration(minutes: 1),
      );
      await engine.session.connect('123456');

      final create = engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
      );
      final settled = expectLater(
        create,
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            contains('Could not fetch origin/develop.'),
          ),
        ),
      );
      // Let the reconcile loop start polling before the desktop reports
      // the rollback.
      await Future<void>.delayed(Duration.zero);
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateDeltaEvent(
              worktreeSetupFailure: RemoteWorktreeSetupFailure(
                workspaceLocalId: 'ws-app',
                worktreeLocalId: 'wt-2',
                error: 'Could not fetch origin/develop.',
              ),
            ),
          ],
          nextCursor: 1,
        ),
      );
      await settled;
      // A rolled-back create is terminal: the guard is released so the
      // user can retry a fresh create.
      expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
    });

    test(
      'uses one recovery projection when the ready push was missed',
      () async {
        final worktrees = <RemoteWorktree>[];
        final repository = repositoryWith(worktrees);
        var overviewCallsAtCreate = -1;
        repository.createWorktreeHandler = () async {
          overviewCallsAtCreate = repository.requestOverviewStateCalls;
          worktrees.add(_worktree('wt-1'));
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-1',
          );
        };
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        await engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app');

        // The missed ready push needs one post-submit recovery projection.
        expect(overviewCallsAtCreate, 0);
        expect(repository.requestOverviewStateCalls, 1);
      },
    );

    test('forwards the branch base and fork flag', () async {
      final worktrees = [_worktree('wt-1')];
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () async {
        worktrees.add(_worktree('wt-2'));
        return const RemoteWorktreeCreateResult(
          commandId: 'cmd-1',
          worktreeLocalId: 'wt-2',
        );
      };
      final engine = connectedVm(repository);
      await engine.session.connect('123456');

      await engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
        baseWorktreeId: 'wt-1',
        forkOpenTabs: true,
      );

      final call = repository.createWorktreeCalls.single;
      expect(call.baseWorktreeId, 'wt-1');
      expect(call.forkOpenTabs, isTrue);
    });

    test(
      'reports a still-pending create instead of a failure when no worktree appears',
      () async {
        // Models the server's wait window elapsing: the create was accepted
        // but the desktop had not finished, so the refreshed snapshot is
        // unchanged and no id came back.
        final repository = repositoryWith([_worktree('wt-1')]);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(repository);
        final attempt = RemoteWorktreeCreateAttempt();
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(
            isA<RemoteControlException>().having(
              (e) => e.message,
              'message',
              allOf(contains('still being created'), contains('duplicate')),
            ),
          ),
        );
        // The accepted create remains guarded until a later reconciliation
        // sees its worktree, so retrying cannot submit a duplicate command.
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
      },
    );

    test(
      'reports a pending create when overview reconciliation fails',
      () async {
        final repository = repositoryWith([_worktree('wt-1')]);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(
              commandId: 'cmd-1',
              worktreeLocalId: 'wt-2',
            );
        repository.requestOverviewStateHandler = () async {
          if (repository.requestOverviewStateCalls >= 1) {
            throw const RemoteControlException('Re-projection failed.');
          }
        };
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
          throwsA(
            isA<RemoteControlException>().having(
              (e) => e.message,
              'message',
              allOf(contains('still being created'), contains('duplicate')),
            ),
          ),
        );
        expect(repository.requestOverviewStateCalls, 1);
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
      },
    );

    test(
      'retries a pending create by reconciling without submitting again',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(repository);
        final attempt = RemoteWorktreeCreateAttempt();
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(isA<RemoteControlException>()),
        );
        worktrees.add(_worktree('wt-2'));
        _completeCreate(engine, 'wt-2');

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
          attempt: attempt,
        );

        expect(created.localId, 'wt-2');
        expect(repository.createWorktreeCalls, hasLength(1));
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      },
    );

    test(
      'pull-to-refresh clears a pending create once its worktree appears',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(repository);
        final attempt = RemoteWorktreeCreateAttempt();
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(isA<RemoteControlException>()),
        );
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
        worktrees.add(_worktree('wt-2'));
        _completeCreate(engine, 'wt-2');

        await engine.refresh();

        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
        expect(repository.createWorktreeCalls, hasLength(1));
      },
    );

    test(
      'a reconciled refresh lets the originating flow claim the worktree',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(repository);
        final attempt = RemoteWorktreeCreateAttempt();
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(isA<RemoteControlException>()),
        );
        worktrees.add(_worktree('wt-2'));
        _completeCreate(engine, 'wt-2');

        // A refresh may discover the worktree after the originating create
        // call timed out. Its next call must claim that result rather than
        // submit the non-idempotent create command again.
        await engine.refresh();
        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
          attempt: attempt,
        );

        expect(created.localId, 'wt-2');
        expect(repository.createWorktreeCalls, hasLength(1));
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      },
    );

    test('an unrelated create cannot claim a reconciled worktree', () async {
      final worktrees = [_worktree('wt-1')];
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () async {
        if (repository.createWorktreeCalls.length == 1) {
          return const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        }
        worktrees.add(_worktree('wt-3'));
        return const RemoteWorktreeCreateResult(
          commandId: 'cmd-2',
          worktreeLocalId: 'wt-3',
        );
      };
      final engine = connectedVm(repository);
      await engine.session.connect('123456');

      await expectLater(
        engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
        throwsA(isA<RemoteControlException>()),
      );
      worktrees.add(_worktree('wt-2'));
      _completeCreate(engine, 'wt-2');
      await engine.refresh();

      final created = await engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
      );

      expect(created.localId, 'wt-3');
      expect(repository.createWorktreeCalls, hasLength(2));
    });

    test('a late create failure clears the matching pending guard', () async {
      final repository = repositoryWith([_worktree('wt-1')]);
      repository.createWorktreeHandler = () async =>
          const RemoteWorktreeCreateResult(commandId: 'cmd-1');
      final engine = connectedVm(repository);
      await engine.session.connect('123456');

      await expectLater(
        engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
        throwsA(isA<RemoteControlException>()),
      );
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The task create failed.',
              commandId: 'cmd-1',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      expect(engine.commands.failureMessage, 'The task create failed.');
    });

    test(
      'a create failure received before acknowledgement does not install a pending guard',
      () async {
        final result = Completer<RemoteWorktreeCreateResult>();
        final repository = repositoryWith([_worktree('wt-1')]);
        repository.createWorktreeHandler = () => result.future;
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        final create = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await Future<void>.delayed(Duration.zero);
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The task create failed early.',
                commandId: 'cmd-race',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await Future<void>.delayed(Duration.zero);
        result.complete(
          const RemoteWorktreeCreateResult(commandId: 'cmd-race'),
        );

        await expectLater(
          create,
          throwsA(
            isA<RemoteControlException>().having(
              (error) => error.message,
              'message',
              'The task create failed early.',
            ),
          ),
        );
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      },
    );

    test('ambiguous reconciliation retains the pending create guard', () async {
      final worktrees = [_worktree('wt-1')];
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () async =>
          const RemoteWorktreeCreateResult(commandId: 'cmd-1');
      final engine = connectedVm(repository);
      final attempt = RemoteWorktreeCreateAttempt();
      await engine.session.connect('123456');

      await expectLater(
        engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
          attempt: attempt,
        ),
        throwsA(isA<RemoteControlException>()),
      );
      worktrees.addAll([_worktree('wt-2'), _worktree('wt-3')]);

      await expectLater(
        engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
          attempt: attempt,
        ),
        throwsA(
          isA<RemoteControlException>().having(
            (error) => error.message,
            'message',
            contains('still being created'),
          ),
        ),
      );

      expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
      expect(repository.createWorktreeCalls, hasLength(1));
    });

    test(
      'a terminal failure during reconciliation surfaces immediately',
      () async {
        final now = DateTime(2026, 8, 9, 12);
        var currentTime = now;
        final repository = repositoryWith([_worktree('wt-1')]);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(
              commandId: 'cmd-late-failure',
              worktreeLocalId: 'wt-2',
            );
        repository.requestOverviewStateHandler = () async {
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteCommandFailedEvent(
                  message: 'Desktop git worktree add failed.',
                  commandId: 'cmd-late-failure',
                ),
              ],
              nextCursor: 1,
            ),
          );
          await Future<void>.delayed(Duration.zero);
          currentTime = now.add(const Duration(minutes: 1));
        };
        final engine = connectedVm(
          repository,
          createTimeout: const Duration(seconds: 30),
          clock: () => currentTime,
        );
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
          throwsA(
            isA<RemoteControlException>().having(
              (error) => error.message,
              'message',
              'Desktop git worktree add failed.',
            ),
          ),
        );

        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      },
    );

    test('never guesses a lost response from another new row', () async {
      final worktrees = [_worktree('wt-1')];
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () async {
        worktrees.add(_worktree('wt-unrelated'));
        throw const RemoteWorktreeCreateOutcomeUnknownException(
          'Response lost.',
        );
      };
      final engine = connectedVm(repository);
      await engine.session.connect('123456');
      final attempt = RemoteWorktreeCreateAttempt();
      for (var retry = 0; retry < 2; retry++) {
        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(isA<RemoteControlException>()),
        );
        await engine.refresh();
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      }
      expect(repository.createWorktreeCalls, hasLength(2));
    });

    test(
      'releases an unidentified create at timeout and allows a new attempt',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async =>
            throw const RemoteWorktreeCreateOutcomeUnknownException(
              'Response lost.',
            );
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
          throwsA(
            isA<RemoteControlException>().having(
              (error) => error.message,
              'message',
              allOf(
                contains("couldn't confirm"),
                contains('Check your desktop'),
              ),
            ),
          ),
        );

        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
        expect(engine.worktreeCreates.unidentifiedAttempt, isNull);
        final overviewCalls = repository.requestOverviewStateCalls;
        await engine.refresh();
        expect(repository.requestOverviewStateCalls, overviewCalls);

        repository.createWorktreeHandler = () async {
          worktrees.add(_worktree('wt-next'));
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-next',
            worktreeLocalId: 'wt-next',
          );
        };
        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        expect(created.localId, 'wt-next');
        expect(repository.createWorktreeCalls, hasLength(2));
      },
    );

    test('keeps polling until the created worktree appears', () async {
      // The command reported an id, but several recovery reads precede the
      // ready row. Keep following that id instead of treating absence as failure.
      final worktrees = [_worktree('wt-1')];
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () async =>
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-2',
          );
      var fetches = 0;
      repository.snapshotBuilder = () {
        fetches += 1;
        // Connect plus three recovery reads exercises the missed-event path.
        if (fetches == 4) worktrees.add(_worktree('wt-2'));
        return RemoteSessionSnapshot(
          workspaces: const [_workspace],
          worktrees: List.of(worktrees),
          standaloneChats: const [],
        );
      };
      final engine = connectedVm(
        repository,
        createTimeout: const Duration(minutes: 1),
      );
      await engine.session.connect('123456');

      final created = await engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
      );

      expect(created.localId, 'wt-2');
      expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      // Each empty round must serialize a fresh re-projection behind the
      // still-running create, not just re-read the same stale snapshot.
      expect(repository.requestOverviewStateCalls, greaterThan(1));
    });

    test(
      'resolves by the echoed id when other new worktrees appear alongside',
      () async {
        // Another client's create landing in the same refresh must not make
        // this one unidentifiable when the desktop already echoed our id.
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async {
          worktrees.addAll([_worktree('wt-other'), _worktree('wt-mine')]);
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-mine',
          );
        };
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );

        expect(created.localId, 'wt-mine');
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      },
    );

    test(
      'exposes the creating workspace while a create is unresolved',
      () async {
        final repository = repositoryWith([_worktree('wt-1')]);
        final gate = Completer<RemoteWorktreeCreateResult>();
        repository.createWorktreeHandler = () => gate.future;
        final engine = connectedVm(repository);
        await engine.session.connect('123456');
        expect(engine.worktreeCreates.creatingWorktreeWorkspaceId, isNull);

        final create = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await Future<void>.delayed(Duration.zero);
        expect(engine.worktreeCreates.creatingWorktreeWorkspaceId, 'ws-app');

        gate.complete(const RemoteWorktreeCreateResult(commandId: 'cmd-1'));
        await expectLater(create, throwsA(isA<RemoteControlException>()));
        // The accepted-but-unresolved create still marks its workspace so the
        // list keeps showing where the task will appear.
        expect(engine.worktreeCreates.creatingWorktreeWorkspaceId, 'ws-app');
      },
    );

    test(
      'reports still-running only for an unconfirmed pending create',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(repository);
        await engine.session.connect('123456');
        expect(engine.worktreeCreates.isWorktreeCreateStillRunning, isFalse);

        await expectLater(
          engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
          throwsA(isA<RemoteControlException>()),
        );
        expect(engine.worktreeCreates.isWorktreeCreateStillRunning, isTrue);

        worktrees.add(_worktree('wt-2'));
        _completeCreate(engine, 'wt-2');
        await engine.refresh();
        expect(engine.worktreeCreates.isWorktreeCreateStillRunning, isFalse);
      },
    );

    test('a stale snapshot cannot select another client worktree', () async {
      // Another client's row was absent from the cached list. The command's
      // id must still choose our worktree after both rows arrive.
      final repository = FakeRemoteControlRepository();
      var fetches = 0;
      repository.snapshotBuilder = () {
        fetches += 1;
        return RemoteSessionSnapshot(
          workspaces: const [_workspace],
          worktrees: [
            _worktree('wt-1'),
            // Appears from the second fetch on: present on the desktop, but
            // absent from the snapshot mobile connected with.
            if (fetches >= 2) _worktree('wt-desktop'),
            if (repository.createWorktreeCalls.isNotEmpty) _worktree('wt-mine'),
          ],
          standaloneChats: const [],
        );
      };
      repository.createWorktreeHandler = () async =>
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-mine',
          );
      final engine = connectedVm(
        repository,
        createTimeout: const Duration(minutes: 1),
      );
      await engine.session.connect('123456');

      final created = await engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
      );

      expect(
        repository.createWorktreeCalls.single.existingWorktreeIds,
        equals(['wt-1']),
      );
      expect(created.localId, 'wt-mine');
    });

    test(
      'ignores stale rows while recovering the authoritative command id',
      () async {
        // Timestamps and list differences cannot identify the create. Recover
        // its id from the command even when another row appears first.
        final repository = FakeRemoteControlRepository();
        final staleWorktree = RemoteWorktree(
          localId: 'wt-stale',
          workspaceLocalId: 'ws-app',
          branch: 'canopy/stale',
          createdAt: DateTime.now()
              .subtract(const Duration(days: 2))
              .toIso8601String(),
        );
        var fetches = 0;
        repository.snapshotBuilder = () {
          fetches += 1;
          return RemoteSessionSnapshot(
            workspaces: const [_workspace],
            worktrees: [
              _worktree('wt-1'),
              // A stale row appears before the command's own worktree.
              if (fetches >= 3) staleWorktree,
              if (fetches >= 4) _worktree('wt-mine'),
            ],
            standaloneChats: const [],
          );
        };
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        repository.commandStatusHandler = (id) async =>
            BrowserPortalCommandStatusResponse(
              commandId: id,
              status: BrowserPortalCommandStatus.completed,
              result: {'id': 'wt-mine'},
            );
        final engine = connectedVm(
          repository,
          createTimeout: const Duration(minutes: 1),
        );
        await engine.session.connect('123456');

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );

        expect(created.localId, 'wt-mine');
      },
    );

    test(
      'a command-completed event upgrades a pending create to id resolution',
      () async {
        // The desktop finishes after the server's wait window: the submit
        // returns no id, but the completion event streams in later carrying
        // the created worktree. Resolution must use that id — even when the
        // diff would be ambiguous because another new worktree appeared.
        final repository = FakeRemoteControlRepository();
        var fetches = 0;
        repository.snapshotBuilder = () {
          fetches += 1;
          return RemoteSessionSnapshot(
            workspaces: const [_workspace],
            worktrees: [
              _worktree('wt-1'),
              if (fetches >= 2) ...[
                _worktree('wt-other'),
                _worktree('wt-mine'),
              ],
            ],
            standaloneChats: const [],
          );
        };
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(
          repository,
          createTimeout: const Duration(minutes: 1),
        );
        await engine.session.connect('123456');

        final create = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await Future<void>.delayed(Duration.zero);
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandCompletedEvent(
                commandId: 'cmd-1',
                result: {'id': 'wt-mine'},
              ),
            ],
            nextCursor: 1,
          ),
        );

        final created = await create;

        expect(created.localId, 'wt-mine');
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      },
    );

    test(
      'recovers the id from command status when its event was missed',
      () async {
        final worktrees = [_worktree('wt-1')];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async {
          worktrees.add(_worktree('wt-2'));
          return const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        };
        repository.commandStatusHandler = (id) async =>
            BrowserPortalCommandStatusResponse(
              commandId: id,
              status: BrowserPortalCommandStatus.completed,
              result: {'id': 'wt-2'},
            );
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );

        expect(created.localId, 'wt-2');
      },
    );

    test('never identifies a no-id create from overview differences', () async {
      final worktrees = [_worktree('wt-1')];
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () async {
        worktrees.add(_worktree('wt-unrelated'));
        return const RemoteWorktreeCreateResult(commandId: 'cmd-1');
      };
      repository.requestOverviewStateHandler = () async {
        if (repository.requestOverviewStateCalls > 1) {
          repository.requestOverviewStateCompleted = false;
        }
      };
      final engine = connectedVm(repository);
      await engine.session.connect('123456');

      await expectLater(
        engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
        throwsA(
          isA<RemoteControlException>().having(
            (error) => error.message,
            'message',
            contains('still being created'),
          ),
        ),
      );

      expect(repository.requestOverviewStateCalls, 0);
      expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
    });

    test('refuses a second concurrent create', () async {
      final worktrees = <RemoteWorktree>[];
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () async {
        worktrees.add(_worktree('wt-1'));
        return const RemoteWorktreeCreateResult(
          commandId: 'cmd-1',
          worktreeLocalId: 'wt-1',
        );
      };
      final engine = connectedVm(repository);
      await engine.session.connect('123456');

      final first = engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
      );
      // A double-tap must not queue a second `git worktree add`.
      await expectLater(
        engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
        throwsA(isA<RemoteControlException>()),
      );
      await first;

      expect(repository.createWorktreeCalls, hasLength(1));
    });

    test(
      'an in-flight create cannot restore pending state into a new session',
      () async {
        final result = Completer<RemoteWorktreeCreateResult>();
        final repository = repositoryWith([_worktree('wt-1')]);
        repository.createWorktreeHandler = () => result.future;
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        final create = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await Future<void>.delayed(Duration.zero);
        expect(repository.createWorktreeCalls, hasLength(1));
        final expectation = expectLater(
          create,
          throwsA(
            isA<RemoteControlException>().having(
              (error) => error.message,
              'message',
              contains('session changed'),
            ),
          ),
        );

        await engine.session.disconnect();
        await engine.session.connect('654321');
        result.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-old-session',
            worktreeLocalId: 'wt-old-session',
          ),
        );

        await expectation;
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
        expect(engine.worktreeCreates.creatingWorktreeWorkspaceId, isNull);
      },
    );

    test('an old create cannot clear a newer session creation guard', () async {
      final worktrees = [_worktree('wt-1')];
      final firstResult = Completer<RemoteWorktreeCreateResult>();
      final secondResult = Completer<RemoteWorktreeCreateResult>();
      final repository = repositoryWith(worktrees);
      repository.createWorktreeHandler = () =>
          repository.createWorktreeCalls.length == 1
          ? firstResult.future
          : secondResult.future;
      final engine = connectedVm(repository);
      await engine.session.connect('123456');

      final firstCreate = engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
      );
      await Future<void>.delayed(Duration.zero);
      expect(repository.createWorktreeCalls, hasLength(1));
      final firstExpectation = expectLater(
        firstCreate,
        throwsA(
          isA<RemoteControlException>().having(
            (error) => error.message,
            'message',
            contains('session changed'),
          ),
        ),
      );

      await engine.session.disconnect();
      await engine.session.connect('654321');
      final secondCreate = engine.worktreeCreates.createWorktree(
        workspaceLocalId: 'ws-app',
      );
      await Future<void>.delayed(Duration.zero);
      expect(repository.createWorktreeCalls, hasLength(2));

      firstResult.complete(
        const RemoteWorktreeCreateResult(
          commandId: 'cmd-old-session',
          worktreeLocalId: 'wt-old-session',
        ),
      );
      await firstExpectation;

      // The discarded pairing's command never joins the current pairing's
      // command state, so its terminal event stays foreign.
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              commandId: 'cmd-old-session',
              message: 'The old create failed.',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pumpEventQueue();
      expect(engine.commands.hasFailed('cmd-old-session'), isFalse);
      expect(engine.commands.failureMessage, isNull);

      expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
      expect(engine.worktreeCreates.creatingWorktreeWorkspaceId, 'ws-app');
      await expectLater(
        engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
        throwsA(isA<RemoteControlException>()),
      );
      expect(repository.createWorktreeCalls, hasLength(2));

      worktrees.add(_worktree('wt-new-session'));
      secondResult.complete(
        const RemoteWorktreeCreateResult(
          commandId: 'cmd-new-session',
          worktreeLocalId: 'wt-new-session',
        ),
      );
      expect((await secondCreate).localId, 'wt-new-session');
    });

    test('rejects a create while disconnected', () async {
      final engine = connectedVm(repositoryWith([]));

      await expectLater(
        engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
        throwsA(isA<RemoteControlException>()),
      );
    });

    for (final outcome in [
      (
        name: 'failed',
        status: BrowserPortalCommandStatus.failed,
        delivered: null,
        terminal: true,
      ),
      (
        name: 'expired before delivery',
        status: BrowserPortalCommandStatus.expired,
        delivered: false,
        terminal: true,
      ),
      (
        name: 'expired after delivery',
        status: BrowserPortalCommandStatus.expired,
        delivered: true,
        terminal: false,
      ),
      (
        name: 'expired with unknown delivery',
        status: BrowserPortalCommandStatus.expired,
        delivered: null,
        terminal: false,
      ),
      (
        name: 'completed without an id',
        status: BrowserPortalCommandStatus.completed,
        delivered: null,
        terminal: false,
      ),
    ]) {
      test(
        'command status ${outcome.name} preserves safe retry behavior',
        () async {
          final repository = repositoryWith([_worktree('wt-unrelated')]);
          repository.createWorktreeHandler = () async =>
              const RemoteWorktreeCreateResult(commandId: 'cmd-create');
          repository.commandStatusHandler = (id) async =>
              BrowserPortalCommandStatusResponse(
                commandId: id,
                status: outcome.status,
                delivered: outcome.delivered,
                error: 'Desktop rejected the create.',
              );
          final engine = connectedVm(repository);
          addTearDown(engine.dispose);
          await engine.session.connect('123456');
          await expectLater(
            engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
            throwsA(isA<RemoteControlException>()),
          );
          expect(engine.worktreeCreates.isCreatingWorktree, !outcome.terminal);
          expect(repository.commandStatusReads, ['cmd-create']);
          expect(repository.requestOverviewStateCalls, 0);
          expect(await engine.refresh(), isTrue);
          expect(engine.worktreeCreates.isCreatingWorktree, !outcome.terminal);
          expect(
            repository.commandStatusReads,
            hasLength(outcome.terminal ? 1 : 2),
          );
          expect(repository.createWorktreeCalls, hasLength(1));
        },
      );
    }

    test(
      'a mismatched command-status identity cannot claim a visible worktree',
      () async {
        final repository = repositoryWith([_worktree('wt-unrelated')]);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-create');
        repository.commandStatusHandler = (_) async =>
            const BrowserPortalCommandStatusResponse(
              commandId: 'another-command',
              status: BrowserPortalCommandStatus.completed,
              result: {'id': 'wt-unrelated'},
            );
        final engine = connectedVm(repository);
        addTearDown(engine.dispose);
        await engine.session.connect('123456');
        await expectLater(
          engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
          throwsA(isA<RemoteControlException>()),
        );
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
        expect(repository.requestOverviewStateCalls, 0);
        expect(await engine.refresh(), isTrue);
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
        expect(repository.createWorktreeCalls, hasLength(1));
      },
    );

    test('a failed command-status read never permits resubmission', () async {
      final repository = repositoryWith([_worktree('wt-unrelated')]);
      repository.createWorktreeHandler = () async =>
          const RemoteWorktreeCreateResult(commandId: 'cmd-create');
      repository.commandStatusHandler = (_) async =>
          throw const RemoteControlException('Offline');
      final engine = connectedVm(repository);
      addTearDown(engine.dispose);
      await engine.session.connect('123456');
      final attempt = RemoteWorktreeCreateAttempt();
      for (var retry = 0; retry < 2; retry++) {
        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(isA<RemoteControlException>()),
        );
      }
      expect(repository.createWorktreeCalls, hasLength(1));
      expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
      expect(await engine.refresh(), isTrue);
      expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
      expect(repository.createWorktreeCalls, hasLength(1));
    });

    test(
      'concurrent refreshes share the pending command-status read',
      () async {
        final worktrees = <RemoteWorktree>[];
        final repository = repositoryWith(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-create');
        final engine = connectedVm(repository);
        addTearDown(engine.dispose);
        await engine.session.connect('123456');
        await expectLater(
          engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
          throwsA(isA<RemoteControlException>()),
        );
        final status = Completer<BrowserPortalCommandStatusResponse>();
        repository.commandStatusHandler = (_) => status.future;
        final first = engine.refresh();
        await pumpEventQueue();
        worktrees.add(_worktree('wt-created'));
        expect(await engine.refresh(), isTrue);
        expect(repository.commandStatusReads, ['cmd-create', 'cmd-create']);
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
        status.complete(
          const BrowserPortalCommandStatusResponse(
            commandId: 'cmd-create',
            status: BrowserPortalCommandStatus.completed,
            result: {'id': 'wt-created'},
          ),
        );
        expect(await first, isTrue);
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
        expect(repository.createWorktreeCalls, hasLength(1));
      },
    );

    for (final status in [
      BrowserPortalCommandStatus.completed,
      BrowserPortalCommandStatus.failed,
    ]) {
      test(
        'a late refresh status $status cannot settle a new pairing',
        () async {
          final repository = repositoryWith([_worktree('wt-unrelated')]);
          repository.connectedSessionId = 'old-session';
          repository.createWorktreeHandler = () async =>
              const RemoteWorktreeCreateResult(commandId: 'cmd-old');
          final engine = connectedVm(repository);
          addTearDown(engine.dispose);
          await engine.session.connect('123456');
          await expectLater(
            engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
            throwsA(isA<RemoteControlException>()),
          );
          final response = Completer<BrowserPortalCommandStatusResponse>();
          repository.commandStatusHandler = (_) => response.future;
          final refresh = engine.refresh();
          await pumpEventQueue();
          await engine.session.disconnect();
          repository.connectedSessionId = 'new-session';
          await engine.session.connect('654321');
          repository.createWorktreeHandler = () async =>
              const RemoteWorktreeCreateResult(commandId: 'cmd-new');
          repository.commandStatusHandler = (id) async =>
              BrowserPortalCommandStatusResponse(
                commandId: id,
                status: BrowserPortalCommandStatus.delivered,
              );
          await expectLater(
            engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
            throwsA(isA<RemoteControlException>()),
          );
          response.complete(
            BrowserPortalCommandStatusResponse(
              commandId: 'cmd-old',
              status: status,
              result: const {'id': 'wt-unrelated'},
              error: 'Old create failed.',
            ),
          );
          expect(await refresh, isFalse);
          expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
          await expectLater(
            engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-app'),
            throwsA(isA<RemoteControlException>()),
          );
          expect(repository.createWorktreeCalls, hasLength(2));
        },
      );
    }

    group('CAN-3643 same-pairing metadata refresh', () {
      /// A pairing whose heartbeat and capability reads return a new
      /// metadata object for the same server session, as the production
      /// repository does on every foreground and degraded-status read.
      _GatedNextSnapshotRepository pairedRepository(
        List<RemoteWorktree> worktrees,
      ) {
        var heartbeat = 0;
        return _GatedNextSnapshotRepository()
          ..connectedSessionId = 'session-1'
          ..snapshotBuilder = (() => RemoteSessionSnapshot(
            workspaces: const [_workspace],
            worktrees: List.of(worktrees),
            standaloneChats: const [],
          ))
          ..sessionMetadataBuilder = () => RemoteConnection(
            deviceLabel: 'Test Desktop',
            pairedAt: DateTime(2026),
            sessionId: 'session-1',
            lastSeenAt: DateTime.utc(2026, 10, 5, 12, 0, ++heartbeat),
          );
      }

      Future<void> refreshMetadata(RemoteClientEngine engine) async {
        final before = engine.session.connection;
        final generation = engine.session.sessionGeneration;
        await engine.session.refreshConnectionMetadata();
        expect(engine.session.connection, isNot(same(before)));
        expect(engine.session.connection?.sessionId, 'session-1');
        expect(engine.session.sessionGeneration, generation);
      }

      final throwsSessionChanged = throwsA(
        isA<RemoteControlException>().having(
          (error) => error.message,
          'message',
          contains('session changed'),
        ),
      );

      void completeCreateCommand(
        FakeRemoteControlRepository repository,
        String worktreeLocalId,
      ) => repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteCommandCompletedEvent(
              commandId: 'cmd-1',
              result: {'id': worktreeLocalId},
            ),
          ],
          nextCursor: 1,
        ),
      );

      void failCreateCommand(FakeRemoteControlRepository repository) =>
          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteCommandFailedEvent(
                  commandId: 'cmd-1',
                  message: 'The old create failed.',
                ),
              ],
              nextCursor: 1,
            ),
          );

      test('refreshes during submission still resolve the create', () async {
        final worktrees = [_worktree('wt-1')];
        final repository = pairedRepository(worktrees);
        final result = Completer<RemoteWorktreeCreateResult>();
        repository.createWorktreeHandler = () => result.future;
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        final create = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await pumpEventQueue();
        expect(repository.createWorktreeCalls, hasLength(1));

        await refreshMetadata(engine);
        await refreshMetadata(engine);
        worktrees.add(_worktree('wt-2'));
        result.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-2',
          ),
        );

        expect((await create).localId, 'wt-2');
        expect(repository.createWorktreeCalls, hasLength(1));
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      });

      test('a refresh during reconciliation keeps the git-pending create '
          'until setup settles', () async {
        final worktrees = [_worktree('wt-1')];
        final repository = pairedRepository(worktrees);
        repository.createWorktreeHandler = () async {
          worktrees.add(_settingUp('wt-2'));
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-2',
          );
        };
        final engine = connectedVm(
          repository,
          createTimeout: const Duration(minutes: 1),
        );
        await engine.session.connect('123456');
        var reconcileRounds = 0;
        repository.requestOverviewStateHandler = () async {
          if (repository.createWorktreeCalls.isEmpty) return;
          reconcileRounds += 1;
          if (reconcileRounds == 1) {
            // Git setup is still running when the heartbeat read lands.
            await refreshMetadata(engine);
          } else {
            worktrees[1] = _worktree('wt-2');
          }
        };

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );

        expect(created.localId, 'wt-2');
        expect(created.setupPhase, isNot(RemoteWorktreeSetupPhase.gitPending));
        expect(reconcileRounds, 2);
        expect(repository.createWorktreeCalls, hasLength(1));
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      });

      test('Retry of an accepted create reconciles a late completion without '
          'submitting again', () async {
        final worktrees = [_worktree('wt-1')];
        final repository = pairedRepository(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(repository);
        final attempt = RemoteWorktreeCreateAttempt();
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(
            isA<RemoteControlException>().having(
              (error) => error.message,
              'message',
              contains('still being created'),
            ),
          ),
        );
        await refreshMetadata(engine);
        worktrees.add(_worktree('wt-2'));
        completeCreateCommand(repository, 'wt-2');
        await pumpEventQueue();

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
          attempt: attempt,
        );

        expect(created.localId, 'wt-2');
        expect(repository.createWorktreeCalls, hasLength(1));
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      });

      test('a pull-refresh result survives refreshes until Retry claims '
          'it', () async {
        final worktrees = [_worktree('wt-1')];
        final repository = pairedRepository(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(repository);
        final attempt = RemoteWorktreeCreateAttempt();
        await engine.session.connect('123456');

        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(isA<RemoteControlException>()),
        );
        await refreshMetadata(engine);
        worktrees.add(_worktree('wt-2'));
        _completeCreate(engine, 'wt-2');
        expect(await engine.refresh(), isTrue);
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
        await refreshMetadata(engine);

        final created = await engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
          attempt: attempt,
        );

        expect(created.localId, 'wt-2');
        expect(repository.createWorktreeCalls, hasLength(1));
      });

      test('a new pairing rejects a refresh-cached result before Retry '
          'claims it', () async {
        final worktrees = [_worktree('wt-1')];
        final repository = pairedRepository(worktrees);
        repository.createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
        final engine = connectedVm(repository);
        final attempt = RemoteWorktreeCreateAttempt();
        await engine.session.connect('123456');
        final generation = engine.session.sessionGeneration;

        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsA(isA<RemoteControlException>()),
        );
        worktrees.add(_worktree('wt-2'));
        _completeCreate(engine, 'wt-2');
        expect(await engine.refresh(), isTrue);
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);

        // A direct pairing replaces the old one without a disconnect.
        await engine.session.connect('654321');
        expect(engine.session.sessionGeneration, greaterThan(generation));

        await expectLater(
          engine.worktreeCreates.createWorktree(
            workspaceLocalId: 'ws-app',
            attempt: attempt,
          ),
          throwsSessionChanged,
        );
        expect(repository.createWorktreeCalls, hasLength(1));
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      });

      test('a new pairing that reuses the session id rejects an old '
          'create', () async {
        final worktrees = [_worktree('wt-1')];
        final repository = pairedRepository(worktrees);
        final result = Completer<RemoteWorktreeCreateResult>();
        repository.createWorktreeHandler = () => result.future;
        final engine = connectedVm(repository);
        await engine.session.connect('123456');
        final generation = engine.session.sessionGeneration;

        final create = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await pumpEventQueue();
        final expectation = expectLater(create, throwsSessionChanged);

        await engine.session.connect('654321');
        expect(engine.session.connection?.sessionId, 'session-1');
        expect(engine.session.sessionGeneration, greaterThan(generation));
        worktrees.add(_worktree('wt-old'));
        result.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-old',
          ),
        );

        await expectation;
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
        failCreateCommand(repository);
        await pumpEventQueue();
        expect(engine.commands.hasFailed('cmd-1'), isFalse);
        expect(engine.commands.failureMessage, isNull);
      });

      test('an old create cannot resolve while disconnect is in '
          'flight', () async {
        final worktrees = [_worktree('wt-1')];
        final repository = pairedRepository(worktrees);
        final result = Completer<RemoteWorktreeCreateResult>();
        repository.createWorktreeHandler = () => result.future;
        final engine = connectedVm(repository);
        await engine.session.connect('123456');

        final create = engine.worktreeCreates.createWorktree(
          workspaceLocalId: 'ws-app',
        );
        await pumpEventQueue();
        final expectation = expectLater(create, throwsSessionChanged);

        final teardown = Completer<void>();
        repository.gateDisconnect = teardown;
        final disconnect = engine.session.disconnect();
        worktrees.add(_worktree('wt-old'));
        result.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-1',
            worktreeLocalId: 'wt-old',
          ),
        );
        await expectation;

        teardown.complete();
        await disconnect;
        expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      });

      test('seeded pairing and creation interleavings (seed 3643)', () async {
        final random = math.Random(3643);
        const stages = ['submit', 'reconcile'];
        const samePairing = [
          'metadata refresh',
          'background/resume',
          'pull refresh',
          'snapshot refresh',
        ];
        const newPairings = [
          'disconnect + pair',
          'direct pair',
          'session end + pair',
        ];
        for (var run = 0; run < 48; run += 1) {
          final stage = stages[random.nextInt(stages.length)];
          final events = [
            for (var i = 0, count = 1 + random.nextInt(3); i < count; i += 1)
              samePairing[random.nextInt(samePairing.length)],
          ];
          if (random.nextInt(3) == 0) {
            events.insert(
              random.nextInt(events.length + 1),
              newPairings[random.nextInt(newPairings.length)],
            );
          }
          final sequence = 'run $run, $stage: ${events.join(' -> ')}';

          final worktrees = [_worktree('wt-1')];
          final repository = pairedRepository(worktrees);
          final oldResult = Completer<RemoteWorktreeCreateResult>();
          var repaired = false;
          repository.createWorktreeHandler = () async {
            if (!repaired) return oldResult.future;
            worktrees.add(_worktree('wt-new'));
            return const RemoteWorktreeCreateResult(
              commandId: 'cmd-new',
              worktreeLocalId: 'wt-new',
            );
          };
          final engine = connectedVm(
            repository,
            createTimeout: const Duration(minutes: 1),
          );
          await engine.session.connect('123456');
          final generation = engine.session.sessionGeneration;

          Future<void> runEvents() async {
            for (final event in events) {
              switch (event) {
                case 'metadata refresh':
                  await engine.session.refreshConnectionMetadata();
                case 'background/resume':
                  engine.session.onAppBackgrounded();
                  await engine.session.onAppForegrounded();
                case 'pull refresh':
                  await engine.refresh();
                case 'snapshot refresh':
                  await engine.session.refreshSnapshot();
                case 'disconnect + pair':
                  await engine.session.disconnect();
                  repaired = true;
                  await engine.session.connect('654321');
                case 'direct pair':
                  repaired = true;
                  await engine.session.connect('654321');
                case 'session end + pair':
                  engine.session.handleRemoteSessionEnded();
                  repaired = true;
                  await engine.session.connect('654321');
              }
              expect(engine.session.isConnected, isTrue, reason: sequence);
              expect(
                engine.session.connection?.sessionId,
                'session-1',
                reason: sequence,
              );
              expect(
                engine.session.sessionGeneration,
                repaired ? greaterThan(generation) : generation,
                reason: '$sequence; after $event',
              );
              expect(
                repository.createWorktreeCalls.length,
                lessThanOrEqualTo(1),
                reason: '$sequence; after $event',
              );
            }
          }

          var reconcileRounds = 0;
          Future<void>? reconciliationEvents;
          repository.requestOverviewStateHandler = () async {
            if (repaired || !oldResult.isCompleted) return;
            reconcileRounds += 1;
            if (reconcileRounds == 1) {
              if (stage == 'reconcile') {
                await (reconciliationEvents = runEvents());
              }
            } else if (!repaired) {
              worktrees[1] = _worktree('wt-2');
            }
          };

          final create = engine.worktreeCreates
              .createWorktree(workspaceLocalId: 'ws-app')
              .then<Object>((created) => created, onError: (Object e) => e);
          await pumpEventQueue();
          if (stage == 'submit') {
            await runEvents();
          }
          {
            expect(
              repository.createWorktreeCalls,
              hasLength(1),
              reason: sequence,
            );
            // The desktop reserves the worktree; its git setup is running.
            worktrees.add(_settingUp('wt-2'));
            oldResult.complete(
              const RemoteWorktreeCreateResult(
                commandId: 'cmd-1',
                worktreeLocalId: 'wt-2',
              ),
            );
          }
          final outcome = await create;
          // A pairing reset now rejects the waiter immediately, even while
          // the recovery request's test-driven reconnect is still finishing.
          await reconciliationEvents;

          if (!repaired) {
            expect(
              outcome,
              isA<RemoteWorktree>()
                  .having((w) => w.localId, 'localId', 'wt-2')
                  .having(
                    (w) => w.setupPhase,
                    'setupPhase',
                    isNot(RemoteWorktreeSetupPhase.gitPending),
                  ),
              reason: sequence,
            );
            expect(reconcileRounds, greaterThanOrEqualTo(2), reason: sequence);
            expect(
              repository.createWorktreeCalls,
              hasLength(1),
              reason: sequence,
            );
            expect(
              engine.worktreeCreates.isCreatingWorktree,
              isFalse,
              reason: sequence,
            );
          } else {
            expect(outcome, isA<RemoteControlException>(), reason: sequence);
            expect(
              engine.worktreeCreates.isCreatingWorktree,
              isFalse,
              reason: sequence,
            );
            if (stage == 'submit') {
              // The old response arrived after the new pairing, so its
              // command never joins the current command state.
              failCreateCommand(repository);
              await pumpEventQueue();
              expect(engine.commands.failureMessage, isNull, reason: sequence);
            }
            // The old result never binds to the next pairing's create.
            final calls = repository.createWorktreeCalls.length;
            final next = await engine.worktreeCreates.createWorktree(
              workspaceLocalId: 'ws-app',
            );
            expect(next.localId, 'wt-new', reason: sequence);
            expect(
              repository.createWorktreeCalls,
              hasLength(calls + 1),
              reason: sequence,
            );
          }
          engine.dispose();
        }
      });

      test('seeded accepted Retry interleavings (seed 3643)', () async {
        final random = math.Random(3643);
        const steps = [
          'metadata refresh',
          'background/resume',
          'pull refresh',
          'command completion',
          'worktree visible',
          'retry',
        ];
        for (var run = 0; run < 32; run += 1) {
          final events = [
            for (var i = 0, count = 2 + random.nextInt(4); i < count; i += 1)
              steps[random.nextInt(steps.length)],
            'worktree visible',
            'command completion',
            'retry',
          ];
          final sequence = 'run $run: ${events.join(' -> ')}';
          final worktrees = [_worktree('wt-1')];
          final repository = pairedRepository(worktrees);
          repository.createWorktreeHandler = () async =>
              const RemoteWorktreeCreateResult(commandId: 'cmd-1');
          final engine = connectedVm(repository);
          final attempt = RemoteWorktreeCreateAttempt();
          await engine.session.connect('123456');
          final generation = engine.session.sessionGeneration;
          await expectLater(
            engine.worktreeCreates.createWorktree(
              workspaceLocalId: 'ws-app',
              attempt: attempt,
            ),
            throwsA(isA<RemoteControlException>()),
            reason: sequence,
          );

          RemoteWorktree? created;
          for (final event in events) {
            if (created != null) break;
            switch (event) {
              case 'metadata refresh':
                await engine.session.refreshConnectionMetadata();
              case 'background/resume':
                engine.session.onAppBackgrounded();
                await engine.session.onAppForegrounded();
              case 'pull refresh':
                await engine.refresh();
              case 'command completion':
                completeCreateCommand(repository, 'wt-2');
                await pumpEventQueue();
              case 'worktree visible':
                if (worktrees.length == 1) worktrees.add(_worktree('wt-2'));
              case 'retry':
                try {
                  created = await engine.worktreeCreates.createWorktree(
                    workspaceLocalId: 'ws-app',
                    attempt: attempt,
                  );
                } on RemoteControlException catch (error) {
                  // Only "still running" may defer the result; anything else
                  // drops the attempt and invites a duplicate create.
                  expect(
                    error.message,
                    contains('still being created'),
                    reason: '$sequence; after $event',
                  );
                }
            }
            expect(
              repository.createWorktreeCalls,
              hasLength(1),
              reason: '$sequence; after $event',
            );
            expect(
              engine.session.sessionGeneration,
              generation,
              reason: sequence,
            );
          }

          expect(created?.localId, 'wt-2', reason: sequence);
          expect(
            engine.worktreeCreates.isCreatingWorktree,
            isFalse,
            reason: sequence,
          );
          engine.dispose();
        }
      });

      test('seeded accepted Retry across new pairings (seed 3643)', () async {
        final random = math.Random(3643);
        const steps = [
          'metadata refresh',
          'pull refresh',
          'command completion',
          'worktree visible',
          'retry',
        ];
        const newPairings = ['disconnect + pair', 'direct pair'];
        for (var run = 0; run < 32; run += 1) {
          final events = [
            for (var i = 0, count = 1 + random.nextInt(4); i < count; i += 1)
              steps[random.nextInt(steps.length)],
          ];
          events.insert(
            random.nextInt(events.length + 1),
            newPairings[random.nextInt(newPairings.length)],
          );
          events.addAll(['retry', 'retry']);
          final sequence = 'run $run: ${events.join(' -> ')}';
          final worktrees = [_worktree('wt-1')];
          final repository = pairedRepository(worktrees);
          repository.createWorktreeHandler = () async {
            if (repository.createWorktreeCalls.length == 1) {
              return const RemoteWorktreeCreateResult(commandId: 'cmd-1');
            }
            worktrees.add(_worktree('wt-new'));
            return const RemoteWorktreeCreateResult(
              commandId: 'cmd-new',
              worktreeLocalId: 'wt-new',
            );
          };
          final engine = connectedVm(repository);
          final attempt = RemoteWorktreeCreateAttempt();
          await engine.session.connect('123456');
          await expectLater(
            engine.worktreeCreates.createWorktree(
              workspaceLocalId: 'ws-app',
              attempt: attempt,
            ),
            throwsA(isA<RemoteControlException>()),
            reason: sequence,
          );

          var repaired = false;
          var sessionChangedErrors = 0;
          RemoteWorktree? created;
          for (final event in events) {
            if (created != null) break;
            switch (event) {
              case 'metadata refresh':
                await engine.session.refreshConnectionMetadata();
              case 'pull refresh':
                await engine.refresh();
              case 'command completion':
                completeCreateCommand(repository, 'wt-2');
                await pumpEventQueue();
              case 'worktree visible':
                if (!worktrees.any((w) => w.localId == 'wt-2')) {
                  worktrees.add(_worktree('wt-2'));
                }
              case 'disconnect + pair':
                await engine.session.disconnect();
                repaired = true;
                await engine.session.connect('654321');
              case 'direct pair':
                repaired = true;
                await engine.session.connect('654321');
              case 'retry':
                try {
                  created = await engine.worktreeCreates.createWorktree(
                    workspaceLocalId: 'ws-app',
                    attempt: attempt,
                  );
                } on RemoteControlException catch (error) {
                  if (repaired) {
                    sessionChangedErrors += 1;
                    expect(
                      error.message,
                      contains('session changed'),
                      reason: '$sequence; after $event',
                    );
                  } else {
                    expect(
                      error.message,
                      contains('still being created'),
                      reason: '$sequence; after $event',
                    );
                  }
                }
                // The old pairing's result never binds after a new pairing,
                // and only a fresh create on the new pairing can resolve.
                if (created != null) {
                  expect(
                    created.localId,
                    repaired ? 'wt-new' : 'wt-2',
                    reason: '$sequence; after $event',
                  );
                }
            }
            expect(
              repository.createWorktreeCalls.length,
              lessThanOrEqualTo(repaired ? 2 : 1),
              reason: '$sequence; after $event',
            );
          }

          expect(created, isNotNull, reason: sequence);
          expect(sessionChangedErrors, lessThanOrEqualTo(1), reason: sequence);
          expect(
            engine.worktreeCreates.isCreatingWorktree,
            isFalse,
            reason: sequence,
          );
          engine.dispose();
        }
      });
    });
  });

  // CAN-4875: an accepted create settles from its completion event and the
  // worktree's delta. Projection rounds are a slow fallback for overdue
  // events, and they stop in the background.
  group('CAN-4875 event-driven reconciliation', () {
    final start = DateTime.utc(2026, 10, 25, 12);

    /// An engine with the production fallback cadence, its fake clock driven
    /// by [async].
    ({RemoteClientEngine engine, FakeRemoteControlRepository repository})
    connect(FakeAsync async, List<RemoteWorktree> worktrees) {
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = (() => RemoteSessionSnapshot(
          workspaces: const [_workspace],
          worktrees: List.of(worktrees),
          standaloneChats: const [],
        ))
        ..createWorktreeHandler = () async =>
            const RemoteWorktreeCreateResult(commandId: 'cmd-1');
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        clock: () => start.add(async.elapsed),
      );
      unawaited(engine.session.connect('123456'));
      async.flushMicrotasks();
      return (engine: engine, repository: repository);
    }

    var cursor = 10;
    void deliver(
      FakeRemoteControlRepository repository,
      List<RemotePortalEvent> events,
    ) {
      cursor += 1;
      repository.eventsController.add(
        RemotePortalEventBatch(events: events, nextCursor: cursor),
      );
    }

    RemoteStateDeltaEvent worktreeDelta(RemoteWorktree worktree) =>
        RemoteStateDeltaEvent(
          cursor: ++cursor,
          scope: 'worktree',
          worktrees: [worktree],
        );

    const completed = RemoteCommandCompletedEvent(
      commandId: 'cmd-1',
      result: {'id': 'wt-2'},
    );

    for (final completionFirst in [false, true]) {
      test('a timely completion and delta settle without a projection round '
          '(completion first: $completionFirst)', () {
        fakeAsync((async) {
          final worktrees = [_worktree('wt-1')];
          final (:engine, :repository) = connect(async, worktrees);
          final requests = repository.requestOverviewStateCalls;
          final reads = repository.snapshotFetches;
          RemoteWorktree? created;
          unawaited(
            engine.worktreeCreates
                .createWorktree(workspaceLocalId: 'ws-app')
                .then((worktree) => created = worktree),
          );
          async.flushMicrotasks();
          expect(repository.createWorktreeCalls, hasLength(1));
          // The create submits without a baseline projection or read.
          expect(repository.requestOverviewStateCalls, requests);
          expect(repository.snapshotFetches, reads);

          async.elapse(const Duration(seconds: 2));
          worktrees.add(_worktree('wt-2'));
          deliver(
            repository,
            completionFirst
                ? [completed, worktreeDelta(_worktree('wt-2'))]
                : [worktreeDelta(_worktree('wt-2')), completed],
          );
          async.flushMicrotasks();
          expect(created?.localId, 'wt-2');
          expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
          async.elapse(const Duration(minutes: 3));
          expect(repository.requestOverviewStateCalls, requests);
          expect(repository.snapshotFetches, reads);
          expect(repository.commandStatusReads, isEmpty);
          expect(repository.createWorktreeCalls, hasLength(1));
          engine.dispose();
        });
      });
    }

    test('a completion alone waits for the ready worktree', () {
      fakeAsync((async) {
        final worktrees = [_worktree('wt-1')];
        final (:engine, :repository) = connect(async, worktrees);
        final requests = repository.requestOverviewStateCalls;
        RemoteWorktree? created;
        unawaited(
          engine.worktreeCreates
              .createWorktree(workspaceLocalId: 'ws-app')
              .then((worktree) => created = worktree),
        );
        async.flushMicrotasks();
        const pending = RemoteWorktree(
          localId: 'wt-2',
          workspaceLocalId: 'ws-app',
          branch: 'feat/wt-2',
          setupPhase: RemoteWorktreeSetupPhase.gitPending,
        );
        const ready = RemoteWorktree(
          localId: 'wt-2',
          workspaceLocalId: 'ws-app',
          branch: 'feat/wt-2',
          setupPhase: RemoteWorktreeSetupPhase.idle,
        );
        worktrees.add(pending);
        deliver(repository, [completed, worktreeDelta(pending)]);
        async.elapse(const Duration(seconds: 10));
        // The id and a git-pending reservation do not prove the setup.
        expect(created, isNull);
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);
        worktrees[1] = ready;
        deliver(repository, [worktreeDelta(ready)]);
        async.flushMicrotasks();
        expect(created?.localId, 'wt-2');
        expect(repository.requestOverviewStateCalls, requests);
        expect(repository.commandStatusReads, isEmpty);
        engine.dispose();
      });
    });

    test('an overdue completion falls back to slow recovery rounds', () {
      fakeAsync((async) {
        final worktrees = [_worktree('wt-1')];
        final (:engine, :repository) = connect(async, worktrees);
        final requests = repository.requestOverviewStateCalls;
        RemoteWorktree? created;
        unawaited(
          engine.worktreeCreates
              .createWorktree(workspaceLocalId: 'ws-app')
              .then((worktree) => created = worktree),
        );
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 29));
        expect(repository.commandStatusReads, isEmpty);
        async.elapse(const Duration(seconds: 1));
        // Without the worktree id, a round reads command status only.
        expect(repository.commandStatusReads, ['cmd-1']);
        expect(repository.requestOverviewStateCalls, requests);
        async.elapse(const Duration(seconds: 29));
        expect(repository.commandStatusReads, ['cmd-1']);
        // The desktop finished; the next round's status read reports the id
        // and its projection shows the worktree.
        worktrees.add(_worktree('wt-2'));
        repository.commandStatusHandler = (id) async =>
            BrowserPortalCommandStatusResponse(
              commandId: id,
              status: BrowserPortalCommandStatus.completed,
              result: {'id': 'wt-2'},
            );
        async.elapse(const Duration(seconds: 1));
        expect(repository.commandStatusReads, ['cmd-1', 'cmd-1']);
        expect(repository.requestOverviewStateCalls, requests + 1);
        expect(created?.localId, 'wt-2');
        expect(repository.createWorktreeCalls, hasLength(1));
        engine.dispose();
      });
    });

    // Each seed interleaves the completion (sometimes twice), the
    // reservation and ready deltas, unrelated deltas, time and background
    // returns; with held requests, a fallback round's projection request
    // also holds and releases in any lifecycle state. After every step: one submit, a
    // result only once the worktree is ready, no projection or read while
    // backgrounded, no failure within two foreground minutes, and fallback
    // projections no more often than every 30 foreground seconds plus one
    // per return.
    for (final holdRequests in [false, true]) {
      test('seeded event orders and lifecycles keep the create consistent'
          '${holdRequests ? ' with held requests' : ''}', () {
        for (var seed = 0; seed < 40; seed++) {
          fakeAsync((async) {
            final random = math.Random(seed);
            final worktrees = [_worktree('wt-1')];
            final (:engine, :repository) = connect(async, worktrees);
            final baseline = repository.requestOverviewStateCalls;
            RemoteWorktree? created;
            Object? failure;
            unawaited(() async {
              try {
                created = await engine.worktreeCreates.createWorktree(
                  workspaceLocalId: 'ws-app',
                );
              } on Object catch (error) {
                failure = error;
              }
            }());
            async.flushMicrotasks();
            var completedCount = 0;
            var reserved = false;
            var ready = false;
            var backgrounded = false;
            var returns = 0;
            var foreground = Duration.zero;
            final log = <String>[];
            Completer<void>? held;
            var readsAtBackground = 0;
            var statusReadsAtBackground = 0;

            void check() {
              final reason = 'seed $seed after ${log.join(', ')}';
              expect(
                repository.createWorktreeCalls,
                hasLength(1),
                reason: reason,
              );
              if (created != null) {
                expect(created!.localId, 'wt-2', reason: reason);
                expect(ready, isTrue, reason: reason);
                expect(
                  engine.worktreeCreates.isCreatingWorktree,
                  isFalse,
                  reason: reason,
                );
              }
              if (foreground < kRemoteWorktreeCreateTimeout) {
                expect(failure, isNull, reason: reason);
              }
              if (backgrounded) {
                expect(
                  repository.snapshotFetches,
                  readsAtBackground,
                  reason: '$reason: read in the background',
                );
                expect(
                  repository.commandStatusReads,
                  hasLength(statusReadsAtBackground),
                  reason: '$reason: status read in the background',
                );
              }
              final allowed =
                  foreground.inSeconds ~/
                      kRemoteWorktreeCreateRecoveryInterval.inSeconds +
                  returns;
              expect(
                repository.requestOverviewStateCalls - baseline,
                lessThanOrEqualTo(allowed),
                reason: reason,
              );
              expect(
                repository.commandStatusReads.length,
                lessThanOrEqualTo(allowed),
                reason: reason,
              );
            }

            RemoteWorktree row({required bool pending}) => RemoteWorktree(
              localId: 'wt-2',
              workspaceLocalId: 'ws-app',
              branch: 'feat/wt-2',
              setupPhase: pending
                  ? RemoteWorktreeSetupPhase.gitPending
                  : RemoteWorktreeSetupPhase.idle,
            );

            for (var step = 0; step < 30 && created == null; step++) {
              switch (random.nextInt(holdRequests ? 9 : 7)) {
                case 0:
                  final seconds = 1 + random.nextInt(20);
                  log.add('wait ${seconds}s');
                  final before = repository.requestOverviewStateCalls;
                  async.elapse(Duration(seconds: seconds));
                  if (backgrounded) {
                    expect(
                      repository.requestOverviewStateCalls,
                      before,
                      reason: 'seed $seed: projected in the background',
                    );
                  } else {
                    foreground += Duration(seconds: seconds);
                  }
                case 1 when completedCount < 2:
                  log.add('completion');
                  completedCount++;
                  deliver(repository, [completed]);
                case 2 when !reserved:
                  log.add('reservation');
                  reserved = true;
                  worktrees.add(row(pending: true));
                  deliver(repository, [worktreeDelta(row(pending: true))]);
                case 3 when reserved && !ready:
                  log.add('ready');
                  ready = true;
                  worktrees[1] = row(pending: false);
                  deliver(repository, [worktreeDelta(row(pending: false))]);
                case 4 when !backgrounded:
                  log.add('background');
                  backgrounded = true;
                  readsAtBackground = repository.snapshotFetches;
                  statusReadsAtBackground =
                      repository.commandStatusReads.length;
                  engine.session.onAppBackgrounded();
                case 5 when backgrounded:
                  log.add('return');
                  backgrounded = false;
                  returns++;
                  engine.session.onAppForegrounded();
                case 6:
                  log.add('unrelated delta');
                  deliver(repository, [worktreeDelta(_worktree('wt-1'))]);
                // The fallback round that comes due in this wait holds its
                // projection request.
                case 7 when held == null && !backgrounded:
                  final seconds = 1 + random.nextInt(40);
                  log.add('wait ${seconds}s holding a round');
                  repository.requestOverviewStateHandler = () {
                    repository.requestOverviewStateHandler = null;
                    return (held = Completer<void>()).future;
                  };
                  async.elapse(Duration(seconds: seconds));
                  repository.requestOverviewStateHandler = null;
                  foreground += Duration(seconds: seconds);
                case 8 when held != null:
                  log.add('release request');
                  held!.complete();
                  held = null;
              }
              async.flushMicrotasks();
              check();
            }
            // The desktop finishes and the app stays in front.
            repository.requestOverviewStateHandler = null;
            held?.complete();
            if (backgrounded) {
              backgrounded = false;
              returns++;
              engine.session.onAppForegrounded();
            }
            if (!reserved) worktrees.add(row(pending: false));
            if (!ready) {
              ready = true;
              if (reserved) worktrees[1] = row(pending: false);
              deliver(repository, [worktreeDelta(row(pending: false))]);
            }
            if (completedCount == 0) deliver(repository, [completed]);
            async.flushMicrotasks();
            log.add('finish');
            check();
            expect(created?.localId, 'wt-2', reason: 'seed $seed');
            engine.dispose();
          });
        }
      });
    }

    test('a fallback request that the background interrupts reads nothing '
        'until the return', () {
      fakeAsync((async) {
        final worktrees = [_worktree('wt-1')];
        final (:engine, :repository) = connect(async, worktrees);
        RemoteWorktree? created;
        Object? failure;
        unawaited(() async {
          try {
            created = await engine.worktreeCreates.createWorktree(
              workspaceLocalId: 'ws-app',
            );
          } on Object catch (error) {
            failure = error;
          }
        }());
        async.flushMicrotasks();
        // The completion reports the id, but the ready delta never arrives.
        deliver(repository, [completed]);
        async.flushMicrotasks();
        final requests = repository.requestOverviewStateCalls;
        final reads = repository.snapshotFetches;

        // The overdue fallback round's projection request is in flight when
        // the app leaves.
        final gate = Completer<void>();
        repository.requestOverviewStateHandler = () => gate.future;
        async.elapse(kRemoteWorktreeCreateRecoveryInterval);
        expect(repository.requestOverviewStateCalls, requests + 1);
        engine.session.onAppBackgrounded();
        repository.requestOverviewStateHandler = null;
        gate.complete();
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 5));
        expect(repository.snapshotFetches, reads);
        expect(repository.requestOverviewStateCalls, requests + 1);
        expect(failure, isNull);
        expect(engine.worktreeCreates.isCreatingWorktree, isTrue);

        // The return finishes the recovery once.
        worktrees.add(_worktree('wt-2'));
        engine.session.onAppForegrounded();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 1));
        expect(created?.localId, 'wt-2');
        expect(failure, isNull);
        expect(repository.createWorktreeCalls, hasLength(1));
        // The known id lets the return's one read settle it; no round repeats
        // the interrupted projection.
        expect(repository.snapshotFetches, reads + 1);
        expect(repository.requestOverviewStateCalls, requests + 1);
        async.elapse(const Duration(minutes: 3));
        expect(repository.snapshotFetches, reads + 1);
        expect(repository.requestOverviewStateCalls, requests + 1);
        expect(repository.commandStatusReads, isEmpty);
        engine.dispose();
      });
    });

    // A short absence replays its events, so the create keeps its remaining
    // foreground wait; a long one skips them, so the create checks with the
    // desktop at once. Either way, one status read recovers the id.
    for (final away in const [Duration(seconds: 30), Duration(minutes: 5)]) {
      test('fallback rounds stop in the background and one reconciliation '
          'follows a return after $away', () {
        fakeAsync((async) {
          final worktrees = [_worktree('wt-1')];
          final (:engine, :repository) = connect(async, worktrees);
          final requests = repository.requestOverviewStateCalls;
          Object? failure;
          RemoteWorktree? created;
          unawaited(() async {
            try {
              created = await engine.worktreeCreates.createWorktree(
                workspaceLocalId: 'ws-app',
              );
            } on Object catch (error) {
              failure = error;
            }
          }());
          async.flushMicrotasks();
          async.elapse(const Duration(seconds: 10));
          engine.session.onAppBackgrounded();
          async.elapse(away);
          // No fallback ran, and background time did not use up the wait.
          expect(repository.requestOverviewStateCalls, requests);
          expect(repository.commandStatusReads, isEmpty);
          expect(failure, isNull);
          expect(engine.worktreeCreates.isCreatingWorktree, isTrue);

          // The desktop finished, and its completion event was lost.
          worktrees.add(_worktree('wt-2'));
          repository.commandStatusHandler = (id) async =>
              BrowserPortalCommandStatusResponse(
                commandId: id,
                status: BrowserPortalCommandStatus.completed,
                result: {'id': 'wt-2'},
              );
          engine.session.onAppForegrounded();
          async.flushMicrotasks();
          async.elapse(const Duration(seconds: 1));
          final skippedEvents = away > const Duration(seconds: 30);
          if (!skippedEvents) {
            // The round stays due after the remaining 20 foreground seconds.
            expect(created, isNull);
            expect(repository.commandStatusReads, isEmpty);
            async.elapse(const Duration(seconds: 19));
          }
          expect(created?.localId, 'wt-2');
          expect(failure, isNull);
          expect(repository.commandStatusReads, ['cmd-1']);
          expect(repository.createWorktreeCalls, hasLength(1));
          // Only a replaying return refreshes the overview for the
          // unidentified create.
          final projections = skippedEvents ? requests : requests + 1;
          expect(repository.requestOverviewStateCalls, projections);
          async.elapse(const Duration(minutes: 3));
          expect(repository.commandStatusReads, ['cmd-1']);
          expect(repository.requestOverviewStateCalls, projections);
          engine.dispose();
        });
      });
    }
  });
}

RemoteWorktree _settingUp(String id) => RemoteWorktree(
  localId: id,
  workspaceLocalId: 'ws-app',
  branch: 'feat/$id',
  setupPhase: RemoteWorktreeSetupPhase.gitPending,
);

final class _GatedNextSnapshotRepository extends FakeRemoteControlRepository {
  /// Holds [disconnect]'s server teardown until the test completes it.
  Completer<void>? gateDisconnect;

  @override
  Future<void> disconnect() async {
    await super.disconnect();
    await gateDisconnect?.future;
  }
}
