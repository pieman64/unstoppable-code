import type * as ScriptExecutionDouble from './helpers/script-execution-double';
import {
  IPC_CHANNELS,
  type AppAdvisorActionResponse,
  type ScriptDescriptor,
  type ScriptRunResponse,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  RunScriptOptions,
  WorktreeScriptEntry,
} from '../services/scripts-service';

jest.mock('../lib/script-execution', () =>
  jest.requireActual<typeof ScriptExecutionDouble>(
    './helpers/script-execution-double',
  ),
);
jest.mock('../services/scripts-service', () => ({
  listWorktreeScriptEntries: jest.fn(),
  runScript: jest.fn(),
}));
jest.mock('../lib/script-runner', () => ({
  isTrackedShellScriptRunning: jest.fn(() => false),
}));
jest.mock('../lib/script-log-store', () => ({
  readScriptRunLogTail: jest.fn(() =>
    Promise.resolve({ meta: null, lines: [] }),
  ),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => 'single-repo'),
  isCoworkWorkspace: jest.fn(() => false),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(),
}));
// Script actions do not use the Codex client; isolate its unrelated runtime cycle.
jest.mock('../codex/app-server-client', () => ({}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(() => true),
}));

import {
  dispatchWorktreeAction,
  type WorktreeActionRuntime,
} from '../canopy-tools/worktree-actions';
import { isTrackedShellScriptRunning } from '../lib/script-runner';
import { readScriptRunLogTail } from '../lib/script-log-store';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { getWorkspaceType } from '../lib/workspace-registry';
import { PortalServiceError } from '../services/portal-service-error';
import {
  listWorktreeScriptEntries,
  runScript,
} from '../services/scripts-service';

const listEntriesMock = jest.mocked(listWorktreeScriptEntries);
const runScriptMock = jest.mocked(runScript);
const isRunningMock = jest.mocked(isTrackedShellScriptRunning);
const readTailMock = jest.mocked(readScriptRunLogTail);
const sendToWindowMock = jest.mocked(sendToWindow);
const readWorkspaceConfigMock = jest.mocked(readWorkspaceConfig);
const readWorkspaceWorktreesMock = jest.mocked(readWorkspaceWorktrees);
const getWorkspaceTypeMock = jest.mocked(getWorkspaceType);

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';

const scriptWindow: SendableBrowserWindow = {
  isDestroyed: () => false,
  webContents: {
    isCrashed: () => false,
    isDestroyed: () => false,
    send: jest.fn(),
    mainFrame: { detached: false, isDestroyed: () => false },
  },
};

function runtime(
  overrides: Partial<WorktreeActionRuntime> = {},
): WorktreeActionRuntime {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    chatId: 'chat-1',
    cwd: '/tmp/worktree',
    getWindow: () => null,
    getSendableWindow: () => scriptWindow,
    ...overrides,
  };
}

function worktreeRow(id = WORKTREE_ID): WorktreeData {
  return { id, branchName: 'feature/scripts', createdAt: '2026-09-24' };
}

function projectEntry(
  scriptName: string,
  overrides: Partial<ScriptDescriptor> = {},
): WorktreeScriptEntry {
  const descriptor: ScriptDescriptor = {
    scriptKey: `project:${scriptName}`,
    scriptName,
    label: scriptName.charAt(0).toUpperCase() + scriptName.slice(1),
    command: `secret-command-${scriptName} --token=abc123`,
    lifecycle:
      scriptName === 'setup' ||
      scriptName === 'launch' ||
      scriptName === 'teardown'
        ? scriptName
        : 'custom',
    target: 'project',
    ...overrides,
  };
  return {
    descriptor,
    request: {
      target: 'project',
      scriptName,
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    },
  };
}

function repoEntry(repoId: string, scriptName: string): WorktreeScriptEntry {
  return {
    descriptor: {
      scriptKey: `workspace-repo:${repoId}:${scriptName}`,
      scriptName,
      label: `API — ${scriptName}`,
      command: `run-${scriptName}`,
      lifecycle: 'custom',
      target: 'workspace-repo',
      repoId,
      repoName: 'API',
    },
    request: {
      target: 'workspace-repo',
      scriptName,
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId,
    },
  };
}

