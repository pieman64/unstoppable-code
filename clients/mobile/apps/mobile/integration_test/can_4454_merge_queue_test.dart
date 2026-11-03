// CAN-4454 on-device flow: a PR in GitHub's merge queue reads as queued in
// the workspaces list and in the Activity drawer, keeps that state across a
// live pr_status update, clears when a worktree row says it left the queue,
// and a Merge that queues another PR says so.
//
//   flutter test integration_test/can_4454_merge_queue_test.dart -d <device-id>
//
// Deterministic: the repository is the local fake (no pairing, desktop,
// GitHub or network) and every PR is synthetic
// (test/support/merge_queue_fixture.dart).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';
import '../test/support/merge_queue_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> pumpFor(WidgetTester tester, [int milliseconds = 600]) async {
    for (var elapsed = 0; elapsed < milliseconds; elapsed += 50) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  var cursor = 100;
  RemotePortalEventBatch delta(Map<String, dynamic> entity) {
    cursor++;
    return RemotePortalEventBatch.fromJson({
      'events': [
        {
          'eventId': 'can-4454-$cursor',
          'cursor': cursor,
          'type': 'portal.state.delta',
          'payload': {
            'scope': entity['entityType'] == 'pr_status' ? 'pr' : 'worktree',
            'entities': [entity],
          },
        },
      ],
      'nextCursor': cursor,
    });
  }

  // A live PR poll for [repos]: no queue fields, as the desktop sends today.
  Map<String, dynamic> prStatus(List<(String, int)> repos) => {
    'entityType': 'pr_status',
    'localId': 'koala',
    'parentLocalId': '$mergeQueueWorkspaceId:koala',
    'payload': {
      'workspaceLocalId': mergeQueueWorkspaceId,
      'worktreeLocalId': 'koala',
      'repos': [
        for (final (repo, number) in repos)
          {
            'repoId': 'repo-$repo',
            'status': {
              'number': number,
              'url': mergeQueuePrUrl(number, repo: repo),
              'state': 'open',
              'checkStatus': 'passing',
            },
          },
      ],
    },
  };

  Map<String, dynamic> rowLeftQueue() => {
    'entityType': 'worktree',
    'localId': 'koala',
    'parentLocalId': mergeQueueWorkspaceId,
    'payload': {
      'localId': 'koala',
      'workspaceLocalId': mergeQueueWorkspaceId,
      'branch': 'feature/koala',
      'lastKnownPrStatus': {
        'repos': [
          mergeQueueRepo(4454, mergeQueue: const {'inQueue': false}),
          mergeQueueRepo(4455, repoId: 'repo-web', repo: 'web'),
        ],
      },
    },
  };

  // Merge adds the web PR to the queue; refresh answers the action state.
  Future<Map<String, dynamic>> runPrAction(
    RemotePrAction action, {
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) async => action != RemotePrAction.merge
      ? mergeQueuePrState()
      : {
          'mergedRepos': [
            {
              'repoId': repoId,
              'repoName': 'web',
              'prNumber': 4455,
              'prUrl': mergeQueuePrUrl(4455, repo: 'web'),
              'mergeMethod': 'squash',
              'mergeCommitSha': null,
              'status': 'enqueued',
              'queuePosition': 3,
            },
          ],
          'mergeQueueChats': <Object>[],
          'requiresUnresolvedConfirmation': <Object>[],
          'failedRepos': <Object>[],
        };

  // The desktop's current row, so an overview read agrees with the deltas.
  late RemoteWorktree desktopRow;
  void pushRow(
    FakeRemoteControlRepository repository,
    Map<String, dynamic> entity,
  ) {
    desktopRow = RemoteWorktree.fromJson(
      entity['payload'] as Map<String, dynamic>,
    );
    repository.eventsController.add(delta(entity));
  }

  FakeRemoteControlRepository repositoryFor(RemoteWorktree worktree) {
    desktopRow = worktree;
    return FakeRemoteControlRepository()
      ..supportsPrActions = true
      ..prActionRunner = runPrAction
      ..snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [
          RemoteWorkspace(
            localId: mergeQueueWorkspaceId,
            name: 'acme',
            type: RemoteWorkspaceType.singleRepo,
          ),
        ],
        worktrees: [desktopRow],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: mergeQueueWorkspaceId,
            worktreeLocalId: 'koala',
            title: 'Merge queue',
            active: true,
          ),
        ],
      );
  }

  Widget host(RemoteControlViewModel viewModel, Widget home) => MultiProvider(
    providers: [
      ChangeNotifierProvider<ChatDraftStoreHolder>(
        create: (_) => ChatDraftStoreHolder(),
      ),
      ChangeNotifierProvider<RemoteControlViewModel>.value(value: viewModel),
      ChangeNotifierProvider<TurnFeedbackController>(
        create: (_) =>
            TurnFeedbackController(repository: MockTurnFeedbackRepository()),
      ),
    ],
    child: MaterialApp(theme: AppTheme.light, home: home),
  );

  testWidgets('the workspaces list row follows live queue state', (
    tester,
  ) async {
    final repository = repositoryFor(
      mergeQueueWorktree('koala', [
        mergeQueueRepo(
          4454,
          mergeQueue: queued(position: 2, phase: 'awaiting_checks'),
        ),
      ]),
    );
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    await tester.pumpWidget(
      host(viewModel, const Scaffold(body: WorkspacesListView())),
    );
    await pumpFor(tester, 1000);
    // Phone sections start collapsed; open the project by its name.
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('workspace-$mergeQueueWorkspaceId')),
        matching: find.text('acme'),
      ),
    );
    await pumpFor(tester);

    final queuedBadge = find.textContaining(
      'PR #4454 · Queued #2',
      findRichText: true,
    );
    expect(queuedBadge, findsOneWidget);
    expect(
      find.byTooltip('In merge queue, position 2. Awaiting queue checks'),
      findsOneWidget,
    );

    repository.eventsController.add(delta(prStatus([('app', 4454)])));
    await pumpFor(tester);
    expect(queuedBadge, findsOneWidget);

    pushRow(repository, rowLeftQueue());
    await pumpFor(tester);
    expect(queuedBadge, findsNothing);
    expect(find.textContaining('Queued', findRichText: true), findsNothing);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    await pumpFor(tester, 300);
    viewModel.dispose();
  });

  testWidgets('the drawer hides Merge for a queued PR and reports a queued '
      'merge', (tester) async {
    final worktree = mergeQueueDrawerWorktree();
    final repository = repositoryFor(worktree);
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    await tester.pumpWidget(
      host(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
    );
    await pumpFor(tester, 1000);
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await pumpFor(tester, 1000);
    await tester.tap(find.byKey(const ValueKey('refresh-pr')));
    await pumpFor(tester, 1000);

    expect(find.text('In merge queue'), findsOneWidget);
    expect(find.text('Position #2 · Awaiting queue checks'), findsOneWidget);
    expect(find.byKey(const ValueKey('merge-pr-repo-app')), findsNothing);
    final mergeWeb = find.byKey(const ValueKey('merge-pr-repo-web'));
    expect(mergeWeb, findsOneWidget);

    // A live PR poll keeps the queue state the row reported.
    repository.eventsController.add(
      delta(prStatus([('app', 4454), ('web', 4455)])),
    );
    await pumpFor(tester);
    expect(find.text('In merge queue'), findsOneWidget);

    await tester.ensureVisible(mergeWeb);
    await pumpFor(tester, 300);
    await tester.tap(mergeWeb);
    await pumpFor(tester, 1200);
    expect(
      find.text('Added #4455 to the merge queue (position 3).'),
      findsOneWidget,
    );

    // A row that reports the PR left the queue brings Merge back.
    pushRow(repository, rowLeftQueue());
    await pumpFor(tester, 5000);
    expect(find.text('In merge queue'), findsNothing);
    expect(find.byKey(const ValueKey('merge-pr-repo-app')), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    await pumpFor(tester, 300);
    viewModel.dispose();
  });
}
