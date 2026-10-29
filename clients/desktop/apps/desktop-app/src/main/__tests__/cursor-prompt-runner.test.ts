import { getCursorRuntimeTarget } from '@canopy/desktop-shared/lib/cursor-runtime-targets';
import type { CursorPromptRunnerRequest } from '@canopy/desktop-shared/node/pipelines/executor/types';
import { runCursorPromptWithDriver } from '@canopy/desktop-shared/node/pipelines/cursor-prompt-runner';
import {
  cursorBaseEnvironment,
  getManagedCursorRuntime,
} from '../cursor/connection';
import { isCursorHarnessEnabled } from '../cursor/feature-flag';
import { cursorConnectionStatus } from '../cursor/runtime-status';
import { runCursorPipelinePrompt } from '../pipelines/cursor-prompt-runner';

jest.mock('../cursor/connection', () => ({
  cursorBaseEnvironment: jest.fn(),
  getManagedCursorRuntime: jest.fn(),
}));
jest.mock('../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: jest.fn(),
}));
jest.mock('../cursor/runtime-status', () => ({
  cursorConnectionStatus: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/pipelines/cursor-prompt-runner', () => ({
  runCursorPromptWithDriver: jest.fn(),
}));
// `step-timeout` is deliberately NOT mocked: the canonical wording is the thing
// under assertion, and a stub here would hide a divergent desktop sentence.

const cursorBaseEnvironmentMock = jest.mocked(cursorBaseEnvironment);
const getManagedCursorRuntimeMock = jest.mocked(getManagedCursorRuntime);
const isCursorHarnessEnabledMock = jest.mocked(isCursorHarnessEnabled);
const cursorConnectionStatusMock = jest.mocked(cursorConnectionStatus);
const runCursorPromptWithDriverMock = jest.mocked(runCursorPromptWithDriver);

const target = getCursorRuntimeTarget('darwin', 'arm64');
if (!target) throw new Error('test host target');

const baseRequest: CursorPromptRunnerRequest = {
  cwd: '/work',
  prompt: 'Summarize',
  environment: {},
  model: 'cursor-default',
  totalTimeoutMs: 60_000,
  permissionPreset: 'read_only',
  executionsDir: '/exec',
  executionId: 'e1',
  jobId: 'j1',
  stepId: 's1',
  attempt: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  isCursorHarnessEnabledMock.mockReturnValue(true);
  cursorConnectionStatusMock.mockResolvedValue({
    supported: true,
    installed: true,
    enabled: true,
    version: '2026.01.01',
    phase: 'connected',
  });
  getManagedCursorRuntimeMock.mockResolvedValue({
    launch: { command: '/rt/cursor-agent', prefix: [] },
    target,
    env: {},
  });
  // Mirrors the real cursorBaseEnvironment/getEnhancedEnv relationship closely
  // enough to prove the caller's scope argument actually reaches it: only a
  // pipeline-runtime scope unlocks the workspace-scoped variable.
  cursorBaseEnvironmentMock.mockImplementation((scope) =>
    scope && scope.runtime === 'pipeline'
      ? { WORKSPACE_PIPELINE_VAR: 'from-scope' }
      : {},
  );
  runCursorPromptWithDriverMock.mockResolvedValue({
    status: 'success',
    sessionId: 'sess-1',
    rawText: 'ok',
    transcript: '',
    usage: {},
  });
});

it('threads the pipeline-scoped workspace environment into the driver base environment', async () => {
  await runCursorPipelinePrompt({ ...baseRequest, projectId: 'workspace-1' });

  expect(cursorBaseEnvironmentMock).toHaveBeenCalledWith({
    runtime: 'pipeline',
    workspaceId: 'workspace-1',
  });
  const driverOptions = runCursorPromptWithDriverMock.mock.calls[0]?.[1];
  expect(driverOptions?.baseEnvironment).toEqual({
    WORKSPACE_PIPELINE_VAR: 'from-scope',
  });
});

it('scopes to the pipeline runtime with no workspaceId when the request has no projectId', async () => {
  await runCursorPipelinePrompt({ ...baseRequest });

  expect(cursorBaseEnvironmentMock).toHaveBeenCalledWith({
    runtime: 'pipeline',
  });
});

