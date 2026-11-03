import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_run_display.dart';

RemotePipelineRun run({
  String status = 'running',
  String? parentExecutionId,
  List<RemotePipelinePauseCheckpoint> pendingPauses = const [],
}) => RemotePipelineRun(
  localId: 'exec-1',
  pipelineName: 'CI',
  status: status,
  parentExecutionId: parentExecutionId,
  pendingPauses: pendingPauses,
);

RemotePipelineRunJob job(
  String jobId, {
  String status = 'pending',
  List<String>? needs,
  List<RemotePipelineRunVariant> variants = const [],
}) => RemotePipelineRunJob(
  jobId: jobId,
  name: jobId.toUpperCase(),
  status: status,
  needs: needs,
  variants: variants,
);

void main() {
  group('status presentation', () {
    test('maps the run status vocabulary onto the shared colors', () {
      final colors = StatusColors.light;
      expect(pipelineRunStatusColor('running', colors), colors.active);
      expect(pipelineRunStatusColor('paused', colors), colors.warning);
      expect(pipelineRunStatusColor('success', colors), colors.success);
      expect(pipelineRunStatusColor('failure', colors), colors.failed);
      expect(pipelineRunStatusColor('cancelled', colors), colors.neutral);
      expect(pipelineRunStatusColor('pending', colors), colors.quaternary);
      expect(pipelineRunStatusColor('skipped', colors), colors.quaternary);
      expect(pipelineRunStatusColor('anything-else', colors), colors.neutral);
    });

    test('labels are sentence case', () {
      expect(pipelineRunStatusLabel('running'), 'Running');
      expect(pipelineRunStatusLabel('failure'), 'Failed');
      expect(pipelineRunStatusLabel('cancelled'), 'Canceled');
      expect(pipelineRunStatusLabel('success'), 'Succeeded');
      expect(pipelineRunStatusLabel('paused'), 'Paused');
      expect(pipelineRunStatusLabel('pending'), 'Queued');
    });

    test('the desktop wire spelling "failed" reads as a failure', () {
      // `pipelines-service.ts` `mapRunStatus` sends `failed`, not the
      // executor's `failure`, for runs, jobs and steps alike.
      final colors = StatusColors.light;
      expect(pipelineRunStatusColor('failed', colors), colors.failed);
      expect(pipelineRunStatusLabel('failed'), 'Failed');
      expect(pipelineRunStatusLabel('queued'), 'Queued');
    });

    test('an unknown trigger reads as manual', () {
      expect(pipelineTriggerLabel(null), 'Started manually');
      expect(pipelineTriggerLabel('hook'), 'Started by a hook');
      expect(pipelineTriggerIcon(null), pipelineTriggerIcon('manual'));
      expect(pipelineTriggerIcon('chat'), isNot(pipelineTriggerIcon('plan')));
    });
  });

  group('action guards (ported from packages/ui-shared execution-actions)', () {
    test('active statuses are pending, running and paused', () {
      expect(isPipelineRunActive('pending'), isTrue);
      expect(isPipelineRunActive('running'), isTrue);
      expect(isPipelineRunActive('paused'), isTrue);
      expect(isPipelineRunActive('success'), isFalse);
    });

    test('cancel follows the active statuses', () {
      expect(canCancelPipelineRun(run(status: 'running')), isTrue);
      expect(canCancelPipelineRun(run(status: 'success')), isFalse);
    });

    test('resume is a paused root run', () {
      expect(canResumePipelineRun(run(status: 'paused')), isTrue);
      expect(
        canResumePipelineRun(
          run(status: 'paused', parentExecutionId: 'exec-parent'),
        ),
        isFalse,
      );
    });

    test('resume is withheld while the desktop is waiting for input', () {
      // Mobile cannot answer an input checkpoint, and a resume with no
      // answers would release nothing the desktop is waiting on.
      expect(
        canResumePipelineRun(
          run(
            status: 'paused',
            pendingPauses: const [
              RemotePipelinePauseCheckpoint(
                id: 'cp-1',
                kind: 'input',
                jobId: 'test',
                stepId: 'run',
              ),
            ],
          ),
        ),
        isFalse,
      );
      expect(
        canResumePipelineRun(
          run(
            status: 'paused',
            pendingPauses: const [
              RemotePipelinePauseCheckpoint(
                id: 'cp-1',
                kind: 'approval',
                jobId: 'test',
                stepId: 'run',
              ),
            ],
          ),
        ),
        isTrue,
      );
    });

    test('retry is a failed or canceled root run', () {
      expect(canRetryPipelineRun(run(status: 'failure')), isTrue);
      expect(canRetryPipelineRun(run(status: 'failed')), isTrue);
      expect(canRetryPipelineRun(run(status: 'cancelled')), isTrue);
      expect(canRetryPipelineRun(run(status: 'running')), isFalse);
      expect(
        canRetryPipelineRun(
          run(status: 'failure', parentExecutionId: 'exec-parent'),
        ),
        isFalse,
      );
    });
  });

  group('duration', () {
    test('formats elapsed and finished runs', () {
      final started = DateTime.utc(2026, 9, 16, 10);
      expect(
        formatPipelineRunDuration(
          started,
          DateTime.utc(2026, 9, 16, 10, 0, 42),
        ),
        '42s',
      );
      expect(
        formatPipelineRunDuration(started, DateTime.utc(2026, 9, 16, 10, 3, 7)),
        '3m 7s',
      );
      expect(
        formatPipelineRunDuration(started, DateTime.utc(2026, 9, 16, 11, 2)),
        '1h 2m',
      );
      expect(formatPipelineRunDuration(null, DateTime.utc(2026)), '');
    });
  });

  group('buildPipelineRunGroups', () {
    test('nests matrix variants exactly one level under their job', () {
      final groups = buildPipelineRunGroups([
        RemotePipelineRunJob(
          jobId: 'build',
          name: 'Build',
          status: 'success',
          steps: const [
            RemotePipelineRunStep(
              stepId: 'compile',
              name: 'Compile',
              status: 'success',
            ),
          ],
        ),
        const RemotePipelineRunJob(
          jobId: 'test',
          name: 'Test',
          status: 'running',
          variants: [
            RemotePipelineRunVariant(
              jobId: 'test_0',
              name: 'Test (linux)',
              status: 'running',
              steps: [
                RemotePipelineRunStep(
                  stepId: 'run',
                  name: 'Run',
                  status: 'running',
                ),
              ],
            ),
          ],
        ),
      ]);

      expect(groups.map((g) => g.jobId), ['build', 'test', 'test_0']);
      expect(groups.map((g) => g.depth), [0, 0, 1]);
      expect(groups.map((g) => g.isVariant), [false, false, true]);
      // A step carries the PHYSICAL job id its log must be requested with.
      expect(groups.last.steps.single.jobId, 'test_0');
      expect(groups.last.steps.single.step.stepId, 'run');
      expect(groups[1].steps, isEmpty);
    });
  });

  group('buildPipelineRunDotTiers', () {
    List<List<String>> ids(List<List<PipelineRunDot>> tiers) => [
      for (final tier in tiers) [for (final dot in tier) dot.jobId],
    ];

    test('groups jobs by dependency depth, one dot per job', () {
      final tiers = buildPipelineRunDotTiers([
        job('lint', needs: const []),
        job('build', needs: const []),
        job('test', needs: const ['build']),
        job('review', needs: const ['test', 'lint']),
        job('report', needs: const ['build']),
      ]);
      expect(ids(tiers), [
        ['lint', 'build'],
        ['test', 'report'],
        ['review'],
      ]);
    });

    test('a dependency resolves before the job that needs it', () {
      // Port of `computeDagTiers`: recursion records a dependency's level
      // before its dependent's, so within a tier it comes first.
      final tiers = buildPipelineRunDotTiers([
        job('b', needs: const ['a']),
        job('c', needs: const []),
        job('a', needs: const []),
      ]);
      expect(ids(tiers), [
        ['a', 'c'],
        ['b'],
      ]);
    });

    test('an older desktop with no needs at all is one group', () {
      final tiers = buildPipelineRunDotTiers([job('a'), job('b'), job('c')]);
      expect(ids(tiers), [
        ['a', 'b', 'c'],
      ]);
    });

    test('ignores dependencies on jobs absent from the run and cycles', () {
      final tiers = buildPipelineRunDotTiers([
        job('a', needs: const ['ghost']),
        job('b', needs: const ['a', 'b']),
        job('x', needs: const ['y']),
        job('y', needs: const ['x']),
      ]);
      expect(ids(tiers).expand((tier) => tier).toSet(), {'a', 'b', 'x', 'y'});
      expect(ids(tiers).first, contains('a'));
      expect(ids(tiers)[1], contains('b'));
    });

    test('a matrix job is one dot carrying its group status', () {
      final tiers = buildPipelineRunDotTiers([
        job(
          'test',
          status: 'failed',
          needs: const [],
          variants: const [
            RemotePipelineRunVariant(
              jobId: 'test_0',
              name: 'Test (linux)',
              status: 'success',
            ),
            RemotePipelineRunVariant(
              jobId: 'test_1',
              name: 'Test (mac)',
              status: 'failed',
            ),
          ],
        ),
      ]);
      expect(ids(tiers), [
        ['test'],
      ]);
      expect(tiers.single.single.status, PipelineRunDotStatus.failure);
      expect(tiers.single.single.name, 'TEST');
    });

    test('maps the wire statuses onto the dot vocabulary', () {
      PipelineRunDotStatus statusOf(String status) => buildPipelineRunDotTiers([
        job('a', status: status),
      ]).single.single.status;
      expect(statusOf('running'), PipelineRunDotStatus.running);
      expect(statusOf('restarting'), PipelineRunDotStatus.running);
      expect(statusOf('success'), PipelineRunDotStatus.success);
      expect(statusOf('failed'), PipelineRunDotStatus.failure);
      expect(statusOf('failure'), PipelineRunDotStatus.failure);
      expect(statusOf('paused'), PipelineRunDotStatus.paused);
      expect(statusOf('cancelled'), PipelineRunDotStatus.cancelled);
      expect(statusOf('skipped'), PipelineRunDotStatus.skipped);
      expect(statusOf('queued'), PipelineRunDotStatus.pending);
      expect(statusOf('pending'), PipelineRunDotStatus.pending);
      expect(statusOf('mystery'), PipelineRunDotStatus.pending);
    });

    test('a run with no jobs has no dots', () {
      expect(buildPipelineRunDotTiers(const []), isEmpty);
    });
  });
}
