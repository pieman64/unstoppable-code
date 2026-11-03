import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/pr_checks_list.dart';
import 'package:provider/provider.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/pr_checks_fixture.dart';

final class _HeldOverviewRepository extends FakeRemoteControlRepository {
  Completer<RemoteSessionSnapshot>? overview;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() =>
      overview?.future ?? super.fetchSnapshot();
}

/// CAN-3618: every GitHub CI check under each PR line in Activity & files,
/// driven through the real chat screen, drawer and Portal wire parser.
void main() {
  const urlLauncherChannel = MethodChannel('plugins.flutter.io/url_launcher');

  late Map<String, dynamic> hostState;
  late FakeRemoteControlRepository liveRepository;
  late int refreshCalls;
  late List<String> launched;
  late Object? Function(String url) launchResult;

  setUp(() {
    refreshCalls = 0;
    launched = [];
    launchResult = (_) => true;
  });

  void usePhoneViewport(WidgetTester tester, {double width = 390}) {
    tester.view.physicalSize = Size(width * 3, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
  }

  void mockUrlLauncher(WidgetTester tester) {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      urlLauncherChannel,
      (call) async {
        if (call.method != 'launch') return null;
        final arguments = call.arguments as Map<Object?, Object?>;
        final url = arguments['url'] as String;
        launched.add(url);
        final result = launchResult(url);
        if (result is Exception) throw result;
        return result;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        urlLauncherChannel,
        null,
      ),
    );
  }

  /// A running check animates indefinitely, so settle for a fixed time.
  Future<void> pumpFor(
    WidgetTester tester, [
    Duration duration = const Duration(milliseconds: 600),
  ]) async {
    const step = Duration(milliseconds: 50);
    for (var elapsed = Duration.zero; elapsed < duration; elapsed += step) {
      await tester.pump(step);
    }
  }

  Future<void> openDrawer(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await pumpFor(tester);
  }

  /// Dismisses the drawer through its scrim, as a user would.
  Future<void> closeDrawer(WidgetTester tester) async {
    await tester.tapAt(const Offset(12, 600));
    await pumpFor(tester);
  }

  Future<void> showChat(
    WidgetTester tester,
    Map<String, dynamic> initialState, {
    double width = 390,
    double textScale = 1,
    bool supportsPrStatusPush = false,
    RemoteWorktree worktree = const RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature',
      prStatuses: [
        RemoteWorktreePr(prNumber: 42, state: 'open', checkStatus: 'failing'),
      ],
    ),
    Future<Map<String, dynamic>> Function()? refresh,
    FakeRemoteControlRepository? repository,
  }) async {
    usePhoneViewport(tester, width: width);
    mockUrlLauncher(tester);
    hostState = initialState;
    repository ??= FakeRemoteControlRepository();
    repository
      ..supportsPrActions = true
      ..supportsPrStatusPush = supportsPrStatusPush
      ..prActionRunner =
          (
            action, {
            repoId,
            identity,
            confirmUnresolvedComments = false,
          }) async {
            if (action == RemotePrAction.refresh) refreshCalls++;
            return refresh?.call() ?? hostState;
          };
    liveRepository = repository;
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
    );
    final viewModel = RemoteControlViewModel(repository: repository);
    await tester.runAsync(() => viewModel.connect('123456'));
    await tester.pumpWidget(
      MultiProvider(
        providers: [
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
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(textScale)),
            child: child!,
          ),
          home: RemoteChatScreen.worktree(worktree: worktree),
        ),
      ),
    );
    await pumpFor(tester);
    await openDrawer(tester);
  }

  /// The chat screen has spinners of its own; only count the list's.
  final checkSpinner = find.descendant(
    of: find.byType(PrChecksList),
    matching: find.byType(DotSpinner),
  );

  Finder rowTarget(String name) =>
      find.ancestor(of: find.text(name), matching: find.byType(InkWell)).first;

  const nineLabels = [
    ('a11y-audit', 'Action required'),
    ('build-android', 'Running'),
    ('build-ios', 'Queued'),
    ('deploy-preview', 'Skipped'),
    ('e2e', 'Timed out'),
    ('license-scan', 'Neutral'),
    ('lint', 'Succeeded'),
    ('typecheck', 'Canceled'),
    ('unit-tests', 'Failed'),
  ];

  testWidgets('lists every check with its exact state under the PR', (
    tester,
  ) async {
    await showChat(
      tester,
      prChecksState([prChecksRepo(checks: nineStatePrChecks())]),
    );

    expect(find.text('Checks (1/9 passed)'), findsOneWidget);
    for (final (name, label) in nineLabels) {
      expect(find.text(name), findsOneWidget, reason: name);
      expect(find.text(label), findsOneWidget, reason: label);
    }
    // Host name order is kept.
    final tops = [
      for (final (name, _) in nineLabels) tester.getTopLeft(find.text(name)).dy,
    ];
    expect(tops, [...tops]..sort());
    // Only the running check moves.
    expect(checkSpinner, findsOneWidget);
    expect(
      find.descendant(
        of: rowTarget('build-android'),
        matching: find.byType(DotSpinner),
      ),
      findsOneWidget,
    );
    // The header replaces the summary's CI fragment.
    expect(find.textContaining('checks failing'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('collapses a passed list by default and toggles on tap', (
    tester,
  ) async {
    await showChat(
      tester,
      prChecksState([
        prChecksRepo(
          checkStatus: 'passing',
          checks: settledPrChecks(),
          reviewStatus: 'approved',
        ),
      ]),
    );

    expect(find.text('Checks (3/4 passed)'), findsOneWidget);
    expect(find.text('unit-tests'), findsNothing);
    // Other summary fragments stay; the CI one is owned by the header.
    expect(find.text('approved'), findsOneWidget);
    expect(find.textContaining('checks passing'), findsNothing);

    await tester.tap(find.text('Checks (3/4 passed)'));
    await pumpFor(tester);
    expect(find.text('unit-tests'), findsOneWidget);
    expect(find.text('Skipped'), findsOneWidget);

    await tester.tap(find.text('Checks (3/4 passed)'));
    await pumpFor(tester);
    expect(find.text('unit-tests'), findsNothing);
  });

  testWidgets(
    "keeps the user's choice through refreshes until the drawer closes",
    (tester) async {
      await showChat(
        tester,
        prChecksState([prChecksRepo(checks: nineStatePrChecks())]),
      );
      expect(find.text('unit-tests'), findsOneWidget);

      await tester.tap(find.text('Checks (1/9 passed)'));
      await pumpFor(tester);
      expect(find.text('unit-tests'), findsNothing);

      // A refresh with new checks and a new summary keeps the choice.
      hostState = prChecksState([
        prChecksRepo(
          checks: [
            prCheckDetail('lint', status: 'success', executionState: 'success'),
            prCheckDetail(
              'unit-tests',
              status: 'pending',
              executionState: 'running',
            ),
          ],
          checkStatus: 'pending',
        ),
      ]);
      await tester.tap(find.byKey(const ValueKey('refresh-pr')));
      await pumpFor(tester);
      expect(find.text('Checks (1/2 passed)'), findsOneWidget);
      expect(find.text('unit-tests'), findsNothing);

      // So does the chat screen's periodic refresh.
      final before = refreshCalls;
      await tester.pump(const Duration(minutes: 1));
      await pumpFor(tester);
      expect(refreshCalls, greaterThan(before));
      expect(find.text('unit-tests'), findsNothing);

      await closeDrawer(tester);
      expect(find.text('Checks (1/2 passed)'), findsNothing);
      await openDrawer(tester);
      expect(find.text('Checks (1/2 passed)'), findsOneWidget);
      expect(find.text('unit-tests'), findsOneWidget);
    },
  );

  testWidgets("keeps the user's choice through a failed refresh", (
    tester,
  ) async {
    var offline = false;
    await showChat(
      tester,
      prChecksState([prChecksRepo(checks: nineStatePrChecks())]),
      refresh: () async {
        if (offline) throw Exception('offline');
        return hostState;
      },
    );
    await tester.tap(find.text('Checks (1/9 passed)'));
    await pumpFor(tester);
    expect(find.text('unit-tests'), findsNothing);

    // The card falls back to the summary line and drops the list.
    offline = true;
    await tester.tap(find.byKey(const ValueKey('refresh-pr')));
    await pumpFor(tester);
    expect(find.text('offline'), findsOneWidget);
    expect(find.text('Checks (1/9 passed)'), findsNothing);
    expect(find.text('checks failing'), findsOneWidget);

    offline = false;
    await tester.tap(find.byKey(const ValueKey('refresh-pr')));
    await pumpFor(tester);
    expect(find.text('Checks (1/9 passed)'), findsOneWidget);
    expect(find.text('unit-tests'), findsNothing);
  });

  testWidgets("keeps the user's choice across the drawer's tabs", (
    tester,
  ) async {
    await showChat(
      tester,
      prChecksState([prChecksRepo(checks: nineStatePrChecks())]),
    );
    await tester.tap(find.text('Checks (1/9 passed)'));
    await pumpFor(tester);
    expect(find.text('unit-tests'), findsNothing);

    await tester.tap(find.text('Files'));
    await pumpFor(tester);
    await tester.tap(find.text('Activity'));
    await pumpFor(tester);
    expect(find.text('Checks (1/9 passed)'), findsOneWidget);
    expect(find.text('unit-tests'), findsNothing);
  });

  testWidgets('shows each refreshed state as a check runs to completion', (
    tester,
  ) async {
    Map<String, dynamic> stateWith(String status, String executionState) =>
        prChecksState([
          prChecksRepo(
            checkStatus: status == 'success' ? 'passing' : 'pending',
            checks: [
              prCheckDetail(
                'build',
                status: status,
                executionState: executionState,
              ),
            ],
          ),
        ]);

    await showChat(tester, stateWith('pending', 'queued'));
    expect(find.text('Queued'), findsOneWidget);
    expect(checkSpinner, findsNothing);

    hostState = stateWith('pending', 'running');
    await tester.tap(find.byKey(const ValueKey('refresh-pr')));
    await pumpFor(tester);
    expect(find.text('Running'), findsOneWidget);
    expect(checkSpinner, findsOneWidget);

    hostState = stateWith('success', 'success');
    await tester.tap(find.byKey(const ValueKey('refresh-pr')));
    await pumpFor(tester);
    // The list was expanded by default and has not been touched, so it
    // follows the new passing default.
    expect(find.text('Checks (1/1 passed)'), findsOneWidget);
    expect(checkSpinner, findsNothing);
    await tester.tap(find.text('Checks (1/1 passed)'));
    await pumpFor(tester);
    expect(find.text('Succeeded'), findsOneWidget);
  });

  testWidgets("shows an older desktop's four statuses", (tester) async {
    await showChat(
      tester,
      prChecksState([prChecksRepo(checks: legacyPrChecks())]),
    );

    expect(find.text('Checks (1/4 passed)'), findsOneWidget);
    for (final (name, label) in const [
      ('build', 'Succeeded'),
      ('coverage', 'Neutral'),
      ('lint', 'Pending'),
      ('tests', 'Failed'),
    ]) {
      expect(find.text(name), findsOneWidget, reason: name);
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(checkSpinner, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('reads unknown and malformed check states as Neutral', (
    tester,
  ) async {
    await showChat(
      tester,
      prChecksState([
        prChecksRepo(
          checks: [
            prCheckDetail('newer', status: 'pending', executionState: 'paused'),
            prCheckDetail('odd-coarse', status: 'exploded'),
            {'name': 'malformed', 'status': 7, 'executionState': false},
            {'status': 'success'},
            'not a check',
            prCheckDetail('lint', status: 'success', executionState: 'success'),
          ],
        ),
      ]),
    );

    expect(find.text('Checks (1/4 passed)'), findsOneWidget);
    expect(find.text('Neutral'), findsNWidgets(3));
    expect(find.text('lint'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('opens a check on GitHub and reports a failed launch', (
    tester,
  ) async {
    await showChat(
      tester,
      prChecksState([prChecksRepo(checks: legacyPrChecks())]),
    );

    await tester.tap(find.text('tests'));
    await pumpFor(tester);
    expect(launched, ['${prChecksJobUrl}tests']);
    // The row opens its check, never the parent PR, and keeps the drawer.
    expect(find.text('Checks (1/4 passed)'), findsOneWidget);

    // A row without a link cannot be tapped.
    expect(tester.widget<InkWell>(rowTarget('coverage')).onTap, isNull);
    await tester.tap(find.text('coverage'), warnIfMissed: false);
    await pumpFor(tester);
    expect(launched, hasLength(1));

    launchResult = (_) => false;
    await tester.tap(find.text('lint'));
    await pumpFor(tester);
    // Shown above the still-open drawer, not hidden behind it.
    expect(
      find.text('Could not open the check.').hitTestable(),
      findsOneWidget,
    );
    expect(find.text('Checks (1/4 passed)').hitTestable(), findsOneWidget);

    ScaffoldMessenger.of(tester.element(find.text('lint'))).clearSnackBars();
    await pumpFor(tester);
    launchResult = (_) => PlatformException(code: 'ACTIVITY_NOT_FOUND');
    await tester.tap(find.text('build'));
    await pumpFor(tester);
    expect(
      find.text('Could not open the check.').hitTestable(),
      findsOneWidget,
    );
  });

  testWidgets('reports a failed PR link launch above the open drawer', (
    tester,
  ) async {
    await showChat(
      tester,
      prChecksState([prChecksRepo(checks: legacyPrChecks())]),
    );

    launchResult = (_) => false;
    await tester.tap(find.text('PR #42 · Show CI checks on the phone'));
    await pumpFor(tester);
    expect(launched, ['https://github.com/acme/app/pull/42']);
    expect(
      find.text('Could not open the pull request.').hitTestable(),
      findsOneWidget,
    );
    expect(find.text('Checks (1/4 passed)').hitTestable(), findsOneWidget);
  });

  // Live `pr_status` deltas parse `checkDetails` into the worktree summary,
  // but only a refreshed card draws the list. Until a refresh lands, or after
  // one fails, the summary line must keep the CI status.
  for (final (label, refresh)
      in <(String, Future<Map<String, dynamic>> Function())>[
        (
          'before the first refresh',
          () => Completer<Map<String, dynamic>>().future,
        ),
        ('after a failed refresh', () async => throw Exception('offline')),
      ]) {
    testWidgets("keeps the summary's CI status $label", (tester) async {
      await showChat(
        tester,
        prChecksState(const []),
        worktree: RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
          prStatuses: [
            RemoteWorktreePr.fromPortal(
              prChecksRepo(checks: legacyPrChecks())['status']
                  as Map<String, dynamic>,
            ),
          ],
        ),
        refresh: refresh,
      );

      expect(find.text('PR #42 · Show CI checks on the phone'), findsOneWidget);
      expect(find.text('checks failing'), findsOneWidget);
      expect(find.textContaining('Checks ('), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  for (final updatedWorktree in ['other', 'wt-1']) {
    testWidgets(
      'unrelated $updatedWorktree updates do not restore a failed Create PR action',
      (tester) async {
        await showChat(
          tester,
          prChecksState([
            {...prChecksRepo(), 'status': null, 'canCreate': true},
          ]),
          supportsPrStatusPush: true,
          worktree: const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature',
          ),
        );
        final create = find.byKey(const ValueKey('create-pr-repo-app'));
        expect(create, findsOneWidget);
        final pending = Completer<Map<String, dynamic>>();
        liveRepository.prActionRunner =
            (action, {repoId, identity, confirmUnresolvedComments = false}) =>
                action == RemotePrAction.create
                ? pending.future
                : Future.value(hostState);
        await tester.tap(create);
        await pumpFor(tester);
        liveRepository.eventsController.add(
          RemotePortalEventBatch(
            nextCursor: 100,
            events: [
              RemoteStateDeltaEvent(
                cursor: 100,
                worktrees: [
                  RemoteWorktree(
                    localId: updatedWorktree,
                    workspaceLocalId: 'ws-1',
                    branch: updatedWorktree == 'wt-1' ? 'feature' : 'other',
                    label: 'Updated activity',
                  ),
                ],
              ),
            ],
          ),
        );
        await pumpFor(tester);
        pending.completeError(Exception('GitHub unavailable'));
        await pumpFor(tester);
        expect(find.text('GitHub unavailable'), findsOneWidget);
        expect(create, findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'unchanged empty host summary keeps PR and Merge across a raced overview',
    (tester) async {
      final repository = _HeldOverviewRepository();
      await showChat(
        tester,
        prChecksState([
          {...prChecksRepo(checkStatus: 'passing'), 'canMerge': true},
        ]),
        supportsPrStatusPush: true,
        repository: repository,
        worktree: const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
        ),
      );
      final merge = find.byKey(const ValueKey('merge-pr-repo-app'));
      expect(merge, findsOneWidget);
      final viewModel = tester
          .element(find.byType(RemoteChatScreen))
          .read<RemoteControlViewModel>();
      final overview = Completer<RemoteSessionSnapshot>();
      repository.overview = overview;
      final refresh = viewModel.refresh();
      await pumpFor(tester);
      final before = refreshCalls;
      final pending = Completer<Map<String, dynamic>>();
      addTearDown(() {
        if (!pending.isCompleted) pending.complete(hostState);
      });
      liveRepository.prActionRunner =
          (action, {repoId, identity, confirmUnresolvedComments = false}) {
            if (action == RemotePrAction.refresh) refreshCalls++;
            return pending.future;
          };
      liveRepository.eventsController.add(
        const RemotePortalEventBatch(
          nextCursor: 100,
          events: [
            RemoteStateDeltaEvent(
              cursor: 100,
              worktrees: [
                RemoteWorktree(
                  localId: 'wt-1',
                  workspaceLocalId: 'ws-1',
                  branch: 'feature',
                  label: 'Updated activity',
                ),
              ],
            ),
          ],
        ),
      );
      await pumpFor(tester);
      // The read began before the runtime row; it must keep that newer row's
      // action-read provenance. Hold any reconciliation read after this race.
      final followUp = Completer<RemoteSessionSnapshot>();
      repository.overview = followUp;
      overview.complete(repository.snapshotBuilder!());
      await pumpFor(tester);
      await refresh;
      liveRepository.eventsController.add(
        const RemotePortalEventBatch(
          nextCursor: 101,
          events: [
            RemoteStateDeltaEvent(
              cursor: 101,
              worktrees: [
                RemoteWorktree(
                  localId: 'wt-1',
                  workspaceLocalId: 'ws-1',
                  branch: 'feature',
                  label: 'Later activity',
                ),
              ],
            ),
          ],
        ),
      );
      await pumpFor(tester);
      expect(merge, findsOneWidget);
      expect(find.text('PR #42 · Show CI checks on the phone'), findsOneWidget);
      expect(refreshCalls, before);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('pushed readiness refreshes host merge eligibility once', (
    tester,
  ) async {
    await showChat(
      tester,
      prChecksState([prChecksRepo(checks: legacyPrChecks())]),
      supportsPrStatusPush: true,
    );
    final before = refreshCalls;
    final repo = prChecksRepo(
      checkStatus: 'passing',
      checks: settledPrChecks(),
    );
    hostState = prChecksState([
      {...repo, 'canMerge': true},
    ]);
    final viewModel = tester
        .element(find.byType(RemoteChatScreen))
        .read<RemoteControlViewModel>();
    expect(
      viewModel.cachedPrReposFor('ws-1', 'wt-1')!.single.canMerge,
      isFalse,
    );
    liveRepository.eventsController.add(
      RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.delta',
            'payload': {
              'scope': 'pr',
              'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
              'entities': [
                {
                  'entityType': 'pr_status',
                  'localId': 'wt-1',
                  'payload': {
                    'workspaceLocalId': 'ws-1',
                    'worktreeLocalId': 'wt-1',
                    'repos': [repo],
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    await pumpFor(tester);
    expect(find.text('Checks (3/4 passed)'), findsOneWidget);
    expect(find.text('Checks (1/4 passed)'), findsNothing);
    expect(refreshCalls, before + 1);
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await pumpFor(tester);
    expect(viewModel.cachedPrReposFor('ws-1', 'wt-1')!.single.canMerge, isTrue);
    expect(find.byKey(const ValueKey('merge-pr-repo-app')), findsOneWidget);
    await tester.pump(const Duration(minutes: 5));
    await pumpFor(tester);
    expect(refreshCalls, before + 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('does not offer non-web check links', (tester) async {
    await showChat(
      tester,
      prChecksState([
        prChecksRepo(
          checks: [
            prCheckDetail(
              'script',
              status: 'failure',
              detailsUrl: 'javascript:alert(1)',
            ),
            prCheckDetail('relative', status: 'failure', detailsUrl: '/job/1'),
            prCheckDetail('number', status: 'failure', detailsUrl: 42),
          ],
        ),
      ]),
    );

    for (final name in ['script', 'relative', 'number']) {
      expect(tester.widget<InkWell>(rowTarget(name)).onTap, isNull);
    }
  });

  testWidgets('gives each repository its own list and choice', (tester) async {
    await showChat(
      tester,
      prChecksState([
        prChecksRepo(checks: legacyPrChecks()),
        prChecksRepo(
          repoId: 'repo-api',
          repoName: 'API',
          checkStatus: 'passing',
          checks: settledPrChecks(),
        ),
      ]),
    );

    expect(find.text('Checks (1/4 passed)'), findsOneWidget);
    expect(find.text('Checks (3/4 passed)'), findsOneWidget);
    // The failing App list is open; the passed API list is not.
    expect(find.text('tests'), findsOneWidget);
    expect(find.text('unit-tests'), findsNothing);

    await tester.tap(find.text('Checks (3/4 passed)'));
    await pumpFor(tester);
    expect(find.text('unit-tests'), findsOneWidget);
    expect(find.text('tests'), findsOneWidget);

    // Both PRs are #42, so closing App must leave API open.
    await tester.tap(find.text('Checks (1/4 passed)'));
    await pumpFor(tester);
    expect(find.text('tests'), findsNothing);
    expect(find.text('unit-tests'), findsOneWidget);

    // The order flipping must not move either choice.
    hostState = prChecksState([
      prChecksRepo(
        repoId: 'repo-api',
        repoName: 'API',
        checkStatus: 'passing',
        checks: settledPrChecks(),
      ),
      prChecksRepo(checks: legacyPrChecks()),
    ]);
    await tester.tap(find.byKey(const ValueKey('refresh-pr')));
    await pumpFor(tester);
    expect(find.text('tests'), findsNothing);
    expect(find.text('unit-tests'), findsOneWidget);
  });

  for (final checks in <Object?>[null, const <Object?>[]]) {
    testWidgets("keeps today's summary when a PR has no checks ($checks)", (
      tester,
    ) async {
      await showChat(tester, prChecksState([prChecksRepo(checks: checks)]));

      expect(find.textContaining('Checks ('), findsNothing);
      expect(find.text('checks failing'), findsOneWidget);
    });
  }

  testWidgets('announces the header state and each check', (tester) async {
    final semantics = tester.ensureSemantics();
    await showChat(
      tester,
      prChecksState([prChecksRepo(checks: legacyPrChecks())]),
    );

    expect(
      tester.getSemantics(find.text('Checks (1/4 passed)')),
      matchesSemantics(
        label: 'Checks (1/4 passed)',
        isButton: true,
        hasTapAction: true,
        hasFocusAction: true,
        hasExpandedState: true,
        isExpanded: true,
        isFocusable: true,
      ),
    );
    expect(
      find.bySemanticsLabel('tests, Failed, opens in browser'),
      findsOneWidget,
    );
    expect(
      tester.getSemantics(find.bySemanticsLabel(RegExp('^tests, Failed'))),
      matchesSemantics(
        label: 'tests, Failed, opens in browser',
        isLink: true,
        hasTapAction: true,
        hasFocusAction: true,
        isFocusable: true,
      ),
    );
    expect(find.bySemanticsLabel('coverage, Neutral'), findsOneWidget);
    expect(
      tester.getSemantics(find.bySemanticsLabel('coverage, Neutral')),
      isNot(matchesSemantics(isLink: true)),
    );

    await tester.tap(find.text('Checks (1/4 passed)'));
    await pumpFor(tester);
    expect(
      tester.getSemantics(find.text('Checks (1/4 passed)')),
      matchesSemantics(
        label: 'Checks (1/4 passed)',
        isButton: true,
        hasTapAction: true,
        hasFocusAction: true,
        hasExpandedState: true,
        isFocusable: true,
      ),
    );
    semantics.dispose();
  });

  for (final (width, textScale) in const [
    (390.0, 1.0),
    (390.0, 2.0),
    (820.0, 2.0),
  ]) {
    testWidgets('fits long names at ${width}px and ${textScale}x text', (
      tester,
    ) async {
      const longName =
          'Build and publish the Android release bundle (ubuntu-latest, '
          'node 24, sharded 3 of 4)';
      await showChat(
        tester,
        prChecksState([
          prChecksRepo(
            checks: [
              prCheckDetail(
                longName,
                status: 'failure',
                executionState: 'timed_out',
              ),
              prCheckDetail(
                'lint',
                status: 'success',
                executionState: 'success',
              ),
            ],
          ),
        ]),
        width: width,
        textScale: textScale,
      );

      final name = tester.widget<Text>(find.text(longName));
      expect(name.maxLines, 1);
      expect(name.overflow, TextOverflow.ellipsis);
      expect(find.text('Timed out'), findsOneWidget);
      expect(
        tester.getSize(rowTarget('lint')).height,
        greaterThanOrEqualTo(48),
      );
      expect(
        tester.getSize(rowTarget('Checks (1/2 passed)')).height,
        greaterThanOrEqualTo(48),
      );
      expect(tester.takeException(), isNull);
    });
  }
}
