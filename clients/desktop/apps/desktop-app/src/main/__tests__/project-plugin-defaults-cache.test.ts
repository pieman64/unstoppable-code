import type {
  ChatTabPluginSelections,
  PreferencesData,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';

jest.mock('../lib/script-runner', () => ({
  listTrackedShellScripts: (): never[] => [],
  subscribeTrackedScriptsChanged: (): (() => void) => (): void => undefined,
}));
jest.mock('../canopy-cloud/mcp-connections', () => ({
  listAccountMcpConnections: (): Promise<never[]> => Promise.resolve([]),
}));
const readPreferencesFileMock = jest.fn<Promise<Partial<PreferencesData>>, []>(
  () => Promise.resolve({}),
);
jest.mock('../lib/preferences-store', () => ({
  DEFAULT_PREFERENCES: {},
  readPreferencesFile: (): Promise<Partial<PreferencesData>> =>
    readPreferencesFileMock(),
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readPersistedChatPluginInheritance: (): Promise<unknown> =>
    Promise.resolve({ inheritsProjectDefaults: true }),
}));

import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEffectiveChatPluginSelections } from '../plugins/global-plugin-overlay';
import { writeWorkspaceConfig } from '../lib/workspace-persistence';
import { getWorkspaceConfigPath } from '../lib/paths';
import { writeCoworkMigrationMap } from '../lib/cowork-migration-map';
import {
  projectPluginDefaultsWritten,
  readThroughProjectPluginDefaults,
  reconcileProjectPluginDefaults,
  type ProjectPluginDefaults,
  type ProjectPluginDefaultsRead,
  type ProjectPluginDefaultsRemoved,
} from '../plugins/project-plugin-defaults-cache';
import { getProjectPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');
const realReadFile = fsPromises.readFile;
const pluginA = { marketplaceId: 'mkt', pluginName: 'plug-a' };
const pluginB = { marketplaceId: 'mkt', pluginName: 'plug-b' };

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], ...overrides };
}

function config(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: '/repo',
    repos: [],
    ...overrides,
  };
}

function resolve(
  projectId: string,
  worktreeId = 'wt-1',
): Promise<ChatTabPluginSelections> {
  return resolveEffectiveChatPluginSelections(
    selections(),
    { projectId, worktreeId, chatId: 'chat-1' },
    true,
  );
}

