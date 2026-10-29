import {
  SharedContainerPublicationStateStore,
  type SharedContainerPublicationRecord,
} from '../shared-containers/publication-state';
import {
  getWorktreeDataRootDir,
  getWorktreeSharePublicationStatePath,
} from '../lib/paths';
import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as FsPromisesModule from 'node:fs/promises';

describe('SharedContainerPublicationStateStore', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'shared-container-publication-'));
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reports an honest not-published state and broadcasts updates', async () => {
    const broadcast = jest.fn();
    const store = new SharedContainerPublicationStateStore(broadcast);
    const state = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY',
    });
    expect(state).toMatchObject({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY',
      status: 'not-published',
    });
    expect(state).not.toHaveProperty('revision');
    await expect(
      store.get('project-1', 'worktree-1', 'org-1'),
    ).resolves.toEqual(state);
    expect(broadcast).toHaveBeenCalledWith(state);
  });

  it('reuses unchanged publication state across sequential lookups and observes mutations', async () => {
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const initial = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
    });
    const statePath = getWorktreeSharePublicationStatePath(
      'project-1',
      'worktree-1',
    );
    const readSpy = jest.spyOn(fsPromises, 'readFile');
    try {
      expect(await store.list('project-1', 'worktree-1')).toEqual([initial]);
      const afterFirst = readSpy.mock.calls.filter(
        ([filePath]) => filePath === statePath,
      ).length;
      expect(await store.list('project-1', 'worktree-1')).toEqual([initial]);
      expect(
        readSpy.mock.calls.filter(([filePath]) => filePath === statePath),
      ).toHaveLength(afterFirst);

      const updated = await store.set({
        ...initial,
        status: 'published',
        updatedAt: '2026-09-24T12:00:00.000Z',
      });
      expect(await store.list('project-1', 'worktree-1')).toEqual([updated]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('invalidates a sequential lookup after external replacement, deletion, and restore', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const initial = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
    });
    expect(await store.list('project-1', 'worktree-1')).toEqual([initial]);
    const statePath = getWorktreeSharePublicationStatePath(
      'project-1',
      'worktree-1',
    );
    const replacement = {
      ...initial,
      status: 'published' as const,
      updatedAt: '2026-09-24T12:00:00.000Z',
    };
    const stagedPath = `${statePath}.replacement`;
    await writeFile(
      stagedPath,
      JSON.stringify({
        version: 1,
        organizations: { 'org-1': replacement },
      }),
      'utf8',
    );
    await rename(stagedPath, statePath);
    expect(await store.list('project-1', 'worktree-1')).toEqual([replacement]);

    await rm(statePath);
    expect(await store.list('project-1', 'worktree-1')).toEqual([]);
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, organizations: { 'org-1': initial } }),
      'utf8',
    );
    expect(await store.list('project-1', 'worktree-1')).toEqual([initial]);
  });

  it('does not let a caller mutate cached publication records', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const saved = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
    });
    const expected = structuredClone(saved);
    const listed = await store.list('project-1', 'worktree-1');
    listed[0].status = 'error';
    listed[0].error = 'caller mutation';
    const found = await store.get('project-1', 'worktree-1', 'org-1');
    if (found) found.updatedAt = 'changed by caller';
    expect(await store.list('project-1', 'worktree-1')).toEqual([expected]);
  });

  it('invalidates on a same-size external edit with preserved mtime', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const initial: SharedContainerPublicationRecord = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
      status: 'error',
      error: 'alpha',
      updatedAt: '2026-09-24T12:00:00.000Z',
    };
    await store.set(initial);
    expect(await store.list('project-1', 'worktree-1')).toEqual([initial]);
    const statePath = getWorktreeSharePublicationStatePath(
      'project-1',
      'worktree-1',
    );
    const before = await stat(statePath);
    const changed = { ...initial, error: 'bravo' };
    const oldBytes = await readFile(statePath);
    await writeFile(
      statePath,
      JSON.stringify(
        { version: 1, organizations: { 'org-1': changed } },
        null,
        2,
      ),
      'utf8',
    );
    expect(oldBytes.byteLength).toBe((await stat(statePath)).size);
    await utimes(statePath, before.atime, before.mtime);
    const after = await stat(statePath);
    expect(after.size).toBe(before.size);
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(1);
    expect(await store.list('project-1', 'worktree-1')).toEqual([changed]);
  });

  it('evicts old publication states after many distinct worktrees', async () => {
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const first = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-0',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
    });
    const firstPath = getWorktreeSharePublicationStatePath(
      'project-1',
      'worktree-0',
    );
    const readSpy = jest.spyOn(fsPromises, 'readFile');
    try {
      expect(await store.list('project-1', 'worktree-0')).toEqual([first]);
      const initialReads = readSpy.mock.calls.filter(
        ([filePath]) => filePath === firstPath,
      ).length;
      for (let index = 1; index <= 256; index += 1) {
        const statePath = getWorktreeSharePublicationStatePath(
          'project-1',
          `worktree-${index}`,
        );
        await mkdir(dirname(statePath), { recursive: true });
        await writeFile(
          statePath,
          JSON.stringify({
            version: 1,
            organizations: {
              'org-1': { ...first, worktreeId: `worktree-${index}` },
            },
          }),
          'utf8',
        );
        expect(await store.list('project-1', `worktree-${index}`)).toHaveLength(
          1,
        );
      }
      expect(await store.list('project-1', 'worktree-0')).toEqual([first]);
      expect(
        readSpy.mock.calls.filter(([filePath]) => filePath === firstPath),
      ).toHaveLength(initialReads + 1);
    } finally {
      readSpy.mockRestore();
    }
  }, 60_000);

  it('bypasses cache for oversized publication files and bounds total cached bytes', async () => {
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const oversized: SharedContainerPublicationRecord = {
      projectId: 'project-1',
      worktreeId: 'oversized',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
      status: 'error',
      error: 'x'.repeat(300 * 1024),
      updatedAt: '2026-09-24T12:00:00.000Z',
    };
    await store.set(oversized);
    const oversizedPath = getWorktreeSharePublicationStatePath(
      'project-1',
      'oversized',
    );
    const readSpy = jest.spyOn(fsPromises, 'readFile');
    try {
      expect(await store.list('project-1', 'oversized')).toEqual([oversized]);
      expect(await store.list('project-1', 'oversized')).toEqual([oversized]);
      expect(
        readSpy.mock.calls.filter(([filePath]) => filePath === oversizedPath),
      ).toHaveLength(2);

      const first: SharedContainerPublicationRecord = {
        ...oversized,
        worktreeId: 'worktree-0',
        error: 'y'.repeat(40 * 1024),
      };
      for (let index = 0; index < 40; index += 1) {
        const statePath = getWorktreeSharePublicationStatePath(
          'project-1',
          `worktree-${index}`,
        );
        await mkdir(dirname(statePath), { recursive: true });
        await writeFile(
          statePath,
          JSON.stringify({
            version: 1,
            organizations: {
              'org-1': { ...first, worktreeId: `worktree-${index}` },
            },
          }),
          'utf8',
        );
        expect(await store.list('project-1', `worktree-${index}`)).toHaveLength(
          1,
        );
      }
      const firstPath = getWorktreeSharePublicationStatePath(
        'project-1',
        'worktree-0',
      );
      expect(await store.list('project-1', 'worktree-0')).toEqual([first]);
      expect(
        readSpy.mock.calls.filter(([filePath]) => filePath === firstPath),
      ).toHaveLength(2);
    } finally {
      readSpy.mockRestore();
    }
  }, 15_000);

  it('retries a read when publication state changes during the read', async () => {
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const readBeforeSpy = fsPromises.readFile.bind(fsPromises);
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const initial = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
    });
    expect(await store.list('project-1', 'worktree-1')).toEqual([initial]);
    const statePath = getWorktreeSharePublicationStatePath(
      'project-1',
      'worktree-1',
    );
    const middle = { ...initial, status: 'publishing' as const };
    const final = { ...initial, status: 'published' as const };
    const serialize = (record: SharedContainerPublicationRecord): string =>
      JSON.stringify({ version: 1, organizations: { 'org-1': record } });
    await writeFile(statePath, serialize(middle), 'utf8');
    const readSpy = jest
      .spyOn(fsPromises, 'readFile')
      .mockImplementationOnce(async () => {
        const old = await readBeforeSpy(statePath, 'utf8');
        await writeFile(statePath, serialize(final), 'utf8');
        return old;
      });
    try {
      expect(await store.list('project-1', 'worktree-1')).toEqual([final]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('does not serve stale state after a stat failure or cache a failed read', async () => {
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const initial = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
    });
    expect(await store.list('project-1', 'worktree-1')).toEqual([initial]);
    const statePath = getWorktreeSharePublicationStatePath(
      'project-1',
      'worktree-1',
    );
    const updated = { ...initial, status: 'published' as const };
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, organizations: { 'org-1': updated } }),
      'utf8',
    );
    const statSpy = jest
      .spyOn(fsPromises, 'stat')
      .mockRejectedValueOnce(
        Object.assign(new Error('stat unavailable'), { code: 'EIO' }),
      );
    try {
      expect(await store.list('project-1', 'worktree-1')).toEqual([updated]);
    } finally {
      statSpy.mockRestore();
    }
    const latest = { ...initial, status: 'error' as const, error: 'retry me' };
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, organizations: { 'org-1': latest } }),
      'utf8',
    );
    const readSpy = jest
      .spyOn(fsPromises, 'readFile')
      .mockRejectedValueOnce(
        Object.assign(new Error('read unavailable'), { code: 'EIO' }),
      );
    try {
      expect(await store.list('project-1', 'worktree-1')).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
    expect(await store.list('project-1', 'worktree-1')).toEqual([latest]);
  });

  it('records each publish transition as a worktree-scoped diagnostic', async () => {
    // CAN-2551 reduced the owner-facing publish UI to one quiet line, so the
    // transition ladder has to survive in session diagnostics instead. It is
    // worktree-scoped, which is why it must never be a global app event.
    const recordTransition = jest.fn<
      void,
      [
        SharedContainerPublicationRecord | undefined,
        SharedContainerPublicationRecord,
      ]
    >();
    const store = new SharedContainerPublicationStateStore(
      jest.fn(),
      recordTransition,
    );
    await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'WORKTREE',
    });
    expect(recordTransition).toHaveBeenCalledTimes(1);
    expect(recordTransition.mock.calls[0]?.[0]).toBeUndefined();
    expect(recordTransition.mock.calls[0]?.[1]).toMatchObject({
      status: 'not-published',
      organizationId: 'org-1',
    });

    const publishing: SharedContainerPublicationRecord = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'WORKTREE',
      status: 'publishing',
      updatedAt: new Date().toISOString(),
    };
    await store.set(publishing);
    expect(recordTransition).toHaveBeenCalledTimes(2);
    expect(recordTransition.mock.calls[1]?.[0]).toMatchObject({
      status: 'not-published',
    });
    expect(recordTransition.mock.calls[1]?.[1]).toMatchObject({
      status: 'publishing',
    });
  });

  it('does not record a transition when the status and revision are unchanged', async () => {
    const recordTransition = jest.fn<
      void,
      [
        SharedContainerPublicationRecord | undefined,
        SharedContainerPublicationRecord,
      ]
    >();
    const store = new SharedContainerPublicationStateStore(
      jest.fn(),
      recordTransition,
    );
    const input = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'WORKTREE' as const,
    };
    await store.markNotPublished(input);
    await store.markNotPublished(input);
    // `mutate` also runs for idempotent re-writes. Recording those would bury
    // the handful of edges that actually explain a publish.
    expect(recordTransition).toHaveBeenCalledTimes(1);
  });

  it('records a retry that fails a different way at the same revision', async () => {
    // A retry can fail a second way without changing status or revision: the
    // publish scheduler and pipeline both rewrite `status: 'error'` with a
    // freshly classified reason (the scheduler strips the stale one first).
    // Comparing only status and revision would drop exactly the edge this
    // diagnostic exists to capture, now that the owner-facing UI no longer
    // narrates these transitions.
    const recordTransition = jest.fn<
      void,
      [
        SharedContainerPublicationRecord | undefined,
        SharedContainerPublicationRecord,
      ]
    >();
    const store = new SharedContainerPublicationStateStore(
      jest.fn(),
      recordTransition,
    );
    const base: SharedContainerPublicationRecord = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'WORKTREE',
      status: 'error',
      errorReason: 'artifact-budget',
      updatedAt: new Date().toISOString(),
    };
    await store.set(base);
    expect(recordTransition).toHaveBeenCalledTimes(1);

    // Same status, same (absent) revision, different reason.
    await store.set({ ...base, errorReason: 'symlink' });
    expect(recordTransition).toHaveBeenCalledTimes(2);
    expect(recordTransition.mock.calls[1]?.[0]).toMatchObject({
      errorReason: 'artifact-budget',
    });
    expect(recordTransition.mock.calls[1]?.[1]).toMatchObject({
      errorReason: 'symlink',
    });

    // Re-writing the same reason is still an idempotent re-write.
    await store.set({ ...base, errorReason: 'symlink' });
    expect(recordTransition).toHaveBeenCalledTimes(2);
  });

  it('keeps publication state distinct for each organization and rehydrates it', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const first = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    });
    const second = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-2',
      containerId: 'container-2',
      containerType: 'COWORK_WORK_ENTRY',
    });

    await expect(
      store.get('project-1', 'worktree-1', 'org-1'),
    ).resolves.toEqual(first);
    await expect(
      store.get('project-1', 'worktree-1', 'org-2'),
    ).resolves.toEqual(second);

    const restarted = new SharedContainerPublicationStateStore(jest.fn());
    await expect(
      restarted.get('project-1', 'worktree-1', 'org-1'),
    ).resolves.toEqual(first);
    await expect(
      restarted.get('project-1', 'worktree-1', 'org-2'),
    ).resolves.toEqual(second);
  });

  it('keeps a personal container beside organization ones without an organization id', async () => {
    const broadcast = jest.fn();
    const store = new SharedContainerPublicationStateStore(broadcast);
    const organization = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
    });
    const personal = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      containerId: 'container-2',
      containerType: 'CODE_WORKTREE',
    });

    expect(personal).not.toHaveProperty('organizationId');
    expect(broadcast).toHaveBeenLastCalledWith(personal);
    const restarted = new SharedContainerPublicationStateStore(jest.fn());
    await expect(
      restarted.get('project-1', 'worktree-1', undefined),
    ).resolves.toEqual(personal);
    await expect(
      restarted.get('project-1', 'worktree-1', 'org-1'),
    ).resolves.toEqual(organization);
    // Still file version 1: the personal record sits under its own key.
    const persisted: unknown = JSON.parse(
      await readFile(
        getWorktreeSharePublicationStatePath('project-1', 'worktree-1'),
        'utf8',
      ),
    );
    expect(persisted).toMatchObject({
      version: 1,
      organizations: {
        'org-1': { containerId: 'container-1' },
        personal: { containerId: 'container-2' },
      },
    });
  });

  it('rehydrates publication state for an app-managed project', async () => {
    // Regression (CAN-2551): `rehydrateAll` hardcoded
    // `workspaces/<id>/worktree-data`, so app-managed workspaces under
    // `app-workspaces/` were never rehydrated or crash-recovered even though
    // their state file is written under `app-workspaces/<id>/worktree-data`.
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const appManaged = await store.markNotPublished({
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-1',
      organizationId: 'org-1',
      containerId: 'container-app-managed',
      containerType: 'COWORK_WORK_ENTRY',
    });

    const broadcast = jest.fn();
    const restored = await new SharedContainerPublicationStateStore(
      broadcast,
    ).rehydrateAll();

    expect(restored).toContainEqual(expect.objectContaining(appManaged));
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
        containerId: 'container-app-managed',
      }),
    );
  });

  it('enumerates the app-managed root through the canonical data-dir helper', async () => {
    // Enumeration must derive the worktree-data directory the same way the
    // write path does (`getWorktreeDataRootDir`, reached through
    // `getWorktreeSharePublicationStatePath`) instead of hand-joining
    // `worktree-data` onto a workspace root. A local copy of that derivation
    // is what silently skipped every app-managed workspace before CAN-2551.
    const store = new SharedContainerPublicationStateStore(jest.fn());
    await store.markNotPublished({
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-1',
      organizationId: 'org-1',
      containerId: 'container-app-managed',
      containerType: 'COWORK_WORK_ENTRY',
    });

    const canonicalRoot = getWorktreeDataRootDir(PLAN_EXPLORE_CHAT_PROJECT_ID);
    expect(canonicalRoot).toBe(
      join(
        dataDir,
        'app-workspaces',
        PLAN_EXPLORE_CHAT_PROJECT_ID,
        'worktree-data',
      ),
    );
    await expect(
      access(join(canonicalRoot, 'plan-1', 'share-publication-state.json')),
    ).resolves.toBeUndefined();

    const restored = await new SharedContainerPublicationStateStore(
      jest.fn(),
    ).rehydrateAll();
    expect(restored.map((record) => record.containerId)).toEqual([
      'container-app-managed',
    ]);
  });

  it('rehydrates user projects and app-managed projects together', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-user',
      containerType: 'WORKTREE',
    });
    await store.markNotPublished({
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-1',
      organizationId: 'org-1',
      containerId: 'container-app-managed',
      containerType: 'COWORK_WORK_ENTRY',
    });

    const restored = await new SharedContainerPublicationStateStore(
      jest.fn(),
    ).rehydrateAll();

    expect(restored.map((record) => record.containerId).sort()).toEqual([
      'container-app-managed',
      'container-user',
    ]);
  });

  it('rehydrates a committed-symlink publication refusal', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const refused = await store.set({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
      status: 'error',
      error: 'unsupported repository tree entry',
      errorReason: 'symlink',
      updatedAt: '2026-09-01T12:00:00.000Z',
    });

    const restarted = new SharedContainerPublicationStateStore(jest.fn());
    await expect(
      restarted.get('project-1', 'worktree-1', 'org-1'),
    ).resolves.toEqual(refused);
  });

  it('preserves the committed parent when a later grant schedules another revision', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    await store.set({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY',
      status: 'published',
      revision: 4,
      revisionId: 'revision-4',
      publishedAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:00:00.000Z',
    });

    const next = await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY',
    });

    expect(next).toMatchObject({
      status: 'not-published',
      revision: 4,
      revisionId: 'revision-4',
      publishedAt: '2026-08-30T12:00:00.000Z',
    });
  });

  it('does not let a superseded container overwrite the current target', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    await store.markNotPublished({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-2',
      containerType: 'CODE_WORKTREE',
    });

    const persisted = await store.set({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE',
      status: 'published',
      revision: 1,
      revisionId: 'obsolete-revision',
      publishedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    expect(persisted).toMatchObject({
      containerId: 'container-2',
      status: 'not-published',
    });
    await expect(
      store.get('project-1', 'worktree-1', 'org-1'),
    ).resolves.toMatchObject({
      containerId: 'container-2',
      status: 'not-published',
    });
  });

  it('does not let a concurrent grant erase an in-flight publication', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const publishing: SharedContainerPublicationRecord = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY',
      status: 'publishing',
      revision: 4,
      revisionId: 'revision-4',
      publishedAt: '2026-08-30T12:00:00.000Z',
      idempotencyKey: '00000000-0000-4000-8000-000000000010',
      stagingSessionId: '00000000-0000-4000-8000-000000000010',
      stagedRevisionId: 'revision-5',
      stageRequestHash: 'sha256:request-fingerprint',
      updatedAt: '2026-08-30T12:01:00.000Z',
    };

    const [, marked] = await Promise.all([
      store.set(publishing),
      store.markNotPublished({
        projectId: publishing.projectId,
        worktreeId: publishing.worktreeId,
        organizationId: publishing.organizationId,
        containerId: 'container-1',
        containerType: publishing.containerType,
      }),
    ]);

    expect(marked).toEqual(publishing);
    await expect(
      store.get(
        publishing.projectId,
        publishing.worktreeId,
        publishing.organizationId,
      ),
    ).resolves.toEqual(publishing);
  });

  it('rehydrates the staged revision identity used to recover changed retries', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const record: SharedContainerPublicationRecord & {
      stageRequestHash: string;
    } = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY',
      status: 'publishing',
      idempotencyKey: '00000000-0000-4000-8000-000000000010',
      stagingSessionId: '00000000-0000-4000-8000-000000000010',
      stagedRevisionId: 'revision-5',
      stageRequestHash: 'sha256:request-fingerprint',
      publishedContentHash: 'sha256:published-content',
      pendingContentHash: 'sha256:pending-content',
      updatedAt: '2026-08-30T12:00:00.000Z',
    };
    const publishing = await store.set(record);

    const restarted = new SharedContainerPublicationStateStore(jest.fn());
    await expect(
      restarted.get('project-1', 'worktree-1', 'org-1'),
    ).resolves.toEqual(publishing);
  });

  it('rehydrates the marker for retrying with a fresh stage', async () => {
    const store = new SharedContainerPublicationStateStore(jest.fn());
    const restartable = await store.set({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY',
      status: 'error',
      error: 'Upload target refresh limit exceeded',
      restartWithFreshStage: true,
      updatedAt: '2026-08-30T12:00:00.000Z',
    } as SharedContainerPublicationRecord & { restartWithFreshStage: true });

    const restarted = new SharedContainerPublicationStateStore(jest.fn());
    await expect(
      restarted.get('project-1', 'worktree-1', 'org-1'),
    ).resolves.toEqual(restartable);
  });
});
