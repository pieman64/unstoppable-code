import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { createInitialState } from '../pipeline-executor';
import {
  clearExecutionCancellation,
  requestExecutionCancellation,
  saveExecutionState,
} from '../execution-state';
import type { ExecutionState } from '../types';

describe('execution cancellation requests', () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'execution-cancellation-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(
      children.splice(0).map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        child.kill();
        await exited;
      }),
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  function fixture(): ExecutionState {
    return createInitialState(
      normalizePipeline({
        name: 'Cancellation',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: 'cancellation',
        runtime: {
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: dir,
          tempRootDir: dir,
          bundledActionsDir: dir,
          getProjectActionsDir: (repoPath: string): string => repoPath,
          getProjectPipelinesDir: (repoPath: string): string => repoPath,
        },
      },
      'cancellation',
    );
  }

  function liveOwner(): ChildProcess {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    children.push(child);
    return child;
  }

  const marker = (): string => join(dir, 'cancellation.cancel');
  const snapshot = (): string => join(dir, 'cancellation.json');

  it('writes a cancellation request atomically and durably', async () => {
    const open = fs.open;
    const sync = jest.fn(() => Promise.resolve());
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      jest.spyOn(handle, 'sync').mockImplementation(sync);
      return handle;
    });

    await requestExecutionCancellation('cancellation', dir);

    expect(sync).toHaveBeenCalled();
    expect(await fs.readFile(marker(), 'utf8')).toBe('cancel');
    expect(
      (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('fails a clear it cannot complete and keeps the request', async () => {
    await requestExecutionCancellation('cancellation', dir);
    const unlink = fs.unlink;
    const failure = Object.assign(new Error('cannot clear request'), {
      code: 'EPERM',
    });
    jest.spyOn(fs, 'unlink').mockImplementation(async (filePath) => {
      if (String(filePath) === marker()) throw failure;
      await unlink(filePath);
    });

    await expect(clearExecutionCancellation('cancellation', dir)).rejects.toBe(
      failure,
    );
    expect(await fs.readFile(marker(), 'utf8')).toBe('cancel');
  });

  it('refuses to clear the request of a run another live process owns', async () => {
    const state = fixture();
    state.status = 'running';
    state.owner_pid = liveOwner().pid;
    await saveExecutionState(state, dir);
    await requestExecutionCancellation(state.id, dir);

    await expect(
      clearExecutionCancellation(state.id, dir),
    ).rejects.toMatchObject({
      reason: 'owned_by_other_process',
    });
    expect(await fs.readFile(marker(), 'utf8')).toBe('cancel');
  });

  it('clears the request before a new attempt installs and never when the install is refused', async () => {
    const state = fixture();
    state.status = 'paused';
    await saveExecutionState(state, dir);
    await requestExecutionCancellation(state.id, dir);
    const rename = fs.rename;
    jest.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === snapshot()) {
        await expect(fs.access(marker())).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      await rename(source, destination);
    });
    await saveExecutionState(state, dir, { cancellation: 'clear_before' });
    jest.restoreAllMocks();

    state.status = 'running';
    state.owner_pid = liveOwner().pid;
    await saveExecutionState(state, dir);
    await requestExecutionCancellation(state.id, dir);
    const bytes = await fs.readFile(snapshot());
    await expect(
      saveExecutionState({ ...state, owner_pid: process.pid }, dir, {
        cancellation: 'clear_before',
      }),
    ).rejects.toMatchObject({ reason: 'owned_by_other_process' });
    expect(await fs.readFile(snapshot())).toEqual(bytes);
    expect(await fs.readFile(marker(), 'utf8')).toBe('cancel');
  });

  it('clears the request of a terminal cancellation only after it is installed', async () => {
    const state = fixture();
    await saveExecutionState(state, dir);
    await requestExecutionCancellation(state.id, dir);
    const bytes = await fs.readFile(snapshot());
    const failure = Object.assign(new Error('cannot install cancellation'), {
      code: 'EIO',
    });
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(failure);

    await expect(
      saveExecutionState({ ...state, status: 'cancelled' }, dir, {
        cancellation: 'clear_after',
      }),
    ).rejects.toBe(failure);
    expect(await fs.readFile(snapshot())).toEqual(bytes);
    expect(await fs.readFile(marker(), 'utf8')).toBe('cancel');

    await saveExecutionState({ ...state, status: 'cancelled' }, dir, {
      cancellation: 'clear_after',
    });
    await expect(fs.access(marker())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
