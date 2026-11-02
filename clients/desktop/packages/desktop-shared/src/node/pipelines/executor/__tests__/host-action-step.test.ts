import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TIMEOUT_MINUTES } from '@canopy/pipeline-interop/normalize-pipeline';
import type {
  NormalizedStep,
  Pipeline,
} from '@canopy/desktop-shared/types/pipeline';
import { emptyWaitForAgentReplyOutputs } from '@canopy/desktop-shared/pipelines/host-wait-for-agent-reply';
import { stepTimedOutMessage } from '../../step-timeout';
import { executePipeline } from '../pipeline-executor';
import { runStep } from '../step-runner';
import type {
  ExecutionRuntime,
  PipelineHostActionCaller,
  PipelineHostActionControls,
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

const WAIT_FOR_AGENT_REPLY_MANIFEST = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../../../resources/actions/wait-for-agent-reply/action.yml',
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
    expect(result.error).toMatch(/is not a workflow action/);
  });

  describe('create-worktree requests', () => {
    const CREATE_WORKTREE_HOST_MANIFEST = fs
      .readFileSync(
        path.resolve(
          __dirname,
          '../../../../../resources/actions/create-worktree/action.yml',
        ),
        'utf8',
      )
      .replace(/\nruns:[\s\S]*$/, '\nruns:\n  using: host\n');

    interface ControlledCall {
      request: PipelineHostActionRequest;
      caller: PipelineHostActionCaller;
      controls: PipelineHostActionControls | undefined;
      signal: AbortSignal;
    }

    function controlledPort(
      respond: (call: ControlledCall) => Promise<PipelineHostActionResult>,
    ): PipelineHostActions & { calls: ControlledCall[] } {
      const calls: ControlledCall[] = [];
      return {
        calls,
        run: (
          request,
          caller,
          signal,
          controls,
        ): Promise<PipelineHostActionResult> => {
          const call = { request, caller, controls, signal };
          calls.push(call);
          return respond(call);
        },
      };
    }

    function createStep(
      overrides: Partial<NormalizedStep> = {},
    ): NormalizedStep {
      return hostStep({
        uses: 'builtin/create-worktree',
        with: { project_id: 'ws-1', worktree_setup: 'run_and_wait' },
        ...overrides,
      });
    }

    const SETUP_TIMED_OUT: PipelineHostActionResult = {
      status: 'failure',
      failureReason: 'setup_timed_out',
      error: 'Setup for task `wt-1` didn’t finish in time',
      outputs: { task_id: 'wt-1', setup_state: 'timed_out' },
    };

    beforeEach(() => {
      writeAction(
        runtime.bundledActionsDir,
        'create-worktree',
        CREATE_WORKTREE_HOST_MANIFEST,
      );
    });

    it('raises the request with a deadline, an artifacts dir and the finalizer seam', async () => {
      const before = Date.now();
      const port = controlledPort(() =>
        Promise.resolve({ status: 'success', outputs: { task_id: 'wt-1' } }),
      );
      runtime.pipelineHostActions = port;

      const result = await run(createStep());

      expect(result.status).toBe('success');
      expect(port.calls).toHaveLength(1);
      const [call] = port.calls;
      expect(call.request).toEqual({
        action: 'create-worktree',
        inputs: {
          projectId: 'ws-1',
          branch: { kind: 'default' },
          repair: false,
          setup: 'run_and_wait',
        },
      });
      expect(call.controls?.deadlineAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(call.controls?.deadlineAt).toBeLessThanOrEqual(
        Date.now() + 60_000,
      );
      const hostDir = path.join(runtime.executionsDir, 'exec-1', 'host');
      expect(path.dirname(call.controls?.artifactsDir ?? '')).toBe(hostDir);
      expect(path.basename(call.controls?.artifactsDir ?? '')).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(typeof call.controls?.registerTimeoutFinalizer).toBe('function');
    });

    it('fails invalid inputs with validation_failed and every create output', async () => {
      const port = controlledPort(() => Promise.resolve(NOT_FOUND));
      runtime.pipelineHostActions = port;

      const result = await run(
        createStep({ with: { project_id: 'ws-1', worktree_setup: 'later' } }),
      );

      expect(result.status).toBe('failure');
      expect(result.outputs.failure_reason).toBe('validation_failed');
      expect(result.outputs).toMatchObject({
        task_id: '',
        worktree_id: '',
        setup_state: '',
        grouped: 'false',
        group_created: 'false',
      });
      expect(port.calls).toHaveLength(0);
    });

    it('fails with needs_desktop and every create output without a port or fallback', async () => {
      const result = await run(createStep());

      expect(result.outputs.failure_reason).toBe('needs_desktop');
      expect(result.outputs.setup_results_file).toBe('');
    });

    function neverSettlingAfterRegistering(
      finalize: () => Promise<PipelineHostActionResult>,
      onCall: () => void,
    ): PipelineHostActions & { calls: ControlledCall[] } {
      return controlledPort((call) => {
        call.controls?.registerTimeoutFinalizer(finalize);
        onCall();
        return new Promise<PipelineHostActionResult>(() => undefined);
      });
    }

    async function runUntilTimeout(
      finalize: () => Promise<PipelineHostActionResult>,
    ): Promise<Awaited<ReturnType<typeof runStep>>> {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      let markCalled: () => void = () => undefined;
      const called = new Promise<void>((resolve) => {
        markCalled = resolve;
      });
      runtime.pipelineHostActions = neverSettlingAfterRegistering(
        finalize,
        markCalled,
      );
      const pending = run(createStep());
      await called;
      jest.advanceTimersByTime(60_000);
      return pending;
    }

    it('returns the finalizer result instead of a generic timeout', async () => {
      const finalize = jest.fn(() => Promise.resolve(SETUP_TIMED_OUT));
      const result = await runUntilTimeout(finalize);

      expect(finalize).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failure');
      expect(result.error).toBe(SETUP_TIMED_OUT.error);
      expect(result.outputs).toEqual({
        task_id: 'wt-1',
        setup_state: 'timed_out',
        failure_reason: 'setup_timed_out',
      });
      expect(fs.readFileSync(result.log_file ?? '', 'utf8')).toContain(
        '[host:create-worktree] timed out (setup_timed_out)',
      );
    });

    it('returns a finalizer success when the work finished as the deadline fired', async () => {
      const result = await runUntilTimeout(() =>
        Promise.resolve({ status: 'success', outputs: { a: '1' } }),
      );

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({ a: '1', failure_reason: '' });
    });

    it.each([
      [
        'rejects',
        (): Promise<PipelineHostActionResult> =>
          Promise.reject(new Error('disk full')),
      ],
      [
        'throws',
        (): Promise<PipelineHostActionResult> => {
          throw new Error('disk full');
        },
      ],
    ])(
      'falls back to the generic timeout when the finalizer %s',
      async (_label, finalize) => {
        const result = await runUntilTimeout(finalize);

        expect(result.status).toBe('failure');
        expect(result.error).toBe(stepTimedOutMessage(60_000));
        expect(result.outputs).toEqual({});
        expect(fs.readFileSync(result.log_file ?? '', 'utf8')).toContain(
          'timeout finalizer failed: disk full',
        );
      },
    );

    it('reports a cancellation without calling the finalizer', async () => {
      const controller = new AbortController();
      const finalize = jest.fn(() => Promise.resolve(SETUP_TIMED_OUT));
      runtime.pipelineHostActions = neverSettlingAfterRegistering(
        finalize,
        () => controller.abort(),
      );

      const result = await run(createStep(), controller.signal);

      expect(result.status).toBe('cancelled');
      expect(result.outputs).toEqual({});
      expect(finalize).not.toHaveBeenCalled();
    });

    it('keeps move-to-group on the generic timeout', async () => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      let markCalled: () => void = () => undefined;
      const called = new Promise<void>((resolve) => {
        markCalled = resolve;
      });
      runtime.pipelineHostActions = controlledPort(() => {
        markCalled();
        return new Promise<PipelineHostActionResult>(() => undefined);
      });
      const pending = run();
      await called;
      jest.advanceTimersByTime(60_000);
      const result = await pending;

      expect(result.error).toBe(stepTimedOutMessage(60_000));
    });
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
        pipelineId: 'host-action-step-test',
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
        pipelineId: 'host-action-step-test',
      });
      const state = await handle.waitForCompletion();

      expect(state.status).toBe('failure');
      expect(state.jobs.build.steps.move.outputs.failure_reason).toBe(
        'not_found',
      );
    });
  });

  describe('wait-for-agent-reply', () => {
    const inputs = {
      project_id: 'proj-1',
      task_id: 'task-1',
      chat_id: 'chat-1',
    };
    const MIN = 60_000;

    function waitStep(overrides: Partial<NormalizedStep> = {}): NormalizedStep {
      return hostStep({
        uses: 'builtin/wait-for-agent-reply',
        with: inputs,
        ...overrides,
      });
    }

    function runWaitStep(
      port: PipelineHostActions,
      step: NormalizedStep,
      extra: Partial<Parameters<typeof runStep>[0]> = {},
    ): ReturnType<typeof runStep> {
      writeAction(
        runtime.bundledActionsDir,
        'wait-for-agent-reply',
        WAIT_FOR_AGENT_REPLY_MANIFEST,
      );
      return runStep({
        executionId: 'exec-1',
        jobId: 'job-a',
        step,
        cwd: tempDir,
        env: {},
        runtime: { ...runtime, pipelineHostActions: port },
        signal: new AbortController().signal,
        attempt: 0,
        iteration: 0,
        ...extra,
      });
    }

    function capturePort(): {
      port: PipelineHostActions;
      controls: () => PipelineHostActionControls | undefined;
    } {
      let seen: PipelineHostActionControls | undefined;
      const port: PipelineHostActions = {
        run: (_request, _caller, _signal, controls) => {
          seen = controls;
          return Promise.resolve({
            status: 'success',
            outputs: emptyWaitForAgentReplyOutputs(),
          });
        },
      };
      return { port, controls: () => seen };
    }

    it('raises the default step deadline to fit reply_timeout_minutes', async () => {
      const { port, controls } = capturePort();
      const before = Date.now();
      await runWaitStep(
        port,
        waitStep({
          timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
          with: { ...inputs, reply_timeout_minutes: '720' },
        }),
      );
      expect(controls()?.deadlineAt).toBeGreaterThanOrEqual(before + 722 * MIN);
    });

    it('keeps the default deadline when it already fits the reply timeout', async () => {
      const { port, controls } = capturePort();
      const before = Date.now();
      await runWaitStep(
        port,
        waitStep({
          timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
          with: { ...inputs, reply_timeout_minutes: '60' },
        }),
      );
      const deadline = controls()?.deadlineAt ?? 0;
      expect(deadline).toBeGreaterThanOrEqual(
        before + DEFAULT_TIMEOUT_MINUTES * MIN,
      );
      expect(deadline).toBeLessThan(
        before + (DEFAULT_TIMEOUT_MINUTES + 1) * MIN,
      );
    });

    it("keeps an author's own timeout_minutes as the hard deadline", async () => {
      const { port, controls } = capturePort();
      const before = Date.now();
      await runWaitStep(
        port,
        waitStep({
          timeout_minutes: 30,
          with: { ...inputs, reply_timeout_minutes: '120' },
        }),
      );
      expect(controls()?.deadlineAt).toBeLessThan(before + 31 * MIN);
    });

    it('returns the finalizer as reply_timed_out with outputs when the step deadline ends the wait', async () => {
      const port: PipelineHostActions = {
        run: (_request, _caller, signal, controls) => {
          controls?.registerTimeoutFinalizer(() =>
            Promise.resolve({
              status: 'failure',
              failureReason: 'reply_timed_out',
              error: 'No reply from chat `chat-1` before the step deadline',
              outputs: {
                ...emptyWaitForAgentReplyOutputs(),
                reply_state: 'timed_out',
                turn_id: 'turn-1',
              },
            }),
          );
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('withdrawn'));
            });
          });
        },
      };
      const result = await runWaitStep(
        port,
        waitStep({ timeout_minutes: 0.001 }),
      );
      expect(result.status).toBe('failure');
      expect(result.outputs).toMatchObject({
        failure_reason: 'reply_timed_out',
        reply_state: 'timed_out',
        turn_id: 'turn-1',
      });
      expect(result.error).not.toContain('Step timed out');
    });

    it('forwards the run agent origin on the caller', async () => {
      const port = stubPort(() =>
        Promise.resolve({ status: 'success', outputs: {} }),
      );
      const origin = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
      await runWaitStep(port, waitStep(), { agentOrigin: origin });
      expect(port.calls[0]?.caller.agentOrigin).toEqual(origin);
    });

    it('omits agentOrigin from the caller when the run has none', async () => {
      const port = stubPort(() =>
        Promise.resolve({ status: 'success', outputs: {} }),
      );
      await runWaitStep(port, waitStep());
      expect(port.calls[0]?.caller).not.toHaveProperty('agentOrigin');
    });

    it('fails validation with every output present', async () => {
      const port = stubPort(() => Promise.reject(new Error('not called')));
      const result = await runWaitStep(
        port,
        waitStep({ with: { project_id: 'p', task_id: 't' } }),
      );
      expect(port.calls).toHaveLength(0);
      expect(result.outputs).toEqual({
        ...emptyWaitForAgentReplyOutputs(),
        failure_reason: 'validation_failed',
      });
    });
  });
});