describe('project plugin defaults read by chat plugin resolution', () => {
  const previousDataDir = process.env.CANOPY_DATA_DIR;
  let dataDir: string;
  let readFileSpy: jest.SpyInstance;

  function configReads(workspaceId: string): number {
    const target = getWorkspaceConfigPath(workspaceId);
    return readFileSpy.mock.calls.filter(([path]) => path === target).length;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'project-plugin-defaults-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    readPreferencesFileMock.mockResolvedValue({});
    readFileSpy = jest.spyOn(fsPromises, 'readFile');
  });

  afterEach(async () => {
    readFileSpy.mockRestore();
    process.env.CANOPY_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reads a project without defaults once', async () => {
    await writeWorkspaceConfig('ws-plain', config());
    readFileSpy.mockClear();

    expect((await resolve('ws-plain')).pluginRefs).toEqual([]);
    expect((await resolve('ws-plain')).pluginRefs).toEqual([]);

    expect(configReads('ws-plain')).toBe(1);
  });

  it('reads a project that has no workspace.json once', async () => {
    await resolve('ws-missing');
    await resolve('ws-missing');

    expect(configReads('ws-missing')).toBe(1);
  });

  it('reads a project with defaults once', async () => {
    await writeWorkspaceConfig(
      'ws-defaults',
      config({
        defaultPluginSelections: selections({ pluginRefs: [pluginA] }),
      }),
    );
    readFileSpy.mockClear();

    expect((await resolve('ws-defaults')).pluginRefs).toEqual([pluginA]);
    expect((await resolve('ws-defaults')).pluginRefs).toEqual([pluginA]);

    expect(configReads('ws-defaults')).toBe(1);
  });

  it('sees a defaults change on the very next resolution', async () => {
    await writeWorkspaceConfig(
      'ws-change',
      config({
        defaultPluginSelections: selections({ pluginRefs: [pluginA] }),
      }),
    );
    expect((await resolve('ws-change')).pluginRefs).toEqual([pluginA]);

    await writeWorkspaceConfig(
      'ws-change',
      config({
        defaultPluginSelections: selections({ pluginRefs: [pluginB] }),
      }),
    );

    expect((await resolve('ws-change')).pluginRefs).toEqual([pluginB]);
  });

  it('sees a project turning a global default off on the next resolution', async () => {
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({ pluginRefs: [pluginA] }),
    });
    await writeWorkspaceConfig('ws-tombstone', config());
    expect((await resolve('ws-tombstone')).pluginRefs).toEqual([pluginA]);

    await writeWorkspaceConfig(
      'ws-tombstone',
      config({ disabledGlobalPluginSelections: { pluginRefs: [pluginA] } }),
    );

    expect((await resolve('ws-tombstone')).pluginRefs).toEqual([]);
  });

  it('does not keep a read that raced a write', async () => {
    await writeWorkspaceConfig(
      'ws-race',
      config({
        defaultPluginSelections: selections({ pluginRefs: [pluginA] }),
      }),
    );
    const target = getWorkspaceConfigPath('ws-race');
    let releaseRead: () => void = (): void => undefined;
    const readHeld = new Promise<void>((resolveRead): void => {
      releaseRead = resolveRead;
    });
    let heldReadDone = false;
    readFileSpy.mockImplementation(
      async (...args: Parameters<typeof realReadFile>) => {
        const contents = await realReadFile(...args);
        if (args[0] === target && !heldReadDone) {
          heldReadDone = true;
          await readHeld;
        }
        return contents;
      },
    );

    // The read finishes with the old defaults before the write starts, and
    // only hands them back after the write has landed.
    const before = resolve('ws-race');
    while (!heldReadDone) {
      await new Promise<void>((next): void => {
        setImmediate(next);
      });
    }
    await writeWorkspaceConfig(
      'ws-race',
      config({
        defaultPluginSelections: selections({ pluginRefs: [pluginB] }),
      }),
    );
    releaseRead();

    expect((await before).pluginRefs).toEqual([pluginA]);
    expect((await resolve('ws-race')).pluginRefs).toEqual([pluginB]);
  });

  describe('a migrated cowork project', () => {
    afterEach(async () => {
      await writeCoworkMigrationMap({});
    });

    it('reads the defaults of the workspace a legacy id maps to, once', async () => {
      await writeCoworkMigrationMap({ 'legacy-project': 'cowork-ws' });
      await writeWorkspaceConfig(
        'cowork-ws',
        config({
          type: 'cowork',
          repoPath: undefined,
          defaultPluginSelections: selections({ pluginRefs: [pluginA] }),
        }),
      );
      readFileSpy.mockClear();

      expect(
        (await resolve(STANDALONE_CHAT_PROJECT_ID, 'legacy-project'))
          .pluginRefs,
      ).toEqual([pluginA]);
      expect((await resolve('legacy-project')).pluginRefs).toEqual([pluginA]);
      expect((await resolve('cowork-ws')).pluginRefs).toEqual([pluginA]);

      expect(configReads('cowork-ws')).toBe(1);
      expect(configReads('legacy-project')).toBe(0);
    });

    it('sees a write to the mapped workspace from a legacy target', async () => {
      await writeCoworkMigrationMap({ 'legacy-project': 'cowork-ws' });
      await writeWorkspaceConfig(
        'cowork-ws',
        config({
          type: 'cowork',
          repoPath: undefined,
          defaultPluginSelections: selections({ pluginRefs: [pluginA] }),
        }),
      );
      expect(
        (await resolve(STANDALONE_CHAT_PROJECT_ID, 'legacy-project'))
          .pluginRefs,
      ).toEqual([pluginA]);

      await writeWorkspaceConfig(
        'cowork-ws',
        config({
          type: 'cowork',
          repoPath: undefined,
          defaultPluginSelections: selections({ pluginRefs: [pluginB] }),
        }),
      );

      expect(
        (await resolve(STANDALONE_CHAT_PROJECT_ID, 'legacy-project'))
          .pluginRefs,
      ).toEqual([pluginB]);
    });
  });
});