it('does not resolve the managed runtime when the feature flag is off', async () => {
  isCursorHarnessEnabledMock.mockReturnValue(false);

  const result = await runCursorPipelinePrompt({ ...baseRequest });

  expect(result).toMatchObject({
    status: 'failure',
    failure: { message: 'Cursor is not available on this device.' },
  });
  expect(getManagedCursorRuntimeMock).not.toHaveBeenCalled();
  expect(runCursorPromptWithDriverMock).not.toHaveBeenCalled();
});

it('does not resolve the managed runtime when Cursor is not connected', async () => {
  cursorConnectionStatusMock.mockResolvedValue({
    supported: true,
    installed: false,
    enabled: false,
    version: '2026.01.01',
    phase: 'idle',
  });

  const result = await runCursorPipelinePrompt({ ...baseRequest });

  expect(result).toMatchObject({
    status: 'failure',
    failure: {
      message: 'Connect Cursor in Settings to run this step.',
    },
  });
  expect(getManagedCursorRuntimeMock).not.toHaveBeenCalled();
  expect(runCursorPromptWithDriverMock).not.toHaveBeenCalled();
});

/** Narrows a runner result's failure message without casting. */
const failureMessageOf = (value: unknown): string => {
  if (typeof value !== 'object' || value === null || !('failure' in value))
    return '';
  const { failure } = value;
  if (
    typeof failure !== 'object' ||
    failure === null ||
    !('message' in failure)
  )
    return '';
  return typeof failure.message === 'string' ? failure.message : '';
};

it.each([
  [
    'a corrupt runtime that fails digest verification',
    new Error('Cursor runtime verification failed: digest mismatch'),
  ],
  ['a setup failure', new Error('EACCES: permission denied')],
  ['a cancellation', new Error('The operation was aborted')],
])(
  'reports %s as a structured Cursor failure instead of a bare exception',
  async (_name, thrown) => {
    // `getManagedCursorRuntime` sits outside any try, so a
    // present-but-corrupt runtime (the cheap gate only checks file presence and
    // X_OK; `installer.verify` does the digest) escaped as a raw exception into
    // the generic step catch. That path writes `error: String(error)` with no
    // agent_failure_metadata_file, no `provider: 'cursor'` classification, no
    // Connect guidance, and — unlike every other failure here — no secret-value
    // redaction of the message.
    getManagedCursorRuntimeMock.mockRejectedValue(thrown);

    const result = await runCursorPipelinePrompt({ ...baseRequest });

    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        version: 1,
        provider: 'cursor',
        agent_harness: 'cursor',
        had_agent_activity: false,
      },
    });
    expect(runCursorPromptWithDriverMock).not.toHaveBeenCalled();
  },
);

it('keeps the Connect guidance in a runtime-resolution failure message', async () => {
  getManagedCursorRuntimeMock.mockRejectedValue(
    new Error('Cursor runtime verification failed: digest mismatch'),
  );

  const result = await runCursorPipelinePrompt({ ...baseRequest });

  expect(failureMessageOf(result)).toContain('Connect Cursor in Settings');
});

