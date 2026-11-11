import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as DirectoryFlush from '@canopy/core-platform/directory-flush';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';

jest.mock('@canopy/core-platform/directory-flush', () => {
  const actual = jest.requireActual<typeof DirectoryFlush>(
    '@canopy/core-platform/directory-flush',
  );
  return { ...actual, flushDirectory: jest.fn(actual.flushDirectory) };
});

import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { recoverOrphanedPipelineExecutions } from '../crash-recovery';
import * as executionState from '../execution-state';
import {
  loadExecutionState,
  loadExecutionStateRevision,
  requestExecutionCancellation,
  saveExecutionState,
  saveExecutionStateIfUnchanged,
} from '../execution-state';
import { createInitialState } from '../pipeline-executor';
import type { ExecutionState } from '../types';

describe('execution state durability qualification', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'execution-durability-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest
      .mocked(flushDirectory)
      .mockImplementation(
        jest.requireActual<typeof DirectoryFlush>(
          '@canopy/core-platform/directory-flush',
        ).flushDirectory,
      );
    await fs.rm(dir, { recursive: true, force: true });
  });

  function fixture(id: string): ExecutionState {
    return createInitialState(
      normalizePipeline({
        name: 'Durability',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: id,
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
      id,
    );
  }

  it('syncs a progress snapshot and flushes its folder before resolving', async () => {
    const open = fs.open;
    const synced: string[] = [];
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      jest.spyOn(handle, 'sync').mockImplementation(async () => {
        synced.push(String(args[0]));
        await sync();
      });
      return handle;
    });

    await saveExecutionState(fixture('progress'), dir);

    expect(synced).toContainEqual(
      expect.stringMatching(/\.progress\.json\..+\.tmp$/),
    );
    expect(jest.mocked(flushDirectory)).toHaveBeenCalledWith(dir);
  });

  it('reports a failed folder flush after a progress install, and rejects it when durability was required', async () => {
    jest
      .mocked(flushDirectory)
      .mockRejectedValue(new Error('folder flush failed'));
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const state = fixture('flush');

    await expect(saveExecutionState(state, dir)).resolves.toBeUndefined();
    expect((await loadExecutionState('flush', dir))?.id).toBe('flush');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('folder flush failed');

    const required = await saveExecutionState(state, dir, {
      durable: true,
    }).catch((error: unknown) => error);
    expect(isStorageOutcomeUnknownError(required)).toBe(true);
  });

  it('installs nothing when another install replaced the revision it read', async () => {
    const state = fixture('revision');
    await saveExecutionState(state, dir);
    const loaded = await loadExecutionStateRevision('revision', dir);
    await saveExecutionState({ ...state, hidden: true }, dir);
    const bytes = await fs.readFile(join(dir, 'revision.json'));

    await expect(
      saveExecutionStateIfUnchanged(
        { ...state, status: 'paused' },
        dir,
        loaded?.revision,
      ),
    ).resolves.toBe(false);
    expect(await fs.readFile(join(dir, 'revision.json'))).toEqual(bytes);
  });

  it('pairs a state with the revision of the file it was read from', async () => {
    const state = fixture('paired');
    await saveExecutionState(state, dir);
    const statePath = join(dir, 'paired.json');
    const open = fs.open;
    let replaced = false;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === statePath && !replaced) {
        replaced = true;
        await saveExecutionState({ ...state, hidden: true }, dir);
      }
      return handle;
    });

    const loaded = await loadExecutionStateRevision('paired', dir);

    expect(replaced).toBe(true);
    expect(loaded?.state.hidden).toBeUndefined();
    await expect(
      saveExecutionStateIfUnchanged(
        { ...state, status: 'paused' },
        dir,
        loaded?.revision,
      ),
    ).resolves.toBe(false);
    expect((await loadExecutionState('paired', dir))?.hidden).toBe(true);
  });

  it('settles a cancellation whose install lost to another recovery pausing the run', async () => {
    const state = fixture('cancel-race');
    state.status = 'running';
    state.owner_pid = 2_000_000_000;
    state.jobs.main.status = 'running';
    state.jobs.main.steps.work.status = 'running';
    await saveExecutionState(state, dir);
    await requestExecutionCancellation('cancel-race', dir);
    const load = executionState.loadExecutionStateRevision;
    let paused = false;
    jest
      .spyOn(executionState, 'loadExecutionStateRevision')
      .mockImplementation(async (...args) => {
        const loaded = await load(...args);
        if (!paused && loaded) {
          paused = true;
          await saveExecutionState({ ...loaded.state, status: 'paused' }, dir);
        }
        return loaded;
      });

    expect(
      await recoverOrphanedPipelineExecutions(['cancel-race'], dir),
    ).toEqual([]);

    expect(paused).toBe(true);
    expect((await loadExecutionState('cancel-race', dir))?.status).toBe(
      'cancelled',
    );
    await expect(
      fs.access(join(dir, 'cancel-race.cancel')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the first recovery and its reason IDs when two recover one orphan at once', async () => {
    const state = fixture('orphan');
    state.status = 'running';
    state.owner_pid = 2_000_000_000;
    state.jobs.main.status = 'running';
    state.jobs.main.steps.work.status = 'running';
    await saveExecutionState(state, dir);
    const load = executionState.loadExecutionStateRevision;
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothLoaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(executionState, 'loadExecutionStateRevision')
      .mockImplementation(async (...args) => {
        const loaded = await load(...args);
        arrived += 1;
        if (arrived === 2) release();
        if (arrived <= 2) await bothLoaded;
        return loaded;
      });

    const rename = fs.rename;
    const installs: string[] = [];
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to) === join(dir, 'orphan.json')) {
        const installed = await loadExecutionState('orphan', dir);
        installs.push(JSON.stringify(installed?.status_reasons));
      }
    });

    const results = await Promise.all([
      recoverOrphanedPipelineExecutions(['orphan'], dir),
      recoverOrphanedPipelineExecutions(['orphan'], dir),
    ]);

    expect(results).toEqual([[], []]);
    expect(installs).toHaveLength(1);
    const installed = await loadExecutionState('orphan', dir);
    expect(installed?.status).toBe('paused');
    expect(JSON.stringify(installed?.status_reasons)).toBe(installs[0]);
  });
});
