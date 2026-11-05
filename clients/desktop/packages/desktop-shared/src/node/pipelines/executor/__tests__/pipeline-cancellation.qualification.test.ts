import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePipeline } from '../../../../pipelines/normalize-pipeline';
import { recoverOrphanedPipelineExecutions } from '../crash-recovery';
import {
  loadExecutionState,
  requestExecutionCancellation,
  saveExecutionState,
} from '../execution-state';
import {
  createInitialState,
  executePipeline,
  resumePipeline,
} from '../pipeline-executor';
import type { ExecutionRuntime, ExecutionState } from '../types';

describe('pipeline cancellation qualification', () => {
  let dir: string;
  let runtime: ExecutionRuntime;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'pipeline-cancellation-'));
    runtime = {
      isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
      executionsDir: join(dir, 'executions'),
      tempRootDir: join(dir, 'tmp'),
      bundledActionsDir: join(dir, 'actions'),
      getProjectActionsDir: (repoPath: string): string =>
        join(repoPath, '.canopy', 'actions'),
      getProjectPipelinesDir: (repoPath: string): string =>
        join(repoPath, '.canopy', 'pipelines'),
    };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function fixture(id: string): ExecutionState {
    return createInitialState(
      normalizePipeline({
        name: 'Cancellation recovery',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      { cwd: dir, pipelineId: id, runtime },
      id,
    );
  }

  it('cancels an orphaned run whose cancellation was requested before its owner exited', async () => {
    const state = fixture('orphan-cancellation');
    state.status = 'running';
    state.owner_pid = 2_000_000_000;
    state.jobs.main.status = 'running';
    state.jobs.main.steps.work.status = 'running';
    await saveExecutionState(state, runtime.executionsDir);
    await requestExecutionCancellation(state.id, runtime.executionsDir);

    expect(
      await recoverOrphanedPipelineExecutions(
        [state.id],
        runtime.executionsDir,
      ),
    ).toEqual([]);
    const recovered = await loadExecutionState(state.id, runtime.executionsDir);
    expect(recovered?.status).toBe('cancelled');
    expect(recovered?.completed_at).toBeTruthy();
    expect(recovered?.status_reasons).toEqual([]);
    await expect(
      fs.access(join(runtime.executionsDir, `${state.id}.cancel`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['child-first', 'parent-first'] as const)(
    'cancels nested orphans regardless of %s recovery order',
    async (order) => {
      const ids = ['cancel-parent', 'cancel-child', 'cancel-grandchild'];
      for (const [index, id] of ids.entries()) {
        const state = fixture(id);
        state.status = 'running';
        state.owner_pid = 2_000_000_000;
        state.jobs.main.status = 'running';
        state.jobs.main.steps.work.status = 'running';
        if (ids[index + 1])
          state.jobs.main.steps.work.child_execution_id = ids[index + 1];
        await saveExecutionState(state, runtime.executionsDir);
      }
      await requestExecutionCancellation(ids[0], runtime.executionsDir);

      expect(
        await recoverOrphanedPipelineExecutions(
          order === 'child-first' ? [...ids].reverse() : ids,
          runtime.executionsDir,
        ),
      ).toEqual([]);

      for (const id of ids) {
        const state = await loadExecutionState(id, runtime.executionsDir);
        expect(state?.status).toBe('cancelled');
        expect(state?.completed_at).toBeTruthy();
        expect(state?.status_reasons).toEqual([]);
        await expect(
          fs.access(join(runtime.executionsDir, `${id}.cancel`)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    },
  );

  it.each(['running', 'pending'] as const)(
    'keeps the parent cancellation request when its child still has a live %s owner',
    async (status) => {
      const child = fixture('live-child');
      child.status = status;
      child.owner_pid = process.pid;
      await saveExecutionState(child, runtime.executionsDir);
      const childBytes = await fs.readFile(
        join(runtime.executionsDir, `${child.id}.json`),
      );
      const parent = fixture('cancelled-parent');
      parent.status = 'running';
      parent.owner_pid = 2_000_000_000;
      parent.jobs.main.status = 'running';
      parent.jobs.main.steps.work.status = 'running';
      parent.jobs.main.steps.work.child_execution_id = child.id;
      await saveExecutionState(parent, runtime.executionsDir);
      const parentBytes = await fs.readFile(
        join(runtime.executionsDir, `${parent.id}.json`),
      );
      await requestExecutionCancellation(parent.id, runtime.executionsDir);

      const errors = await recoverOrphanedPipelineExecutions(
        [parent.id],
        runtime.executionsDir,
      );

      expect(errors).toEqual([
        expect.stringContaining(
          `Child execution ${child.id} still has a live or unknown owner`,
        ),
      ]);
      expect(
        await fs.readFile(join(runtime.executionsDir, `${parent.id}.json`)),
      ).toEqual(parentBytes);
      expect(
        await fs.readFile(join(runtime.executionsDir, `${child.id}.json`)),
      ).toEqual(childBytes);
      expect(
        await fs.readFile(
          join(runtime.executionsDir, `${parent.id}.cancel`),
          'utf8',
        ),
      ).toBe('cancel');
    },
  );

  it('cancels nested orphans paused by an earlier recovery sweep', async () => {
    const ids = ['cancel-parent', 'cancel-child', 'cancel-grandchild'];
    for (const [index, id] of ids.entries()) {
      const state = fixture(id);
      state.status = 'running';
      state.owner_pid = 2_000_000_000;
      state.jobs.main.status = 'running';
      state.jobs.main.steps.work.status = 'running';
      if (ids[index + 1])
        state.jobs.main.steps.work.child_execution_id = ids[index + 1];
      await saveExecutionState(state, runtime.executionsDir);
    }
    expect(
      await recoverOrphanedPipelineExecutions(
        ids.slice(1).reverse(),
        runtime.executionsDir,
      ),
    ).toEqual([]);
    await requestExecutionCancellation(ids[0], runtime.executionsDir);
    expect(
      await recoverOrphanedPipelineExecutions([ids[0]], runtime.executionsDir),
    ).toEqual([]);
    for (const id of ids) {
      expect(
        (await loadExecutionState(id, runtime.executionsDir))?.status,
      ).toBe('cancelled');
      await expect(
        fs.access(join(runtime.executionsDir, `${id}.cancel`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('does not start a resumed attempt when its stale request cannot be cleared', async () => {
    const state = fixture('resume-cancellation');
    state.status = 'paused';
    state.jobs.main.status = 'paused';
    state.jobs.main.steps.work.status = 'paused';
    state.status_reasons = [
      {
        id: 'a917c47e-26f6-4f7a-a905-1b8d0e9d655a',
        kind: 'app_shutdown',
        code: 'app_shutdown',
        detected_at: new Date().toISOString(),
        source: { job_id: 'main', step_id: 'work', attempt: 0, iteration: 1 },
      },
    ];
    await saveExecutionState(state, runtime.executionsDir);
    await requestExecutionCancellation(state.id, runtime.executionsDir);
    const marker = join(runtime.executionsDir, `${state.id}.cancel`);
    const unlink = fs.unlink;
    const failure = Object.assign(new Error('cannot clear stale request'), {
      code: 'EPERM',
    });
    jest.spyOn(fs, 'unlink').mockImplementation(async (filePath) => {
      if (String(filePath) === marker) throw failure;
      await unlink(filePath);
    });

    await expect(resumePipeline(state.id, { cwd: dir, runtime })).rejects.toBe(
      failure,
    );
    expect(
      (await loadExecutionState(state.id, runtime.executionsDir))?.status,
    ).toBe('paused');
    expect(await fs.readFile(marker, 'utf8')).toBe('cancel');
  });

  it('keeps watching for cancellation after a check fails', async () => {
    const id = 'poll-cancellation';
    const marker = join(runtime.executionsDir, `${id}.cancel`);
    const access = fs.access;
    let failed = false;
    jest.spyOn(fs, 'access').mockImplementation(async (...args) => {
      if (String(args[0]) === marker && !failed) {
        failed = true;
        throw Object.assign(new Error('cannot inspect request'), {
          code: 'EACCES',
        });
      }
      await access(...args);
    });
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const handle = await executePipeline(
      {
        name: 'Polling cancellation',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'sleep 30' }] } },
      },
      { cwd: dir, pipelineId: id, executionId: id, runtime },
    );
    try {
      await requestExecutionCancellation(id, runtime.executionsDir);
      expect((await handle.waitForCompletion()).status).toBe('cancelled');
      expect(failed).toBe(true);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