describe('the step budget covers setup, not just the turn', () => {
  /**
   * `getManagedCursorRuntime` runs the full SHA-256 digest of the unpacked
   * runtime tree, globally serialized across steps. Starting the clock inside
   * the shared runner left every second of that outside the budget the user
   * declared, so a matrix fan-out could spend minutes in serialized digests
   * with `timeout_minutes` untouched.
   */
  it('charges setup time against the declared budget', async () => {
    const SETUP_MS = 400;
    getManagedCursorRuntimeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                launch: { command: '/rt/cursor-agent', prefix: [] },
                target,
                env: {},
              }),
            SETUP_MS,
          );
        }),
    );
    const startedAt = Date.now();
    await runCursorPipelinePrompt({ ...baseRequest, totalTimeoutMs: 60_000 });

    const forwarded = runCursorPromptWithDriverMock.mock.calls[0]?.[0];
    expect(forwarded).toBeDefined();
    expect(typeof forwarded?.budgetStartedAt).toBe('number');
    // The budget is anchored at the real entry, before the digest.
    expect(forwarded?.budgetStartedAt).toBeGreaterThanOrEqual(startedAt);
    expect(forwarded?.budgetStartedAt).toBeLessThanOrEqual(startedAt + 50);
  });

  it('reports the canonical step timeout when setup alone exhausts the budget', async () => {
    getManagedCursorRuntimeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                launch: { command: '/rt/cursor-agent', prefix: [] },
                target,
                env: {},
              }),
            80,
          );
        }),
    );
    const result = await runCursorPipelinePrompt({
      ...baseRequest,
      totalTimeoutMs: 20,
    });
    expect(result.status).toBe('failure');
    expect(result.status === 'failure' ? result.failure.message : '').toContain(
      'timed out',
    );
    // A budget already gone must not reach the driver at all.
    expect(runCursorPromptWithDriverMock).not.toHaveBeenCalled();
  });

  it('reports cancellation during setup as cancelled, not as connect guidance', async () => {
    // The setup catch mapped EVERY rejection to "Connect Cursor…", so a user
    // who cancelled the run was told their runtime was not connected.
    const controller = new AbortController();
    getManagedCursorRuntimeMock.mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const pending = runCursorPipelinePrompt({
      ...baseRequest,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(
      result.status === 'failure' ? result.failure.message : '',
    ).not.toContain('Connect Cursor');
  });
});

/**
 * Setup must settle on the step's own schedule, not the probe's.
 *
 * Checking elapsed time before and after an `await` is accounting, not
 * enforcement: a connection probe or a runtime digest that never settles left
 * the step pending for as long as it took, whatever budget was declared. The
 * earlier test resolved setup at 80ms and then inspected the result, which
 * cannot tell the two apart.
 */
describe('a step withdraws from setup that has not settled', () => {
  /** Resolves the deferred probe the case is holding open. */
  let releaseSetup: () => void = () => {};
  const holdDigest = (): void => {
    getManagedCursorRuntimeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSetup = (): void =>
            resolve({
              launch: { command: '/rt/cursor-agent', prefix: [] },
              target,
              env: {},
            });
        }),
    );
  };
  const holdConnection = (): void => {
    cursorConnectionStatusMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSetup = (): void =>
            resolve({
              supported: true,
              installed: true,
              enabled: true,
              version: '2026.01.01',
              phase: 'connected',
            });
        }),
    );
  };
  /** True when `pending` settles while setup is still being held open. */
  const settlesWhileHeld = async (
    pending: Promise<unknown>,
  ): Promise<boolean> => {
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return settled;
  };

  it.each([
    ['the runtime digest', holdDigest],
    ['the connection probe', holdConnection],
  ])('reports the step timeout while %s is still pending', async (_l, hold) => {
    hold();
    const pending = runCursorPipelinePrompt({
      ...baseRequest,
      totalTimeoutMs: 20,
    });
    expect(await settlesWhileHeld(pending)).toBe(true);

    releaseSetup();
    const result = await pending;
    expect(result.status).toBe('failure');
    expect(failureMessageOf(result)).toContain('Step timed out');
    // A late setup result must not start a turn afterwards.
    expect(runCursorPromptWithDriverMock).not.toHaveBeenCalled();
  });

  it('reports cancellation while the connection probe is still pending', async () => {
    holdConnection();
    const controller = new AbortController();
    const pending = runCursorPipelinePrompt({
      ...baseRequest,
      signal: controller.signal,
    });
    controller.abort();
    expect(await settlesWhileHeld(pending)).toBe(true);

    releaseSetup();
    const result = await pending;
    // Cancellation, not a timeout and not connect guidance.
    expect(result.status).toBe('cancelled');
    expect(failureMessageOf(result)).not.toContain('Connect Cursor');
    expect(runCursorPromptWithDriverMock).not.toHaveBeenCalled();
  });

  it('does not begin readiness at all for a caller that already cancelled', async () => {
    holdConnection();
    const controller = new AbortController();
    controller.abort();
    const result = await runCursorPipelinePrompt({
      ...baseRequest,
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    // The connection probe ran BEFORE the signal was even inspected.
    expect(cursorConnectionStatusMock).not.toHaveBeenCalled();
    expect(getManagedCursorRuntimeMock).not.toHaveBeenCalled();
  });
});
