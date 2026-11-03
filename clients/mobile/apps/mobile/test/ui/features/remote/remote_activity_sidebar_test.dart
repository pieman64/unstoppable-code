import 'package:mobile/data/repositories/remote_control_repository.dart'
    show RemoteControlException;
import 'dart:async';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/progress/canopy_progress_checklist.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/ui/features/remote/views/widgets/activity_sidebar.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart'
    show
        ChangedFilesLoadStatus,
        RemoteControlViewModel,
        kRemoteHydrationTimeout;
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_activity_load_tracker.dart'
    show kChangedFilesLoadFailed, kChangedFilesOffline, kChangedFilesTimedOut;
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/merge_queue_fixture.dart';

/// Lets futures started outside the fake clock complete.
Future<void> _realTurns() async {
  for (var i = 0; i < 4; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// The desktop's answer to the drawer's worktree projection request.
const _worktreeProjected = RemotePortalEventBatch(
  events: [
    RemoteStateSnapshotEvent(
      scope: 'worktree',
      targetWorkspaceLocalId: 'ws-1',
      targetWorktreeLocalId: 'wt-1',
    ),
  ],
  nextCursor: 7,
);

void main() {
  group('Remote activity/files sidebar', () {
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Widget host(RemoteControlViewModel viewModel, Widget screen) =>
        MultiProvider(
          providers: [
            // `create` (not `.value`) so the widget tree owns disposal: when
            // the tree is torn down the view model is disposed, cancelling
            // its hydration watchdog timers before the pending-timer
            // invariant runs.
            ChangeNotifierProvider<RemoteControlViewModel>(
              create: (_) => viewModel,
            ),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            navigatorObservers: [appRouteObserver],
            home: screen,
          ),
        );

    testWidgets('PR status is an accessible link in the Activity drawer', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: RemoteWorktree.fromJson({
                'localId': 'wt-1',
                'workspaceLocalId': 'ws-1',
                'branch': 'feature',
                'lastKnownPrStatus': {
                  'repos': [
                    {
                      'repoId': 'repo',
                      'status': {
                        'state': 'open',
                        'prNumber': 42,
                        'prUrl': 'https://github.com/acme/repo/pull/42',
                      },
                    },
                  ],
                },
              }),
              activity: const RemoteWorktreeActivity(),
            ),
          ),
        ),
      );
      expect(find.byKey(const ValueKey('pr-link-42')), findsOneWidget);
      expect(
        tester.widget<InkWell>(find.byKey(const ValueKey('pr-link-42'))).onTap,
        isNotNull,
      );
    });

    Future<void> showPrDrawer(
      WidgetTester tester,
      RemotePrActionRunner runner,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true
        ..prActionRunner = runner;
      final worktree = RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feature',
      );
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: [worktree],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Task',
            active: true,
          ),
        ],
        raw: const {},
      );
      final vm = RemoteControlViewModel(repository: repository);
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();
    }

    testWidgets('the drawer is near-full-bleed on a phone', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;
      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();

      final screenWidth =
          tester.view.physicalSize.width / tester.view.devicePixelRatio;
      final drawerWidth = tester.getSize(find.byType(Drawer)).width;
      expect(drawerWidth, greaterThan(304));
      expect(drawerWidth, lessThan(screenWidth));
      expect(drawerWidth, closeTo(screenWidth * 0.88, 1));
    });

    testWidgets('pipeline runs open the run viewer', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
      );
      repository.worktreeStateSlices = {
        'wt-1': {
          'pipelineRuns': [
            {
              'localId': 'exec-1',
              'worktreeLocalId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'pipelineName': 'CI',
              'status': 'running',
              'startedAt': '2026-09-16T10:00:00.000Z',
              'triggerSource': 'hook',
              'progress': {'completedSteps': 1, 'totalSteps': 4},
            },
            {
              'localId': 'exec-hidden',
              'worktreeLocalId': 'wt-1',
              'pipelineName': 'Child',
              'status': 'running',
              'hidden': true,
            },
          ],
        },
      };
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;
      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();
      // The desktop announces the drawer's projection (CAN-4875); the read
      // after it runs where the session connected.
      repository.eventsController.add(_worktreeProjected);
      await tester.runAsync(_realTurns);
      await tester.pumpAndSettle();

      expect(find.text('CI'), findsOneWidget);
      expect(find.text('1/4'), findsOneWidget);
      expect(find.text('Child'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('pipeline-run-row:exec-1')));
      await tester.pumpAndSettle();

      expect(find.byType(RemotePipelineRunScreen), findsOneWidget);
      expect(repository.pipelineExecutionRequests.single.executionId, 'exec-1');
    });

    testWidgets('pipeline runs show desktop-style job progress dots', (
      tester,
    ) async {
      usePhoneViewport(tester);
      // Running dots pulse; with animations off the pulse stays still so the
      // tree can settle.
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(
        tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
      );
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
      );
      Map<String, dynamic> job(
        String id,
        String status, [
        List<String> needs = const [],
      ]) => {
        'jobId': id,
        'name': id,
        'status': status,
        'needs': needs,
        'steps': const [],
      };
      repository.worktreeStateSlices = {
        'wt-1': {
          'pipelineRuns': [
            {
              'localId': 'exec-1',
              'worktreeLocalId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'pipelineName': 'Code Review',
              'status': 'running',
              'startedAt': '2026-09-16T10:00:00.000Z',
              'jobs': [
                job('setup', 'success'),
                job('claude', 'running', ['setup']),
                job('codex', 'failed', ['setup']),
                job('report', 'pending', ['claude', 'codex']),
              ],
            },
            {
              'localId': 'exec-old',
              'worktreeLocalId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'pipelineName': 'Legacy',
              'status': 'success',
              'startedAt': '2026-09-15T10:00:00.000Z',
            },
          ],
        },
      };
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;
      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();
      // The desktop announces the drawer's projection (CAN-4875); the read
      // after it runs where the session connected.
      repository.eventsController.add(_worktreeProjected);
      await tester.runAsync(_realTurns);
      await tester.pumpAndSettle();

      final track = find.byKey(const ValueKey('pipeline-run-dots:exec-1'));
      expect(track, findsOneWidget);
      // One group per dependency tier, one dot per job, in tier order.
      Finder tier(int index) => find.descendant(
        of: track,
        matching: find.byKey(ValueKey('pipeline-run-dot-tier:$index')),
      );
      for (final index in [0, 1, 2]) {
        expect(tier(index), findsOneWidget);
      }
      expect(tier(3), findsNothing);
      // `claude` and `codex` both need only `setup`, so they share a group.
      for (final id in ['claude', 'codex']) {
        expect(
          find.descendant(
            of: tier(1),
            matching: find.byKey(ValueKey('pipeline-run-dot:exec-1:$id')),
          ),
          findsOneWidget,
        );
      }
      for (final id in ['setup', 'claude', 'codex', 'report']) {
        expect(
          find.byKey(ValueKey('pipeline-run-dot:exec-1:$id')),
          findsOneWidget,
        );
      }
      final dx = [
        for (final id in ['setup', 'claude', 'report'])
          tester
              .getCenter(find.byKey(ValueKey('pipeline-run-dot:exec-1:$id')))
              .dx,
      ];
      expect(dx[0], lessThan(dx[1]));
      expect(dx[1], lessThan(dx[2]));
      // The track sits under the run's title, inside the tappable row.
      expect(
        tester.getTopLeft(track).dy,
        greaterThan(tester.getBottomLeft(find.text('Code Review')).dy),
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('pipeline-run-row:exec-1')),
          matching: track,
        ),
        findsOneWidget,
      );

      // A run the desktop sent without jobs keeps the plain row.
      expect(
        find.byKey(const ValueKey('pipeline-run-dots:exec-old')),
        findsNothing,
      );

      // Tapping the dots opens the run like the rest of the row.
      await tester.tap(
        find.byKey(const ValueKey('pipeline-run-dot:exec-1:claude')),
      );
      await tester.pumpAndSettle();
      expect(find.byType(RemotePipelineRunScreen), findsOneWidget);
    });

    Map<String, dynamic> prState({
      bool create = false,
      bool merge = false,
      bool warning = false,
      bool busy = false,
    }) => {
      'busy': busy,
      'repos': [
        {
          'repoId': 'repo-1',
          'repoName': 'App',
          'canCreate': create,
          'canMerge': merge,
          'mergeWarning': warning,
          'baseBranch': 'develop',
          'headBranch': 'feature',
          'status': create
              ? null
              : {
                  'number': 42,
                  'state': 'open',
                  'url': 'https://github.com/acme/repo/pull/42',
                  'unresolvedReviewThreadCount': warning ? 2 : 0,
                },
        },
      ],
    };

    List<RemotePrRepo> reposFrom(Map<String, dynamic> state) =>
        (state['repos'] as List? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(RemotePrRepo.fromJson)
            .toList();

    for (final mergeFromDrawer in [false, true]) {
      testWidgets(
        'live merged state retires stale drawer merge progress (local: $mergeFromDrawer)',
        (tester) async {
          usePhoneViewport(tester);
          var refreshCalls = 0;
          final pendingMerge = Completer<Map<String, dynamic>>();
          final repository = FakeRemoteControlRepository()
            ..supportsPrActions = true
            ..prActionRunner =
                (
                  action, {
                  repoId,
                  identity,
                  confirmUnresolvedComments = false,
                }) async {
                  if (action == RemotePrAction.merge) {
                    return pendingMerge.future;
                  }
                  refreshCalls++;
                  return prState(merge: true, busy: !mergeFromDrawer);
                };
          final worktree = RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature',
            mergingPr: !mergeFromDrawer,
            mergePrPhase: 'merging',
          );
          repository.snapshotBuilder = () => RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [worktree],
            standaloneChats: [],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Task',
                active: true,
              ),
            ],
          );
          final vm = RemoteControlViewModel(repository: repository);
          await tester.runAsync(() => vm.connect('123456'));
          await tester.pumpWidget(
            host(vm, RemoteChatScreen.worktree(worktree: worktree)),
          );
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('open-activity')));
          await tester.pump();
          await tester.pump(const Duration(seconds: 1));
          expect(find.text('open'), findsOneWidget);
          if (mergeFromDrawer) {
            await tester.tap(find.byKey(const ValueKey('merge-pr-repo-1')));
            await tester.pump();
            expect(find.text('Merging PR…'), findsOneWidget);
          }

          repository.eventsController.add(
            RemotePortalEventBatch.fromJson({
              'events': [
                {
                  'type': 'portal.state.delta',
                  'payload': {
                    'scope': 'pr',
                    'entities': [
                      {
                        'entityType': 'worktree',
                        'localId': 'wt-1',
                        'payload': {
                          'localId': 'wt-1',
                          'workspaceLocalId': 'ws-1',
                          'branch': 'feature',
                          'lastKnownPrStatus': {
                            'repos': [
                              {
                                'repoId': 'repo-1',
                                'status': {
                                  'prNumber': 42,
                                  'prUrl':
                                      'https://github.com/acme/repo/pull/42',
                                  'state': 'merged',
                                },
                              },
                            ],
                          },
                        },
                      },
                      {
                        'entityType': 'pr_status',
                        'localId': 'wt-1',
                        'payload': {
                          'workspaceLocalId': 'ws-1',
                          'worktreeLocalId': 'wt-1',
                          'mergeProgress': {
                            'currentPhase': 'done',
                            'steps': [
                              {'phase': 'merging', 'repoId': 'repo-1'},
                              {'phase': 'done', 'repoId': 'repo-1'},
                              {'phase': 'done'},
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
          await tester.pump();
          await tester.pump();

          expect(
            vm.worktreesFor('ws-1').single.prStatuses.single.state,
            'merged',
          );
          expect(find.text('merged'), findsOneWidget);
          expect(find.text('open'), findsNothing);
          expect(find.byKey(const ValueKey('merge-pr-repo-1')), findsNothing);
          expect(find.byType(CanopyProgressChecklist), findsNothing);
          expect(find.byType(CircularProgressIndicator), findsNothing);
          expect(
            refreshCalls,
            1,
            reason: 'Pushed state needs no polling round trip.',
          );
        },
      );
    }

    testWidgets('refreshes PR state only while the chat route is current', (
      tester,
    ) async {
      usePhoneViewport(tester);
      var refreshCalls = 0;
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true
        ..prActionRunner =
            (
              action, {
              repoId,
              identity,
              confirmUnresolvedComments = false,
            }) async {
              if (action == RemotePrAction.refresh) refreshCalls++;
              return prState();
            };
      const worktree = RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feature',
      );
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [worktree],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Task',
            active: true,
          ),
        ],
      );
      final vm = RemoteControlViewModel(repository: repository);
      await tester.runAsync(() => vm.connect('123456'));

      await tester.pumpWidget(
        host(vm, const RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pump();
      expect(refreshCalls, 1);

      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pump();
      expect(refreshCalls, 1);

      await tester.pump(const Duration(minutes: 1));
      await tester.pump();
      expect(refreshCalls, 2);

      unawaited(
        Navigator.of(
          tester.element(find.byType(RemoteChatScreen)),
        ).push(MaterialPageRoute<void>(builder: (_) => const SizedBox())),
      );
      await tester.pumpAndSettle();

      await tester.pump(const Duration(minutes: 1));
      await tester.pump();
      expect(refreshCalls, 2);

      Navigator.of(tester.element(find.byType(SizedBox))).pop();
      await tester.pumpAndSettle();
      expect(refreshCalls, 3);

      await tester.pump(const Duration(minutes: 1));
      await tester.pump();
      expect(refreshCalls, 4);
    });

    testWidgets(
      'runs a trailing PR refresh when the chat becomes visible mid-request',
      (tester) async {
        usePhoneViewport(tester);
        var refreshCalls = 0;
        final firstRefresh = Completer<Map<String, dynamic>>();
        final repository = FakeRemoteControlRepository()
          ..supportsPrActions = true
          ..prActionRunner =
              (action, {repoId, identity, confirmUnresolvedComments = false}) {
                if (action != RemotePrAction.refresh) return Future.value({});
                refreshCalls++;
                if (refreshCalls == 1) return firstRefresh.future;
                return Future.value(prState());
              };
        const worktree = RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
        );
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [worktree],
          standaloneChats: [],
        );
        final vm = RemoteControlViewModel(repository: repository);
        await tester.runAsync(() => vm.connect('123456'));

        await tester.pumpWidget(
          host(vm, const RemoteChatScreen.worktree(worktree: worktree)),
        );
        await tester.pump();
        expect(refreshCalls, 1);

        unawaited(
          Navigator.of(
            tester.element(find.byType(RemoteChatScreen)),
          ).push(MaterialPageRoute<void>(builder: (_) => const SizedBox())),
        );
        await tester.pumpAndSettle();
        Navigator.of(tester.element(find.byType(SizedBox))).pop();
        await tester.pumpAndSettle();
        expect(refreshCalls, 1);

        firstRefresh.complete(prState());
        await tester.pump();
        await tester.pump();

        expect(refreshCalls, 2);
      },
    );

    testWidgets('pauses PR refresh while the app is backgrounded', (
      tester,
    ) async {
      usePhoneViewport(tester);
      var refreshCalls = 0;
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true
        ..prActionRunner =
            (
              action, {
              repoId,
              identity,
              confirmUnresolvedComments = false,
            }) async {
              if (action == RemotePrAction.refresh) refreshCalls++;
              return prState();
            };
      const worktree = RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'feature',
      );
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [worktree],
        standaloneChats: [],
      );
      final vm = RemoteControlViewModel(repository: repository);
      await tester.runAsync(() => vm.connect('123456'));

      await tester.pumpWidget(
        host(vm, const RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pump();
      expect(refreshCalls, 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      await tester.pump(const Duration(minutes: 1));
      await tester.pump();
      expect(refreshCalls, 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(refreshCalls, 2);

      await tester.pump(const Duration(minutes: 1));
      await tester.pump();
      expect(refreshCalls, 3);
    });

    testWidgets(
      'does not arm PR refresh when worktree creation finishes on a covered route',
      (tester) async {
        usePhoneViewport(tester);
        var refreshCalls = 0;
        final createResult = Completer<RemoteWorktreeCreateResult>();
        final worktrees = <RemoteWorktree>[];
        final repository = FakeRemoteControlRepository()
          ..supportsPrActions = true
          ..prActionRunner =
              (
                action, {
                repoId,
                identity,
                confirmUnresolvedComments = false,
              }) async {
                if (action == RemotePrAction.refresh) refreshCalls++;
                return prState();
              };
        repository.createWorktreeHandler = () => createResult.future;
        const workspace = RemoteWorkspace(
          localId: 'ws-1',
          order: 0,
          name: 'App',
          type: RemoteWorkspaceType.singleRepo,
        );
        repository.snapshotBuilder = () => RemoteSessionSnapshot(
          workspaces: const [workspace],
          worktrees: List.of(worktrees),
          standaloneChats: const [],
        );
        final vm = RemoteControlViewModel(
          repository: repository,
          worktreeCreateRecoveryInterval: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));

        await tester.pumpWidget(
          host(vm, const RemoteChatScreen.create(workspace: workspace)),
        );
        await tester.pump();
        await tester.pump();
        expect(repository.createWorktreeCalls, hasLength(1));

        unawaited(
          Navigator.of(
            tester.element(find.byType(RemoteChatScreen)),
          ).push(MaterialPageRoute<void>(builder: (_) => const SizedBox())),
        );
        await tester.pumpAndSettle();

        const createdWorktree = RemoteWorktree(
          localId: 'wt-created',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
        );
        worktrees.add(createdWorktree);
        createResult.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-created',
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(refreshCalls, 0);
        await tester.pump(const Duration(minutes: 1));
        await tester.pump();
        expect(refreshCalls, 0);

        Navigator.of(tester.element(find.byType(SizedBox))).pop();
        await tester.pumpAndSettle();
        expect(refreshCalls, 1);
      },
    );

    testWidgets('live PR progress disables cached create and merge actions', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final createRepo = RemotePrRepo.fromJson(
        prState(create: true)['repos']![0],
      );
      final mergeRepo = RemotePrRepo.fromJson(
        prState(merge: true)['repos']![0],
      );
      Future<Map<String, dynamic>> runner(
        RemotePrAction action, {
        String? repoId,
        RemotePrActionIdentity? identity,
        bool confirmUnresolvedComments = false,
      }) async => prState();

      Widget subject({
        required RemotePrRepo repo,
        required RemotePrProgressState progress,
      }) => MaterialApp(
        home: Scaffold(
          body: RemoteActivitySidebar(
            worktree: const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'feature',
            ),
            activity: const RemoteWorktreeActivity(),
            runPrAction: runner,
            cachedPrRepos: [repo],
            prProgress: progress,
          ),
        ),
      );

      await tester.pumpWidget(
        subject(
          repo: createRepo,
          progress: RemotePrProgressState(
            creation: RemotePrCreationProgress.fromJson({
              'currentPhase': 'summarizing',
              'steps': const [],
            }),
          ),
        ),
      );
      await tester.pump();
      expect(
        tester
            .widget<TextButton>(
              find.descendant(
                of: find.byKey(const ValueKey('create-pr-repo-1')),
                matching: find.byType(TextButton),
              ),
            )
            .onPressed,
        isNull,
      );

      await tester.pumpWidget(
        subject(
          repo: mergeRepo,
          progress: RemotePrProgressState(
            merge: RemoteMergePrProgress.fromJson({
              'currentPhase': 'waiting_mergeability',
              'steps': const [],
            }),
          ),
        ),
      );
      await tester.pump();
      expect(
        tester
            .widget<TextButton>(
              find.descendant(
                of: find.byKey(const ValueKey('merge-pr-repo-1')),
                matching: find.byType(TextButton),
              ),
            )
            .onPressed,
        isNull,
      );
    });

    testWidgets(
      'creates a PR from Activity, blocks duplicate taps, then shows its link',
      (tester) async {
        final pending = Completer<Map<String, dynamic>>();
        var created = false;
        var calls = 0;
        await showPrDrawer(tester, (
          action, {
          repoId,
          identity,
          confirmUnresolvedComments = false,
        }) async {
          if (action == RemotePrAction.create) {
            calls++;
            expect(repoId, 'repo-1');
            final result = await pending.future;
            created = true;
            return result;
          }
          return prState(create: !created);
        });
        final button = find.byKey(const ValueKey('create-pr-repo-1'));
        expect(
          tester.widget<CanopyButton>(button).foregroundColor,
          StatusColors.light.accent,
        );
        expect(
          tester
              .widget<CanopyIcon>(
                find.descendant(of: button, matching: find.byType(CanopyIcon)),
              )
              .glyph,
          CanopyGlyph.pullRequestSimple,
        );
        await tester.tap(button);
        await tester.pump();
        expect(find.text('Creating PR…'), findsOneWidget);
        expect(
          tester
              .widget<TextButton>(
                find.descendant(of: button, matching: find.byType(TextButton)),
              )
              .onPressed,
          isNull,
        );
        expect(calls, 1);
        pending.complete({'repos': []});
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('pr-link-42')), findsOneWidget);
        expect(find.text('Create PR'), findsNothing);
      },
    );

    testWidgets('binds a PR action to the displayed repository identity', (
      tester,
    ) async {
      String? expectedBaseBranch;
      String? expectedHeadBranch;
      int? expectedPrNumber;
      Future<Map<String, dynamic>> runner(
        RemotePrAction action, {
        String? repoId,
        bool confirmUnresolvedComments = false,
        RemotePrActionIdentity? identity,
      }) async {
        if (action == RemotePrAction.merge) {
          expectedBaseBranch = identity?.baseBranch;
          expectedHeadBranch = identity?.headBranch;
          expectedPrNumber = identity?.prNumber;
          return {
            'mergedRepos': [
              {'repoId': repoId},
            ],
          };
        }
        return prState(merge: true);
      }

      await showPrDrawer(tester, runner);
      await tester.tap(find.byKey(const ValueKey('merge-pr-repo-1')));
      await tester.pump();

      expect(expectedBaseBranch, 'develop');
      expect(expectedHeadBranch, 'feature');
      expect(expectedPrNumber, 42);
    });

    group('merge queue chat handoff', () {
      const queueSnack =
          'Opened a chat on the desktop to merge through the merge queue.';
      const queueChats = [
        {
          'repoId': 'repo-1',
          'repoName': 'App',
          'prNumber': 42,
          'prUrl': 'https://github.com/acme/repo/pull/42',
          'chatId': 'merge-queue-1',
        },
      ];

      Future<void> mergeWith(
        WidgetTester tester,
        Map<String, dynamic> mergeResult, {
        bool settle = true,
      }) async {
        Future<Map<String, dynamic>> runner(
          RemotePrAction action, {
          String? repoId,
          bool confirmUnresolvedComments = false,
          RemotePrActionIdentity? identity,
        }) async =>
            action == RemotePrAction.merge ? mergeResult : prState(merge: true);

        await showPrDrawer(tester, runner);
        await tester.tap(find.byKey(const ValueKey('merge-pr-repo-1')));
        if (settle) {
          await tester.pumpAndSettle();
        } else {
          // The row keeps its busy spinner while the dialog is open.
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
        }
      }

      testWidgets('says the desktop opened a chat', (tester) async {
        await mergeWith(tester, {
          'mergedRepos': <Object>[],
          'mergeQueueChats': queueChats,
        });

        expect(find.text(queueSnack), findsOneWidget);
      });

      for (final entry in <String, Map<String, dynamic>>{
        'an absent field': {
          'mergedRepos': [
            {'repoId': 'repo-1'},
          ],
        },
        'an empty list': {
          'mergedRepos': [
            {'repoId': 'repo-1'},
          ],
          'mergeQueueChats': <Object>[],
        },
        'a failed repository': {
          'mergeQueueChats': queueChats,
          'failedRepos': [
            {'repoId': 'repo-2', 'error': 'No window is available'},
          ],
        },
        'a cancelled action': {
          'mergeQueueChats': queueChats,
          'cancelled': true,
        },
      }.entries) {
        testWidgets('stays quiet for ${entry.key}', (tester) async {
          await mergeWith(tester, entry.value);

          expect(find.text(queueSnack), findsNothing);
        });
      }

      testWidgets('asks for confirmation before reporting a chat', (
        tester,
      ) async {
        await mergeWith(tester, {
          'mergeQueueChats': queueChats,
          'requiresUnresolvedConfirmation': [
            {'repoId': 'repo-2', 'unresolvedReviewThreadCount': 1},
          ],
        }, settle: false);

        expect(find.text('Merge with unresolved comments?'), findsOneWidget);
        expect(find.text(queueSnack), findsNothing);
      });
    });

    testWidgets('shows merge loading only on the targeted repository', (
      tester,
    ) async {
      final pending = Completer<Map<String, dynamic>>();
      await showPrDrawer(tester, (
        action, {
        repoId,
        identity,
        confirmUnresolvedComments = false,
      }) async {
        if (action == RemotePrAction.merge) return pending.future;
        return {
          'busy': false,
          'repos': [
            for (final id in ['repo-1', 'repo-2'])
              {
                'repoId': id,
                'repoName': id == 'repo-1' ? 'App' : 'API',
                'canCreate': false,
                'canMerge': true,
                'baseBranch': 'develop',
                'headBranch': 'feature',
                'status': {
                  'number': id == 'repo-1' ? 42 : 43,
                  'state': 'open',
                  'url': 'https://github.com/acme/$id/pull/42',
                },
              },
          ],
        };
      });

      final target = find.byKey(const ValueKey('merge-pr-repo-1'));
      final sibling = find.byKey(const ValueKey('merge-pr-repo-2'));
      await tester.tap(target);
      await tester.pump();

      expect(
        find.descendant(of: target, matching: find.text('Merging PR…')),
        findsOneWidget,
      );
      expect(tester.widget<CanopyButton>(target).loading, isTrue);
      expect(
        find.descendant(of: sibling, matching: find.text('Merge PR')),
        findsOneWidget,
      );
      expect(tester.widget<CanopyButton>(sibling).loading, isFalse);
      expect(
        tester
            .widget<TextButton>(
              find.descendant(of: sibling, matching: find.byType(TextButton)),
            )
            .onPressed,
        isNull,
      );

      pending.complete({'mergedRepos': const []});
      await tester.pumpAndSettle();
    });

    testWidgets(
      'merges a ready PR only after unresolved-comment confirmation',
      (tester) async {
        final confirmations = <bool>[];
        var merged = false;
        await showPrDrawer(tester, (
          action, {
          repoId,
          identity,
          confirmUnresolvedComments = false,
        }) async {
          if (action == RemotePrAction.merge) {
            expect(repoId, 'repo-1');
            confirmations.add(confirmUnresolvedComments);
            if (!confirmUnresolvedComments) {
              return {
                'requiresUnresolvedConfirmation': [
                  {'repoId': repoId},
                ],
              };
            }
            merged = true;
            return {
              'mergedRepos': [
                {'repoId': repoId},
              ],
            };
          }
          return prState(merge: !merged, warning: true);
        });
        final button = find.byKey(const ValueKey('merge-pr-repo-1'));
        expect(
          tester.widget<CanopyButton>(button).foregroundColor,
          StatusColors.light.warning,
        );
        expect(
          tester
              .widget<CanopyIcon>(
                find.descendant(of: button, matching: find.byType(CanopyIcon)),
              )
              .glyph,
          CanopyGlyph.mergedSimple,
        );
        await tester.tap(button);
        await tester.pump();
        expect(tester.widget<CanopyButton>(button).loading, isTrue);
        expect(find.text('Merging PR…'), findsOneWidget);
        expect(
          find.descendant(
            of: button,
            matching: find.byType(CircularProgressIndicator),
          ),
          findsOneWidget,
        );
        expect(find.text('PR action in progress…'), findsNothing);
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.text('Merge with unresolved comments?'), findsOneWidget);
        expect(confirmations, [false]);
        await tester.tap(find.widgetWithText(TextButton, 'Merge PR').last);
        await tester.pumpAndSettle();
        expect(confirmations, [false, true]);
        expect(button, findsNothing);
      },
    );

    Future<void> pumpSidebar(
      WidgetTester tester, {
      required RemoteWorktree worktree,
      RemotePrActionRunner? runner,
    }) async {
      usePhoneViewport(tester);
      final cached = runner == null
          ? null
          : await runner(RemotePrAction.refresh);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: worktree,
              activity: const RemoteWorktreeActivity(),
              runPrAction: runner,
              cachedPrRepos: cached == null
                  ? null
                  : (cached['repos'] as List? ?? const [])
                        .whereType<Map<String, dynamic>>()
                        .map(RemotePrRepo.fromJson)
                        .toList(),
              cachedPrBusy: cached?['busy'] == true,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('keeps cached PR state when a refresh result is discarded', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: const RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'feature',
              ),
              activity: const RemoteWorktreeActivity(),
              cachedPrRepos: const [
                RemotePrRepo(
                  repoId: 'repo-1',
                  repoName: 'App',
                  baseBranch: 'develop',
                  headBranch: 'feature',
                  canCreate: true,
                ),
              ],
              runPrAction:
                  (
                    action, {
                    repoId,
                    identity,
                    confirmUnresolvedComments = false,
                  }) async => remotePrActionDiscardedResult,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('create-pr-repo-1')), findsOneWidget);
      await tester.tap(find.byTooltip('Refresh pull requests'));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('create-pr-repo-1')), findsOneWidget);
    });

    testWidgets(
      'applies newer cached PR state after an in-flight refresh is discarded',
      (tester) async {
        usePhoneViewport(tester);
        final refresh = Completer<Map<String, dynamic>>();
        var cachedRepos = const [
          RemotePrRepo(
            repoId: 'repo-1',
            repoName: 'App',
            baseBranch: 'develop',
            headBranch: 'feature',
            canCreate: true,
          ),
        ];
        var cachedBusy = false;
        late StateSetter updateHost;

        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light,
            home: StatefulBuilder(
              builder: (context, setState) {
                updateHost = setState;
                return Scaffold(
                  body: RemoteActivitySidebar(
                    worktree: const RemoteWorktree(
                      localId: 'wt-1',
                      workspaceLocalId: 'ws-1',
                      branch: 'feature',
                    ),
                    activity: const RemoteWorktreeActivity(),
                    cachedPrRepos: cachedRepos,
                    cachedPrBusy: cachedBusy,
                    runPrAction:
                        (
                          action, {
                          repoId,
                          identity,
                          confirmUnresolvedComments = false,
                        }) => refresh.future,
                  ),
                );
              },
            ),
          ),
        );

        await tester.tap(find.byTooltip('Refresh pull requests'));
        await tester.pump();
        updateHost(() {
          cachedRepos = const [
            RemotePrRepo(
              repoId: 'repo-2',
              repoName: 'Website',
              baseBranch: 'main',
              headBranch: 'feature',
              canCreate: true,
            ),
          ];
          cachedBusy = true;
        });
        await tester.pump();

        refresh.complete(remotePrActionDiscardedResult);
        await tester.pump();
        await tester.pump();

        expect(find.byKey(const ValueKey('create-pr-repo-1')), findsNothing);
        final updatedButton = find.byKey(const ValueKey('create-pr-repo-2'));
        expect(updatedButton, findsOneWidget);
        expect(tester.widget<CanopyButton>(updatedButton).onPressed, isNull);
        expect(find.text('PR action in progress…'), findsOneWidget);
      },
    );

    const bareWorktree = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature',
    );

    testWidgets(
      'does not drop a confirmed merge when a snapshot changes behind the dialog',
      (tester) async {
        final backgroundRefresh = Completer<Map<String, dynamic>>();
        final events = <String>[];
        var refreshCalls = 0;
        var merged = false;
        Future<Map<String, dynamic>> runner(
          RemotePrAction action, {
          String? repoId,
          RemotePrActionIdentity? identity,
          bool confirmUnresolvedComments = false,
        }) async {
          if (action == RemotePrAction.merge) {
            if (!confirmUnresolvedComments) {
              return {
                'requiresUnresolvedConfirmation': [
                  {'repoId': repoId},
                ],
              };
            }
            events.add('merge-confirmed');
            merged = true;
            return {
              'mergedRepos': [
                {'repoId': repoId},
              ],
            };
          }
          refreshCalls++;
          if (refreshCalls == 1) return prState(merge: true, warning: true);
          events.add('refresh-2');
          return backgroundRefresh.future;
        }

        await pumpSidebar(tester, worktree: bareWorktree, runner: runner);
        await tester.tap(find.byKey(const ValueKey('merge-pr-repo-1')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.text('Merge with unresolved comments?'), findsOneWidget);

        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light,
            home: Scaffold(
              body: RemoteActivitySidebar(
                worktree: const RemoteWorktree(
                  localId: 'wt-1',
                  workspaceLocalId: 'ws-1',
                  branch: 'feature',
                  mergingPr: true,
                  mergePrPhase: 'checking_mergeability',
                ),
                activity: const RemoteWorktreeActivity(),
                runPrAction: runner,
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.tap(find.widgetWithText(TextButton, 'Merge PR').last);
        await tester.pump();
        backgroundRefresh.complete(prState(merge: !merged, warning: true));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));

        expect(events, ['merge-confirmed', 'refresh-2']);
      },
    );

    testWidgets('names the base branch the Create PR action targets', (
      tester,
    ) async {
      await pumpSidebar(
        tester,
        worktree: bareWorktree,
        runner:
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
                  'repoName': 'App',
                  'baseBranch': 'develop',
                  'headBranch': 'feature',
                  'canCreate': true,
                  'canMerge': false,
                },
              ],
            },
      );
      expect(find.text('Create PR into develop'), findsOneWidget);
    });

    testWidgets('blocks Create PR when the base branch is unresolved', (
      tester,
    ) async {
      var mutationCalls = 0;
      await pumpSidebar(
        tester,
        worktree: bareWorktree,
        runner:
            (
              action, {
              repoId,
              identity,
              confirmUnresolvedComments = false,
            }) async {
              if (action != RemotePrAction.refresh) mutationCalls++;
              return {
                'busy': false,
                'repos': [
                  {
                    'repoId': 'repo-1',
                    'repoName': 'App',
                    'canCreate': true,
                    'headBranch': 'feature',
                  },
                  {
                    'repoId': 'repo-2',
                    'repoName': 'Api',
                    'canMerge': true,
                    'headBranch': 'feature',
                    'status': {'number': 42, 'state': 'open'},
                  },
                ],
              };
            },
      );
      expect(find.byKey(const ValueKey('create-pr-repo-1')), findsNothing);
      expect(find.byKey(const ValueKey('merge-pr-repo-2')), findsNothing);
      expect(
        find.text(
          'Choose a base branch on the desktop to open a pull request.',
        ),
        findsOneWidget,
      );
      expect(
        find.text(
          'Choose a base branch on the desktop to merge this pull request.',
        ),
        findsOneWidget,
      );
      expect(mutationCalls, 0);
    });

    testWidgets('explains what is needed instead of hiding Create silently', (
      tester,
    ) async {
      await pumpSidebar(
        tester,
        worktree: bareWorktree,
        runner:
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
                  'repoName': 'App',
                  'canCreate': false,
                  'createBlockedReason': 'no_changes',
                },
              ],
            },
      );
      expect(
        find.text('Make a change to open a pull request.'),
        findsOneWidget,
      );
    });

    testWidgets('explains what is needed instead of hiding Merge silently', (
      tester,
    ) async {
      await pumpSidebar(
        tester,
        worktree: bareWorktree,
        runner:
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
                  'repoName': 'App',
                  'canCreate': false,
                  'canMerge': false,
                  'createBlockedReason': 'pr_open',
                  'mergeBlockedReason': 'checks_failing',
                  'status': {'number': 42, 'state': 'open'},
                },
              ],
            },
      );
      // `pr_open` needs no sentence — the PR line above it already says so.
      expect(find.text('Fix the failing checks to merge.'), findsOneWidget);
      expect(find.textContaining('open a pull request'), findsNothing);
    });

    testWidgets('asks for a desktop update when PR actions are unsupported', (
      tester,
    ) async {
      await pumpSidebar(tester, worktree: bareWorktree);
      expect(
        find.text('Update the desktop app to create pull requests from here.'),
        findsOneWidget,
      );
    });

    testWidgets('reports a create that was skipped for want of a remote', (
      tester,
    ) async {
      await pumpSidebar(
        tester,
        worktree: bareWorktree,
        runner:
            (
              action, {
              repoId,
              identity,
              confirmUnresolvedComments = false,
            }) async => action == RemotePrAction.create
            ? {
                'repos': [],
                'skippedRepos': [
                  {
                    'repoId': 'repo-1',
                    'repoName': 'App',
                    'reason': 'no_remote_origin',
                  },
                ],
                'localOnlyCommittedRepos': [],
              }
            : {
                'busy': false,
                'repos': [
                  {
                    'repoId': 'repo-1',
                    'repoName': 'App',
                    'baseBranch': 'develop',
                    'headBranch': 'feature',
                    'canCreate': true,
                  },
                ],
              },
      );
      await tester.tap(find.byKey(const ValueKey('create-pr-repo-1')));
      await tester.pumpAndSettle();
      expect(
        find.text(
          "Couldn't open the pull request. Add an origin remote first.",
        ),
        findsOneWidget,
      );
    });

    testWidgets('confirms the pull request it just created', (tester) async {
      var created = false;
      await pumpSidebar(
        tester,
        worktree: bareWorktree,
        runner:
            (
              action, {
              repoId,
              identity,
              confirmUnresolvedComments = false,
            }) async {
              if (action == RemotePrAction.create) {
                created = true;
                return {
                  'repos': [
                    {
                      'repoId': 'repo-1',
                      'repoName': 'App',
                      'prNumber': 42,
                      'prUrl': 'https://github.com/acme/repo/pull/42',
                    },
                  ],
                  'skippedRepos': [],
                  'localOnlyCommittedRepos': [],
                };
              }
              return {
                'busy': false,
                'repos': [
                  {
                    'repoId': 'repo-1',
                    'repoName': 'App',
                    'baseBranch': 'develop',
                    'headBranch': 'feature',
                    'canCreate': !created,
                    'status': created ? {'number': 42, 'state': 'open'} : null,
                  },
                ],
              };
            },
      );
      await tester.tap(find.byKey(const ValueKey('create-pr-repo-1')));
      await tester.pumpAndSettle();
      expect(find.text('Created pull request #42.'), findsOneWidget);
    });

    testWidgets('labels each repository and never prints a raw reason code', (
      tester,
    ) async {
      await pumpSidebar(
        tester,
        worktree: bareWorktree,
        runner:
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
                  'repoName': 'App',
                  'baseBranch': 'develop',
                  'headBranch': 'feature',
                  'canCreate': true,
                },
                {
                  'repoId': 'repo-2',
                  'repoName': 'Api',
                  'canCreate': false,
                  'createBlockedReason': 'needs_pull',
                },
                {
                  // A reason this build has never heard of, from a newer desktop.
                  'repoId': 'repo-3',
                  'repoName': 'Docs',
                  'canCreate': false,
                  'createBlockedReason': 'quantum_flux',
                },
                {
                  'repoId': 'repo-4',
                  'repoName': 'Web',
                  'canCreate': false,
                  'createBlockedReason': 'pr_status_unavailable',
                },
              ],
            },
      );
      expect(find.text('App'), findsOneWidget);
      expect(find.text('Api'), findsOneWidget);
      expect(find.text('Docs'), findsOneWidget);
      expect(find.text('Web'), findsOneWidget);
      expect(find.text('Create PR into develop'), findsOneWidget);
      expect(
        find.text('Pull the latest commits to open a pull request.'),
        findsOneWidget,
      );
      // An unknown reason degrades to the neutral label rather than leaking
      // a wire token into the UI.
      expect(find.text('quantum_flux'), findsNothing);
      expect(find.text('No pull request'), findsOneWidget);
      expect(
        find.text('Refresh to verify whether a pull request already exists.'),
        findsOneWidget,
      );
    });

    testWidgets('ignores malformed eligibility fields from the host', (
      tester,
    ) async {
      await pumpSidebar(
        tester,
        worktree: bareWorktree,
        runner:
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
                  'repoName': 'App',
                  'baseBranch': 7,
                  'createBlockedReason': 12,
                  'canCreate': true,
                },
              ],
            },
      );
      expect(tester.takeException(), isNull);
      expect(find.byKey(const ValueKey('create-pr-repo-1')), findsNothing);
      expect(
        find.text(
          'Choose a base branch on the desktop to open a pull request.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('does not re-read PR state when the drawer widget updates', (
      tester,
    ) async {
      var calls = 0;
      Future<Map<String, dynamic>> runner(
        RemotePrAction action, {
        String? repoId,
        RemotePrActionIdentity? identity,
        bool confirmUnresolvedComments = false,
      }) async {
        calls++;
        return {'busy': false, 'repos': const []};
      }

      await pumpSidebar(tester, worktree: bareWorktree, runner: runner);
      expect(calls, 1);

      Future<void> pumpWorktree(RemoteWorktree worktree) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light,
            home: Scaffold(
              body: RemoteActivitySidebar(
                worktree: worktree,
                activity: const RemoteWorktreeActivity(),
                runPrAction: runner,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      // The agent writing code moves these counters constantly; each refetch
      // costs a live GitHub read on the desktop.
      await pumpWorktree(
        const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
          insertions: 12,
          deletions: 3,
        ),
      );
      expect(calls, 1);

      await pumpWorktree(
        const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
          insertions: 12,
          deletions: 3,
          prStatuses: [RemoteWorktreePr(prNumber: 42, state: 'open')],
        ),
      );
      expect(calls, 1);

      await pumpWorktree(
        const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
          insertions: 12,
          deletions: 3,
          prStatuses: [
            RemoteWorktreePr(
              prNumber: 42,
              state: 'open',
              title: 'Renamed pull request',
            ),
          ],
        ),
      );
      expect(calls, 1);

      await pumpWorktree(
        const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
          insertions: 12,
          deletions: 3,
          prStatuses: [
            RemoteWorktreePr(
              prNumber: 42,
              state: 'open',
              title: 'Renamed pull request',
              commentCount: 4,
            ),
          ],
        ),
      );
      expect(calls, 1);
    });

    testWidgets(
      'hides ineligible actions and reports failures with refresh recovery',
      (tester) async {
        var fail = false;
        await showPrDrawer(tester, (
          action, {
          repoId,
          identity,
          confirmUnresolvedComments = false,
        }) async {
          if (fail) throw const RemoteControlException('GitHub unavailable');
          return prState();
        });
        expect(find.text('Merge PR'), findsNothing);
        expect(find.text('Create PR'), findsNothing);
        fail = true;
        await tester.tap(find.byKey(const ValueKey('refresh-pr')));
        await tester.pumpAndSettle();
        expect(find.text('GitHub unavailable'), findsOneWidget);
        fail = false;
        await tester.tap(find.byKey(const ValueKey('refresh-pr')));
        await tester.pumpAndSettle();
        expect(find.text('GitHub unavailable'), findsNothing);
      },
    );

    testWidgets('opens from the chat app bar and shows activity + files', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
            insertions: 10,
            deletions: 2,
            prStatuses: [RemoteWorktreePr(prNumber: 42, state: 'open')],
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [
          RemoteChatMessage(
            messageId: 'm',
            chatId: 'chat-1',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'hi',
          ),
        ],
        raw: const {
          'worktreeSummaries': [
            {
              'worktreeLocalId': 'wt-1',
              'title': 'Auth refactor',
              'description': 'Reworked the OAuth flow.',
            },
          ],
          'plans': [
            {
              'worktreeLocalId': 'wt-1',
              'title': 'Migration plan',
              'status': 'approved',
            },
          ],
          'changedFiles': {
            'wt-1': {
              'worktreeLocalId': 'wt-1',
              'uncommitted': [
                {
                  'filePath': 'lib/a.dart',
                  'status': 'modified',
                  'repoName': 'api',
                },
              ],
              'committed': [],
            },
          },
        },
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();

      expect(find.text('Activity'), findsOneWidget);
      expect(find.text('Files'), findsOneWidget);
      expect(find.text('Auth refactor'), findsOneWidget);
      expect(find.text('Migration plan'), findsOneWidget);
      expect(find.textContaining('PR #42'), findsWidgets);

      await tester.tap(find.text('Files'));
      await tester.pumpAndSettle();
      // Rows show the file name; the directory (and, in multi-repo
      // worktrees, the owning repo) is a header shared by its files.
      expect(find.text('a.dart'), findsOneWidget);
      expect(find.text('api · lib'), findsOneWidget);
      expect(find.text('1 file'), findsOneWidget);
    });

    testWidgets('renders the Todos card with per-item status', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
        raw: const {
          'todoLists': [
            {
              'localId': 'chat-1',
              'worktreeLocalId': 'wt-1',
              'chatId': 'chat-1',
              'items': [
                {'id': 't-1', 'content': 'Write tests', 'status': 'pending'},
                {'id': 't-2', 'content': 'Ship it', 'status': 'completed'},
              ],
            },
          ],
        },
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();

      expect(find.text('Todos'), findsOneWidget);
      expect(find.text('Write tests'), findsOneWidget);
      expect(find.text('Ship it'), findsOneWidget);

      // Completed items render struck through.
      final completed = tester.widget<Text>(find.text('Ship it'));
      expect(completed.style?.decoration, TextDecoration.lineThrough);
      final pending = tester.widget<Text>(find.text('Write tests'));
      expect(pending.style?.decoration, isNot(TextDecoration.lineThrough));
      expect(tester.takeException(), isNull);
    });

    testWidgets('renders widened PR fields on the PR card', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
            prStatuses: [
              RemoteWorktreePr(
                prNumber: 42,
                state: 'open',
                title: 'Add feature X',
                checkStatus: 'failing',
                reviewStatus: 'changes-requested',
                hasConflicts: true,
                commentCount: 3,
              ),
              // When the desktop reports unresolved review threads, that
              // count replaces the raw comment tally (desktop/web parity).
              RemoteWorktreePr(
                prNumber: 43,
                state: 'open',
                title: 'Add feature Y',
                commentCount: 9,
                unresolvedReviewThreadCount: 2,
              ),
            ],
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();

      expect(find.text('PR #42 · Add feature X'), findsOneWidget);
      expect(
        find.text(
          'checks failing · changes requested · conflicts · 3 comments',
        ),
        findsOneWidget,
      );
      expect(find.text('PR #43 · Add feature Y'), findsOneWidget);
      expect(find.text('2 unresolved threads'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('paused hooks strike through and toggle resume', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
        raw: const {
          'hookDescriptors': [
            {
              'name': 'Lint on save',
              'hookKey': 'hook-lint',
              'triggerName': 'file_saved',
              'worktreeLocalId': 'wt-1',
              'paused': true,
              'runDisabled': true,
              'runDisabledReason': 'Agent is busy',
            },
          ],
        },
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();

      final name = tester.widget<Text>(find.text('Lint on save'));
      expect(name.style?.decoration, TextDecoration.lineThrough);
      expect(find.text('Agent is busy'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('hook-toggle-hook-lint')));
      await tester.pumpAndSettle();

      // Currently paused → the toggle resumes.
      expect(repository.lastHooksPausedHookKey, 'hook-lint');
      expect(repository.lastHooksPausedValue, isFalse);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the Scripts card lists configured scripts that never ran', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
        raw: const {
          'scriptDescriptors': [
            {
              'worktreeLocalId': 'wt-1',
              'scriptKey': 'project:setup',
              'scriptName': 'setup',
              'name': 'setup',
              'target': 'project',
            },
            {
              'worktreeLocalId': 'wt-1',
              'scriptKey': 'project:storybook',
              'scriptName': 'storybook',
              'name': 'Storybook',
              'target': 'project',
            },
          ],
          'scriptRuns': [
            {
              'worktreeLocalId': 'wt-1',
              'scriptKey': 'project:setup',
              'name': 'setup',
              'status': 'failed',
              'startedAt': '2026-10-17T10:00:00Z',
            },
            {
              'worktreeLocalId': 'wt-1',
              'scriptKey': 'project:setup',
              'name': 'setup',
              'status': 'completed',
              'startedAt': '2026-10-17T11:00:00Z',
            },
          ],
        },
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();
      // The Hooks card follows Scripts, so the whole Scripts card is built.
      await tester.scrollUntilVisible(
        find.text('Hooks'),
        200,
        scrollable: find.byType(Scrollable).last,
      );

      // One row per script: the latest setup run, and no status for the
      // script that never ran.
      expect(find.text('setup'), findsOneWidget);
      expect(find.text('completed'), findsOneWidget);
      expect(find.text('failed'), findsNothing);
      expect(find.text('Storybook'), findsOneWidget);
      final storybookRow = find.ancestor(
        of: find.text('Storybook'),
        matching: find.byType(Row),
      );
      expect(
        find.descendant(of: storybookRow.first, matching: find.byType(Text)),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    /// Opens the Files tab on one worktree whose changed files carry
    /// porcelain status codes: two uncommitted root files and one
    /// committed one.
    Future<void> openPorcelainChangedFiles(WidgetTester tester) async {
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
        raw: const {
          'changedFiles': {
            'wt-1': {
              'worktreeLocalId': 'wt-1',
              'uncommitted': [
                {'filePath': 'a.dart', 'status': 'A'},
                {'filePath': 'd.dart', 'status': 'D'},
              ],
              'committed': [
                {'filePath': 'm.dart', 'status': 'M'},
              ],
            },
          },
        },
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Files'));
      await tester.pumpAndSettle();
    }

    testWidgets('accepts porcelain changed-file status codes', (tester) async {
      usePhoneViewport(tester);
      await openPorcelainChangedFiles(tester);

      // Porcelain codes map to the same status-dot colors as word statuses.
      // (A dot, not an action glyph — a pencil icon would read as an edit
      // affordance on a read-only list.)
      Color? leadingDotColorFor(String path) {
        final dot = tester.widget<Container>(
          find.descendant(
            of: find.byKey(ValueKey('changed-file::$path')),
            matching: find.byType(Container),
          ),
        );
        final decoration = dot.decoration;
        decoration as BoxDecoration;
        return decoration.color;
      }

      expect(leadingDotColorFor('a.dart'), StatusColors.light.success);
      expect(leadingDotColorFor('d.dart'), StatusColors.light.destructive);
      expect(leadingDotColorFor('m.dart'), StatusColors.light.neutral);

      // Color is never the only cue: each row also shows the normalized
      // status word, which assistive tech reads with the file name.
      Finder rowText(String path, String text) => find.descendant(
        of: find.byKey(ValueKey('changed-file::$path')),
        matching: find.text(text),
      );
      expect(rowText('a.dart', 'Added'), findsOneWidget);
      expect(rowText('d.dart', 'Deleted'), findsOneWidget);
      expect(rowText('m.dart', 'Modified'), findsOneWidget);
      Finder semanticsLabel(String label) => find.byWidgetPredicate(
        (widget) => widget is Semantics && widget.properties.label == label,
      );
      expect(semanticsLabel('a.dart, Added'), findsOneWidget);
      expect(semanticsLabel('d.dart, Deleted'), findsOneWidget);
      expect(semanticsLabel('m.dart, Modified'), findsOneWidget);
      expect(
        tester
            .widget<Semantics>(semanticsLabel('a.dart, Added'))
            .properties
            .onTap,
        isNotNull,
      );
      // Committed-ness reads from sentence-case section headers; root
      // files sit under a `/` directory header.
      expect(find.text('Uncommitted'), findsOneWidget);
      expect(find.text('Committed'), findsOneWidget);
      expect(find.text('UNCOMMITTED'), findsNothing);
      expect(find.text('COMMITTED'), findsNothing);
      expect(find.text('/'), findsNWidgets(2));
      expect(tester.takeException(), isNull);
    });

    // DESIGN.md: touch targets at least 44 x 44. Covers a small phone and
    // dense (scaled-down) text, where the compact row is shortest, and
    // enlarged text at the same width, where it must not overflow.
    for (final (width, textScale) in const [
      (390.0, 1.0),
      (320.0, 0.85),
      (320.0, 2.0),
    ]) {
      testWidgets('changed-file rows are at least 44px tall at '
          '${width.toInt()}px wide with ${textScale}x text', (tester) async {
        tester.view.physicalSize = Size(width * 3, 2532);
        tester.view.devicePixelRatio = 3.0;
        tester.platformDispatcher.textScaleFactorTestValue = textScale;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await openPorcelainChangedFiles(tester);

        for (final path in const ['a.dart', 'd.dart', 'm.dart']) {
          final row = find.byKey(ValueKey('changed-file::$path'));
          final size = tester.getSize(row);
          expect(size.height, greaterThanOrEqualTo(44), reason: path);
          expect(size.width, greaterThanOrEqualTo(44), reason: path);
        }
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('standalone chats open the read-only workspace panel', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [
          RemoteWorkspace(
            localId: 'p',
            name: 'Research notes',
            type: RemoteWorkspaceType.cowork,
          ),
        ],
        worktrees: [],
        standaloneChats: [
          RemoteStandaloneChat(
            localId: 'c',
            projectLocalId: 'p',
            title: 'Cowork',
          ),
        ],
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));

      await tester.pumpWidget(
        host(
          vm,
          RemoteChatScreen.standalone(
            standaloneChat: vm.standaloneChatsFor('p').single,
          ),
        ),
      );
      await tester.pump();

      // The worktree activity drawer stays worktree-only, but cowork gets
      // the web-parity read-only Workspace panel instead of nothing.
      expect(find.byKey(const ValueKey('open-activity')), findsNothing);
      final openPanel = find.byKey(const ValueKey('open-workspace-panel'));
      expect(openPanel, findsOneWidget);
      await tester.tap(openPanel);
      await tester.pumpAndSettle();

      expect(find.text('PROJECT'), findsOneWidget);
      expect(find.text('Research notes'), findsOneWidget);
      // The desktop's real cowork workspace-item cards — no removed
      // features (Context/Artifacts) may appear here.
      expect(find.text('Notes'), findsOneWidget);
      expect(find.text('Prompts'), findsOneWidget);
      expect(find.text('Attachments'), findsOneWidget);
      expect(find.text('Context'), findsNothing);
      expect(find.text('Artifacts'), findsNothing);
      expect(tester.takeException(), isNull);

      // Drain the standalone transcript hydration watchdog before teardown.
      await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
    });

    testWidgets('renders the PR creation checklist from pushed progress', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: RemoteWorktree.fromJson({
                'localId': 'wt-1',
                'workspaceLocalId': 'ws-1',
                'branch': 'feature',
              }),
              activity: const RemoteWorktreeActivity(),
              prProgress: RemotePrProgressState(
                creation: RemotePrCreationProgress.fromJson({
                  'currentPhase': 'summarizing',
                  'steps': [
                    {'phase': 'gathering_changes'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      // Not pumpAndSettle: an active checklist step renders an indeterminate
      // CircularProgressIndicator, which never settles.
      await tester.pump();

      expect(find.byType(CanopyProgressChecklist), findsOneWidget);
      expect(find.text('Creating'), findsOneWidget);
      expect(find.text('Gathering changes'), findsOneWidget);
      expect(find.text('Summarizing changes'), findsOneWidget);
      expect(find.text('Pushing to remote'), findsOneWidget);
      expect(find.text('Creating pull request'), findsOneWidget);
    });

    testWidgets('prefers the merge checklist over the creation one', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: RemoteWorktree.fromJson({
                'localId': 'wt-1',
                'workspaceLocalId': 'ws-1',
                'branch': 'feature',
              }),
              activity: const RemoteWorktreeActivity(),
              prProgress: RemotePrProgressState(
                creation: RemotePrCreationProgress.fromJson({
                  'currentPhase': 'done',
                  'steps': [
                    {'phase': 'done'},
                  ],
                }),
                merge: RemoteMergePrProgress.fromJson({
                  'currentPhase': 'waiting_mergeability',
                  'steps': [
                    {'phase': 'checking_mergeability'},
                    {'phase': 'waiting_mergeability', 'retryDelayMs': 4000},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      // Not pumpAndSettle: an active checklist step renders an indeterminate
      // CircularProgressIndicator, which never settles.
      await tester.pump();

      expect(find.text('Merging'), findsOneWidget);
      expect(find.text('Checking mergeability'), findsOneWidget);
      expect(find.text('Waiting for GitHub (4s)'), findsOneWidget);
      expect(find.text('Gathering changes'), findsNothing);
    });

    testWidgets('merge checklist owns the only progress spinner', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: const RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'feature',
                mergingPr: true,
                mergePrPhase: 'merging',
              ),
              activity: const RemoteWorktreeActivity(),
              runPrAction:
                  (
                    action, {
                    repoId,
                    identity,
                    confirmUnresolvedComments = false,
                  }) async => prState(merge: true),
              cachedPrRepos: reposFrom(prState(merge: true)),
              prProgress: RemotePrProgressState(
                merge: RemoteMergePrProgress.fromJson({
                  'currentPhase': 'merging',
                  'steps': [
                    {'phase': 'checking_mergeability'},
                    {'phase': 'merging'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      final button = find.byKey(const ValueKey('merge-pr-repo-1'));
      expect(button, findsOneWidget);
      expect(find.byType(CanopyProgressChecklist), findsOneWidget);
      expect(
        find.descendant(
          of: button,
          matching: find.byType(CircularProgressIndicator),
        ),
        findsNothing,
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets(
      'keeps sibling PR actions disabled until merge command returns',
      (tester) async {
        usePhoneViewport(tester);
        final pendingMerge = Completer<Map<String, dynamic>>();
        const cachedRepos = [
          RemotePrRepo(
            repoId: 'target',
            repoName: 'Target',
            baseBranch: 'develop',
            headBranch: 'feature',
            canMerge: true,
            pr: RemoteWorktreePr(
              prNumber: 42,
              url: 'https://github.com/acme/target/pull/42',
              state: 'open',
            ),
          ),
          RemotePrRepo(
            repoId: 'sibling',
            repoName: 'Sibling',
            baseBranch: 'develop',
            headBranch: 'feature',
            canCreate: true,
          ),
        ];
        Future<Map<String, dynamic>> runner(
          RemotePrAction action, {
          String? repoId,
          RemotePrActionIdentity? identity,
          bool confirmUnresolvedComments = false,
        }) => action == RemotePrAction.merge
            ? pendingMerge.future
            : Future.value(<String, dynamic>{'repos': []});

        Widget buildDrawer(RemoteWorktree worktree) => MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: worktree,
              activity: const RemoteWorktreeActivity(),
              runPrAction: runner,
              cachedPrRepos: cachedRepos,
            ),
          ),
        );
        await tester.pumpWidget(
          buildDrawer(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'feature',
            ),
          ),
        );
        await tester.tap(find.byKey(const ValueKey('merge-pr-target')));
        await tester.pump();

        await tester.pumpWidget(
          buildDrawer(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'feature',
              prStatuses: [
                RemoteWorktreePr(
                  prNumber: 42,
                  url: 'https://github.com/acme/target/pull/42',
                  state: 'merged',
                ),
              ],
            ),
          ),
        );
        await tester.pump();

        expect(find.byKey(const ValueKey('merge-pr-target')), findsNothing);
        expect(
          tester
              .widget<CanopyButton>(
                find.byKey(const ValueKey('create-pr-sibling')),
              )
              .onPressed,
          isNull,
        );
        expect(find.byType(CircularProgressIndicator), findsNothing);

        pendingMerge.complete({'repos': []});
        await tester.pump();
      },
    );

    testWidgets('hides a completed creation checklist once the PR arrives', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              // The host never clears a successful creation feed, so without
              // a render gate this checklist would be permanent.
              worktree: RemoteWorktree.fromJson({
                'localId': 'wt-1',
                'workspaceLocalId': 'ws-1',
                'branch': 'feature',
                'lastKnownPrStatus': {
                  'repos': [
                    {
                      'status': {'state': 'open', 'prNumber': 7},
                    },
                  ],
                },
              }),
              activity: const RemoteWorktreeActivity(),
              prProgress: RemotePrProgressState(
                creation: RemotePrCreationProgress.fromJson({
                  'currentPhase': 'done',
                  'steps': [
                    {'phase': 'gathering_changes'},
                    {'phase': 'done'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(CanopyProgressChecklist), findsNothing);
      expect(find.text('Created'), findsNothing);
      expect(find.text('PR #7'), findsOneWidget);
    });

    testWidgets('keeps completed merge visible until the PR is merged', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: RemoteWorktree.fromJson({
                'localId': 'wt-1',
                'workspaceLocalId': 'ws-1',
                'branch': 'feature',
                'lastKnownPrStatus': {
                  'repos': [
                    {
                      'status': {'state': 'open', 'prNumber': 7},
                    },
                  ],
                },
              }),
              activity: const RemoteWorktreeActivity(),
              prProgress: RemotePrProgressState(
                merge: RemoteMergePrProgress.fromJson({
                  'currentPhase': 'done',
                  'steps': [
                    {'phase': 'merging'},
                    {'phase': 'done'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(CanopyProgressChecklist), findsOneWidget);
      expect(find.text('Merged'), findsOneWidget);
      expect(find.text('PR #7'), findsOneWidget);
    });

    testWidgets(
      'does not retire completed creation for a sibling repository PR',
      (tester) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: RemoteActivitySidebar(
                worktree: const RemoteWorktree(
                  localId: 'wt-1',
                  workspaceLocalId: 'ws-1',
                  branch: 'feature',
                ),
                activity: const RemoteWorktreeActivity(),
                runPrAction:
                    (
                      action, {
                      repoId,
                      identity,
                      confirmUnresolvedComments = false,
                    }) async => {
                      'repos': [
                        {
                          'repoId': 'target',
                          'repoName': 'Target',
                          'status': null,
                        },
                        {
                          'repoId': 'sibling',
                          'repoName': 'Sibling',
                          'status': {'state': 'open', 'number': 7},
                        },
                      ],
                    },
                cachedPrRepos: const [
                  RemotePrRepo(repoId: 'target', repoName: 'Target'),
                  RemotePrRepo(
                    repoId: 'sibling',
                    repoName: 'Sibling',
                    pr: RemoteWorktreePr(prNumber: 7, state: 'open'),
                  ),
                ],
                prProgress: RemotePrProgressState(
                  creation: RemotePrCreationProgress.fromJson({
                    'currentPhase': 'done',
                    'steps': [
                      {'phase': 'creating_pr', 'repoName': 'Target'},
                      {'phase': 'done', 'repoName': 'Target'},
                    ],
                  }),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byType(CanopyProgressChecklist), findsOneWidget);
        expect(find.text('Created'), findsOneWidget);
        expect(find.text('PR #7'), findsOneWidget);
      },
    );

    testWidgets('does not retire completed creation for a stale terminal PR', (
      tester,
    ) async {
      usePhoneViewport(tester);

      for (final staleState in ['closed', 'merged']) {
        await tester.pumpWidget(
          MaterialApp(
            key: ValueKey(staleState),
            home: Scaffold(
              body: RemoteActivitySidebar(
                worktree: const RemoteWorktree(
                  localId: 'wt-1',
                  workspaceLocalId: 'ws-1',
                  branch: 'feature',
                ),
                activity: const RemoteWorktreeActivity(),
                runPrAction:
                    (
                      action, {
                      repoId,
                      identity,
                      confirmUnresolvedComments = false,
                    }) async => {
                      'repos': [
                        {
                          'repoId': 'target',
                          'repoName': 'Target',
                          'status': {'state': staleState, 'number': 7},
                        },
                      ],
                    },
                prProgress: RemotePrProgressState(
                  creation: RemotePrCreationProgress.fromJson({
                    'currentPhase': 'done',
                    'steps': [
                      {'phase': 'creating_pr', 'repoName': 'Target'},
                      {'phase': 'done', 'repoName': 'Target'},
                    ],
                  }),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byType(CanopyProgressChecklist),
          findsOneWidget,
          reason: 'A stale $staleState PR must not confirm new creation.',
        );
        expect(find.text('Created'), findsOneWidget);
      }
    });

    testWidgets(
      'keeps repository-scoped creation visible until repo details load',
      (tester) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: RemoteActivitySidebar(
                worktree: RemoteWorktree.fromJson({
                  'localId': 'wt-1',
                  'workspaceLocalId': 'ws-1',
                  'branch': 'feature',
                  'lastKnownPrStatus': {
                    'repos': [
                      {
                        'repoId': 'sibling',
                        'status': {'state': 'open', 'prNumber': 7},
                      },
                    ],
                  },
                }),
                activity: const RemoteWorktreeActivity(),
                prProgress: RemotePrProgressState(
                  creation: RemotePrCreationProgress.fromJson({
                    'currentPhase': 'done',
                    'steps': [
                      {'phase': 'creating_pr', 'repoName': 'Target'},
                      {'phase': 'done', 'repoName': 'Target'},
                    ],
                  }),
                ),
              ),
            ),
          ),
        );
        await tester.pump();

        expect(find.byType(CanopyProgressChecklist), findsOneWidget);
        expect(find.text('Created'), findsOneWidget);
      },
    );

    testWidgets('does not retire completed merge for a sibling merged PR', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: const RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'feature',
                prStatuses: [
                  RemoteWorktreePr(
                    prNumber: 7,
                    url: 'https://github.com/acme/sibling/pull/7',
                    state: 'merged',
                  ),
                  RemoteWorktreePr(
                    prNumber: 6,
                    url: 'https://github.com/acme/target/pull/6',
                    state: 'merged',
                  ),
                ],
              ),
              activity: const RemoteWorktreeActivity(),
              runPrAction:
                  (
                    action, {
                    repoId,
                    identity,
                    confirmUnresolvedComments = false,
                  }) async => {
                    'repos': [
                      {
                        'repoId': 'target',
                        'repoName': 'Target',
                        'status': {'state': 'open', 'number': 8},
                      },
                      {
                        'repoId': 'sibling',
                        'repoName': 'Sibling',
                        'status': {'state': 'merged', 'number': 7},
                      },
                    ],
                  },
              cachedPrRepos: const [
                RemotePrRepo(
                  repoId: 'target',
                  repoName: 'Target',
                  baseBranch: 'develop',
                  headBranch: 'feature',
                  canMerge: true,
                  pr: RemoteWorktreePr(
                    prNumber: 7,
                    url: 'https://github.com/acme/target/pull/7',
                    state: 'open',
                  ),
                ),
                RemotePrRepo(
                  repoId: 'sibling',
                  repoName: 'Sibling',
                  pr: RemoteWorktreePr(
                    prNumber: 7,
                    url: 'https://github.com/acme/sibling/pull/7',
                    state: 'merged',
                  ),
                ),
              ],
              prProgress: RemotePrProgressState(
                merge: RemoteMergePrProgress.fromJson({
                  'currentPhase': 'done',
                  'steps': [
                    {'phase': 'done', 'repoId': 'target', 'repoName': 'Target'},
                    {'phase': 'done'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(CanopyProgressChecklist), findsOneWidget);
      expect(find.text('Merged'), findsOneWidget);
      expect(find.text('PR #7'), findsNWidgets(2));
      expect(find.text('open'), findsOneWidget);
      expect(find.byKey(const ValueKey('merge-pr-target')), findsOneWidget);
    });

    testWidgets(
      'keeps repository-scoped merge visible until repo details load',
      (tester) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: RemoteActivitySidebar(
                worktree: RemoteWorktree.fromJson({
                  'localId': 'wt-1',
                  'workspaceLocalId': 'ws-1',
                  'branch': 'feature',
                  'lastKnownPrStatus': {
                    'repos': [
                      {
                        'repoId': 'sibling',
                        'status': {'state': 'merged', 'prNumber': 7},
                      },
                    ],
                  },
                }),
                activity: const RemoteWorktreeActivity(),
                prProgress: RemotePrProgressState(
                  merge: RemoteMergePrProgress.fromJson({
                    'currentPhase': 'done',
                    'steps': [
                      {
                        'phase': 'done',
                        'repoId': 'target',
                        'repoName': 'Target',
                      },
                      {'phase': 'done'},
                    ],
                  }),
                ),
              ),
            ),
          ),
        );
        await tester.pump();

        expect(find.byType(CanopyProgressChecklist), findsOneWidget);
        expect(find.text('Merged'), findsOneWidget);
      },
    );

    testWidgets('does not retire completed merge for a closed PR', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: const RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'feature',
              ),
              activity: const RemoteWorktreeActivity(),
              runPrAction:
                  (
                    action, {
                    repoId,
                    identity,
                    confirmUnresolvedComments = false,
                  }) async => {
                    'repos': [
                      {
                        'repoId': 'target',
                        'repoName': 'Target',
                        'status': {'state': 'closed', 'number': 8},
                      },
                    ],
                  },
              cachedPrRepos: const [
                RemotePrRepo(
                  repoId: 'target',
                  repoName: 'Target',
                  pr: RemoteWorktreePr(prNumber: 8, state: 'closed'),
                ),
              ],
              prProgress: RemotePrProgressState(
                merge: RemoteMergePrProgress.fromJson({
                  'currentPhase': 'done',
                  'steps': [
                    {'phase': 'done', 'repoId': 'target', 'repoName': 'Target'},
                    {'phase': 'done'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(CanopyProgressChecklist), findsOneWidget);
      expect(find.text('Merged'), findsOneWidget);
      expect(find.text('PR #8'), findsOneWidget);
    });

    testWidgets('keeps a failed checklist visible after the PR arrives', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: RemoteWorktree.fromJson({
                'localId': 'wt-1',
                'workspaceLocalId': 'ws-1',
                'branch': 'feature',
                'lastKnownPrStatus': {
                  'repos': [
                    {
                      'status': {'state': 'open', 'prNumber': 7},
                    },
                  ],
                },
              }),
              activity: const RemoteWorktreeActivity(),
              prProgress: RemotePrProgressState(
                merge: RemoteMergePrProgress.fromJson({
                  'currentPhase': 'error',
                  'steps': [
                    {'phase': 'merging'},
                    {'phase': 'error', 'error': 'merge conflict'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(CanopyProgressChecklist), findsOneWidget);
      expect(find.text('Failed'), findsOneWidget);
      expect(find.text('merge conflict'), findsOneWidget);
    });

    testWidgets('a settled merge feed does not mask a live creation one', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: RemoteWorktree.fromJson({
                'localId': 'wt-1',
                'workspaceLocalId': 'ws-1',
                'branch': 'feature',
                'lastKnownPrStatus': {
                  'repos': [
                    {
                      'status': {'state': 'merged', 'prNumber': 7},
                    },
                  ],
                },
              }),
              activity: const RemoteWorktreeActivity(),
              prProgress: RemotePrProgressState(
                // A merge that finished earlier in this desktop process; the
                // undefined-valued clear delta never reached the client.
                merge: RemoteMergePrProgress.fromJson({
                  'currentPhase': 'done',
                  'steps': [
                    {'phase': 'merging'},
                    {'phase': 'done'},
                  ],
                }),
                creation: RemotePrCreationProgress.fromJson({
                  'currentPhase': 'pushing',
                  'steps': [
                    {'phase': 'gathering_changes'},
                    {'phase': 'pushing'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      // Not pumpAndSettle: an active checklist step renders an indeterminate
      // CircularProgressIndicator, which never settles.
      await tester.pump();

      expect(find.text('Merged'), findsNothing);
      expect(find.text('Creating'), findsOneWidget);
      expect(find.text('Pushing to remote'), findsOneWidget);
    });

    testWidgets('a failed merge feed does not mask a live creation one', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: const RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'feature',
              ),
              activity: const RemoteWorktreeActivity(),
              prProgress: RemotePrProgressState(
                merge: RemoteMergePrProgress.fromJson({
                  'currentPhase': 'error',
                  'steps': [
                    {'phase': 'merging'},
                    {'phase': 'error', 'error': 'merge conflict'},
                  ],
                }),
                creation: RemotePrCreationProgress.fromJson({
                  'currentPhase': 'pushing',
                  'steps': [
                    {'phase': 'gathering_changes'},
                    {'phase': 'pushing'},
                  ],
                }),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('Failed'), findsNothing);
      expect(find.text('Creating'), findsOneWidget);
      expect(find.text('Pushing to remote'), findsOneWidget);
    });

    testWidgets('falls back to the flat label when no feed is pushed', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RemoteActivitySidebar(
              // A merging worktree from an older host: worktree flags only,
              // no pushed feed.
              worktree: RemoteWorktree.fromJson({
                'localId': 'wt-1',
                'workspaceLocalId': 'ws-1',
                'branch': 'feature',
                'mergingPr': true,
                'mergePrPhase': 'merging',
              }),
              activity: const RemoteWorktreeActivity(),
            ),
          ),
        ),
      );
      // Not pumpAndSettle: the flat fallback row renders an indeterminate
      // CircularProgressIndicator (see the sibling merge-progress tests
      // above), which never settles.
      await tester.pump();

      expect(find.byType(CanopyProgressChecklist), findsNothing);
      expect(find.text('Merging pull request'), findsOneWidget);
    });
  });

  group('CAN-3644 Files tab load states', () {
    const worktree = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature',
    );
    final cached = RemoteWorktreeActivity(
      changedFiles: [
        for (var i = 0; i < 40; i++)
          RemoteChangedFile(
            filePath: 'lib/billing/file_$i.dart',
            status: 'modified',
            committed: false,
            insertions: i,
          ),
      ],
    );
    const failed = ChangedFilesLoadStatus.failed(kChangedFilesLoadFailed);

    Future<void> pumpFiles(
      WidgetTester tester, {
      required RemoteWorktreeActivity activity,
      required ChangedFilesLoadStatus status,
      VoidCallback? onRetry,
      ThemeMode themeMode = ThemeMode.light,
      bool reduceMotion = false,
    }) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: themeMode,
          home: MediaQuery(
            data: const MediaQueryData(
              size: Size(390, 844),
            ).copyWith(disableAnimations: reduceMotion),
            child: Scaffold(
              body: RemoteActivitySidebar(
                worktree: worktree,
                activity: activity,
                changedFilesStatus: status,
                onRetryChangedFiles: onRetry,
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Files'));
      // Bounded: a loading spinner animates until the load settles.
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Rect filesTabBounds(WidgetTester tester) =>
        tester.getRect(find.byType(TabBarView));

    for (final themeMode in [ThemeMode.light, ThemeMode.dark]) {
      testWidgets('an unknown list loads instead of reading as empty '
          '(${themeMode.name})', (tester) async {
        await pumpFiles(
          tester,
          activity: const RemoteWorktreeActivity(),
          status: ChangedFilesLoadStatus.loading,
          themeMode: themeMode,
        );
        expect(find.text('Loading changed files…'), findsOneWidget);
        expect(find.byType(LoadingSpinner), findsOneWidget);
        expect(find.text('No changed files.'), findsNothing);
        expect(tester.takeException(), isNull);
      });

      testWidgets('a failed load offers Retry, never the empty state '
          '(${themeMode.name})', (tester) async {
        var retries = 0;
        await pumpFiles(
          tester,
          activity: const RemoteWorktreeActivity(),
          status: failed,
          onRetry: () => retries++,
          themeMode: themeMode,
        );
        expect(find.text(kChangedFilesLoadFailed), findsOneWidget);
        expect(find.text('No changed files.'), findsNothing);
        expect(find.byType(LoadingSpinner), findsNothing);
        final retry = find.byKey(const ValueKey('retry-changed-files'));
        expect(tester.getSize(retry).height, greaterThanOrEqualTo(44));
        await tester.tap(retry);
        expect(retries, 1);
        expect(tester.takeException(), isNull);
      });

      for (final withCache in [false, true]) {
        testWidgets('offline ${withCache ? 'over cached files ' : ''}'
            'explains how to recover and offers no Retry '
            '(${themeMode.name})', (tester) async {
          var retries = 0;
          await pumpFiles(
            tester,
            activity: withCache ? cached : const RemoteWorktreeActivity(),
            status: ChangedFilesLoadStatus.offline,
            onRetry: () => retries++,
            themeMode: themeMode,
          );
          expect(find.text(kChangedFilesOffline), findsOneWidget);
          expect(
            find.byKey(const ValueKey('retry-changed-files')),
            findsNothing,
          );
          expect(find.text('Retry'), findsNothing);
          expect(find.text('No changed files.'), findsNothing);
          expect(find.byType(LoadingSpinner), findsNothing);
          expect(
            find.text('file_0.dart'),
            withCache ? findsOneWidget : findsNothing,
          );
          expect(retries, 0);
          expect(tester.takeException(), isNull);
        });
      }

      testWidgets('cached files stay with one compact loading line '
          '(${themeMode.name})', (tester) async {
        await pumpFiles(
          tester,
          activity: cached,
          status: ChangedFilesLoadStatus.loading,
          themeMode: themeMode,
        );
        expect(find.text('file_0.dart'), findsOneWidget);
        expect(find.text('Checking for changes…'), findsOneWidget);
        expect(find.byType(LoadingSpinner), findsOneWidget);
        expect(find.text('Loading changed files…'), findsNothing);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a settled empty list keeps the existing empty state', (
      tester,
    ) async {
      await pumpFiles(
        tester,
        activity: const RemoteWorktreeActivity(),
        status: ChangedFilesLoadStatus.loaded,
      );
      expect(find.text('No changed files.'), findsOneWidget);
      expect(find.byType(LoadingSpinner), findsNothing);
      expect(find.byKey(const ValueKey('retry-changed-files')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a failed refresh keeps the cached files with Retry', (
      tester,
    ) async {
      var retries = 0;
      await pumpFiles(
        tester,
        activity: cached,
        status: const ChangedFilesLoadStatus.failed(kChangedFilesTimedOut),
        onRetry: () => retries++,
      );
      expect(find.text('file_0.dart'), findsOneWidget);
      expect(find.text(kChangedFilesTimedOut), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('retry-changed-files')));
      expect(retries, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the tab keeps its bounds across load states', (tester) async {
      final bounds = <Rect>[];
      for (final (activity, status) in [
        (const RemoteWorktreeActivity(), ChangedFilesLoadStatus.loading),
        (const RemoteWorktreeActivity(), ChangedFilesLoadStatus.loaded),
        (const RemoteWorktreeActivity(), failed),
        (cached, ChangedFilesLoadStatus.loading),
        (cached, failed),
        (cached, ChangedFilesLoadStatus.loaded),
        (const RemoteWorktreeActivity(), ChangedFilesLoadStatus.offline),
        (cached, ChangedFilesLoadStatus.offline),
      ]) {
        await pumpFiles(tester, activity: activity, status: status);
        bounds.add(filesTabBounds(tester));
        expect(tester.takeException(), isNull);
      }
      expect(bounds.toSet(), hasLength(1));
    });

    testWidgets('refreshing keeps the list and its scroll position, then '
        'replaces the files', (tester) async {
      await pumpFiles(
        tester,
        activity: cached,
        status: ChangedFilesLoadStatus.loaded,
      );
      await tester.drag(find.text('file_1.dart'), const Offset(0, -300));
      await tester.pump();
      final listFinder = find.descendant(
        of: find.byKey(const ValueKey('changed-files-list')),
        matching: find.byType(Scrollable),
      );
      final offset = tester.state<ScrollableState>(listFinder).position.pixels;
      expect(offset, greaterThan(0));

      await pumpFiles(
        tester,
        activity: cached,
        status: ChangedFilesLoadStatus.loading,
      );
      expect(tester.state<ScrollableState>(listFinder).position.pixels, offset);

      await pumpFiles(
        tester,
        activity: const RemoteWorktreeActivity(
          changedFiles: [
            RemoteChangedFile(
              filePath: 'lib/replaced.dart',
              status: 'added',
              committed: false,
            ),
          ],
        ),
        status: ChangedFilesLoadStatus.loaded,
      );
      expect(find.text('replaced.dart'), findsOneWidget);
      expect(find.text('file_0.dart'), findsNothing);
      expect(find.text('Checking for changes…'), findsNothing);
    });

    testWidgets('loading is announced once, as a live region', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpFiles(
        tester,
        activity: const RemoteWorktreeActivity(),
        status: ChangedFilesLoadStatus.loading,
      );
      expect(
        tester.getSemantics(
          find.byKey(const ValueKey('changed-files-loading')),
        ),
        matchesSemantics(label: 'Loading changed files…', isLiveRegion: true),
      );
      expect(find.bySemanticsLabel('In progress'), findsNothing);
      semantics.dispose();
    });

    testWidgets('reduced motion leaves a static spinner', (tester) async {
      await pumpFiles(
        tester,
        activity: const RemoteWorktreeActivity(),
        status: ChangedFilesLoadStatus.loading,
        reduceMotion: true,
      );
      // No frames are scheduled once the static spinner is painted.
      await tester.pumpAndSettle();
      expect(find.text('Loading changed files…'), findsOneWidget);
      expect(tester.hasRunningAnimations, isFalse);
    });
  });
  group('Pull Requests card merge queue (CAN-4454)', () {
    Future<void> pumpDrawer(
      WidgetTester tester, {
      Map<String, dynamic> Function()? mergeResult,
      bool cached = true,
      bool dark = false,
      double textScale = 1,
    }) async {
      tester.view.physicalSize = const Size(390, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(textScale)),
            child: child!,
          ),
          home: Scaffold(
            body: RemoteActivitySidebar(
              worktree: mergeQueueDrawerWorktree(),
              activity: const RemoteWorktreeActivity(),
              runPrAction:
                  (
                    action, {
                    String? repoId,
                    RemotePrActionIdentity? identity,
                    bool confirmUnresolvedComments = false,
                  }) async => action == RemotePrAction.merge
                  ? mergeResult!()
                  : mergeQueuePrState(),
              cachedPrRepos: cached
                  ? [
                      for (final repo in mergeQueuePrState()['repos'] as List)
                        RemotePrRepo.fromJson(repo as Map<String, dynamic>),
                    ]
                  : null,
            ),
          ),
        ),
      );
      await tester.pump();
    }

    for (final cached in [true, false]) {
      testWidgets('a queued repo shows its queue state (cached: $cached)', (
        tester,
      ) async {
        await pumpDrawer(tester, cached: cached);
        expect(find.text('In merge queue'), findsOneWidget);
        expect(
          find.text('Position #2 · Awaiting queue checks'),
          findsOneWidget,
        );
        // The sibling stays a plain open PR.
        expect(find.text('open'), findsOneWidget);
        final state = tester.widget<Text>(find.text('In merge queue'));
        expect(state.style!.color, StatusColors.light.warning);
      });
    }

    testWidgets('Merge is hidden only for the queued repo', (tester) async {
      await pumpDrawer(tester);
      expect(find.byKey(const ValueKey('merge-pr-repo-app')), findsNothing);
      expect(find.byKey(const ValueKey('merge-pr-repo-web')), findsOneWidget);
      expect(find.byKey(const ValueKey('refresh-pr')), findsOneWidget);
      expect(find.byKey(const ValueKey('pr-link-4454')), findsOneWidget);
    });

    Map<String, dynamic> enqueued(int number, [int? position]) => {
      'repoId': 'repo-web',
      'repoName': 'web',
      'prNumber': number,
      'prUrl': mergeQueuePrUrl(number, repo: 'web'),
      'mergeMethod': 'squash',
      'mergeCommitSha': null,
      'status': 'enqueued',
      'queuePosition': position,
    };

    for (final entry in <String, (Map<String, dynamic>, String?)>{
      'one PR with a position': (
        {
          'mergedRepos': [enqueued(4455, 3)],
        },
        'Added #4455 to the merge queue (position 3).',
      ),
      'one PR without a position': (
        {
          'mergedRepos': [enqueued(4455)],
        },
        'Added #4455 to the merge queue.',
      ),
      'two PRs': (
        {
          'mergedRepos': [enqueued(4455, 1), enqueued(4456, 2)],
        },
        'Added 2 pull requests to the merge queue.',
      ),
      'a merged PR': (
        {
          'mergedRepos': [
            {...enqueued(4455), 'status': 'merged', 'mergeCommitSha': 'abc'},
          ],
        },
        null,
      ),
    }.entries) {
      testWidgets('Merge feedback for ${entry.key}', (tester) async {
        await pumpDrawer(tester, mergeResult: () => entry.value.$1);
        await tester.tap(find.byKey(const ValueKey('merge-pr-repo-web')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        final expected = entry.value.$2;
        if (expected == null) {
          expect(find.textContaining('to the merge queue'), findsNothing);
        } else {
          expect(find.text(expected), findsOneWidget);
        }
        expect(find.textContaining('Opened a chat'), findsNothing);
        await tester.pumpAndSettle(const Duration(seconds: 5));
      });
    }

    for (final dark in [false, true]) {
      testWidgets('fits a phone at text scale 2 (dark: $dark)', (tester) async {
        await pumpDrawer(tester, dark: dark, textScale: 2);
        expect(tester.takeException(), isNull);
        expect(find.text('In merge queue'), findsOneWidget);
      });
    }
  });
}
