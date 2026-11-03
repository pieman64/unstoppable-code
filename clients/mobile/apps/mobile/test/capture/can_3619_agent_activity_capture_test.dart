// Visual-evidence capture for CAN-3619 (Agent activity panel with pipeline
// runs in mobile worktree chat transcripts).
//
// What changes:
//  * A worktree chat whose desktop links pipeline runs to a turn
//    (`PortalPipelineRun.chatTurns`) now shows an "Agent activity · N items"
//    panel after that turn's footer, or under the live working row. Each card
//    shows the status, start time, name and job dots, and offers Cancel.
//  * Before the change the same synthetic data shows no panel; the runs are
//    only reachable from Activity & files.
//
// Run both stages from `apps/mobile` (the tree must be rebuilt between them):
//
//   git diff origin/develop -- lib > /tmp/can-3619-lib.patch
//   git apply -R /tmp/can-3619-lib.patch
//   CAN3619_STAGE=before flutter test test/capture/can_3619_agent_activity_capture_test.dart --update-goldens
//   git apply /tmp/can-3619-lib.patch
//   CAN3619_STAGE=after flutter test test/capture/can_3619_agent_activity_capture_test.dart --update-goldens
//
// Captures are deterministic: a fake repository supplies one worktree chat and
// the runs arrive as raw `portal.pipeline.event` payloads, so no desktop,
// agent, or network is involved. Times are relative to the test clock, so the
// labels ("40m ago", "Completed in 1:08") do not drift between runs. Output is
// written to the gitignored `<repo>/.playwright/can-3619/` directory.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../support/fake_remote_control_repository.dart';

final String? _requestedStage = Platform.environment['CAN3619_STAGE'];
final String _stage = switch (_requestedStage) {
  null || 'after' => 'after',
  'before' => 'before',
  final value => throw ArgumentError.value(
    value,
    'CAN3619_STAGE',
    'must be either "before" or "after"',
  ),
};

/// `<name>-<stage>-<light|dark>.png`, the naming the capture report builder
/// pairs into before/after scenarios.
String _capture(String name, String mode) =>
    '../../../../.playwright/can-3619/$name-$_stage-$mode.png';

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
  // Only a golden-writing run needs real fonts; CI runs this assertion-only.
  if (_requestedStage == null) return;
  throw StateError(
    'No font found for "$family". Checked: ${candidates.where((p) => p.isNotEmpty).join(', ')}',
  );
}

Future<void> _writeCapture(String name, String mode) async {
  if (_requestedStage == null) return;
  Directory('../../.playwright/can-3619').createSync(recursive: true);
  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile(_capture(name, mode)),
  );
}

const _chatId = 'chat-a';
const _factoryName = 'Mobile Factory · Experiment v2 · Factory';

Map<String, dynamic> _link(String turn, {String relation = 'launched'}) => {
  'chatId': _chatId,
  'userMessageId': turn,
  'relation': relation,
};

List<Map<String, dynamic>> _factoryJobs(String status) => [
  for (final (index, (id, name)) in const [
    ('refine', 'Refine'),
    ('plan', 'Plan'),
    ('implement', 'Implement'),
    ('verify', 'Verify'),
    ('review', 'Review'),
    ('publish', 'Publish'),
    ('ci', 'CI'),
    ('merge', 'Merge'),
  ].indexed)
    {
      'jobId': id,
      'name': name,
      'needs': index == 0 ? <String>[] : [index == 1 ? 'refine' : 'plan'],
      'status': switch ((status, index)) {
        (_, < 2) => 'success',
        ('running', 2) => 'running',
        ('failure', 2) => 'failure',
        ('cancelled', 2) => 'cancelled',
        _ => 'pending',
      },
    },
];

Map<String, dynamic> _run(
  String id, {
  String name = _factoryName,
  String status = 'running',
  Duration startedAgo = const Duration(minutes: 40),
  required List<Map<String, dynamic>> chatTurns,
}) => {
  'localId': id,
  'pipelineId': 'pipeline-$id',
  'pipelineName': name,
  'workspaceLocalId': 'ws-1',
  'worktreeLocalId': 'wt-1',
  'status': status,
  'startedAt': DateTime.now().toUtc().subtract(startedAgo).toIso8601String(),
  if (status != 'running')
    'finishedAt': DateTime.now().toUtc().toIso8601String(),
  'triggerSource': 'chat',
  'chatTurns': chatTurns,
  'jobs': _factoryJobs(status),
};

