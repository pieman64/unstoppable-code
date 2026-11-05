import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePipeline } from '../../../../pipelines/normalize-pipeline';
import { createInitialState } from '../pipeline-executor';
import {
  installRestoredExecutionState,
  saveExecutionState,
} from '../execution-state';

describe('execution state restore qualification', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'execution-restore-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const document = {
    id: 'restore',
    version: 1,
    status: 'success',
    future_field: { preserved: true },
  };
  const target = (): string => join(dir, 'restore.json');

  it('installs a restored state durably when no live state exists', async () => {
    const open = fs.open;
    const sync = jest.fn(() => Promise.resolve());
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      jest.spyOn(handle, 'sync').mockImplementation(sync);
      return handle;
    });
    expect(await installRestoredExecutionState('restore', dir, document)).toBe(
      'installed',
    );
    expect(JSON.parse(await fs.readFile(target(), 'utf8'))).toEqual(document);
    expect(sync).toHaveBeenCalled();
  });

  it('never replaces a live state and reports it present', async () => {
    const state = createInitialState(
      normalizePipeline({
        name: 'Live execution',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: 'restore',
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
      'restore',
    );
    await saveExecutionState(state, dir);
    const bytes = await fs.readFile(target());
    expect(await installRestoredExecutionState('restore', dir, document)).toBe(
      'already_present',
    );
    expect(await fs.readFile(target())).toEqual(bytes);
    const newer = JSON.stringify({ id: 'restore', version: 11 });
    await fs.writeFile(target(), newer);
    expect(await installRestoredExecutionState('restore', dir, document)).toBe(
      'already_present',
    );
    expect(await fs.readFile(target(), 'utf8')).toBe(newer);
  });

  it('replaces a damaged live state after copying it aside', async () => {
    await fs.writeFile(target(), '{damaged');
    expect(await installRestoredExecutionState('restore', dir, document)).toBe(
      'installed',
    );
    const copies = (await fs.readdir(dir)).filter((name) =>
      name.startsWith('restore.json.damaged-'),
    );
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(join(dir, copies[0]), 'utf8')).toBe('{damaged');
    expect(JSON.parse(await fs.readFile(target(), 'utf8'))).toEqual(document);
  });

  it('refuses a live state it cannot read', async () => {
    await fs.mkdir(target());
    await expect(
      installRestoredExecutionState('restore', dir, document),
    ).rejects.toMatchObject({ reason: 'unreadable' });
    expect((await fs.stat(target())).isDirectory()).toBe(true);
  });
});
