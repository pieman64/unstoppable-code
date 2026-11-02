// CAN-5061 golden: the host-step requests the executor raises
// (create-worktree with worktree_setup, move-to-group) and their replay
// rules across retry, resume and start-over, captured on unchanged code
// before CAN-4140 and CAN-5077 route them through core. The host port
// records each request and answers from a fixed script; the bundled host
// action manifests are the real ones. Re-record deliberately with
// `pnpm test packages/desktop-shared/src/node/pipelines/executor/__tests__/pipeline-host-steps-golden.test.ts -u`
// and review the snapshot diff as a behavior change.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import {
  executePipeline,
  rerunPipelineExecution,
  resumePipeline,
  retryPipelineExecution,
} from '../index';
import type {
  ExecutionRuntime,
  PipelineHostActionCaller,
  PipelineHostActionRequest,
  PipelineHostActionResult,
} from '../types';
import {
  normalizeGoldenValue,
  type GoldenReplacement,
} from '../../__tests__/golden-fixtures';

jest.setTimeout(60_000);

const BUNDLED_ACTIONS = resolve(__dirname, '../../../../../resources/actions');

let root: string;
let replacements: GoldenReplacement[];
const calls: Array<{
  request: PipelineHostActionRequest;
  caller: PipelineHostActionCaller;
}> = [];
let answer: (
  request: PipelineHostActionRequest,
) => PipelineHostActionResult = () => ({ status: 'success', outputs: {} });

function runtime(withHost = true): ExecutionRuntime {
  return {
    isModelBlockedByOrgPolicy: () => Promise.resolve(false),
    isOrgModelPolicyActive: () => Promise.resolve(false),
    executionsDir: join(root, 'executions'),
    tempRootDir: join(root, 'tmp'),
    bundledActionsDir: BUNDLED_ACTIONS,
    getProjectActionsDir: (repoPath) => join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath) =>
      join(repoPath, '.canopy', 'pipelines'),
    ...(withHost
      ? {
          pipelineHostActions: {
            run: async (request, caller): Promise<PipelineHostActionResult> => {
              calls.push({ request, caller });
              await Promise.resolve();
              return answer(request);
            },
          },
        }
      : {}),
  };
}

const CREATED: PipelineHostActionResult = {
  status: 'success',
  outputs: {
    project_id: 'ws-1',
    workspace_id: 'ws-1',
    task_id: 'wt-new',
    worktree_id: 'wt-new',
    path: '/workspaces/ws-1/worktrees/wt-new',
    setup_status: 'success',
    group_id: 'grp-1',
    grouped: 'true',
  },
};

const GROUPED: PipelineHostActionResult = {
  status: 'success',
  outputs: { grouped: 'true', group_id: 'grp-2', group_name: 'Review' },
};

/** create-worktree, move-to-group, then a step that fails until its marker exists. */
function hostPipeline(markerName: string): string {
  return [
    'pipeline:',
    '  name: Golden host steps',
    '  on: dispatch',
    '  scope: [global, directory, worktree]',
    '  jobs:',
    '    host:',
    '      name: Host',
    '      steps:',
    '        - id: create',
    '          uses: builtin/create-worktree',
    '          with:',
    '            project_id: ws-1',
    '            branch: golden/host',
    '            base_branch: main',
    '            worktree_setup: run_and_wait',
    '            group: Review',
    '        - id: move',
    '          uses: builtin/move-to-group',
    '          with:',
    '            project_id: ws-1',
    '            task_id: ${{ steps.create.outputs.task_id }}',
    '            group: Review',
    '            color: categorical-2',
    '        - id: check',
    '          run: |',
    `            if [ -f "${join(root, markerName)}" ]; then echo ok; else touch "${join(root, markerName)}"; exit 3; fi`,
    '        - id: report',
    '          run: echo "${{ steps.create.outputs.worktree_id }} ${{ steps.move.outputs.group_id }}"',
    '',
  ].join('\n');
}

function project(state: ExecutionState): unknown {
  return {
    status: state.status,
    status_reasons: state.status_reasons.map((reason) => ({
      kind: reason.kind,
      code: reason.code,
      source: reason.source,
    })),
    jobs: Object.fromEntries(
      Object.entries(state.jobs).map(([jobId, job]) => [
        jobId,
        {
          status: job.status,
          retry_count: job.retry_count,
          steps: Object.fromEntries(
            Object.entries(job.steps).map(([stepId, step]) => [
              stepId,
              {
                status: step.status,
                outcome: step.outcome,
                error: step.error,
                outputs: step.outputs,
              },
            ]),
          ),
        },
      ]),
    ),
  };
}

