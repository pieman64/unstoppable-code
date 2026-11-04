import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/run_presentation.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/background_tray.dart';
import 'package:mobile/ui/features/remote/views/widgets/background_tray_run_row.dart';
import 'package:mobile/ui/features/remote/views/widgets/pipeline_run_dot_track.dart';

import '../../../../../support/reduced_motion.dart';
import '../../view_models/background_tray/fixtures.dart';

final _start = DateTime.parse('2026-10-25T10:00:00Z').millisecondsSinceEpoch;

const _jobs = [
  RemotePipelineRunJob(jobId: 'build', name: 'Build', status: 'success'),
  RemotePipelineRunJob(
    jobId: 'test',
    name: 'Test',
    status: 'running',
    needs: ['build'],
  ),
  RemotePipelineRunJob(
    jobId: 'ship',
    name: 'Ship',
    status: 'pending',
    needs: ['test'],
  ),
];

const _input = RemotePipelinePauseCheckpoint(
  id: 'pause',
  kind: 'input',
  jobId: 'test',
  stepId: 'ask',
  message: 'Which environment should this deploy to?',
);

const _approval = RemotePipelinePauseCheckpoint(
  id: 'pause',
  kind: 'action',
  jobId: 'test',
  stepId: 'approve',
);

final class _NoTimer implements Timer {
  @override
  bool get isActive => false;
  @override
  int get tick => 0;
  @override
  void cancel() {}
}

final class _Harness {
  _Harness() {
    model = BackgroundTrayViewModel(
      onChanged: () => _rebuild?.call(),
      nowMs: () => _start + 65000,
      periodicTimer: (_, _) => _NoTimer(),
    );
  }

  late final BackgroundTrayViewModel model;
  void Function()? _rebuild;
  final actions = <(String, BackgroundTrayRunAction)>[];
  final opened = <String>[];
  bool canStop = true;

  void show(List<RemotePipelineRun> runs) {
    model.update(target: target, pipelineRuns: runs);
    model.setExpanded(true);
  }

