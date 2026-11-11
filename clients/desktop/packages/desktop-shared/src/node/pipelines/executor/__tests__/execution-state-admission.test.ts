import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { createInitialState } from '../pipeline-executor';
import {
  deleteExecutionState,
  isExecutionStateWriteRefusal,
  loadExecutionState,
  saveExecutionState,
  setExecutionHidden,
} from '../execution-state';
import type { ExecutionState } from '../types';

describe('execution state writer admission', () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(join(tmpdir(), 'execution-admission-'));
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  function fixture(): ExecutionState {
    const state = createInitialState(
      normalizePipeline({
        name: 'Admission',
        on: 'dispatch',
        jobs: { main: { steps: [{ run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: 'admission',
        runtime: {
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: dir,
          tempRootDir: dir,
          bundledActionsDir: dir,
          getProjectActionsDir: (repoPath: string) => repoPath,
          getProjectPipelinesDir: (repoPath: string) => repoPath,
        },
      },
      'admission',
    );
    state.id = 'admission';
    return state;
  }

  function liveOwner(): ChildProcess {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    children.push(child);
    return child;
  }

  const statePath = (): string => join(dir, 'admission.json');

  it('refuses to replace a running execution owned by another live process', async () => {
    const child = liveOwner();
    const state = fixture();
    state.status = 'running';
    state.owner_pid = child.pid;
    await saveExecutionState(state, dir);
    const bytes = await fsPromises.readFile(statePath());
    const stale = { ...state, owner_pid: process.pid };
    const refusal: unknown = await saveExecutionState(stale, dir).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ reason: 'owned_by_other_process' });
    if (!isExecutionStateWriteRefusal(refusal))
      throw new Error('Expected a write refusal');
    expect(refusal.code).toBe('EXECUTION_STATE_WRITE_REFUSED');
    expect(await fsPromises.readFile(statePath())).toEqual(bytes);
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.kill();
    await exited;
    await expect(saveExecutionState(stale, dir)).resolves.toBeUndefined();
  });

  it('admits a save over a paused or finished execution whatever its recorded owner', async () => {
    const child = liveOwner();
    for (const status of ['paused', 'success'] as const) {
      const state = fixture();
      state.status = status;
      state.owner_pid = child.pid;
      await saveExecutionState(state, dir);
      await expect(
        saveExecutionState({ ...state, owner_pid: process.pid }, dir),
      ).resolves.toBeUndefined();
    }
  });

  it('refuses to write over a newer-version file and leaves it byte-identical', async () => {
    const bytes = '{"version":11,"id":"admission"}';
    await fsPromises.writeFile(statePath(), bytes);
    await expect(saveExecutionState(fixture(), dir)).rejects.toMatchObject({
      reason: 'newer_version',
    });
    expect(await fsPromises.readFile(statePath(), 'utf8')).toBe(bytes);
  });

  it('refuses to write over a file it cannot read', async () => {
    await fsPromises.mkdir(statePath());
    await expect(saveExecutionState(fixture(), dir)).rejects.toMatchObject({
      reason: 'unreadable',
    });
    expect((await fsPromises.stat(statePath())).isDirectory()).toBe(true);
  });

  it('copies a damaged file aside before replacing it', async () => {
    await fsPromises.writeFile(statePath(), '{bad');
    await saveExecutionState(fixture(), dir);
    const copies = (await fsPromises.readdir(dir)).filter((name) =>
      /^admission\.json\.damaged-\d+$/.test(name),
    );
    expect(copies).toHaveLength(1);
    expect(await fsPromises.readFile(join(dir, copies[0]), 'utf8')).toBe(
      '{bad',
    );
    expect(await loadExecutionState('admission', dir)).toMatchObject({
      id: 'admission',
    });
  });

  it('keeps only the newest five damaged copies', async () => {
    for (let index = 1000; index <= 1005; index += 1)
      await fsPromises.writeFile(
        `${statePath()}.damaged-${index}`,
        String(index),
      );
    await fsPromises.writeFile(statePath(), '{bad');
    await saveExecutionState(fixture(), dir);
    const copies = (await fsPromises.readdir(dir)).filter((name) =>
      name.includes('.damaged-'),
    );
    expect(copies).toHaveLength(5);
    for (let index = 1002; index <= 1005; index += 1)
      expect(copies).toContain(`admission.json.damaged-${index}`);
  });

  it('refuses to replace a damaged file it cannot copy aside', async () => {
    await fsPromises.writeFile(statePath(), '{bad');
    jest
      .spyOn(fsPromises, 'copyFile')
      .mockRejectedValueOnce(
        Object.assign(new Error('copy failed'), { code: 'EIO' }),
      );
    await expect(saveExecutionState(fixture(), dir)).rejects.toMatchObject({
      reason: 'damaged_copy_failed',
    });
    expect(await fsPromises.readFile(statePath(), 'utf8')).toBe('{bad');
  });

  it('rechecks the owner after another process rewrote the file', async () => {
    const state = fixture();
    await saveExecutionState(state, dir);
    const foreign = { ...state, status: 'running', owner_pid: liveOwner().pid };
    await fsPromises.writeFile(statePath(), JSON.stringify(foreign));
    await expect(saveExecutionState(state, dir)).rejects.toMatchObject({
      reason: 'owned_by_other_process',
    });
  });

  it("deletes a finished execution's state, request and damaged copies, and refuses a running one owned by another live process", async () => {
    const state = fixture();
    state.status = 'success';
    await saveExecutionState(state, dir);
    await fsPromises.writeFile(join(dir, 'admission.cancel'), 'cancel');
    await fsPromises.writeFile(`${statePath()}.damaged-1000`, '{bad');
    await deleteExecutionState(state.id, dir);
    expect(
      (await fsPromises.readdir(dir)).filter((name) => name !== '.locks'),
    ).toEqual([]);
    state.status = 'running';
    state.owner_pid = liveOwner().pid;
    await saveExecutionState(state, dir);
    await fsPromises.writeFile(join(dir, 'admission.cancel'), 'cancel');
    await fsPromises.writeFile(`${statePath()}.damaged-1000`, '{bad');
    const before = await fsPromises.readdir(dir);
    await expect(deleteExecutionState(state.id, dir)).rejects.toMatchObject({
      reason: 'owned_by_other_process',
    });
    expect(await fsPromises.readdir(dir)).toEqual(before);
  });

  it('hides an execution through the lock and refuses one another live process runs', async () => {
    const state = fixture();
    state.status = 'success';
    await saveExecutionState(state, dir);
    await expect(
      setExecutionHidden(state.id, true, dir),
    ).resolves.toMatchObject({ hidden: true });
    state.status = 'running';
    state.owner_pid = liveOwner().pid;
    await saveExecutionState(state, dir);
    await expect(setExecutionHidden(state.id, true, dir)).rejects.toMatchObject(
      { reason: 'owned_by_other_process' },
    );
  });
});
