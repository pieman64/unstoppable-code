import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/run_presentation.dart';

import 'fixtures.dart';

void main() {
  test('each pipeline status has its one action', () {
    final expected = {
      BackgroundTrayRunStatus.running: BackgroundTrayRunAction.stop,
      BackgroundTrayRunStatus.needsInput: BackgroundTrayRunAction.respond,
      BackgroundTrayRunStatus.paused: BackgroundTrayRunAction.resume,
      BackgroundTrayRunStatus.succeeded: BackgroundTrayRunAction.dismiss,
      BackgroundTrayRunStatus.failed: BackgroundTrayRunAction.dismiss,
      BackgroundTrayRunStatus.cancelled: BackgroundTrayRunAction.dismiss,
    };
    for (final MapEntry(key: status, value: action) in expected.entries) {
      expect(
        backgroundTrayRunAction(run('r', status), canStop: true),
        action,
        reason: status.name,
      );
    }
    expect(
      [
        for (final action in BackgroundTrayRunAction.values)
          action.semanticsLabel,
      ],
      ['Stop run', 'Respond to run', 'Resume run', 'Dismiss run'],
    );
  });

  test('Stop needs the command gate; waiting runs keep their action', () {
    expect(
      backgroundTrayRunAction(
        run('r', BackgroundTrayRunStatus.running),
        canStop: false,
      ),
      isNull,
    );
    expect(
      backgroundTrayRunAction(
        run('r', BackgroundTrayRunStatus.paused),
        canStop: false,
      ),
      BackgroundTrayRunAction.resume,
    );
    expect(
      backgroundTrayRunAction(
        run(
          'r',
          BackgroundTrayRunStatus.running,
          kind: BackgroundTrayRunKind.github,
        ),
        canStop: true,
      ),
      isNull,
    );
  });

  test('trailing is elapsed while running, otherwise the state', () {
    BackgroundTrayRun at(BackgroundTrayRunStatus status, {int? startedAt}) =>
        BackgroundTrayRun(
          id: 'r',
          title: 'r',
          kind: BackgroundTrayRunKind.pipeline,
          status: status,
          startedAt: startedAt,
        );
    expect(
      backgroundTrayRunTrailing(
        at(BackgroundTrayRunStatus.running, startedAt: 1000),
        66000,
      ),
      '1 minute, 5 seconds',
    );
    expect(
      backgroundTrayRunTrailing(at(BackgroundTrayRunStatus.running), 66000),
      'Running',
    );
    expect(
      [
        for (final status in [
          BackgroundTrayRunStatus.needsInput,
          BackgroundTrayRunStatus.paused,
          BackgroundTrayRunStatus.succeeded,
          BackgroundTrayRunStatus.failed,
          BackgroundTrayRunStatus.cancelled,
        ])
          backgroundTrayRunTrailing(at(status, startedAt: 1000), 66000),
      ],
      ['Needs input', 'Paused', 'Succeeded', 'Failed', 'Cancelled'],
    );
  });

  test('elapsed time uses every non-zero full unit', () {
    final running = BackgroundTrayRun(
      id: 'r',
      title: 'r',
      kind: BackgroundTrayRunKind.pipeline,
      status: BackgroundTrayRunStatus.running,
      startedAt: 1000,
    );
    final cases = {
      -1: '0 seconds',
      0: '0 seconds',
      999: '0 seconds',
      1000: '1 second',
      2000: '2 seconds',
      60000: '1 minute',
      120000: '2 minutes',
      3600000: '1 hour',
      3601000: '1 hour, 1 second',
      3660000: '1 hour, 1 minute',
      7382000: '2 hours, 3 minutes, 2 seconds',
    };
    for (final entry in cases.entries) {
      expect(
        backgroundTrayRunTrailing(running, 1000 + entry.key),
        entry.value,
        reason: '${entry.key} milliseconds elapsed',
      );
    }
  });

  test('running jobs list running and restarting jobs in order', () {
    BackgroundTrayRun withJobs(List<RemotePipelineRunJob> jobs) =>
        BackgroundTrayRun(
          id: 'r',
          title: 'r',
          kind: BackgroundTrayRunKind.pipeline,
          status: BackgroundTrayRunStatus.running,
          pipelineRun: pipeline('r', jobs: jobs),
        );
    expect(
      backgroundTrayRunRunningJobs(
        withJobs(const [
          RemotePipelineRunJob(jobId: 'a', name: 'Build', status: 'running'),
          RemotePipelineRunJob(jobId: 'b', name: 'Lint', status: 'success'),
          RemotePipelineRunJob(jobId: 'c', name: 'Test', status: 'restarting'),
        ]),
      ),
      'Build, Test',
    );
    expect(
      backgroundTrayRunRunningJobs(
        withJobs(const [
          RemotePipelineRunJob(jobId: 'a', name: 'Build', status: 'success'),
        ]),
      ),
      isNull,
    );
  });
}
