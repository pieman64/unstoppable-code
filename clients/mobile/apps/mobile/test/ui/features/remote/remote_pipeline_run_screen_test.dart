import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_chat_follow_up_coordinator.dart'
    show
        kRemotePipelineFollowUpOwnerUnavailable,
        kRemotePipelineFollowUpTimeout;
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_pipeline_content_commands.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/pipeline_follow_up_fixture.dart';

Map<String, dynamic> runPayload({
  String status = 'running',
  Object? jobs,
  String? finishedAt,
  String? triggerSource = 'chat',
  List<Map<String, dynamic>> statusReasons = const [],
  List<Map<String, dynamic>> pendingPauses = const [],
}) => {
  'localId': 'exec-1',
  'worktreeLocalId': 'wt-1',
  'workspaceLocalId': 'ws-1',
  'pipelineName': 'CI',
  'status': status,
  'startedAt': '2026-09-16T10:00:00.000Z',
  'finishedAt': ?finishedAt,
  'triggerSource': ?triggerSource,
  'progress': {'completedSteps': 1, 'totalSteps': 3},
  'statusReasons': statusReasons,
  'pendingPauses': pendingPauses,
  'jobs': ?jobs,
};

final _jobs = [
  {
    'jobId': 'build',
    'name': 'Build',
    'status': 'success',
    'steps': [
      {
        'stepId': 'compile',
        'name': 'Compile',
        'status': 'success',
        'outputTail': 'compiled 12 files\n',
      },
    ],
  },
  {
    'jobId': 'test',
    'name': 'Test',
    'status': 'running',
    'variants': [
      {
        'jobId': 'test_0',
        'name': 'Test (linux)',
        'status': 'running',
        'steps': [
          {'stepId': 'run', 'name': 'Run', 'status': 'running'},
        ],
      },
    ],
  },
];

