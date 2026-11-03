import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_project_commands.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';

void main() {
  group('MockRemoteControlRepository', () {
    MockRemoteControlRepository build() =>
        MockRemoteControlRepository(latency: Duration.zero);

    test(
      'watcher fixtures cover GitHub, wakeups and failed delivery; deletion survives a reread',
      () async {
        final repo = build();
        await repo.connect('123456');
        final snapshot = await repo.fetchSnapshot();
        final worktree = snapshot.worktrees.first;
        Future<RemoteWorktreeActivity> activity() async =>
            RemoteWorktreeActivity.fromState(
              worktreeLocalId: worktree.localId,
              state: (await repo.fetchWorktreeStateSlices(
                workspaceLocalId: worktree.workspaceLocalId,
                worktreeLocalId: worktree.localId,
              )).slices,
            );
        expect(repo.watchers.supportsChatWatchers, isTrue);
        final rows = (await activity()).watchers;
        expect(
          rows.map((row) => row.trigger),
          containsAll([
            'github_pull_requests_changed',
            'github_workflow_runs_changed',
            'scheduled_wakeup',
          ]),
        );
        expect(
          rows.where((row) => row.status == 'delivery_failed'),
          hasLength(1),
        );
        final removal = repo.events.first;
        await repo.watchers.deleteWatcher(
          'mock-session',
          'watch-pr',
          notifySubscriber: false,
        );
        expect(
          (await activity()).watchers.map((row) => row.id),
          isNot(contains('watch-pr')),
        );
        final batch = await removal.timeout(const Duration(seconds: 1));
        final delta = batch.events.whereType<RemoteStateDeltaEvent>().single;
        expect(delta.shell.watcherRemovals.single.localId, 'watch-pr');
        expect(
          delta.shell.watcherRemovals.single.parentLocalId,
          '${worktree.workspaceLocalId}:${worktree.localId}',
        );
        await expectLater(
          repo.watchers.deleteWatcher(
            'mock-session',
            'watch-pr',
            notifySubscriber: true,
          ),
          throwsA(
            isA<RemoteWatcherDeleteException>().having(
              (e) => e.failure,
              'failure',
              RemoteWatcherDeleteFailure.notFoundOrFiring,
            ),
          ),
        );
      },
    );

    test('supportsChatAttachments is true', () {
      expect(MockRemoteControlRepository().supportsChatAttachments, isTrue);
      expect(
        MockRemoteControlRepository().supportsStandaloneChatCreate,
        isTrue,
      );
    });

    test('connect accepts a well-formed 6-digit code', () async {
      final repo = build();

      final connection = await repo.connect('123456');

      expect(connection.deviceLabel, isNotEmpty);
      expect(connection.sessionId, isNotEmpty);
    });

    test(
      'connect rejects a malformed code with RemoteControlException',
      () async {
        final repo = build();

        await expectLater(
          repo.connect('12ab'),
          throwsA(isA<RemoteControlException>()),
        );
      },
    );

    test('connect rejects the reserved error code', () async {
      final repo = build();

      await expectLater(
        repo.connect('000000'),
        throwsA(isA<RemoteControlException>()),
      );
    });

    test('a local reset disconnects the demo session', () async {
      final repo = build();
      await repo.connect('123456');

      repo.clearLocalSession();

      await expectLater(
        repo.fetchSnapshot(),
        throwsA(isA<RemoteControlException>()),
      );
    });

    test('fetchSnapshot before connect throws', () async {
      final repo = build();

      await expectLater(
        repo.fetchSnapshot(),
        throwsA(isA<RemoteControlException>()),
      );
    });

    test(
      'fetchSnapshot after connect returns representative sample data',
      () async {
        final repo = build();
        await repo.connect('123456');

        final snapshot = await repo.fetchSnapshot();

        // At least one workspace of each type is represented.
        final types = snapshot.workspaces.map((w) => w.type).toSet();
        expect(types, contains(RemoteWorkspaceType.singleRepo));
        expect(types, contains(RemoteWorkspaceType.multiRepo));
        expect(types, contains(RemoteWorkspaceType.cowork));

        // Multi-repo workspaces expose child repos.
        final multi = snapshot.workspaces.firstWhere(
          (w) => w.type == RemoteWorkspaceType.multiRepo,
        );
        expect(multi.repos, isNotNull);
        expect(multi.repos, isNotEmpty);

        // Worktrees exercise the varied badge states.
        expect(snapshot.worktrees, isNotEmpty);
        expect(snapshot.worktrees.any((w) => w.busy == true), isTrue);
        expect(snapshot.worktrees.any((w) => w.hasUnread == true), isTrue);
        expect(
          snapshot.worktrees.any((w) => w.awaitingApproval == true),
          isTrue,
        );
        expect(snapshot.worktrees.any((w) => w.pipelineStatus != null), isTrue);

        // Every worktree references an existing workspace.
        final workspaceIds = snapshot.workspaces.map((w) => w.localId).toSet();
        for (final wt in snapshot.worktrees) {
          expect(workspaceIds, contains(wt.workspaceLocalId));
        }

        // Standalone chats are present.
        expect(snapshot.standaloneChats.length, greaterThanOrEqualTo(2));
      },
    );

    test('disconnect prevents further snapshot reads', () async {
      final repo = build();
      await repo.connect('123456');
      await repo.disconnect();

      await expectLater(
        repo.fetchSnapshot(),
        throwsA(isA<RemoteControlException>()),
      );
    });

    test('fetchWorktreeStateSlices seeds a running, a paused and a succeeded '
        'pipeline run so demo mode exercises the run screen', () async {
      final repo = build();
      await repo.connect('123456');

      final result = await repo.fetchWorktreeStateSlices(
        workspaceLocalId: 'ws-auth',
        worktreeLocalId: 'wt-feature-auth',
      );
      final activity = RemoteWorktreeActivity.fromState(
        worktreeLocalId: 'wt-feature-auth',
        state: result.slices,
      );

      expect(activity.pipelineRuns, hasLength(3));
      final byStatus = {
        for (final run in activity.pipelineRuns) run.status: run,
      };
      expect(byStatus.keys, containsAll(['running', 'paused', 'success']));

      // The running one carries a job tree with a matrix variant, so the
      // run screen's tree and step selection are reachable in demo mode.
      final running = byStatus['running']!;
      expect(running.hasDetail, isTrue);
      expect(running.jobs, isNotEmpty);
      expect(running.jobs!.any((job) => job.variants.isNotEmpty), isTrue);

      // The paused one carries a status reason so the attention block is
      // reachable too.
      expect(byStatus['paused']!.statusReasons, isNotEmpty);
    });

    test('a demo clone completes at once and adds a project named after the '
        'repository', () async {
      final repo = build();
      await repo.connect('123456');
      final before = await repo.fetchSnapshot();

      final first = await repo.projects.createProjectFromGitUrl(
        ' https://github.com/acme/widgets.git ',
      );
      final second = await repo.projects.createProjectFromGitUrl(
        'git@github.com:acme/api.git',
      );

      expect(first, isA<RemoteProjectCreateCompleted>());
      expect(second, isA<RemoteProjectCreateCompleted>());
      final firstId = (first as RemoteProjectCreateCompleted).workspaceId;
      final secondId = (second as RemoteProjectCreateCompleted).workspaceId;
      expect(firstId, isNot(secondId));
      final snapshot = await repo.fetchSnapshot();
      expect(snapshot.workspaces.map((w) => w.localId), [
        ...before.workspaces.map((w) => w.localId),
        firstId,
        secondId,
      ]);
      final added = snapshot.workspaces.skip(before.workspaces.length);
      expect(added.map((w) => w.name), ['widgets', 'api']);
      expect(
        added.map((w) => w.type),
        everyElement(RemoteWorkspaceType.singleRepo),
      );
      final status = await repo.projects.commandStatus('mock-cmd-1');
      expect(status.commandId, 'mock-cmd-1');
      expect(status.status, BrowserPortalCommandStatus.completed);
    });

    test('a demo clone without a connection fails and adds nothing', () async {
      final repo = build();

      final outcome = await repo.projects.createProjectFromGitUrl(
        'https://github.com/acme/widgets.git',
      );

      expect(outcome, isA<RemoteProjectCreateFailed>());
      expect(
        (outcome as RemoteProjectCreateFailed).message,
        'Not connected to a desktop.',
      );
      await repo.connect('123456');
      final snapshot = await repo.fetchSnapshot();
      expect(
        snapshot.workspaces.map((w) => w.name),
        isNot(contains('widgets')),
      );
    });
  });

  group('RemoteSessionSnapshot.fromJson', () {
    test('reads the wire-accurate top-level keys', () {
      final snapshot = RemoteSessionSnapshot.fromJson({
        'workspaces': [
          {
            'localId': 'ws-1',
            'name': 'app',
            'type': 'multi-repo',
            'rootPath': '/tmp/app',
            'color': '#fff',
            'repos': [
              {'id': 'r1', 'name': 'api', 'repoPath': 'packages/api'},
            ],
          },
        ],
        'worktrees': [
          {
            'localId': 'wt-1',
            'workspaceLocalId': 'ws-1',
            'branch': 'main',
            'busy': true,
            'pipelineStatus': 'unseen-failure',
          },
        ],
        'standaloneChats': [
          {
            'localId': 'chat-1',
            'projectLocalId': 'ws-1',
            'title': 'Hello',
            'providerType': 'claude',
          },
        ],
        // Extra keys from the full shell state are ignored.
        'chatMessages': [],
      });

      expect(snapshot.workspaces.single.type, RemoteWorkspaceType.multiRepo);
      expect(snapshot.workspaces.single.repos?.single.name, 'api');
      expect(
        snapshot.worktrees.single.pipelineStatus,
        RemoteWorktreePipelineStatus.unseenFailure,
      );
      expect(snapshot.standaloneChats.single.title, 'Hello');
    });
  });
}