describe('reconciling the cached layer after a write that may have landed without its refresh', () => {
  const layerA: ProjectPluginDefaults = {
    defaultPluginSelections: selections({ pluginRefs: [pluginA] }),
  };
  const layerB: ProjectPluginDefaults = {
    defaultPluginSelections: selections({ pluginRefs: [pluginB] }),
  };
  let path: string;
  let workspaceId: string;
  let sequence = 0;

  beforeEach(() => {
    sequence += 1;
    workspaceId = `ws-reconcile-${String(sequence)}`;
    path = `/reconcile/${workspaceId}/workspace.json`;
  });

  const loaded =
    (defaults: ProjectPluginDefaults, cacheable = true) =>
    (): Promise<ProjectPluginDefaultsRead> =>
      Promise.resolve({ defaults, cacheable });
  const read = (defaults: ProjectPluginDefaults): Promise<unknown> =>
    readThroughProjectPluginDefaults(path, loaded(defaults));
  /** Commits of the config whose refresh still runs after the queue. */
  const committing = new Set<Promise<void>>();
  function registerCommit(commit: Promise<void>): void {
    const settled = commit.then(
      () => undefined,
      () => undefined,
    );
    committing.add(settled);
    void settled.then(() => committing.delete(settled));
  }
  const reconcile = (
    load: () => Promise<
      ProjectPluginDefaultsRead | ProjectPluginDefaultsRemoved
    >,
    serialize: (work: () => Promise<void>) => Promise<void> = (work) => work(),
  ): Promise<void> =>
    reconcileProjectPluginDefaults({
      configPath: path,
      workspaceId,
      load,
      serialize,
      committing: () => Array.from(committing),
    });
  const revision = (): number => getProjectPluginDefaultsRevision(workspaceId);

  it('advances nothing when nothing was served since the last advance, or the file holds what was served', async () => {
    await reconcile(loaded(layerB));
    expect(revision()).toBe(0);
    await read(layerA);
    await reconcile(loaded(layerA));
    await reconcile(loaded(layerA));
    expect(revision()).toBe(0);
  });

  it('advances once when the file differs from what was served, and drops the cached layer', async () => {
    await read(layerA);
    for (let attempt = 0; attempt < 3; attempt += 1)
      await reconcile(loaded(layerB));
    expect(revision()).toBe(1);
    expect(
      await readThroughProjectPluginDefaults(path, loaded(layerB)),
    ).toEqual(layerB);
  });

  it('advances once for concurrent reconciles', async () => {
    await read(layerA);
    await Promise.all([reconcile(loaded(layerB)), reconcile(loaded(layerB))]);
    expect(revision()).toBe(1);
  });

  it('compares the layer a read in flight serves', async () => {
    let finish: (value: ProjectPluginDefaultsRead) => void = () => undefined;
    const inFlight = readThroughProjectPluginDefaults(
      path,
      () =>
        new Promise<ProjectPluginDefaultsRead>((resolveRead) => {
          finish = resolveRead;
        }),
    );
    const reconciled = reconcile(loaded(layerB));
    finish({ defaults: layerA, cacheable: true });
    await inFlight;
    await reconciled;
    expect(revision()).toBe(1);
  });

  /** A load the test finishes, and a way to drain its microtasks. */
  function heldLoad(): {
    load: () => Promise<ProjectPluginDefaultsRead>;
    finish: (defaults: ProjectPluginDefaults) => void;
  } {
    let finish: (defaults: ProjectPluginDefaults) => void = () => undefined;
    const pending = new Promise<ProjectPluginDefaultsRead>((resolveLoad) => {
      finish = (defaults): void => resolveLoad({ defaults, cacheable: true });
    });
    return { load: () => pending, finish: (defaults) => finish(defaults) };
  }
  const drained = (): Promise<void> =>
    new Promise((resolveDrain) => setImmediate(resolveDrain));
  function barrier(): { promise: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((resolveBarrier) => {
      open = resolveBarrier;
    });
    return { promise, open: () => open() };
  }

  it('compares again, against what was served since, when a layer change lands during its read', async () => {
    await read(layerA);
    const stale = heldLoad();
    const load = jest
      .fn<Promise<ProjectPluginDefaultsRead>, []>()
      .mockImplementationOnce(stale.load)
      .mockImplementation(loaded(layerB));
    const reconciled = reconcile(load);
    await drained();
    // A real write of B lands and advances the revision; a session reads B.
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: true,
    });
    await read(layerB);
    stale.finish(layerA);
    await reconciled;
    expect(revision()).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('awaits a read in flight that the cache no longer holds', async () => {
    const inFlight = heldLoad();
    const session = readThroughProjectPluginDefaults(path, inFlight.load);
    // A write that leaves the layer alone drops the cached read.
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: false,
    });
    let done = false;
    const reconciled = reconcile(loaded(layerB)).then(() => {
      done = true;
    });
    await drained();
    expect(done).toBe(false);
    inFlight.finish(layerA);
    expect(await session).toEqual(layerA);
    await reconciled;
    expect(revision()).toBe(1);
  });

  /** A commit the test settles. */
  function heldCommit(): {
    commit: Promise<void>;
    settle: (outcome: 'resolve' | 'reject') => void;
  } {
    let settle: (outcome: 'resolve' | 'reject') => void = () => undefined;
    const commit = new Promise<void>((resolveCommit, rejectCommit) => {
      settle = (outcome): void =>
        outcome === 'resolve'
          ? resolveCommit()
          : rejectCommit(new Error('commit failed'));
    });
    return { commit, settle: (outcome) => settle(outcome) };
  }

  it.each(['resolve', 'reject'] as const)(
    'waits for a registered commit to %s before it reads, so the commit refresh is not counted twice',
    async (outcome) => {
      await read(layerA);
      const held = heldCommit();
      registerCommit(held.commit);
      const load = jest.fn(loaded(layerB));
      const reconciled = reconcile(load);
      await drained();
      expect(load).not.toHaveBeenCalled();
      // The commit landed B; its refresh runs before it settles.
      projectPluginDefaultsWritten({
        configPath: path,
        workspaceId,
        layerChanged: true,
      });
      held.settle(outcome);
      await reconciled;
      expect(load).toHaveBeenCalledTimes(1);
      expect(revision()).toBe(1);
    },
  );

  it('reads and compares inside the write queue', async () => {
    await read(layerA);
    let queued = false;
    const serialize = async (work: () => Promise<void>): Promise<void> => {
      queued = true;
      try {
        await work();
      } finally {
        queued = false;
      }
    };
    const load = jest.fn(() => {
      expect(queued).toBe(true);
      return loaded(layerB)();
    });
    await reconcile(load, serialize);
    expect(load).toHaveBeenCalledTimes(1);
    expect(revision()).toBe(1);
  });

  it('starts over when a commit registers while it waits for the write queue', async () => {
    await read(layerA);
    const queue = barrier();
    const entered = barrier();
    let calls = 0;
    const serialize = async (work: () => Promise<void>): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        entered.open();
        await queue.promise;
      }
      await work();
    };
    const load = jest.fn(loaded(layerB));
    const reconciled = reconcile(load, serialize);
    await entered.promise;
    // A commit registers, takes the queue first, lands B and refreshes as it
    // settles.
    const held = heldCommit();
    registerCommit(held.commit);
    queue.open();
    await drained();
    expect(load).not.toHaveBeenCalled();
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: true,
    });
    held.settle('resolve');
    await reconciled;
    expect(calls).toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
    expect(revision()).toBe(1);
  });

  it('treats a failed read as a different layer, and an unreadable reconcile read as deciding nothing', async () => {
    await read(layerB);
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: false,
    });
    await expect(
      readThroughProjectPluginDefaults(path, () =>
        Promise.reject(new Error('read failed')),
      ),
    ).rejects.toThrow('read failed');
    await reconcile(loaded({}, false));
    expect(revision()).toBe(0);
    await expect(
      reconcile(() => Promise.reject(new Error('reconcile read failed'))),
    ).rejects.toThrow('reconcile read failed');
    expect(revision()).toBe(0);
    await reconcile(loaded(layerB));
    await reconcile(loaded(layerB));
    expect(revision()).toBe(1);
  });

  /** A removed read; `owed` is owed since revision `since`. */
  const removed =
    (owed: ProjectPluginDefaults | null, since = 0) =>
    (): Promise<ProjectPluginDefaultsRemoved> =>
      Promise.resolve({
        removed: true,
        owed: owed && { ...owed, revision: since },
      });

  it('leaves the cached layer, what was served and the revision to the remover of a removed config', async () => {
    await read(layerA);
    const load = jest.fn(removed(null));
    await reconcile(load);
    await reconcile(load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(revision()).toBe(0);
    expect(
      await readThroughProjectPluginDefaults(path, loaded(layerB)),
    ).toEqual(layerA);
    // A later reconcile that reads a layer still compares what was served.
    await reconcile(loaded(layerB));
    expect(revision()).toBe(1);
  });

  it('for a removed config, owes nothing when only the owed layer or the empty layer was served', async () => {
    await reconcile(removed(layerB));
    expect(revision()).toBe(0);
    await read(layerB);
    await reconcile(removed(layerB));
    expect(revision()).toBe(0);
    expect(
      await readThroughProjectPluginDefaults(path, loaded(layerA)),
    ).toEqual(layerB);
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: true,
    });
    await read({});
    await reconcile(removed(layerB, 1));
    expect(revision()).toBe(1);
  });

  it('for a removed config, owes nothing once the revision advanced since the owed write', async () => {
    await read(layerA);
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: true,
    });
    await read(layerA);
    await reconcile(removed(layerB, 0));
    expect(revision()).toBe(1);
    expect(
      await readThroughProjectPluginDefaults(path, loaded(layerB)),
    ).toEqual(layerA);
    await reconcile(removed(layerB, 1));
    expect(revision()).toBe(2);
  });

  it('for a removed config, drops and advances once when a layer from before the owed write was served', async () => {
    await read(layerA);
    for (let replay = 0; replay < 3; replay += 1)
      await reconcile(removed(layerB));
    expect(revision()).toBe(1);
    expect(await readThroughProjectPluginDefaults(path, loaded({}))).toEqual(
      {},
    );
  });

  it('for a removed config, advances once when reads at the revision served two layers', async () => {
    await read(layerA);
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: false,
    });
    await read(layerB);
    await reconcile(removed(layerB));
    await reconcile(removed(layerB));
    expect(revision()).toBe(1);
  });

  it('keeps what was served across a write that left the layer alone, and forgets it at a layer change', async () => {
    await read(layerA);
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: false,
    });
    await read(layerB);
    await reconcile(loaded(layerB));
    expect(revision()).toBe(1);
    projectPluginDefaultsWritten({
      configPath: path,
      workspaceId,
      layerChanged: true,
    });
    expect(revision()).toBe(2);
    await reconcile(loaded(layerA));
    expect(revision()).toBe(2);
  });

  // Consumers stamp the revision synchronously, then read after an await.
  describe('a read that loaded across a layer-changing advance', () => {
    async function stampThenRead(
      load: () => Promise<ProjectPluginDefaultsRead>,
    ): Promise<{ stamp: number; layer: ProjectPluginDefaults | 'failed' }> {
      const stamp = revision();
      await Promise.resolve();
      return readThroughProjectPluginDefaults(path, load).then(
        (layer) => ({ stamp, layer }),
        () => ({ stamp, layer: 'failed' as const }),
      );
    }
    const advance = (): void =>
      projectPluginDefaultsWritten({
        configPath: path,
        workspaceId,
        layerChanged: true,
      });
    /** A write that leaves the layer alone: the next read loads. */
    const dropCached = (): void =>
      projectPluginDefaultsWritten({
        configPath: path,
        workspaceId,
        layerChanged: false,
      });

    it('serves its caller, but is neither cached nor compared at the new revision', async () => {
      await read(layerA);
      advance();
      const inFlight = heldLoad();
      const load = jest.fn(inFlight.load);
      const session = stampThenRead(load);
      await drained();
      expect(load).toHaveBeenCalledTimes(1);
      advance();
      const after = await stampThenRead(loaded(layerB));
      inFlight.finish(layerA);
      expect(await session).toEqual({ stamp: 1, layer: layerA });
      expect(after).toEqual({ stamp: 2, layer: layerB });
      expect(
        await readThroughProjectPluginDefaults(path, loaded(layerA)),
      ).toEqual(layerB);
      for (let replay = 0; replay < 3; replay += 1) {
        await reconcile(loaded(layerB));
        expect(revision()).toBe(2);
      }
    });

    it('with nothing read since, leaves nothing to compare', async () => {
      await read(layerA);
      dropCached();
      const inFlight = heldLoad();
      const load = jest.fn(inFlight.load);
      const session = stampThenRead(load);
      await drained();
      expect(load).toHaveBeenCalledTimes(1);
      advance();
      inFlight.finish(layerA);
      expect(await session).toEqual({ stamp: 0, layer: layerA });
      await reconcile(loaded(layerB));
      expect(revision()).toBe(1);
      expect(
        await readThroughProjectPluginDefaults(path, loaded(layerB)),
      ).toEqual(layerB);
    });

    it('that failed is not counted as a different layer', async () => {
      await read(layerB);
      dropCached();
      let fail: (error: Error) => void = () => undefined;
      const session = stampThenRead(
        () =>
          new Promise<ProjectPluginDefaultsRead>((_resolveRead, rejectRead) => {
            fail = rejectRead;
          }),
      );
      await drained();
      advance();
      await read(layerB);
      fail(new Error('read failed'));
      expect(await session).toEqual({ stamp: 0, layer: 'failed' });
      await reconcile(loaded(layerB));
      expect(revision()).toBe(1);
    });

    it('is not a layer from before an owed write of a removed config', async () => {
      await read(layerA);
      dropCached();
      const inFlight = heldLoad();
      const load = jest.fn(inFlight.load);
      const session = stampThenRead(load);
      await drained();
      expect(load).toHaveBeenCalledTimes(1);
      advance();
      inFlight.finish(layerA);
      await session;
      await reconcile(removed(layerB, 1));
      expect(revision()).toBe(1);
    });

    it('is still compared across a write that left the layer alone', async () => {
      const inFlight = heldLoad();
      const load = jest.fn(inFlight.load);
      const session = stampThenRead(load);
      await drained();
      expect(load).toHaveBeenCalledTimes(1);
      dropCached();
      inFlight.finish(layerA);
      expect(await session).toEqual({ stamp: 0, layer: layerA });
      await reconcile(loaded(layerB));
      expect(revision()).toBe(1);
    });
  });
});