RemoteChatMessage _message(String id, ChatRole role, String text) =>
    RemoteChatMessage(
      messageId: id,
      chatId: _chatId,
      role: role,
      status: ChatMessageStatus.complete,
      text: text,
    );

RemoteChatMessage _timer(String turn, {required bool completed}) {
  final now = DateTime.now().millisecondsSinceEpoch;
  return RemoteChatMessage(
    messageId: '$turn:turn-timer',
    chatId: _chatId,
    role: ChatRole.system,
    status: completed
        ? ChatMessageStatus.complete
        : ChatMessageStatus.streaming,
    text: '',
    parts: [
      ChatPart(
        kind: 'turn_timer',
        data: {'startedAt': now - 68000, 'completedAt': completed ? now : null},
      ),
    ],
  );
}

final class _CaptureRepository extends FakeRemoteControlRepository {
  _CaptureRepository(List<RemoteChatMessage> messages) {
    snapshotBuilder = () => RemoteSessionSnapshot(
      workspaces: const [],
      standaloneChats: const [],
      worktrees: const [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'gvoltr/mobile-factory',
        ),
      ],
      chatSummaries: const [
        RemoteChatSummary(
          chatId: _chatId,
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Mobile factory',
          active: true,
        ),
      ],
      chatMessages: messages,
    );
  }

  /// Answers a cancel with a command id but never completes it, so the
  /// capture holds the in-flight state.
  @override
  Future<String> submitPipelineRunAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineRunAction action,
  }) async => 'capture-${action.name}-$executionId';
}

