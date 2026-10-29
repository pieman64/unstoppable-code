import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TIMEOUT_MINUTES } from '@canopy/pipeline-interop/normalize-pipeline';
import type {
  NormalizedStep,
  Pipeline,
} from '@canopy/desktop-shared/types/pipeline';
import { stepTimedOutMessage } from '../../step-timeout';
import { executePipeline } from '../pipeline-executor';
import { runStep } from '../step-runner';
import type {
  ExecutionRuntime,
  PipelineHostActionCaller,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
} from '../types';

const MOVE_TO_GROUP_MANIFEST = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../../../resources/actions/move-to-group/action.yml',
  ),
  'utf8',
);

const NOT_FOUND: PipelineHostActionResult = {
  status: 'failure',
  failureReason: 'not_found',
  error: "Project `ws-1` isn't available to this pipeline",
  outputs: { grouped: 'false' },
};

function writeAction(root: string, name: string, body: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'action.yml'), body, 'utf8');
}

function createRuntime(root: string): ExecutionRuntime {
  return {
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(root, 'executions'),
    tempRootDir: path.join(root, 'tmp'),
    bundledActionsDir: path.join(root, 'actions'),
    getProjectActionsDir: (repoPath) =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath) =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

interface StubPort extends PipelineHostActions {
  calls: Array<{
    request: PipelineHostActionRequest;
    caller: PipelineHostActionCaller;
  }>;
}

function stubPort(
  respond: (signal: AbortSignal) => Promise<PipelineHostActionResult>,
): StubPort {
  const calls: StubPort['calls'] = [];
  return {
    calls,
    run: (request, caller, signal): Promise<PipelineHostActionResult> => {
      calls.push({ request, caller });
      return respond(signal);
    },
  };
}

function hostStep(overrides: Partial<NormalizedStep> = {}): NormalizedStep {
  return {
    id: 'step-1',
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 1,
    skip_on_missing_action: false,
    uses: 'builtin/move-to-group',
    with: { project_id: 'ws-1', task_id: 'wt-1', group: 'Reviews' },
    ...overrides,
  };
}

describe('host action steps', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-host-step-'));
    runtime = createRuntime(tempDir);
    writeAction(
      runtime.bundledActionsDir,
      'move-to-group',
      MOVE_TO_GROUP_MANIFEST,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    step: NormalizedStep = hostStep(),
    signal = new AbortController().signal,
  ): ReturnType<typeof runStep> {
    return runStep({
      executionId: 'exec-1',
      jobId: 'job-a',
      step,
      cwd: tempDir,
      env: {},
      runtime,
      signal,
      attempt: 2,
      iteration: 3,
      childId: 'child-2',
    });
  }

  it('fails with needs_desktop when the host supplies no port', async () => {
    const result = await run();

    expect(result.status).toBe('failure');
    expect(result.error).toBe('This step needs the desktop app.');
    expect(result.outputs.failure_reason).toBe('needs_desktop');
    expect(result.outputs.grouped).toBe('false');
    expect(result.log_file).toBeDefined();
    const log = fs.readFileSync(result.log_file ?? '', 'utf8');
    expect(log).toContain('[host:move-to-group] failed (needs_desktop)');
    expect(log).not.toContain('Reviews');
  });

  it('echoes the port success outputs with an empty failure_reason', async () => {
    const port = stubPort(() =>
      Promise.resolve({
        status: 'success',
        outputs: { group_id: 'grp-1', group_name: 'Reviews', grouped: 'true' },
      }),
    );
    runtime.pipelineHostActions = port;

    const result = await run();

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({
      group_id: 'grp-1',
      group_name: 'Reviews',
      grouped: 'true',
      failure_reason: '',
    });
    expect(port.calls).toHaveLength(1);
    const [{ request, caller }] = port.calls;
    expect(caller.idempotencyKey).toBe(
      'pipeline-host:exec-1:job-a:child-2:step-1:2:3',
    );
    expect(caller.attempt).toBe(2);
    expect(caller.iteration).toBe(3);
    expect(request).toEqual({
      action: 'move-to-group',
      inputs: {
        task: { kind: 'project', projectId: 'ws-1', taskId: 'wt-1' },
        target: { kind: 'name', name: 'Reviews' },
      },
    });
    expect(fs.readFileSync(result.log_file ?? '', 'utf8')).not.toContain(
      'Reviews',
    );
  });

  it('keeps the outputs of a typed port failure', async () => {
    runtime.pipelineHostActions = stubPort(() => Promise.resolve(NOT_FOUND));

    const result = await run();

    expect(result.status).toBe('failure');
    expect(result.error).toBe(NOT_FOUND.error);
    expect(result.outputs).toEqual({
      grouped: 'false',
      failure_reason: 'not_found',
    });
  });

  it('fails invalid inputs with validation_failed before calling the port', async () => {
    const port = stubPort(() => Promise.resolve(NOT_FOUND));
    runtime.pipelineHostActions = port;

    const bothOwners = await run(
      hostStep({
        with: { project_id: 'ws-1', bot_id: 'app_advisor', task_id: 't' },
      }),
    );
    const noTask = await run(
      hostStep({ with: { project_id: 'ws-1', group: 'Reviews' } }),
    );

    expect(bothOwners.status).toBe('failure');
    expect(bothOwners.outputs.failure_reason).toBe('validation_failed');
    expect(bothOwners.outputs.grouped).toBe('false');
    expect(noTask.status).toBe('failure');
    expect(noTask.outputs.failure_reason).toBe('validation_failed');
    expect(noTask.error).toBe('move-to-group requires "task_id"');
    expect(port.calls).toHaveLength(0);
  });

  it('fails an unknown host action with unsupported_action', async () => {
    writeAction(
      runtime.bundledActionsDir,
      'not-a-host-step',
      ['name: Not A Host Step', 'runs:', '  using: host'].join('\n'),
    );
    const port = stubPort(() => Promise.resolve(NOT_FOUND));
    runtime.pipelineHostActions = port;

    const result = await run(hostStep({ uses: 'builtin/not-a-host-step' }));

    expect(result.status).toBe('failure');
    expect(result.outputs).toEqual({ failure_reason: 'unsupported_action' });
    expect(result.error).toBe(
      'Action "builtin/not-a-host-step" is not a host action this app knows.',
    );
    expect(port.calls).toHaveLength(0);
  });

  it.each([
    ['an explicit timeout', 1],
    ['the default timeout', DEFAULT_TIMEOUT_MINUTES],
  ])('times out a port that never settles with %s', async (_label, minutes) => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    let markCalled: () => void = () => undefined;
    const called = new Promise<void>((resolve) => {
      markCalled = resolve;
    });
    runtime.pipelineHostActions = stubPort(() => {
      markCalled();
      return new Promise<PipelineHostActionResult>(() => undefined);
    });

    const pending = run(hostStep({ timeout_minutes: minutes }));
    await called;
    jest.advanceTimersByTime(minutes * 60_000);
    const result = await pending;

    expect(result.status).toBe('failure');
    expect(result.error).toBe(stepTimedOutMessage(minutes * 60_000));
    expect(result.outputs).toEqual({});
  });

  it('cancels when the signal aborts while the port is pending', async () => {
    const controller = new AbortController();
    let settle: (result: PipelineHostActionResult) => void = () => undefined;
    let portSignal: AbortSignal | undefined;
    runtime.pipelineHostActions = stubPort((signal) => {
      portSignal = signal;
      controller.abort();
      return new Promise<PipelineHostActionResult>((resolve) => {
        settle = resolve;
      });
    });

    const pending = run(hostStep(), controller.signal);
    const result = await pending;
    settle({ status: 'success', outputs: {} });

    expect(result.status).toBe('cancelled');
    expect(result.outputs).toEqual({});
    expect(portSignal?.aborted).toBe(true);
  });

  it('cancels without calling the port when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const port = stubPort(() => Promise.resolve(NOT_FOUND));
    runtime.pipelineHostActions = port;

    const result = await run(hostStep(), controller.signal);

    expect(result.status).toBe('cancelled');
    expect(port.calls).toHaveLength(0);
  });

  it('fails with the message and no failure_reason when the port throws', async () => {
    runtime.pipelineHostActions = stubPort(() =>
      Promise.reject(new Error('boom')),
    );

    const result = await run();

    expect(result.status).toBe('failure');
    expect(result.error).toBe('boom');
    expect(result.outputs).not.toHaveProperty('failure_reason');
  });

  it('rejects a target on a host step', async () => {
    const result = await run(hostStep({ target: { scope: 'global' } }));

    expect(result.status).toBe('failure');
    expect(result.error).toMatch(/is not a pipeline action/);
  });

  describe('through the executor', () => {
    function pipeline(continueOnError: boolean): Pipeline {
      return {
        name: 'Host step',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [
              {
                id: 'move',
                uses: 'builtin/move-to-group',
                continue_on_error: continueOnError,
                with: { project_id: 'ws-1', task_id: 'wt-1', group: 'Reviews' },
              },
              {
                id: 'after',
                run: 'echo "seen=${{ steps.move.outputs.failure_reason }}" >> "$PIPELINE_OUTPUT"',
              },
            ],
          },
        },
      };
    }

    it('lets a later step read failure_reason under continue_on_error', async () => {
      runtime.pipelineHostActions = stubPort(() => Promise.resolve(NOT_FOUND));

      const handle = await executePipeline(pipeline(true), {
        cwd: tempDir,
        runtime,
      });
      const state = await handle.waitForCompletion();

      // A step-level continue_on_error keeps the job running; the job's own
      // outcome still records the failed step (`finalizeJobResult`).
      expect(state.jobs.build.steps.move.conclusion).toBe('success');
      expect(state.jobs.build.steps.move.outcome).toBe('failure');
      expect(state.jobs.build.steps.after.outputs.seen).toBe('not_found');
    });

    it('fails the execution without continue_on_error and keeps the outputs', async () => {
      runtime.pipelineHostActions = stubPort(() => Promise.resolve(NOT_FOUND));

      const handle = await executePipeline(pipeline(false), {
        cwd: tempDir,
        runtime,
      });
      const state = await handle.waitForCompletion();

      expect(state.status).toBe('failure');
      expect(state.jobs.build.steps.move.outputs.failure_reason).toBe(
        'not_found',
      );
    });
  });
});
