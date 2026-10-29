import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import { loadExecutionState, saveExecutionState } from '../execution-state';
import {
  executePipeline,
  getGlobalExecutionWorkspaceDir,
  isTopLevelGlobalRun,
  rerunPipelineExecution,
  resumePipeline,
  retryPipelineExecution,
} from '../pipeline-executor';
import type { ExecutionRuntime, ResolvePipelineTargetResult } from '../types';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
    resolvePipelineTarget: (): Promise<ResolvePipelineTargetResult> =>
      Promise.reject(new Error('Unexpected target resolution')),
  };
}

function writeRunPipelineAction(runtime: ExecutionRuntime): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'run-pipeline');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.copyFileSync(
    path.resolve(
      __dirname,
      '../../../../../resources/actions/run-pipeline/action.yml',
    ),
    path.join(actionDir, 'action.yml'),
  );
}

/** Writes the job's working directory into `cwd.txt` in that directory. */
function cwdPipeline(options: { fail?: boolean } = {}): Pipeline {
  return {
    name: 'Global cwd',
    on: 'dispatch',
    scope: ['global', 'directory'],
    jobs: {
      build: {
        steps: [
          { id: 'where', run: 'pwd > cwd.txt' },
          ...(options.fail ? [{ id: 'fail', run: 'exit 1' }] : []),
        ],
      },
    },
  };
}

function readCwdMarker(dir: string): string {
  return fs.realpathSync(
    fs.readFileSync(path.join(dir, 'cwd.txt'), 'utf8').trim(),
  );
}