  Future<void> pump(WidgetTester tester, {ThemeData? theme}) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme ?? AppTheme.light,
        home: Scaffold(
          body: MediaQuery(
            data: const MediaQueryData(
              size: Size(390, 844),
              disableAnimations: true,
            ),
            child: Align(
              alignment: Alignment.bottomCenter,
              child: StatefulBuilder(
                builder: (context, setState) {
                  _rebuild = () => setState(() {});
                  return BackgroundTray(
                    summary: model.summary,
                    now: model.now,
                    expanded: model.expanded,
                    onExpandedChanged: model.setExpanded,
                    runControls: BackgroundTrayRunControls(
                      canStop: canStop,
                      onOpen: (run) => opened.add(run.pipelineRun!.localId),
                      onAction: (run, action) {
                        actions.add((run.pipelineRun!.localId, action));
                        if (action == BackgroundTrayRunAction.dismiss) {
                          model.dismissRun(run.id);
                        }
                      },
                    ),
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }
}

void main() {
  useReducedMotion();

  Finder action(String label) => find.bySemanticsLabel(label);

  testWidgets('each status shows its trailing state and one action at 390px', (
    tester,
  ) async {
    final cases = [
      (
        'running',
        const <RemotePipelinePauseCheckpoint>[],
        '1 minute, 5 seconds',
        'Stop run',
      ),
      ('paused', const [_input], 'Needs input', 'Respond to run'),
      ('paused', const [_approval], 'Paused', 'Resume run'),
      (
        'success',
        const <RemotePipelinePauseCheckpoint>[],
        'Succeeded',
        'Dismiss run',
      ),
      (
        'failure',
        const <RemotePipelinePauseCheckpoint>[],
        'Failed',
        'Dismiss run',
      ),
      (
        'cancelled',
        const <RemotePipelinePauseCheckpoint>[],
        'Cancelled',
        'Dismiss run',
      ),
    ];
    for (final (status, pauses, trailing, label) in cases) {
      final harness = _Harness();
      addTearDown(harness.model.dispose);
      // A finished run shows only after the tray saw it live.
      harness.show([pipeline('run', jobs: _jobs)]);
      harness.show([
        pipeline('run', status: status, pauses: pauses, jobs: _jobs),
      ]);
      await harness.pump(tester);
      expect(find.text(trailing), findsOneWidget, reason: status);
      expect(action(label), findsOneWidget, reason: status);
      expect(
        find.byKey(
          const ValueKey(
            'pipeline-run-dot-strip:canopy:pipeline_run:execution:run',
          ),
        ),
        findsOneWidget,
      );
      await tester.tap(action(label));
      await tester.pump();
      expect(harness.actions.first.$2.semanticsLabel, label);
      expect(tester.takeException(), isNull, reason: status);
    }
  });

  testWidgets('finished states use success and failed ink', (tester) async {
    for (final (status, label) in [
      ('success', 'Succeeded'),
      ('failure', 'Failed'),
    ]) {
      final harness = _Harness();
      addTearDown(harness.model.dispose);
      harness.show([pipeline('run')]);
      harness.show([pipeline('run', status: status)]);
      await harness.pump(tester, theme: AppTheme.dark);
      final colors = StatusColors.of(tester.element(find.text(label)));
      expect(
        tester.widget<Text>(find.text(label)).style?.color,
        status == 'success' ? colors.success : colors.failed,
      );
    }
  });

  testWidgets('Stop is hidden without the command capability', (tester) async {
    final harness = _Harness()..canStop = false;
    addTearDown(harness.model.dispose);
    harness.show([pipeline('run', jobs: _jobs)]);
    await harness.pump(tester);
    expect(find.text('Pipeline run'), findsOneWidget);
    expect(action('Stop run'), findsNothing);
    expect(find.text('Stop'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'inspector shows the job track, question, running jobs and Open run',
    (tester) async {
      final harness = _Harness();
      addTearDown(harness.model.dispose);
      final jobs = [
        ..._jobs.take(2),
        const RemotePipelineRunJob(
          jobId: 'lint',
          name: 'Lint',
          status: 'running',
          needs: ['build'],
        ),
      ];
      harness.show([
        pipeline('run', status: 'paused', pauses: const [_input], jobs: jobs),
      ]);
      await harness.pump(tester);
      expect(find.text('Needs you'), findsNothing);
      await tester.tap(find.text('Pipeline run'));
      await tester.pump();
      // The open row keeps its one dot strip; the inspector names the jobs
      // in tier order instead of drawing a second track.
      expect(find.byType(PipelineRunDotStrip), findsOneWidget);
      expect(find.byType(PipelineRunDotTrack), findsNothing);
      final jobLines = find.byKey(
        const ValueKey(
          'background-tray-run-jobs-canopy:pipeline_run:execution:run',
        ),
      );
      expect(
        [
          for (final text in tester.widgetList<Text>(
            find.descendant(of: jobLines, matching: find.byType(Text)),
          ))
            text.data,
        ],
        ['Build', 'Succeeded', 'Test', 'Running', 'Lint', 'Running'],
      );
      final question = tester.widget<Text>(
        find.byKey(const ValueKey('background-tray-run-question')),
      );
      expect(question.data, 'Which environment should this deploy to?');
      expect(question.maxLines, 3);
      expect(
        question.style?.color,
        StatusColors.of(tester.element(find.text('Needs input'))).warning,
      );
      expect(find.text('Test, Lint · running'), findsOneWidget);
      await tester.tap(find.text('Open run'));
      await tester.pump();
      expect(harness.opened, ['run']);
      // The row tap toggles only its inspector.
      expect(harness.actions, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('the job strip is clipped and hidden from semantics', (
    tester,
  ) async {
    final harness = _Harness();
    addTearDown(harness.model.dispose);
    harness.show([
      pipeline(
        'run',
        jobs: [
          for (var i = 0; i < 80; i++)
            RemotePipelineRunJob(
              jobId: 'job-$i',
              name: 'Job $i',
              status: 'pending',
              needs: i == 0 ? const [] : ['job-${i - 1}'],
            ),
        ],
      ),
    ]);
    await harness.pump(tester);
    final strip = find.byType(PipelineRunDotStrip);
    expect(strip, findsOneWidget);
    expect(
      find.byKey(const ValueKey('pipeline-run-dot-strip-hairline:1')),
      findsOneWidget,
    );
    final row = tester.getRect(
      find.byKey(
        const ValueKey('background-tray-run-canopy:pipeline_run:execution:run'),
      ),
    );
    expect(tester.getRect(strip).right, lessThanOrEqualTo(row.right));
    expect(
      find.ancestor(
        of: find.byKey(
          const ValueKey(
            'pipeline-run-strip-dot:canopy:pipeline_run:execution:run:job-0',
          ),
        ),
        matching: find.byType(ExcludeSemantics),
      ),
      findsWidgets,
    );
    expect(find.bySemanticsLabel(RegExp('Job')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a dismissed run reappears when it goes live again', (
    tester,
  ) async {
    final harness = _Harness();
    addTearDown(harness.model.dispose);
    harness.show([pipeline('run')]);
    harness.show([pipeline('run', status: 'failure')]);
    await harness.pump(tester);
    await tester.tap(action('Dismiss run'));
    await tester.pump();
    expect(find.text('Pipeline run'), findsNothing);
    harness.show([pipeline('run', status: 'running')]);
    await tester.pump();
    expect(find.text('Pipeline run'), findsOneWidget);
    expect(action('Stop run'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a run already finished when first seen does not show', (
    tester,
  ) async {
    final harness = _Harness();
    addTearDown(harness.model.dispose);
    harness.show([pipeline('history', status: 'success'), pipeline('live')]);
    await harness.pump(tester);
    expect(find.text('Pipeline live'), findsOneWidget);
    expect(find.text('Pipeline history'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
