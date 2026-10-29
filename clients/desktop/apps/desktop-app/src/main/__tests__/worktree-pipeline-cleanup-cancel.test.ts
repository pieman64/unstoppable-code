jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

import type * as PipelineExecutorModule from '@canopy/desktop-shared/node/pipelines/executor/pipeline-executor';

const mockCancelPipelineExecution = jest.fn();
const mockPersistedCancelPipelineExecution = jest.fn();
const mockGetActiveExecutionHandle = jest.fn();
jest.mock('../pipelines/pipeline-execution-registry', () => ({
  getActiveExecutionHandle: mockGetActiveExecutionHandle,
}));
jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/pipeline-executor',
  () => {
    const actual = jest.requireActual<typeof PipelineExecutorModule>(
      '@canopy/desktop-shared/node/pipelines/executor/pipeline-executor',
    );
    return {
      ...actual,
      cancelPipelineExecution: mockPersistedCancelPipelineExecution,
    };
  },
);

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createInitialState,
  normalizePipeline,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';

async function waitForRemoval(
  filePath: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${filePath} to be removed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
import type {
  ExecutionRuntime,
  ExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  cleanupWorktreePipelines,
  drainWorktreePipelines,
} from '../pipelines/worktree-cleanup';

function makeRuntime(dir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: dir,
    tempRootDir: dir,
    bundledActionsDir: dir,
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
  };
}

function makeExecution(
  id: string,
  worktreeId: string,
  dir: string,
): ExecutionState {
  const normalized = normalizePipeline({
    name: `Pipeline ${id}`,
    on: 'dispatch',
    jobs: {
      build: {
        steps: [{ id: 'step1', run: 'echo hello' }],
      },
    },
  });
  return createInitialState(
    normalized,
    {
      cwd: dir,
      pipelineId: `pipeline-${id}`,
      runtime: makeRuntime(dir),
      projectId: 'project-1',
      worktreeId,
    },
    id,
  );
}

describe('cleanupWorktreePipelines cancellation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-wt-cancel-'));
    mockCancelPipelineExecution.mockReset();
    mockPersistedCancelPipelineExecution.mockReset();
    mockGetActiveExecutionHandle.mockReset();
    mockGetActiveExecutionHandle.mockReturnValue({
      cancel: mockCancelPipelineExecution,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('cancels running executions and cleans them up on success', async () => {
    const runtime = makeRuntime(tempDir);

    const state = makeExecution('exec-running', 'wt-1', tempDir);
    state.status = 'running';
    state.jobs.build.status = 'running';
    await saveExecutionState(state, tempDir);

    // Mock successful cancellation
    mockCancelPipelineExecution.mockResolvedValue({
      ...state,
      status: 'cancelled',
    });

    const result = await cleanupWorktreePipelines('project-1', 'wt-1', runtime);
    expect(result.warnings).toEqual([]);
    expect(mockCancelPipelineExecution).toHaveBeenCalledWith();

    // Wait for fire-and-forget deletion to complete
    await waitForRemoval(path.join(tempDir, 'exec-running.json'));
  });

  it('drains running executions without deleting their archival artifacts', async () => {
    const runtime = makeRuntime(tempDir);
    const state = makeExecution('exec-running', 'wt-1', tempDir);
    state.status = 'running';
    state.jobs.build.status = 'running';
    await saveExecutionState(state, tempDir);
    mockCancelPipelineExecution.mockResolvedValue({
      ...state,
      status: 'cancelled',
    });

    await drainWorktreePipelines('project-1', 'wt-1', runtime);

    expect(mockCancelPipelineExecution).toHaveBeenCalledWith();
    expect(fs.existsSync(path.join(tempDir, 'exec-running.json'))).toBe(true);
  });

  it('drains through the active handle and waits for its process teardown', async () => {
    const runtime = makeRuntime(tempDir);
    const state = makeExecution('exec-active', 'wt-1', tempDir);
    state.status = 'running';
    state.jobs.build.status = 'running';
    await saveExecutionState(state, tempDir);
    const cancel = jest.fn().mockResolvedValue({
      ...state,
      status: 'cancelled',
    });
    mockGetActiveExecutionHandle.mockReturnValue({ cancel });
    mockCancelPipelineExecution.mockRejectedValue(
      new Error('persisted cancellation must not be used for archive drain'),
    );

    await drainWorktreePipelines('project-1', 'wt-1', runtime);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockCancelPipelineExecution).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, 'exec-active.json'))).toBe(true);
  });

  it('falls back to durable cancellation when no active handle is registered', async () => {
    const runtime = makeRuntime(tempDir);
    const state = makeExecution('exec-untracked', 'wt-1', tempDir);
    state.status = 'running';
    state.jobs.build.status = 'running';
    await saveExecutionState(state, tempDir);
    mockGetActiveExecutionHandle.mockReturnValue(undefined);
    mockPersistedCancelPipelineExecution.mockResolvedValue({
      ...state,
      status: 'cancelled',
    });

    await drainWorktreePipelines('project-1', 'wt-1', runtime);

    expect(mockPersistedCancelPipelineExecution).toHaveBeenCalledWith(
      'exec-untracked',
      runtime,
      { allowRecoveredFallback: false },
    );
  });

  it('ignores an unreadable foreign execution while draining this worktree', async () => {
    const runtime = makeRuntime(tempDir);
    const state = makeExecution('exec-readable', 'wt-1', tempDir);
    state.status = 'running';
    state.jobs.build.status = 'running';
    await saveExecutionState(state, tempDir);
    fs.writeFileSync(path.join(tempDir, 'foreign.json'), '{not-json');
    mockCancelPipelineExecution.mockResolvedValue({
      ...state,
      status: 'cancelled',
    });

    await expect(
      drainWorktreePipelines('project-1', 'wt-1', runtime),
    ).resolves.toBeUndefined();
    expect(mockCancelPipelineExecution).toHaveBeenCalledTimes(1);
  });

  it('returns warning when cancel times out', async () => {
    const runtime = makeRuntime(tempDir);

    const state = makeExecution('exec-stuck', 'wt-1', tempDir);
    state.status = 'running';
    state.jobs.build.status = 'running';
    await saveExecutionState(state, tempDir);

    // Mock a cancel that never resolves
    mockCancelPipelineExecution.mockReturnValue(new Promise(() => {}));

    const result = await cleanupWorktreePipelines('project-1', 'wt-1', runtime);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('exec-stuck');
    expect(result.warnings[0]).toContain('Pipeline exec-stuck');

    // Execution file should still exist (not cleaned up)
    expect(fs.existsSync(path.join(tempDir, 'exec-stuck.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'exec-stuck.cancel'))).toBe(true);
  }, 15_000);
});