describe('global run working folder', () => {
  let tempDir: string;
  let callerDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-global-workspace-')),
    );
    callerDir = path.join(tempDir, 'caller');
    fs.mkdirSync(callerDir);
    runtime = createRuntime(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('identifies only top-level global runs', () => {
    expect(isTopLevelGlobalRun({ scope: 'global' })).toBe(true);
    expect(
      isTopLevelGlobalRun({ scope: 'global', target: { scope: 'global' } }),
    ).toBe(true);
    expect(
      isTopLevelGlobalRun({ scope: 'global', parentExecutionId: 'parent' }),
    ).toBe(false);
    expect(isTopLevelGlobalRun({ scope: 'global', projectId: 'p' })).toBe(
      false,
    );
    expect(isTopLevelGlobalRun({ scope: 'directory' })).toBe(false);
    expect(isTopLevelGlobalRun({})).toBe(false);
  });

  it('runs a top-level global run in its own workspace folder', async () => {
    const handle = await executePipeline(cwdPipeline(), {
      cwd: callerDir,
      runtime,
      pipelineId: 'global-cwd',
      scope: 'global',
    });
    const state = await handle.waitForCompletion();

    const workspaceDir = getGlobalExecutionWorkspaceDir(
      runtime.executionsDir,
      state.id,
    );
    expect(state.status).toBe('success');
    expect(state.cwd).toBe(workspaceDir);
    expect(readCwdMarker(workspaceDir)).toBe(workspaceDir);
    expect(fs.existsSync(path.join(callerDir, 'cwd.txt'))).toBe(false);
  });

  it('creates no folder when a global run fails to start', async () => {
    const pipeline: Pipeline = {
      ...cwdPipeline(),
      on: {
        dispatch: {
          inputs: { ticket: { type: 'string', required: true } },
        },
      },
    };

    await expect(
      executePipeline(pipeline, {
        cwd: callerDir,
        runtime,
        pipelineId: 'global-cwd',
        scope: 'global',
        executionId: 'failed-start',
      }),
    ).rejects.toThrow();
    expect(
      fs.existsSync(path.join(runtime.executionsDir, 'failed-start')),
    ).toBe(false);
  });

  it('gives a rerun a fresh folder under its new id', async () => {
    const first = await (
      await executePipeline(cwdPipeline(), {
        cwd: callerDir,
        runtime,
        pipelineId: 'global-cwd',
        scope: 'global',
      })
    ).waitForCompletion();

    const rerun = await (
      await rerunPipelineExecution(first.id, { cwd: callerDir, runtime })
    ).waitForCompletion();

    expect(rerun.id).not.toBe(first.id);
    expect(rerun.cwd).toBe(
      getGlobalExecutionWorkspaceDir(runtime.executionsDir, rerun.id),
    );
    expect(readCwdMarker(rerun.cwd)).toBe(rerun.cwd);
  });

  it('removes a failed global rerun folder when its shared snapshot is missing', async () => {
    const first = await (
      await executePipeline(cwdPipeline(), {
        cwd: callerDir,
        runtime,
        pipelineId: 'global-cwd',
        scope: 'global',
      })
    ).waitForCompletion();
    await saveExecutionState(
      {
        ...first,
        shared_pipeline_source: {
          type: 'shared',
          serverId: 'server',
          serverName: 'Cloud',
          remoteId: 'remote',
          cachedPipelinePath: path.join(tempDir, 'missing.yaml'),
          fetchedAt: '2026-10-20T00:00:00.000Z',
        },
      },
      runtime.executionsDir,
    );

    await expect(
      rerunPipelineExecution(first.id, {
        cwd: callerDir,
        runtime,
        executionId: 'rerun-id',
      }),
    ).rejects.toThrow('shared pipeline snapshot is unavailable');
    expect(fs.existsSync(path.join(runtime.executionsDir, 'rerun-id'))).toBe(
      false,
    );
  });

  it('keeps the existing folder on retry, recreating it when removed', async () => {
    const failed = await (
      await executePipeline(cwdPipeline({ fail: true }), {
        cwd: callerDir,
        runtime,
        pipelineId: 'global-cwd',
        scope: 'global',
      })
    ).waitForCompletion();
    expect(failed.status).toBe('failure');
    fs.rmSync(failed.cwd, { recursive: true, force: true });

    const retried = await (
      await retryPipelineExecution(failed.id, { cwd: callerDir, runtime })
    ).waitForCompletion();

    expect(retried.cwd).toBe(failed.cwd);
    expect(fs.existsSync(failed.cwd)).toBe(true);
  });

  it('keeps the existing folder on resume', async () => {
    const pipeline: Pipeline = {
      name: 'Global pause',
      on: 'dispatch',
      scope: ['global'],
      jobs: { build: { steps: [{ id: 'wait', run: 'sleep 30' }] } },
    };
    const handle = await executePipeline(pipeline, {
      cwd: callerDir,
      runtime,
      pipelineId: 'global-pause',
      scope: 'global',
    });
    if (!handle.pauseForShutdown) throw new Error('Expected shutdown pause');
    const paused = await handle.pauseForShutdown();
    expect(paused.status).toBe('paused');
    fs.rmSync(paused.cwd, { recursive: true, force: true });

    const resumed = await resumePipeline(paused.id, {
      cwd: callerDir,
      runtime,
    });
    const state = resumed.getState();
    await resumed.cancel();

    expect(paused.cwd).toBe(
      getGlobalExecutionWorkspaceDir(runtime.executionsDir, paused.id),
    );
    expect(state.cwd).toBe(paused.cwd);
    expect(fs.existsSync(paused.cwd)).toBe(true);
  });

  it('runs a global child with an inherited target in the parent folder', async () => {
    writeRunPipelineAction(runtime);
    const parent: Pipeline = {
      name: 'Global parent',
      on: 'dispatch',
      scope: ['global'],
      jobs: {
        build: {
          steps: [
            {
              id: 'child',
              uses: 'builtin/run-pipeline',
              target: { scope: 'inherit' },
              with: { pipeline_yaml: JSON.stringify(cwdPipeline()) },
            },
          ],
        },
      },
    };

    const state = await (
      await executePipeline(parent, {
        cwd: callerDir,
        runtime,
        pipelineId: 'global-parent',
        scope: 'global',
      })
    ).waitForCompletion();

    expect(state.status).toBe('success');
    const childId = state.jobs.build.steps.child.child_execution_id;
    if (childId === undefined) throw new Error('Expected a child execution');
    const child = await loadExecutionState(childId, runtime.executionsDir);
    expect(child?.cwd).toBe(state.cwd);
    expect(
      fs.existsSync(
        getGlobalExecutionWorkspaceDir(runtime.executionsDir, childId),
      ),
    ).toBe(false);
  });

  it('leaves a directory run in its caller folder', async () => {
    const state = await (
      await executePipeline(cwdPipeline(), {
        cwd: callerDir,
        runtime,
        pipelineId: 'directory-cwd',
        scope: 'directory',
      })
    ).waitForCompletion();

    expect(state.cwd).toBe(callerDir);
    expect(readCwdMarker(callerDir)).toBe(callerDir);
  });
});