describe('host action node fallback', () => {
  const FALLBACK_SCRIPT = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.writeFileSync(path.join(__dirname, 'fallback-ran'), 'yes');",
    "fs.appendFileSync(process.env.PIPELINE_OUTPUT, 'echoed=yes\\n');",
  ].join('\n');

  let tempDir: string;
  let runtime: ExecutionRuntime;

  /** Writes `move-to-group` as a host action with a bundled Node fallback. */
  function writeFallbackAction(): string {
    const manifest = MOVE_TO_GROUP_MANIFEST.replace(
      /^runs:\n {2}using: host$/m,
      [
        'runs:',
        '  using: host',
        '  fallback:',
        '    using: node',
        '    main: index.js',
      ].join('\n'),
    );
    expect(manifest).toContain('    main: index.js');
    writeAction(runtime.bundledActionsDir, 'move-to-group', manifest);
    const actionDir = path.join(runtime.bundledActionsDir, 'move-to-group');
    fs.writeFileSync(path.join(actionDir, 'index.js'), FALLBACK_SCRIPT, 'utf8');
    return path.join(actionDir, 'fallback-ran');
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-host-fallback-'));
    runtime = createRuntime(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(): ReturnType<typeof runStep> {
    return runStep({
      executionId: 'exec-1',
      jobId: 'job-a',
      step: hostStep(),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });
  }

  it('runs the fallback subprocess when the host supplies no port', async () => {
    const marker = writeFallbackAction();

    const result = await run();

    expect(result.status).toBe('success');
    expect(result.error).toBeUndefined();
    expect(result.outputs.echoed).toBe('yes');
    expect(result.outputs).not.toHaveProperty('failure_reason');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('still fails with needs_desktop when there is no port and no fallback', async () => {
    writeAction(
      runtime.bundledActionsDir,
      'move-to-group',
      MOVE_TO_GROUP_MANIFEST,
    );

    const result = await run();

    expect(result.status).toBe('failure');
    expect(result.outputs.failure_reason).toBe('needs_desktop');
    expect(result.outputs).not.toHaveProperty('echoed');
  });

  it('never runs the fallback when the port is present', async () => {
    const marker = writeFallbackAction();
    const port = stubPort(() =>
      Promise.resolve({ status: 'success', outputs: { grouped: 'true' } }),
    );
    runtime.pipelineHostActions = port;

    const result = await run();

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({ grouped: 'true', failure_reason: '' });
    expect(port.calls).toHaveLength(1);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    [
      'a typed refusal',
      (): Promise<PipelineHostActionResult> => Promise.resolve(NOT_FOUND),
      NOT_FOUND.error,
    ],
    [
      'a thrown error',
      (): Promise<PipelineHostActionResult> =>
        Promise.reject(new Error('boom')),
      'boom',
    ],
  ])(
    'does not run the fallback after %s from the port',
    async (_label, respond, error) => {
      const marker = writeFallbackAction();
      const port = stubPort(respond);
      runtime.pipelineHostActions = port;

      const result = await run();

      expect(result.status).toBe('failure');
      expect(result.error).toBe(error);
      expect(result.outputs).not.toHaveProperty('echoed');
      expect(port.calls).toHaveLength(1);
      expect(fs.existsSync(marker)).toBe(false);
    },
  );
});

describe('create-project-entry and create-bot-entry requests', () => {
  const manifest = (name: string): string =>
    fs.readFileSync(
      path.resolve(
        __dirname,
        `../../../../../resources/actions/${name}/action.yml`,
      ),
      'utf8',
    );
  const emptyProjectOutputs = {
    project_id: '',
    task_id: '',
    chat_id: '',
    task_created: 'false',
    chat_created: 'false',
    group_id: '',
    group_created: 'false',
    grouped: 'false',
    not_grouped_reason: '',
  };
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-host-entry-'));
    runtime = createRuntime(tempDir);
    for (const name of ['create-project-entry', 'create-bot-entry'])
      writeAction(runtime.bundledActionsDir, name, manifest(name));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    step: NormalizedStep,
    agentOrigin?: { projectId: string; worktreeId: string; chatId: string },
  ): ReturnType<typeof runStep> {
    return runStep({
      executionId: 'exec-1',
      jobId: 'job-a',
      step,
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      attempt: 0,
      iteration: 0,
      ...(agentOrigin ? { agentOrigin } : {}),
    });
  }

  const success = (): Promise<PipelineHostActionResult> =>
    Promise.resolve({ status: 'success', outputs: {} });

  it('raises a create-project-entry request with its parsed inputs', async () => {
    const port = stubPort(success);
    runtime.pipelineHostActions = port;

    await run(
      hostStep({
        uses: 'builtin/create-project-entry',
        with: { project_id: 'cowork-default', title: 'Nightly', group: 'Ops' },
      }),
    );

    expect(port.calls.map(({ request }) => request)).toEqual([
      {
        action: 'create-project-entry',
        inputs: { projectId: 'cowork-default', title: 'Nightly', group: 'Ops' },
      },
    ]);
  });

  it('defaults create-bot-entry to app_advisor from the manifest', async () => {
    const port = stubPort(success);
    runtime.pipelineHostActions = port;

    await run(hostStep({ uses: 'builtin/create-bot-entry', with: {} }));

    expect(port.calls.map(({ request }) => request)).toEqual([
      { action: 'create-bot-entry', inputs: { botId: 'app_advisor' } },
    ]);
  });

  it.each([
    [{}, 'create-project-entry requires "project_id"'],
    [
      { project_id: 'cowork-default', title: 'x'.repeat(201) },
      'create-project-entry "title" must be at most 200 characters',
    ],
  ])(
    'fails invalid inputs with validation_failed and every output',
    async (inputs, message) => {
      const port = stubPort(success);
      runtime.pipelineHostActions = port;

      const result = await run(
        hostStep({ uses: 'builtin/create-project-entry', with: inputs }),
      );

      expect(result.status).toBe('failure');
      expect(result.error).toBe(message);
      expect(result.error).not.toContain('xxxxx');
      expect(result.outputs).toEqual({
        ...emptyProjectOutputs,
        failure_reason: 'validation_failed',
      });
      expect(port.calls).toHaveLength(0);
    },
  );

  it.each(['create-project-entry', 'create-bot-entry'])(
    'fails %s with needs_desktop and its empty outputs without a port',
    async (name) => {
      const result = await run(
        hostStep({
          uses: `builtin/${name}`,
          with: { project_id: 'cowork-default' },
        }),
      );

      expect(result.status).toBe('failure');
      expect(result.outputs.failure_reason).toBe('needs_desktop');
      expect(result.outputs.task_created).toBe('false');
      expect(result.outputs.grouped).toBe('false');
    },
  );

  it('passes the agent origin to the host only when the run has one', async () => {
    const port = stubPort(success);
    runtime.pipelineHostActions = port;
    const agentOrigin = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    const step = hostStep({ uses: 'builtin/create-bot-entry', with: {} });

    await run(step, agentOrigin);
    await run(step);

    expect(port.calls[0]?.caller.agentOrigin).toEqual(agentOrigin);
    expect(port.calls[1]?.caller).not.toHaveProperty('agentOrigin');
  });
});