void main() {
  void usePhoneViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
  }

  Future<RemoteControlViewModel> connected(
    WidgetTester tester,
    FakeRemoteControlRepository repository,
  ) async {
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await tester.runAsync(() => vm.connect('123456'));
    return vm;
  }

  Widget host(RemoteControlViewModel vm) => ChangeNotifierProvider.value(
    value: vm,
    child: const RemotePipelineRunScreen(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      executionId: 'exec-1',
      pipelineName: 'CI',
    ),
  );

  void emitRun(
    FakeRemoteControlRepository repository,
    Map<String, dynamic> payload,
  ) => repository.eventsController.add(
    RemotePortalEventBatch.fromJson({
      'events': [
        {
          'type': 'portal.pipeline.event',
          'payload': {
            'kind': 'upsert',
            'entity': {
              'entityType': 'pipeline_run',
              'localId': payload['localId'],
              'payload': payload,
            },
          },
        },
      ],
      'nextCursor': 1,
    }),
  );

  testWidgets('requests detail on open and shows a spinner until it lands', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);

    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();

    expect(repository.pipelineExecutionRequests.single.executionId, 'exec-1');
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    emitRun(repository, runPayload(jobs: _jobs));
    await tester.pumpAndSettle();

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byKey(const ValueKey('pipeline-run-detail')), findsOneWidget);
  });

  testWidgets('renders the header, the tree and the selected step log', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(jobs: _jobs));
    await tester.pumpAndSettle();

    expect(find.text('CI'), findsWidgets);
    expect(find.text('Running'), findsWidgets);
    expect(find.text('1/3 steps'), findsOneWidget);
    expect(find.text('Started from a chat'), findsOneWidget);

    // Jobs and their matrix variants, one level deep.
    expect(
      find.byKey(const ValueKey('pipeline-run-group:build')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('pipeline-run-group:test')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('pipeline-run-group:test_0')),
      findsOneWidget,
    );

    // Selecting a step shows its tail; the variant's step carries the
    // physical job id its log is requested with.
    await tester.tap(
      find.byKey(const ValueKey('pipeline-run-step:build:compile')),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('compiled 12 files'), findsOneWidget);
    // The action only ever hydrates a bounded tail (STEP_TAIL_MAX_BYTES on
    // the desktop), never the whole log, so it reads as a refresh rather than
    // a promise to fetch "full" output.
    expect(find.text('Refresh output'), findsOneWidget);
    expect(find.text('Load full output'), findsNothing);
    expect(
      find.text('Showing the end of this step\'s output.'),
      findsOneWidget,
    );

    // A step with no output at all must not claim to be "showing the end"
    // of something that does not exist yet.
    await tester.tap(
      find.byKey(const ValueKey('pipeline-run-step:test_0:run')),
    );
    await tester.pumpAndSettle();
    expect(find.text('No output yet.'), findsOneWidget);
    expect(find.text('Showing the end of this step\'s output.'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('pipeline-run-load-log')));
    // The key is a contract with later tasks: it must stay findable while
    // the fetch is in flight, not disappear in favor of an unkeyed spinner.
    await tester.pump();
    expect(find.byKey(const ValueKey('pipeline-run-load-log')), findsOneWidget);
    await tester.pumpAndSettle();
    expect(repository.pipelineStepLogRequests.single.jobId, 'test_0');
    expect(repository.pipelineStepLogRequests.single.stepId, 'run');
  });

  testWidgets('the selected step opens its log directly beneath it, and a '
      'second tap closes it', (tester) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(jobs: _jobs));
    await tester.pumpAndSettle();

    final log = find.byKey(const ValueKey('pipeline-run-log'));
    final compile = find.byKey(
      const ValueKey('pipeline-run-step:build:compile'),
    );
    expect(log, findsNothing);

    await tester.tap(compile);
    await tester.pumpAndSettle();

    // Under the tapped step, above the next job — not after the whole tree.
    expect(log, findsOneWidget);
    final logTop = tester.getTopLeft(log).dy;
    expect(logTop, greaterThanOrEqualTo(tester.getBottomLeft(compile).dy));
    expect(
      logTop,
      lessThan(
        tester
            .getTopLeft(find.byKey(const ValueKey('pipeline-run-group:test')))
            .dy,
      ),
    );

    // Moving to another step moves the pane with it.
    final run = find.byKey(const ValueKey('pipeline-run-step:test_0:run'));
    await tester.tap(run);
    await tester.pumpAndSettle();
    expect(log, findsOneWidget);
    expect(
      tester.getTopLeft(log).dy,
      greaterThanOrEqualTo(tester.getBottomLeft(run).dy),
    );

    await tester.tap(run);
    await tester.pumpAndSettle();
    expect(log, findsNothing);
  });

  testWidgets('a running run header shows a deterministic start time, not '
      'a wall-clock read', (tester) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(jobs: _jobs));
    await tester.pumpAndSettle();

    final timeText = tester.widget<Text>(
      find.byKey(const ValueKey('pipeline-run-time')),
    );
    expect(timeText.data, isNotNull);
    expect(timeText.data, isNotEmpty);
  });

  testWidgets(
    'a run whose payload omits triggerSource shows no trigger sentence, but '
    'still renders the time',
    (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      final vm = await connected(tester, repository);
      addTearDown(vm.dispose);
      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.light, home: host(vm)),
      );
      await tester.pump();
      emitRun(repository, runPayload(jobs: _jobs, triggerSource: null));
      await tester.pumpAndSettle();

      // No desktop producer populates `triggerSource` yet (verified against
      // `pipelines-service.ts`), so claiming "Started manually" would be a
      // guess dressed up as fact. The icon may still fall back (the protocol
      // comment sanctions that), but the text must not.
      expect(find.text('Started manually'), findsNothing);
      expect(find.byKey(const ValueKey('pipeline-run-time')), findsOneWidget);
    },
  );

  testWidgets('a finished run header shows the elapsed duration', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(
      repository,
      runPayload(
        status: 'success',
        jobs: _jobs,
        finishedAt: '2026-09-16T10:05:23.000Z',
      ),
    );
    await tester.pumpAndSettle();

    // startedAt is fixed at 2026-09-16T10:00:00.000Z in runPayload(), so the
    // elapsed duration below is deterministic regardless of wall-clock time.
    expect(find.text('5m 23s'), findsOneWidget);
  });

  var cursor = 100;
  void completeCommand(FakeRemoteControlRepository repository, String id) =>
      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.command.completed',
              'payload': {'commandId': id, 'result': <String, dynamic>{}},
            },
          ],
          'nextCursor': ++cursor,
        }),
      );

  Future<void> openOptions(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('pipeline-run-options')));
    await tester.pumpAndSettle();
  }

  MenuItemButton menuItem(WidgetTester tester, String action) =>
      tester.widget<MenuItemButton>(
        find.byKey(ValueKey('pipeline-run-action:$action')),
      );

  testWidgets('a running run is canceled from the app bar menu', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(jobs: _jobs));
    await tester.pumpAndSettle();

    // The old disabled chips and their "go to your desktop" hint are gone.
    expect(find.text('Run controls are on your desktop'), findsNothing);
    expect(find.byType(OutlinedButton), findsNothing);

    await openOptions(tester);
    expect(
      find.byKey(const ValueKey('pipeline-run-action:cancel')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('pipeline-run-action:retry')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('pipeline-run-action:resume')),
      findsNothing,
    );

    await tester.tap(find.byKey(const ValueKey('pipeline-run-action:cancel')));
    await tester.pumpAndSettle();

    final sent = repository.pipelineRunActions.single;
    expect(sent.action, RemotePipelineRunAction.cancel);
    expect(sent.executionId, 'exec-1');
    expect(sent.workspaceLocalId, 'ws-1');
    expect(sent.worktreeLocalId, 'wt-1');

    // While the desktop works on it the action cannot be sent twice.
    await openOptions(tester);
    expect(menuItem(tester, 'cancel').onPressed, isNull);
    expect(find.text('Cancelling…'), findsOneWidget);
    await tester.tapAt(const Offset(10, 600));
    await tester.pumpAndSettle();

    // The desktop acts, then reconciles the run through its event.
    completeCommand(repository, 'pipeline-action-1');
    emitRun(repository, runPayload(status: 'cancelled', jobs: _jobs));
    await tester.pumpAndSettle();
    expect(find.text('Canceled'), findsWidgets);
    await openOptions(tester);
    expect(
      find.byKey(const ValueKey('pipeline-run-action:cancel')),
      findsNothing,
    );
    expect(menuItem(tester, 'retry').onPressed, isNotNull);
  });

  testWidgets('a failed run offers Retry, never Cancel', (tester) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    // The desktop's wire spelling (`mapRunStatus`), not the executor's.
    emitRun(repository, runPayload(status: 'failed', jobs: _jobs));
    await tester.pumpAndSettle();

    await openOptions(tester);
    expect(
      find.byKey(const ValueKey('pipeline-run-action:cancel')),
      findsNothing,
    );
    await tester.tap(find.byKey(const ValueKey('pipeline-run-action:retry')));
    await tester.pumpAndSettle();

    expect(
      repository.pipelineRunActions.single.action,
      RemotePipelineRunAction.retry,
    );
    completeCommand(repository, 'pipeline-action-1');
    await tester.pumpAndSettle();
  });

  testWidgets('a paused run resumes unless it is waiting for input', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(
      repository,
      runPayload(
        status: 'paused',
        jobs: _jobs,
        pendingPauses: const [
          {'id': 'cp-1', 'kind': 'input', 'jobId': 'test', 'stepId': 'run'},
        ],
      ),
    );
    await tester.pumpAndSettle();

    await openOptions(tester);
    expect(
      find.byKey(const ValueKey('pipeline-run-action:resume')),
      findsNothing,
    );
    // A paused run is still active, so it can be canceled.
    expect(
      find.byKey(const ValueKey('pipeline-run-action:cancel')),
      findsOneWidget,
    );
    await tester.tapAt(const Offset(10, 600));
    await tester.pumpAndSettle();

    emitRun(repository, runPayload(status: 'paused', jobs: _jobs));
    await tester.pumpAndSettle();
    await openOptions(tester);
    await tester.tap(find.byKey(const ValueKey('pipeline-run-action:resume')));
    await tester.pumpAndSettle();

    expect(
      repository.pipelineRunActions.single.action,
      RemotePipelineRunAction.resume,
    );
    completeCommand(repository, 'pipeline-action-1');
    await tester.pumpAndSettle();
  });

  testWidgets('a rejected action shows the desktop reason', (tester) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(jobs: _jobs));
    await tester.pumpAndSettle();

    await openOptions(tester);
    await tester.tap(find.byKey(const ValueKey('pipeline-run-action:cancel')));
    await tester.pumpAndSettle();

    repository.eventsController.add(
      RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.command.failed',
            'payload': {
              'commandId': 'pipeline-action-1',
              'error': 'This run already finished.',
            },
          },
        ],
        'nextCursor': 2,
      }),
    );
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('pipeline-run-action-error')),
      findsOneWidget,
    );
    expect(find.text('This run already finished.'), findsOneWidget);
    // The failure belongs to this run, not the chat-wide command banner.
    expect(vm.commandFailureMessage, isNull);

    // The action is offered again once the desktop has answered.
    await openOptions(tester);
    expect(menuItem(tester, 'cancel').onPressed, isNotNull);
    await tester.tapAt(const Offset(10, 600));
    await tester.pumpAndSettle();

    await tester.tap(
      find.byKey(const ValueKey('pipeline-run-action-error-dismiss')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('pipeline-run-action-error')),
      findsNothing,
    );
  });

  testWidgets('Refresh in the menu re-reads the run', (tester) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(status: 'success', jobs: _jobs));
    await tester.pumpAndSettle();

    await openOptions(tester);
    await tester.tap(find.byKey(const ValueKey('pipeline-run-action:refresh')));
    await tester.pumpAndSettle();

    expect(repository.pipelineExecutionRequests, hasLength(2));
    expect(repository.pipelineRunActions, isEmpty);
    // The desktop answers the re-read with the run.
    emitRun(repository, runPayload(status: 'success', jobs: _jobs));
    await tester.pumpAndSettle();
  });

  testWidgets('puts pause and failure reasons above the tree', (tester) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(
      repository,
      runPayload(
        status: 'paused',
        jobs: _jobs,
        statusReasons: const [
          {'id': 'r1', 'kind': 'pause', 'code': 'usage_limit'},
        ],
        pendingPauses: const [
          {
            'id': 'cp-1',
            'kind': 'input',
            'jobId': 'test',
            'stepId': 'run',
            'request': {
              'title': 'Pick a target',
              'fields': [
                {'key': 'env', 'label': 'Environment'},
              ],
            },
          },
        ],
      ),
    );
    await tester.pumpAndSettle();

    final attention = find.byKey(const ValueKey('pipeline-run-attention'));
    expect(attention, findsOneWidget);
    expect(find.text('Pick a target'), findsOneWidget);
    expect(find.textContaining('Environment'), findsOneWidget);
    expect(
      tester.getCenter(attention).dy,
      lessThan(
        tester
            .getCenter(find.byKey(const ValueKey('pipeline-run-group:build')))
            .dy,
      ),
    );
  });

  testWidgets('a run with no steps says so', (tester) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(jobs: <Map<String, dynamic>>[]));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('pipeline-run-empty')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('pipeline-run-unavailable')),
      findsNothing,
    );
  });

  testWidgets('an older desktop that sends no detail falls back', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload());
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('pipeline-run-unavailable')),
      findsOneWidget,
    );
    // The summary the desktop DID send stays visible.
    expect(find.text('Running'), findsWidgets);
  });

  testWidgets('a rejected request offers a retry', (tester) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    repository.pipelineExecutionError = const RemoteControlException(
      'Pipeline execution not found.',
    );
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pumpAndSettle();

    expect(find.text('Pipeline execution not found.'), findsOneWidget);

    repository.pipelineExecutionError = null;
    await tester.tap(find.byKey(const ValueKey('pipeline-run-retry')));
    await tester.pumpAndSettle();
    expect(repository.pipelineExecutionRequests, hasLength(2));
  });

  testWidgets('an open run reconciles live, with no manual refresh', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(jobs: _jobs));
    await tester.pumpAndSettle();
    expect(find.text('Running'), findsWidgets);

    // A truncated live tick: status moves, the tree survives.
    emitRun(repository, {
      'localId': 'exec-1',
      'worktreeLocalId': 'wt-1',
      'status': 'success',
      'truncated': true,
      'finishedAt': '2026-09-16T10:04:00.000Z',
    });
    await tester.pumpAndSettle();

    expect(find.text('Succeeded'), findsWidgets);
    expect(
      find.byKey(const ValueKey('pipeline-run-group:build')),
      findsOneWidget,
    );
  });

  testWidgets('a fetched log replaces the tail of the selected step', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = FakeRemoteControlRepository();
    final vm = await connected(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(MaterialApp(theme: AppTheme.light, home: host(vm)));
    await tester.pump();
    emitRun(repository, runPayload(jobs: _jobs));
    await tester.pumpAndSettle();

    await tester.tap(
      find.byKey(const ValueKey('pipeline-run-step:build:compile')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pipeline-run-load-log')));
    await tester.pumpAndSettle();

    // The desktop answers a log request by re-projecting the WHOLE run with
    // the requested step's tail replaced by the larger read, so the fixture
    // carries every job — exactly what `stateToPortalRun` sends.
    emitRun(repository, {
      'localId': 'exec-1',
      'worktreeLocalId': 'wt-1',
      'status': 'running',
      'jobs': [
        {
          'jobId': 'build',
          'name': 'Build',
          'status': 'success',
          'steps': [
            {
              'stepId': 'compile',
              'name': 'Compile',
              'status': 'success',
              'outputTail': 'line 1\nline 2\nline 3\n',
            },
          ],
        },
        {
          'jobId': 'test',
          'name': 'Test',
          'status': 'running',
          'variants': [
            {
              'jobId': 'test_0',
              'name': 'Test (linux)',
              'status': 'running',
              'steps': [
                {'stepId': 'run', 'name': 'Run', 'status': 'running'},
              ],
            },
          ],
        },
      ],
    });
    await tester.pumpAndSettle();

    expect(find.textContaining('line 3'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('pipeline-run-group:test_0')),
      findsOneWidget,
    );
  });

  group('chat follow-up (CAN-3719)', () {
    Future<RemoteControlViewModel> openRun(
      WidgetTester tester,
      FakeRemoteControlRepository repository,
      Map<String, dynamic> payload,
    ) async {
      usePhoneViewport(tester);
      final vm = await connected(tester, repository);
      addTearDown(vm.dispose);
      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.light, home: host(vm)),
      );
      await tester.pump();
      emitRun(repository, payload);
      await tester.pumpAndSettle();
      return vm;
    }

    testWidgets('a failed run with a saved report shows Chat follow-up', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      await openRun(tester, repository, {
        ...runPayload(status: 'failure', jobs: _jobs),
        'chatFollowUp': {'planAvailable': false, 'reportAvailable': true},
      });

      expect(find.text('Chat follow-up'), findsOneWidget);
      // Outside the options menu: visible without opening it.
      expect(
        find.byKey(const ValueKey('pipeline-run-options')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a finished run without saved output explains why there is '
        'no Chat follow-up', (tester) async {
      final repository = FakeRemoteControlRepository();
      await openRun(tester, repository, {
        ...runPayload(status: 'success', jobs: _jobs),
        'chatFollowUp': {'planAvailable': false, 'reportAvailable': false},
      });

      expect(find.text('Chat follow-up'), findsNothing);
      expect(
        find.byKey(const ValueKey('pipeline-run-chat-follow-up-no-output')),
        findsOneWidget,
      );
      expect(
        find.text(
          'Chat follow-up needs a saved plan or report. This run has neither.',
        ),
        findsOneWidget,
      );
      expect(find.text(kRemotePipelineFollowUpUnsupported), findsNothing);
    });

    final noOutput = find.byKey(
      const ValueKey('pipeline-run-chat-follow-up-no-output'),
    );

    testWidgets('a running run without saved output shows no hint', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      await openRun(tester, repository, {
        ...runPayload(status: 'running', jobs: _jobs),
        'chatFollowUp': {'planAvailable': false, 'reportAvailable': false},
      });

      expect(noOutput, findsNothing);
      expect(find.text('Chat follow-up'), findsNothing);
    });

    testWidgets('a finished run with unknown outputs shows no hint', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      // A supporting desktop that left availability out of the row: unknown,
      // not missing, so neither hint applies.
      final vm = await openRun(
        tester,
        repository,
        runPayload(status: 'success', jobs: _jobs),
      );

      expect(vm.supportsPipelineChatFollowUp, isTrue);
      expect(noOutput, findsNothing);
      expect(find.text(kRemotePipelineFollowUpUnsupported), findsNothing);
      expect(find.text('Chat follow-up'), findsNothing);
    });
  });

  group('chat follow-up flow (CAN-3719)', () {
    late PipelineFollowUpFixtureRepository repository;
    late InMemoryChatDraftStore drafts;
    late RemoteControlViewModel vm;

    Future<void> open(
      WidgetTester tester, {
      Map<String, dynamic>? payload,
      ThemeData? theme,
      double textScale = 1,
      String routeWorktreeLocalId = 'wt-1',
    }) async {
      usePhoneViewport(tester);
      tester.view.physicalSize = const Size(1170, 2532);
      tester.platformDispatcher.textScaleFactorTestValue = textScale;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        draftStore: drafts,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: ChatDraftStoreHolder(drafts),
          child: ChangeNotifierProvider.value(
            value: vm,
            child: MaterialApp(
              theme: theme ?? AppTheme.light,
              home: RemotePipelineRunScreen(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: routeWorktreeLocalId,
                executionId: followUpExecutionId,
                pipelineName: 'Plan and review',
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      repository.eventsController.add(
        followUpRunEvent(payload ?? followUpRunPayload()),
      );
      await tester.pumpAndSettle();
    }

    /// Unmounts and lets the chat screen's hydration watchdog expire.
    Future<void> finish(WidgetTester tester) async {
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
      await tester.pump(const Duration(minutes: 2));
    }

    Finder button() =>
        find.byKey(const ValueKey('pipeline-run-chat-follow-up'));

    setUp(() {
      repository = PipelineFollowUpFixtureRepository()
        ..followUpChatId = 'chat-owner';
      drafts = InMemoryChatDraftStore();
    });

    testWidgets(
      'a report-only run sends once, opens the receiving chat, and Back '
      'returns to the selected step',
      (tester) async {
        await open(
          tester,
          payload: followUpRunPayload(
            status: 'failed',
            chatFollowUp: {'planAvailable': false, 'reportAvailable': true},
          ),
        );
        await tester.tap(find.text('Draft plan'));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('pipeline-run-log')), findsOneWidget);

        await tester.tap(button());
        await tester.pumpAndSettle();

        expect(repository.followUpPrepareCalls.single.output.name, 'report');
        final send = repository.sendChatMessageCalls.single;
        expect(send.text, 'Review this report: /runs/exec-1/report.md');
        expect(
          send.target,
          isA<RemoteWorktreeChatTarget>()
              .having((t) => t.worktreeLocalId, 'worktree', 'wt-1')
              .having((t) => t.chatId, 'chat', 'chat-owner'),
        );
        expect(find.byType(RemoteChatScreen), findsOneWidget);
        expect(
          find.text('Review this report: /runs/exec-1/report.md'),
          findsOneWidget,
        );

        await tester.pageBack();
        await tester.pumpAndSettle();
        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(find.byKey(const ValueKey('pipeline-run-log')), findsOneWidget);
        expect(
          find.text('Saved the plan for invoice rounding.\n'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await finish(tester);
      },
    );

    testWidgets('both outputs offer a choice; closing it sends nothing', (
      tester,
    ) async {
      await open(tester);

      await tester.tap(button());
      await tester.pumpAndSettle();
      expect(find.text('Review plan'), findsOneWidget);
      expect(find.text('Review report'), findsOneWidget);
      await tester.tapAt(const Offset(20, 40));
      await tester.pumpAndSettle();
      expect(find.text('Review plan'), findsNothing);
      expect(repository.followUpPrepareCalls, isEmpty);
      expect(repository.sendChatMessageCalls, isEmpty);

      await tester.tap(button());
      await tester.pumpAndSettle();
      await tester.tap(find.text('Review plan'));
      await tester.pumpAndSettle();
      expect(repository.followUpPrepareCalls.single.output.name, 'plan');
      expect(
        repository.sendChatMessageCalls.single.text,
        'Review this plan: /plans/invoice-rounding.md',
      );
      await finish(tester);
    });

    testWidgets('a run opened from another worktree sends to its owner', (
      tester,
    ) async {
      await open(
        tester,
        routeWorktreeLocalId: 'wt-2',
        payload: followUpRunPayload(
          chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
        ),
      );

      await tester.tap(button());
      await tester.pumpAndSettle();

      expect(repository.followUpPrepareCalls.single.worktreeLocalId, 'wt-1');
      final target = repository.sendChatMessageCalls.single.target;
      expect(
        target,
        isA<RemoteWorktreeChatTarget>().having(
          (t) => t.worktreeLocalId,
          'worktree',
          'wt-1',
        ),
      );
      await finish(tester);
    });

    testWidgets('repeated taps while pending send one message', (tester) async {
      final answer = Completer<RemotePortalCommandResult>();
      repository.followUpPrepareHandler = () => answer.future;
      await open(
        tester,
        payload: followUpRunPayload(
          chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
        ),
      );

      await tester.tap(button());
      await tester.pump();
      final control = tester.widget<CanopyButton>(button());
      expect(control.loading, isTrue);
      expect(control.onPressed, isNull);
      await tester.tap(button(), warnIfMissed: false);
      await tester.pump();

      answer.complete(
        RemotePortalCommandResult(
          commandId: 'prep-1',
          result: followUpPreparationJson(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            executionId: followUpExecutionId,
            output: RemotePipelineFollowUpOutput.plan,
            chatId: 'chat-owner',
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(repository.followUpPrepareCalls, hasLength(1));
      expect(repository.sendChatMessageCalls, hasLength(1));
      await finish(tester);
    });

    testWidgets('a host rejection shows its reason and stays on the run', (
      tester,
    ) async {
      repository.followUpPrepareHandler = () async =>
          throw const RemoteControlException(
            'This pipeline run does not have a saved plan file.',
          );
      await open(
        tester,
        payload: followUpRunPayload(
          chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
        ),
      );

      await tester.tap(button());
      await tester.pumpAndSettle();

      expect(
        find.text('This pipeline run does not have a saved plan file.'),
        findsOneWidget,
      );
      expect(find.byType(RemoteChatScreen), findsNothing);
      expect(repository.sendChatMessageCalls, isEmpty);
      await tester.tap(find.text('Dismiss'));
      await tester.pumpAndSettle();
      expect(
        find.text('This pipeline run does not have a saved plan file.'),
        findsNothing,
      );
      await finish(tester);
    });

    testWidgets('a stalled preparation times out and can be tried again', (
      tester,
    ) async {
      final stalled = Completer<RemotePortalCommandResult>();
      repository.followUpPrepareHandler = () => stalled.future;
      await open(
        tester,
        payload: followUpRunPayload(
          chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
        ),
      );

      await tester.tap(button());
      await tester.pump();
      expect(tester.widget<CanopyButton>(button()).loading, isTrue);

      await tester.pump(kRemotePipelineFollowUpTimeout);
      await tester.pump();
      const timedOut =
          "Your desktop didn't answer. Nothing was sent. Try again.";
      expect(find.text(timedOut), findsOneWidget);
      final control = tester.widget<CanopyButton>(button());
      expect(control.loading, isFalse);
      expect(control.onPressed, isNotNull);
      expect(find.byType(RemoteChatScreen), findsNothing);
      expect(repository.sendChatMessageCalls, isEmpty);

      // Only an explicit tap tries again; the stalled answer stays ignored.
      repository.followUpPrepareHandler = null;
      await tester.tap(button());
      await tester.pumpAndSettle();
      stalled.complete(
        RemotePortalCommandResult(
          commandId: 'prep-1',
          result: followUpPreparationJson(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            executionId: followUpExecutionId,
            output: RemotePipelineFollowUpOutput.plan,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(repository.followUpPrepareCalls, hasLength(2));
      expect(repository.sendChatMessageCalls, hasLength(1));
      expect(find.byType(RemoteChatScreen), findsOneWidget);
      await finish(tester);
    });

    testWidgets('an older desktop gets an update hint instead of the button', (
      tester,
    ) async {
      repository.supportsPipelineChatFollowUp = false;
      await open(tester, payload: followUpRunPayload(chatFollowUp: null));

      expect(button(), findsNothing);
      expect(find.text(kRemotePipelineFollowUpUnsupported), findsOneWidget);
      await finish(tester);
    });

    testWidgets('an unavailable owner explains itself and sends nothing', (
      tester,
    ) async {
      await open(
        tester,
        payload: followUpRunPayload(worktreeLocalId: 'wt-gone'),
        routeWorktreeLocalId: 'wt-gone',
      );

      await tester.tap(button());
      await tester.pumpAndSettle();
      await tester.tap(find.text('Review report'));
      await tester.pumpAndSettle();

      expect(
        find.text(kRemotePipelineFollowUpOwnerUnavailable),
        findsOneWidget,
      );
      expect(repository.followUpPrepareCalls, isEmpty);
      expect(repository.sendChatMessageCalls, isEmpty);
      await finish(tester);
    });

    testWidgets('a draft in the receiving chat is kept', (tester) async {
      const draftTarget = RemoteWorktreeChatDraftTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        chatId: 'chat-owner',
      );
      drafts.setDraft(draftTarget, 'my unsent thought');
      await open(
        tester,
        payload: followUpRunPayload(
          chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
        ),
      );

      await tester.tap(button());
      await tester.pumpAndSettle();

      expect(drafts.draftFor(draftTarget), 'my unsent thought');
      expect(find.text('my unsent thought'), findsOneWidget);
      await finish(tester);
    });

    testWidgets('no writable chat creates one and opens it', (tester) async {
      repository.followUpChatId = null;
      await open(
        tester,
        payload: followUpRunPayload(
          chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
        ),
      );

      await tester.tap(button());
      await tester.pumpAndSettle();

      final created = repository.createChatTabTargets.single;
      expect(created.worktreeLocalId, 'wt-1');
      final send = repository.sendChatMessageCalls.single;
      expect(
        send.target,
        isA<RemoteWorktreeChatTarget>().having(
          (t) => t.chatId,
          'chat',
          created.chatId,
        ),
      );
      // Normal scoped defaults: the follow-up picks no provider or model.
      expect(send.options?.model, isNull);
      expect(find.byType(RemoteChatScreen), findsOneWidget);
      expect(
        find.text('Review this plan: /plans/invoice-rounding.md'),
        findsOneWidget,
      );
      await finish(tester);
    });

    for (final (label, theme) in [
      ('light', AppTheme.light),
      ('dark', AppTheme.dark),
    ]) {
      testWidgets('fits a 390px phone at large text ($label)', (tester) async {
        await open(tester, theme: theme, textScale: 2);
        expect(tester.takeException(), isNull);
        expect(button(), findsOneWidget);
        expect(tester.getSize(button()).height, greaterThanOrEqualTo(48));
        expect(
          tester.getSemantics(button()),
          matchesSemantics(
            label: 'Chat follow-up: review this run in a chat',
            isButton: true,
            hasEnabledState: true,
            isEnabled: true,
            hasTapAction: true,
            hasFocusAction: true,
            isFocusable: true,
          ),
        );
        await tester.tap(button());
        await tester.pumpAndSettle();
        expect(find.text('Review report'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await finish(tester);
      });
    }
  });

  group('complete output and Full report (CAN-3717)', () {
    // An agent step's streamed tail is the end of its provider event log.
    final agentJobs = [
      {
        'jobId': 'review',
        'name': 'Review',
        'status': 'success',
        'steps': [
          {
            'stepId': 'agent',
            'name': 'Agent review',
            'status': 'success',
            'outputTail':
                '{"type":"assistant","message":{"content":[{"type":"text",'
                '"text":"## Findings"}]}}\n{"type":"result","subtype":"succ',
          },
        ],
      },
    ];

    Future<(FakeRemoteControlRepository, RemoteControlViewModel)> open(
      WidgetTester tester, {
      ThemeData? theme,
      bool supported = true,
      List<Object> jobs = const [],
    }) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..supportsPipelineContent = supported;
      final vm = await connected(tester, repository);
      addTearDown(vm.dispose);
      await tester.pumpWidget(
        MaterialApp(theme: theme ?? AppTheme.light, home: host(vm)),
      );
      await tester.pump();
      emitRun(
        repository,
        runPayload(
          status: 'success',
          finishedAt: '2026-09-16T10:05:00.000Z',
          jobs: jobs.isEmpty ? agentJobs : jobs,
        ),
      );
      await tester.pumpAndSettle();
      return (repository, vm);
    }

    Future<void> selectAgentStep(WidgetTester tester) async {
      await tester.tap(
        find.byKey(const ValueKey('pipeline-run-step:review:agent')),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('a settled agent step shows its readable output, not JSON', (
      tester,
    ) async {
      final (repository, _) = await open(tester);
      repository.contentDocuments['step_output:review:agent'] =
          const RemotePipelineContentDocument(
            format: RemotePipelineContentFormat.markdown,
            text: '## Findings\n\n- One **issue**',
          );

      await selectAgentStep(tester);

      expect(find.textContaining('Findings'), findsOneWidget);
      expect(find.textContaining('issue'), findsOneWidget);
      expect(find.textContaining('"type"'), findsNothing);
      expect(repository.contentReadCalls.single.source, {
        'kind': 'step_output',
        'jobId': 'review',
        'stepId': 'agent',
      });
    });

    for (final changedField in ['attempt', 'iteration']) {
      testWidgets('reloads selected output when $changedField changes', (
        tester,
      ) async {
        List<Object> jobs(String status, int value) => [
          {
            'jobId': 'review',
            'name': 'Review',
            'status': status,
            'steps': [
              {
                'stepId': 'agent',
                'name': 'Agent review',
                'status': status,
                'attempt': changedField == 'attempt' ? value : 1,
                'iteration': changedField == 'iteration' ? value : 1,
              },
            ],
          },
        ];
        final (repository, _) = await open(tester, jobs: jobs('failed', 1));
        repository.contentDocuments['step_output:review:agent'] =
            const RemotePipelineContentDocument(
              format: RemotePipelineContentFormat.text,
              text: 'Failed attempt output',
            );
        await selectAgentStep(tester);
        expect(find.text('Failed attempt output'), findsOneWidget);

        repository.contentDocuments['step_output:review:agent'] =
            const RemotePipelineContentDocument(
              format: RemotePipelineContentFormat.text,
              text: 'Successful retry output',
            );
        emitRun(
          repository,
          runPayload(status: 'success', jobs: jobs('success', 2)),
        );
        await tester.pumpAndSettle();
        expect(find.text('Successful retry output'), findsOneWidget);
        expect(find.text('Failed attempt output'), findsNothing);
        expect(repository.contentReadCalls, hasLength(2));
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('Full report preserves embedded triple backticks', (
      tester,
    ) async {
      final (repository, _) = await open(tester);
      repository.contentDocuments['report'] =
          const RemotePipelineContentDocument(
            format: RemotePipelineContentFormat.markdown,
            text: '````text\na\n```\nb\n````',
          );
      await tester.tap(find.byKey(const ValueKey('pipeline-run-full-report')));
      await tester.pumpAndSettle();
      expect(find.text('a\n```\nb'), findsOneWidget);
      expect(find.textContaining('````'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a long step output keeps its beginning, middle and end', (
      tester,
    ) async {
      final (repository, _) = await open(tester);
      final lines = [for (var i = 0; i < 3000; i++) 'line $i'];
      repository
        ..contentPageSize = 4096
        ..contentDocuments['step_output:review:agent'] =
            RemotePipelineContentDocument(
              format: RemotePipelineContentFormat.text,
              text: lines.join('\n'),
            );

      await selectAgentStep(tester);
      await tester.tap(
        find.byKey(const ValueKey('pipeline-run-open-output')).first,
      );
      await tester.pumpAndSettle();

      expect(repository.contentReadCalls.length, greaterThan(2));
      final list = find.byKey(const ValueKey('pipeline-content'));
      expect(find.textContaining('line 0\n'), findsOneWidget);
      for (final line in ['line 1500\n', 'line 2999']) {
        await tester.dragUntilVisible(
          find.textContaining(line),
          list,
          const Offset(0, -600),
          maxIteration: 200,
        );
        expect(find.textContaining(line), findsOneWidget);
      }
    });

    testWidgets('Full report opens the run report; Back keeps the step', (
      tester,
    ) async {
      final (repository, _) = await open(tester);
      repository.contentDocuments['report'] =
          const RemotePipelineContentDocument(
            format: RemotePipelineContentFormat.markdown,
            text:
                '# Run report\n\n| Check | Result |\n| --- | --- |\n'
                '| Lint | ok |\n\n```sh\npnpm test\n```',
          );
      await selectAgentStep(tester);

      await tester.tap(find.byKey(const ValueKey('pipeline-run-full-report')));
      await tester.pumpAndSettle();

      expect(find.text('Full report'), findsOneWidget);
      expect(find.textContaining('Run report'), findsOneWidget);
      expect(find.textContaining('Lint'), findsOneWidget);
      expect(find.textContaining('pnpm test'), findsOneWidget);
      expect(repository.contentReadCalls.last.executionId, 'exec-1');
      expect(repository.contentReadCalls.last.source, {'kind': 'report'});

      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('pipeline-run-pane:review:agent:null:null')),
        findsOneWidget,
      );
    });

    testWidgets('a run without a saved report says so', (tester) async {
      await open(tester);
      await tester.tap(find.byKey(const ValueKey('pipeline-run-full-report')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('pipeline-content-empty')), findsOne);
      expect(find.text('This run has no saved report.'), findsOneWidget);
    });

    testWidgets('a failed read shows the reason and retries', (tester) async {
      final (repository, _) = await open(tester);
      var fail = true;
      repository.contentReadHandler = (offset) async {
        if (fail) throw const RemoteControlException('Desktop is offline.');
        return RemotePortalCommandResult(
          commandId: 'content',
          result: pipelineContentPageJson(
            const RemotePipelineContentDocument(
              format: RemotePipelineContentFormat.markdown,
              text: '# Recovered',
            ),
          ),
        );
      };
      await tester.tap(find.byKey(const ValueKey('pipeline-run-full-report')));
      await tester.pumpAndSettle();
      expect(find.text('Desktop is offline.'), findsOneWidget);

      fail = false;
      await tester.tap(find.byKey(const ValueKey('pipeline-content-retry')));
      await tester.pumpAndSettle();
      expect(find.textContaining('Recovered'), findsOneWidget);
    });

    testWidgets('an older desktop keeps the tail and explains the report', (
      tester,
    ) async {
      final (repository, _) = await open(tester, supported: false);
      await selectAgentStep(tester);
      expect(find.byKey(const ValueKey('pipeline-run-log')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('pipeline-run-open-output')),
        findsNothing,
      );

      await tester.tap(find.byKey(const ValueKey('pipeline-run-full-report')));
      await tester.pumpAndSettle();
      expect(find.text(kRemotePipelineContentUnsupported), findsOneWidget);
      expect(repository.contentReadCalls, isEmpty);
    });

    testWidgets('a running step keeps its live tail', (tester) async {
      final (repository, _) = await open(tester, jobs: _jobs);
      await tester.tap(
        find.byKey(const ValueKey('pipeline-run-step:test_0:run')),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('pipeline-run-log')), findsOneWidget);
      expect(find.byKey(const ValueKey('pipeline-run-open-output')), findsOne);
      expect(repository.contentReadCalls, isEmpty);
    });

    for (final (label, theme) in [
      ('light', AppTheme.light),
      ('dark', AppTheme.dark),
    ]) {
      testWidgets('fits a 390px phone ($label)', (tester) async {
        final (repository, _) = await open(tester, theme: theme);
        repository.contentDocuments['step_output:review:agent'] =
            const RemotePipelineContentDocument(
              format: RemotePipelineContentFormat.markdown,
              text: '## Findings\n\n`a-very-long-identifier-name-that-wraps`',
            );
        await selectAgentStep(tester);
        expect(tester.takeException(), isNull);
        await tester.tap(
          find.byKey(const ValueKey('pipeline-run-full-report')),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      });
    }
  });
}