Future<(RemoteControlViewModel, _CaptureRepository)> _pumpChat(
  WidgetTester tester,
  ThemeMode mode,
  List<RemoteChatMessage> messages,
  List<Map<String, dynamic>> runs, {
  double textScale = 1,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

  final repository = _CaptureRepository(messages);
  final viewModel = RemoteControlViewModel(
    repository: repository,
    stateRefreshDebounce: Duration.zero,
  );
  await tester.runAsync(() => viewModel.connect('123456'));
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<RemoteControlViewModel>.value(value: viewModel),
        ChangeNotifierProvider<TurnFeedbackController>(
          create: (_) =>
              TurnFeedbackController(repository: MockTurnFeedbackRepository()),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: mode,
        home: RemoteChatScreen.worktree(
          worktree: viewModel.allWorktrees.single,
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  repository.eventsController.add(
    RemotePortalEventBatch.fromJson({
      'events': [
        for (final run in runs)
          {
            'type': 'portal.pipeline.event',
            'payload': {
              'kind': 'upsert',
              'entity': {
                'entityType': 'pipeline_run',
                'localId': run['localId'],
                'payload': run,
              },
            },
          },
      ],
      'nextCursor': 1,
    }),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  return (viewModel, repository);
}

Future<void> _close(WidgetTester tester, RemoteControlViewModel vm) async {
  await tester.pumpWidget(const SizedBox());
  vm.dispose();
}

final _completedTurn = [
  _message('u-1', ChatRole.user, 'Run the mobile factory for CAN-3619.'),
  _message(
    'a-1',
    ChatRole.assistant,
    'Started the factory pipeline. I will report back when it finishes.',
  ),
  _timer('u-1', completed: true),
];

final _twoTurns = [
  _message('u-1', ChatRole.user, 'Start the nightly checks.'),
  _message('a-1', ChatRole.assistant, 'Started the nightly checks.'),
  _timer('u-1', completed: true),
  _message('u-2', ChatRole.user, 'Run the mobile factory for CAN-3619.'),
  _message('a-2', ChatRole.assistant, 'Started two runs for this ticket.'),
  _timer('u-2', completed: true),
];

final _liveTurn = [
  _message('u-1', ChatRole.user, 'Run the mobile factory for CAN-3619.'),
  _timer('u-1', completed: false),
];

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    // The theme's own families, bundled with the app (paths are relative to
    // `apps/mobile`, where this spec runs).
    await _loadFont('Inter', const ['assets/fonts/inter/InterVariable.ttf']);
    await _loadFont('JetBrainsMono', const [
      'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
    ]);
    await _loadFont('Roboto', const [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Supplemental/Verdana.ttf',
      '/Library/Fonts/Arial.ttf',
    ]);
    await _loadFont('MaterialIcons', <String>[
      if (Platform.environment['FLUTTER_ROOT'] case final root?)
        '$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
      for (final launcher in [
        '/opt/homebrew/bin/flutter',
        '/usr/local/bin/flutter',
      ])
        if (File(launcher).existsSync())
          '${File(launcher).resolveSymbolicLinksSync().replaceFirst(RegExp(r'/flutter$'), '')}/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    ]);
  });

  Finder panelText(String text) => find.text(text);

  for (final (label, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('running card under a completed turn ($label)', (tester) async {
      final (vm, _) = await _pumpChat(tester, mode, _completedTurn, [
        _run('exec-1', chatTurns: [_link('u-1')]),
      ]);
      expect(
        panelText('Agent activity'),
        _stage == 'after' ? findsOneWidget : findsNothing,
      );
      expect(tester.takeException(), isNull);
      await _writeCapture('running-card', label);
      await _close(tester, vm);
    });

    testWidgets('older turn collapsed, latest expanded ($label)', (
      tester,
    ) async {
      final (vm, _) = await _pumpChat(tester, mode, _twoTurns, [
        _run(
          'exec-nightly',
          name: 'Nightly checks',
          status: 'success',
          startedAgo: const Duration(hours: 3),
          chatTurns: [_link('u-1')],
        ),
        _run('exec-1', chatTurns: [_link('u-2')]),
        _run(
          'exec-watch',
          name: 'Release checks',
          status: 'paused',
          startedAgo: const Duration(minutes: 12),
          chatTurns: [_link('u-2', relation: 'watching')],
        ),
      ]);
      expect(
        panelText('2 items'),
        _stage == 'after' ? findsOneWidget : findsNothing,
      );
      expect(tester.takeException(), isNull);
      await _writeCapture('two-turns', label);
      await _close(tester, vm);
    });

    testWidgets('panel under the live working row ($label)', (tester) async {
      final (vm, _) = await _pumpChat(tester, mode, _liveTurn, [
        _run(
          'exec-1',
          startedAgo: const Duration(minutes: 1),
          chatTurns: [_link('u-1')],
        ),
      ]);
      expect(tester.takeException(), isNull);
      await _writeCapture('live-turn', label);
      await _close(tester, vm);
    });

    testWidgets('cancel in flight ($label)', (tester) async {
      final (vm, _) = await _pumpChat(tester, mode, _completedTurn, [
        _run('exec-1', chatTurns: [_link('u-1')]),
      ]);
      if (_stage == 'after') {
        await tester.tap(
          find.byKey(const ValueKey('agent-activity-cancel:exec-1')),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Cancelling…'), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
      await _writeCapture('cancelling', label);
      await _close(tester, vm);
    });

    testWidgets('canceled and failed runs ($label)', (tester) async {
      final (vm, _) = await _pumpChat(tester, mode, _completedTurn, [
        _run(
          'exec-1',
          status: 'cancelled',
          startedAgo: const Duration(minutes: 41),
          chatTurns: [_link('u-1')],
        ),
        _run(
          'exec-2',
          name: 'Release checks',
          status: 'failure',
          startedAgo: const Duration(minutes: 20),
          chatTurns: [_link('u-1')],
        ),
      ]);
      expect(tester.takeException(), isNull);
      await _writeCapture('settled-runs', label);
      await _close(tester, vm);
    });

    testWidgets('large text with a long name ($label)', (tester) async {
      final (vm, _) = await _pumpChat(tester, mode, _completedTurn, [
        _run(
          'exec-1',
          name:
              'Mobile Factory · Experiment v2 · Factory with a deliberately '
              'long pipeline name',
          chatTurns: [_link('u-1')],
        ),
      ], textScale: 2);
      if (_stage == 'after') expect(tester.takeException(), isNull);
      // The unchanged tree overflows its "Completed in" row at this scale.
      tester.takeException();
      await _writeCapture('large-text', label);
      await _close(tester, vm);
    });
  }
}