/** Pin and reset the requests the host received. */
function takeCalls(): unknown {
  const taken = calls.splice(0, calls.length);
  return taken.map(({ request, caller }) => {
    expect(caller.pipelineId).toBe('host-steps-golden');
    const { pipelineId, ...snapshotCaller } = caller;
    void pipelineId;
    return { request, caller: snapshotCaller };
  });
}

function golden(value: unknown): unknown {
  return normalizeGoldenValue(value, replacements);
}

async function run(
  yaml: string,
  executionId: string,
  withHost = true,
): Promise<ExecutionState> {
  const handle = await executePipeline(parsePipelineText(yaml), {
    cwd: join(root, 'work'),
    runtime: runtime(withHost),
    executionId,
    pipelineId: 'host-steps-golden',
    initiationSource: 'user',
  });
  return handle.waitForCompletion();
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-host-golden-')));
  mkdirSync(join(root, 'work'), { recursive: true });
  replacements = [{ value: root, token: '<root>' }];
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  answer = (request): PipelineHostActionResult =>
    request.action === 'create-worktree' ? CREATED : GROUPED;
});

it('raises typed requests, then replays them on retry and start-over', async () => {
  const failed = await run(hostPipeline('retry-marker'), 'golden-host-retry');
  const firstCalls = takeCalls();
  const retry = await retryPipelineExecution('golden-host-retry', {
    cwd: join(root, 'work'),
    runtime: runtime(),
  });
  const retried = await retry.waitForCompletion();
  const retryCalls = takeCalls();
  const rerun = await rerunPipelineExecution('golden-host-retry', {
    cwd: join(root, 'work'),
    runtime: runtime(),
    executionId: 'golden-host-rerun',
  });
  const rerunState = await rerun.waitForCompletion();
  expect(
    golden({
      failed: project(failed),
      firstCalls,
      retried: project(retried),
      retryCalls,
      rerun: project(rerunState),
      rerunCalls: takeCalls(),
    }),
  ).toMatchSnapshot();
});

it('keeps a completed host step when a later pause resumes', async () => {
  const yaml = [
    'pipeline:',
    '  name: Golden host pause',
    '  on: dispatch',
    '  jobs:',
    '    host:',
    '      steps:',
    '        - id: move',
    '          uses: builtin/move-to-group',
    '          with:',
    '            project_id: ws-1',
    '            task_id: wt-1',
    '            group: Review',
    '        - id: gate',
    '          run: echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
    '        - id: after',
    '          run: echo after',
    '',
  ].join('\n');
  const paused = await run(yaml, 'golden-host-pause');
  const pausedCalls = takeCalls();
  const resumed = await resumePipeline('golden-host-pause', {
    cwd: join(root, 'work'),
    runtime: runtime(),
    statusReasonIds: paused.status_reasons.map((reason) => reason.id),
    pauseResponses: paused.pending_pauses.map((pause) => ({
      checkpoint_id: pause.id,
      job_id: pause.job_id,
      step_id: pause.step_id,
    })),
  });
  const done = await resumed.waitForCompletion();
  expect(
    golden({
      paused: project(paused),
      pausedCalls,
      resumed: project(done),
      resumeCalls: takeCalls(),
    }),
  ).toMatchSnapshot();
});

it('returns typed refusals, invalid inputs and the needs-desktop failure', async () => {
  const refusalYaml = [
    'pipeline:',
    '  name: Golden host refusals',
    '  on: dispatch',
    '  jobs:',
    '    host:',
    '      steps:',
    '        - id: refused',
    '          uses: builtin/move-to-group',
    '          continue_on_error: true',
    '          with:',
    '            project_id: ws-1',
    '            task_id: wt-1',
    '            group: Review',
    '        - id: invalid',
    '          uses: builtin/create-worktree',
    '          continue_on_error: true',
    '          with:',
    '            project_id: ws-1',
    '            branch: a',
    '            existing_branch: b',
    '        - id: thrown',
    '          uses: builtin/create-worktree',
    '          continue_on_error: true',
    '          with:',
    '            project_id: ws-1',
    '        - id: seen',
    '          run: echo "${{ steps.refused.outputs.failure_reason }} ${{ steps.invalid.outputs.failure_reason }}"',
    '',
  ].join('\n');
  answer = (request): PipelineHostActionResult => {
    if (request.action === 'move-to-group')
      return {
        status: 'failure',
        failureReason: 'target_not_ready',
        error: 'Task is not ready',
        outputs: { grouped: 'false' },
      };
    throw new Error('Host crashed');
  };
  const refused = await run(refusalYaml, 'golden-host-refusals');
  const refusedCalls = takeCalls();
  const needsDesktop = await run(
    refusalYaml,
    'golden-host-needs-desktop',
    false,
  );
  expect(
    golden({
      refused: project(refused),
      refusedCalls,
      needsDesktop: project(needsDesktop),
      needsDesktopCalls: takeCalls(),
    }),
  ).toMatchSnapshot();
});