function rootEntry(scriptName: string): WorktreeScriptEntry {
  return {
    descriptor: {
      scriptKey: `workspace-root:${scriptName}`,
      scriptName,
      label: `Project root — ${scriptName}`,
      command: `root-${scriptName}`,
      lifecycle: 'before-setup',
      target: 'workspace-root',
    },
    request: {
      target: 'workspace-root',
      scriptName,
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    },
  };
}

function response(
  overrides: Partial<ScriptRunResponse> = {},
): ScriptRunResponse {
  return {
    success: true,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: 1200,
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outputTail(result: AppAdvisorActionResponse): string[] {
  const tail = isRecord(result.result) ? result.result.outputTail : undefined;
  if (
    !Array.isArray(tail) ||
    !tail.every((line): line is string => typeof line === 'string')
  ) {
    throw new Error('Expected an output tail.');
  }
  return tail;
}

interface ControlledRun {
  /** Resolves once the action layer has called `runScript`. */
  called: Promise<void>;
  options: () => RunScriptOptions;
  finish: (result: ScriptRunResponse) => void;
}

// Agent runs are tracked module-wide until they settle, so every run a test
// starts is finished before the next test begins.
const outstandingRuns: ControlledRun[] = [];

/**
 * Mocks one `runScript` call that emits the renderer lifecycle the real
 * service emits (started, execution started, output), then keeps running
 * until the test finishes it.
 */
function controlledRun(outputLines: string[] = []): ControlledRun {
  let captured: RunScriptOptions | undefined;
  let finishRun: (result: ScriptRunResponse) => void = (): void => undefined;
  let markCalled: () => void = (): void => undefined;
  const called = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  runScriptMock.mockImplementationOnce((request, options = {}) => {
    captured = options;
    const script = projectEntry(request.scriptName).descriptor;
    const event = {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run' as const,
    };
    options.onRendererStarted?.(event);
    options.onExecutionStarted?.();
    if (outputLines.length > 0) {
      options.onRendererOutput?.({ ...event, lines: outputLines });
    }
    const running = new Promise<ScriptRunResponse>((resolve) => {
      finishRun = (result): void => {
        options.onRendererComplete?.({ ...event, result });
        resolve(result);
      };
    });
    markCalled();
    return running;
  });
  const run: ControlledRun = {
    called,
    options: (): RunScriptOptions => {
      if (!captured) throw new Error('runScript was not called');
      return captured;
    },
    finish: (result): void => finishRun(result),
  };
  outstandingRuns.push(run);
  return run;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('worktree script actions', () => {
  afterEach(async () => {
    for (const run of outstandingRuns.splice(0)) run.finish(response());
    await flushMicrotasks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    runScriptMock.mockReset();
    getWorkspaceTypeMock.mockReturnValue('single-repo');
    readWorkspaceWorktreesMock.mockResolvedValue([worktreeRow()]);
    readWorkspaceConfigMock.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'api', name: 'API', repoPath: '/repos/api' }],
    });
    isRunningMock.mockReturnValue(false);
    readTailMock.mockResolvedValue({ meta: null, lines: [] });
    listEntriesMock.mockResolvedValue([
      projectEntry('setup'),
      projectEntry('test'),
      projectEntry('launch'),
      projectEntry('wizard', { interactive: true }),
      projectEntry('teardown', { interactive: true }),
    ]);
  });

  describe('worktree.list_scripts', () => {
    it('lists configured scripts with run state and never returns command text', async () => {
      isRunningMock.mockImplementation(
        (target) => target.scriptKey === 'project:launch',
      );
      readTailMock.mockImplementation(({ scriptKey }) => {
        if (scriptKey === 'project:test') {
          return Promise.resolve({
            meta: {
              version: 1,
              runId: 'run-test',
              script: projectEntry('test').descriptor,
              invocation: 'manual-run',
              status: 'failed',
              startedAt: '2026-09-24T10:00:00.000Z',
              updatedAt: '2026-09-24T10:00:03.000Z',
              completedAt: '2026-09-24T10:00:03.000Z',
              exitCode: 2,
              timedOut: false,
              durationMs: 3000,
            },
            lines: [],
          });
        }
        if (scriptKey === 'project:setup') {
          // A persisted "running" record whose process is gone was stopped.
          return Promise.resolve({
            meta: {
              version: 1,
              runId: 'run-setup',
              script: projectEntry('setup').descriptor,
              invocation: 'automatic-setup',
              status: 'running',
              startedAt: '2026-09-24T09:00:00.000Z',
              updatedAt: '2026-09-24T09:00:01.000Z',
              exitCode: null,
              timedOut: false,
              durationMs: 0,
            },
            lines: [],
          });
        }
        return Promise.resolve({ meta: null, lines: [] });
      });

      const result = await dispatchWorktreeAction(
        { action: { type: 'worktree.list_scripts' } },
        runtime(),
      );
      const terminalReason: unknown = expect.stringContaining('terminal');
      const teardownReason: unknown = expect.stringContaining(
        'archived or deleted',
      );

      expect(result.ok).toBe(true);
      expect(listEntriesMock).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      });
      expect(readTailMock).toHaveBeenCalledWith(
        expect.objectContaining({ scriptKey: 'project:test', maxLines: 0 }),
      );
      expect(result.result).toMatchObject({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        scripts: [
          {
            scriptKey: 'project:setup',
            scriptName: 'setup',
            label: 'Setup',
            lifecycle: 'setup',
            scope: 'project',
            repoId: null,
            interactive: false,
            agentRunnable: true,
            running: false,
            lastRun: { status: 'stopped', exitCode: null },
          },
          {
            scriptKey: 'project:test',
            lifecycle: 'custom',
            agentRunnable: true,
            running: false,
            lastRun: {
              status: 'failed',
              exitCode: 2,
              timedOut: false,
              durationMs: 3000,
              startedAt: '2026-09-24T10:00:00.000Z',
              completedAt: '2026-09-24T10:00:03.000Z',
            },
          },
          {
            scriptKey: 'project:launch',
            agentRunnable: true,
            running: true,
            lastRun: null,
          },
          {
            scriptKey: 'project:wizard',
            interactive: true,
            agentRunnable: false,
            notRunnableReason: terminalReason,
          },
          {
            scriptKey: 'project:teardown',
            // Teardown phases never run in a terminal.
            interactive: false,
            agentRunnable: false,
            notRunnableReason: teardownReason,
          },
        ],
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('secret-command');
      expect(serialized).not.toContain('abc123');
    });

    it.each([
      {
        name: 'a Cowork project',
        setup: (): void => {
          getWorkspaceTypeMock.mockReturnValue('cowork');
        },
        code: 'invalid_target',
        message: 'Project project-1 is a Cowork project',
      },
      {
        name: 'an assistant sentinel project',
        setup: (): void => {
          getWorkspaceTypeMock.mockReturnValue(null);
        },
        code: 'invalid_target',
        message: 'Project project-1 is not a Code project',
      },
      {
        name: 'a missing worktree',
        setup: (): void => {
          readWorkspaceWorktreesMock.mockResolvedValue([worktreeRow('other')]);
        },
        code: 'not_found',
        message: 'Worktree worktree-1 not found in project project-1',
      },
    ])('refuses $name', async ({ setup, code, message }) => {
      setup();
      for (const action of [
        { type: 'worktree.list_scripts' as const },
        { type: 'worktree.run_script' as const, scriptId: 'test' },
      ]) {
        const result = await dispatchWorktreeAction({ action }, runtime());
        expect(result).toMatchObject({ ok: false, error: { code } });
        expect(result.error?.message).toContain(message);
      }
      expect(listEntriesMock).not.toHaveBeenCalled();
      expect(runScriptMock).not.toHaveBeenCalled();
    });

    it('rejects script actions in a Cowork project folder runtime', async () => {
      const result = await dispatchWorktreeAction(
        { action: { type: 'worktree.list_scripts' } },
        runtime({ executionScope: 'directory' }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_target',
          message:
            'worktree.list_scripts requires a git worktree and is not available in this project folder.',
        },
      });
      expect(listEntriesMock).not.toHaveBeenCalled();
    });
  });

  describe('worktree.run_script', () => {
    it('reserves a run while its approval waits, so a parallel call cannot start it twice', async () => {
      const run = controlledRun();
      let approve: (approved: boolean) => void = (): void => undefined;
      const pendingApproval = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            approve = resolve;
          }),
      );
      const first = dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'test' } },
        runtime({ authorizeScriptCommand: pendingApproval }),
      );
      await Promise.resolve();
      for (let i = 0; i < 20 && pendingApproval.mock.calls.length === 0; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pendingApproval).toHaveBeenCalledTimes(1);

      await expect(
        dispatchWorktreeAction(
          { action: { type: 'worktree.run_script', scriptId: 'test' } },
          runtime({ authorizeScriptCommand: () => Promise.resolve(true) }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_target', retryable: true },
      });

      approve(true);
      await expect(first).resolves.toMatchObject({ ok: true });
      await run.called;
      expect(runScriptMock).toHaveBeenCalledTimes(1);
      expect(runScriptMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          expectedScript: {
            command: 'secret-command-test --token=abc123',
            interactive: false,
          },
        }),
      );
    });

    it('releases the reservation when a delegate run is denied', async () => {
      await expect(
        dispatchWorktreeAction(
          { action: { type: 'worktree.run_script', scriptId: 'test' } },
          runtime({ authorizeScriptCommand: () => Promise.resolve(false) }),
        ),
      ).resolves.toMatchObject({ ok: false });
      const run = controlledRun();
      await expect(
        dispatchWorktreeAction(
          { action: { type: 'worktree.run_script', scriptId: 'test' } },
          runtime(),
        ),
      ).resolves.toMatchObject({ ok: true });
      await run.called;
    });

    it('approves the resolved command before a delegate starts a run', async () => {
      const denied = jest.fn(() => Promise.resolve(false));
      const deniedResult = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'test' } },
        runtime({ authorizeScriptCommand: denied }),
      );
      expect(denied).toHaveBeenCalledWith('secret-command-test --token=abc123');
      expect(deniedResult).toMatchObject({
        ok: false,
        error: { code: 'authorization_conflict' },
      });
      expect(runScriptMock).not.toHaveBeenCalled();

      const run = controlledRun();
      const allowed = jest.fn(() => Promise.resolve(true));
      await expect(
        dispatchWorktreeAction(
          { action: { type: 'worktree.run_script', scriptId: 'test' } },
          runtime({ authorizeScriptCommand: allowed }),
        ),
      ).resolves.toMatchObject({ ok: true, result: { status: 'running' } });
      expect(allowed).toHaveBeenCalledTimes(1);
      await run.called;
    });

    it('starts the run with renderer forwarding and returns once execution starts', async () => {
      const run = controlledRun();

      const result = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: ' test ' } },
        runtime(),
      );
      const callback: unknown = expect.any(Function);
      const outputHint: unknown = expect.stringContaining('GetScriptOutput');

      expect(runScriptMock).toHaveBeenCalledWith(
        {
          target: 'project',
          scriptName: 'test',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
        },
        expect.objectContaining({
          onExecutionStarted: callback,
          onRendererStarted: callback,
          onRendererOutput: callback,
          onRendererComplete: callback,
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        result: {
          scriptKey: 'project:test',
          scriptName: 'test',
          label: 'Test',
          lifecycle: 'custom',
          scope: 'project',
          started: true,
          finished: false,
          status: 'running',
          hint: outputHint,
        },
      });
      expect(JSON.stringify(result)).not.toContain('secret-command');
      expect(sendToWindowMock).toHaveBeenCalledWith(
        scriptWindow,
        IPC_CHANNELS.scriptStarted,
        expect.objectContaining({ worktreeId: WORKTREE_ID }),
      );

      run.options().onRendererOutput?.({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        script: projectEntry('test').descriptor,
        invocation: 'manual-run',
        lines: ['still going'],
      });
      expect(sendToWindowMock).toHaveBeenCalledWith(
        scriptWindow,
        IPC_CHANNELS.scriptOutput,
        expect.objectContaining({ lines: ['still going'] }),
      );
      run.finish(response());
      await flushMicrotasks();
      expect(sendToWindowMock).toHaveBeenCalledWith(
        scriptWindow,
        IPC_CHANNELS.scriptComplete,
        expect.objectContaining({ result: response() }),
      );
    });

    it('waits for the run when waitSeconds is set and returns its result', async () => {
      const run = controlledRun(['building', 'FAIL src/app.test.ts']);

      const pending = dispatchWorktreeAction(
        {
          action: {
            type: 'worktree.run_script',
            scriptId: 'test',
            waitSeconds: 120,
          },
        },
        runtime(),
      );
      await run.called;
      run.finish(response({ success: false, exitCode: 1, durationMs: 4200 }));
      const result = await pending;

      expect(result).toMatchObject({
        ok: true,
        result: {
          scriptKey: 'project:test',
          started: true,
          finished: true,
          status: 'failed',
          success: false,
          exitCode: 1,
          timedOut: false,
          durationMs: 4200,
          outputTail: ['building', 'FAIL src/app.test.ts'],
          outputTruncated: false,
        },
      });
    });

    it('returns the output so far when the wait ends before the script finishes', async () => {
      controlledRun(['listening on http://localhost:5173']);

      const result = await dispatchWorktreeAction(
        {
          action: {
            type: 'worktree.run_script',
            scriptId: 'launch',
            waitSeconds: 1,
          },
        },
        runtime(),
      );

      expect(result).toMatchObject({
        ok: true,
        result: {
          scriptKey: 'project:launch',
          lifecycle: 'launch',
          started: true,
          finished: false,
          status: 'running',
          waitedSeconds: 1,
          outputTail: ['listening on http://localhost:5173'],
        },
      });
    });

    it('stops waiting when the call is cancelled without stopping the script', async () => {
      const run = controlledRun(['watching']);
      const controller = new AbortController();

      const pending = dispatchWorktreeAction(
        {
          action: {
            type: 'worktree.run_script',
            scriptId: 'test',
            waitSeconds: 600,
          },
        },
        runtime({ signal: controller.signal }),
      );
      await run.called;
      await flushMicrotasks();
      controller.abort();
      const result = await pending;

      expect(result).toMatchObject({
        ok: true,
        result: { started: true, finished: false, status: 'running' },
      });
      run.finish(response());
    });

    it('keeps only a bounded output tail', async () => {
      const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
      const run = controlledRun(lines);
      const pending = dispatchWorktreeAction(
        {
          action: {
            type: 'worktree.run_script',
            scriptId: 'test',
            waitSeconds: 60,
          },
        },
        runtime(),
      );
      await run.called;
      run.finish(response());
      const result = await pending;
      const tail = outputTail(result);

      expect(tail.length).toBeLessThanOrEqual(100);
      expect(tail.at(-1)).toBe('line 249');
      expect(result.result).toMatchObject({ outputTruncated: true });
    });

    it('does not start a second run of a script that is already running', async () => {
      isRunningMock.mockReturnValue(true);

      const result = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'test' } },
        runtime(),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid_target', retryable: true },
      });
      expect(result.error?.message).toContain('already running');
      expect(result.error?.message).toContain('project:test');
      expect(runScriptMock).not.toHaveBeenCalled();
    });

    it('treats an agent run that is still in flight as running', async () => {
      const run = controlledRun();
      const first = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'test' } },
        runtime(),
      );
      expect(first.ok).toBe(true);

      const duplicate = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'test' } },
        runtime(),
      );
      expect(duplicate).toMatchObject({
        ok: false,
        error: { code: 'invalid_target' },
      });
      expect(runScriptMock).toHaveBeenCalledTimes(1);

      run.finish(response());
      await flushMicrotasks();
      controlledRun();
      const again = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'test' } },
        runtime(),
      );
      expect(again.ok).toBe(true);
      expect(runScriptMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['wizard', 'interactive'],
      ['teardown', 'teardown'],
    ])('refuses the %s script (%s)', async (scriptId, kind) => {
      const result = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId } },
        runtime(),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid_target' },
      });
      expect(result.error?.message).toContain(kind);
      expect(result.error?.message).toContain('Scripts section');
      expect(runScriptMock).not.toHaveBeenCalled();
    });

    it('reports a missing script with the configured script keys', async () => {
      const result = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'tset' } },
        runtime(),
      );

      expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(result.error?.message).toContain('project:tset');
      expect(result.error?.message).toContain('project:test');
      expect(result.error?.message).toContain('worktree.list_scripts');
      expect(runScriptMock).not.toHaveBeenCalled();
    });

    it('resolves multi-repo script ids with the GetScriptOutput rules', async () => {
      getWorkspaceTypeMock.mockReturnValue('multi-repo');
      listEntriesMock.mockResolvedValue([
        rootEntry('before-setup'),
        repoEntry('api', 'test'),
      ]);

      const ambiguous = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'test' } },
        runtime(),
      );
      expect(ambiguous).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
      expect(ambiguous.error?.message).toContain(
        'Multi-repo script lookup requires repo',
      );

      controlledRun();
      const byRepoName = await dispatchWorktreeAction(
        {
          action: {
            type: 'worktree.run_script',
            scriptId: 'test',
            repo: 'API',
          },
        },
        runtime(),
      );
      expect(byRepoName).toMatchObject({
        ok: true,
        result: { scriptKey: 'workspace-repo:api:test', repoId: 'api' },
      });
      expect(runScriptMock).toHaveBeenLastCalledWith(
        repoEntry('api', 'test').request,
        expect.any(Object),
      );

      controlledRun();
      const rootLifecycle = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: 'before-setup' } },
        runtime(),
      );
      expect(rootLifecycle).toMatchObject({
        ok: true,
        result: { scriptKey: 'workspace-root:before-setup' },
      });
    });

    it('accepts a canonical script key', async () => {
      getWorkspaceTypeMock.mockReturnValue('multi-repo');
      listEntriesMock.mockResolvedValue([repoEntry('api', 'test')]);
      controlledRun();

      const result = await dispatchWorktreeAction(
        {
          action: {
            type: 'worktree.run_script',
            scriptId: 'workspace-repo:api:test',
          },
        },
        runtime(),
      );

      expect(result).toMatchObject({
        ok: true,
        result: { scriptKey: 'workspace-repo:api:test' },
      });
    });

    it.each([
      {
        cause: new Error(
          'This worktree is locked while a Split PR is in progress; running a script is unavailable until it finishes.',
        ),
        code: 'execution_failed',
      },
      {
        cause: new PortalServiceError('invalid_target', 'Not allowed.'),
        code: 'invalid_target',
      },
    ])(
      'reports a $code failure raised before the run starts',
      async ({ cause, code }) => {
        runScriptMock.mockRejectedValueOnce(cause);

        const result = await dispatchWorktreeAction(
          { action: { type: 'worktree.run_script', scriptId: 'test' } },
          runtime(),
        );

        expect(result).toMatchObject({
          ok: false,
          error: { code, message: cause.message },
        });

        // A failed start does not leave the script marked as running.
        controlledRun();
        const retry = await dispatchWorktreeAction(
          { action: { type: 'worktree.run_script', scriptId: 'test' } },
          runtime(),
        );
        expect(retry.ok).toBe(true);
      },
    );

    it('rejects an empty script id', async () => {
      const result = await dispatchWorktreeAction(
        { action: { type: 'worktree.run_script', scriptId: '   ' } },
        runtime(),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
      expect(listEntriesMock).not.toHaveBeenCalled();
    });
  });
});
