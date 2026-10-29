import '../../__tests__/worktree-replica-compatibility';
jest.mock('../lib/script-runner', () => ({
  listTrackedShellScripts: (): never[] => [],
  subscribeTrackedScriptsChanged: (): (() => void) => (): void => undefined,
}));
import {
  foreignActivitySourceSnapshot,
  resetForeignActivitySources,
  publishForeignPipelineQueueActivity,
} from '../services/foreign-activity-sources';
jest.mock('node:fs/promises');
const mockListAccountMcpConnections = jest.fn();
jest.mock('../canopy-cloud/mcp-connections', () => ({
  listAccountMcpConnections: (): unknown => mockListAccountMcpConnections(),
}));

jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(
    (target: string, data: string, options?: { encoding?: BufferEncoding }) =>
      jest
        .requireMock<typeof fs>('node:fs/promises')
        .writeFile(target, data, options?.encoding ?? 'utf8'),
  ),
}));

jest.mock('../lib/paths', () => ({
  getWorkspaceConfigPath: jest.fn(
    (workspaceId: string) => `/tmp/${workspaceId}/workspace.json`,
  ),
  getWorkspaceWorktreesFilePath: jest.fn(
    (workspaceId: string) => `/tmp/${workspaceId}/worktrees.json`,
  ),
}));

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProfileJson } from '@canopy/desktop-shared/node/browser-profiles/storage';
import { writeFileAtomically } from '../lib/atomic-file';
import type * as AtomicFile from '../lib/atomic-file';
import { getWorkspaceWorktreesFilePath } from '../lib/paths';
import { getFeatureFlagService } from '../feature-flags/service';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  WorktreesFile,
  WorktreeData,
  WorkspaceConfigFile,
  PlanDetectionRule,
} from '@canopy/desktop-shared/types';
import {
  ensurePersonalCatalogId,
  ensureOrganizationSourceHookBindings,
  updateWorkspaceConfig,
  clearWorktreesSelfWriteTracking,
  isWorktreesSelfWriteContent,
  parseWorktreesFileReconciliationSnapshot,
  readProjectPluginDefaults,
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
  PROJECT_PLUGIN_DEFAULTS_NORMALIZATION_FAILED,
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceOwnership,
  updateWorkspaceWorktrees,
  updateWorkspaceWorktree,
  wasRecentWorktreesSelfWrite,
  workspacePersistenceTestExports,
  writeWorkspaceConfig,
  writeWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  getProjectPluginDefaultsRevision,
  subscribePluginDefaultsRevision,
} from '../plugins/plugin-defaults-revision';
import type { ProjectPluginDefaults } from '../plugins/project-plugin-defaults-cache';

const mockedMkdir = jest.mocked(mkdir);
const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);

function buildWorktreesFile(): WorktreesFile {
  return {
    version: 1,
    worktrees: [
      {
        id: 'wt-1',
        branchName: 'feature/base',
        createdAt: '2026-04-16T00:00:00.000Z',
        trackedRepoBaseBranches: {},
      },
    ],
  };
}

it('keeps the worktree registry readable by browser retirement throughout a metadata write', async () => {
  const native = jest.requireActual<typeof fs>('node:fs/promises');
  const root = await native.mkdtemp(join(tmpdir(), 'archive-registry-race-'));
  const target = join(root, 'worktrees.json');
  const previous = buildWorktreesFile();
  let observed: unknown;
  const probe = async (): Promise<void> => {
    try {
      observed = await readProfileJson(target);
    } catch (error) {
      observed = error;
    }
  };
  await native.writeFile(target, JSON.stringify(previous));
  // The repository resolves the path for its read and for its write.
  jest
    .mocked(getWorkspaceWorktreesFilePath)
    .mockImplementation((workspaceId: string) =>
      workspaceId === 'registry-race'
        ? target
        : `/tmp/${workspaceId}/worktrees.json`,
    );
  jest.mocked(fs.mkdir).mockImplementation(native.mkdir);
  jest.mocked(fs.readFile).mockImplementation(native.readFile);
  jest.mocked(fs.stat).mockImplementation(native.stat);
  jest.mocked(fs.rename).mockImplementation(native.rename);
  jest.mocked(fs.unlink).mockImplementation(native.unlink);
  // Observe the destination after the writer opens/truncates its output but
  // before it writes the payload. Browser retirement does not take the
  // workspace writer's in-process lock.
  jest.mocked(fs.writeFile).mockImplementation(async (path, data, options) => {
    await native.writeFile(path, '');
    await probe();
    await native.writeFile(path, data, options);
  });
  jest.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await native.open(...args);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...writeArgs): Promise<void> => {
      await probe();
      return write(...writeArgs);
    };
    return handle;
  });
  jest
    .mocked(writeFileAtomically)
    .mockImplementationOnce(
      jest.requireActual<typeof AtomicFile>('../lib/atomic-file')
        .writeFileAtomically,
    );
  try {
    await updateWorkspaceWorktree('registry-race', 'wt-1', (worktree) => ({
      ...worktree,
      label: 'Updated during archive',
    }));
    expect(observed).toEqual(previous);
    const published: unknown = JSON.parse(
      await native.readFile(target, 'utf8'),
    );
    expect(published).toMatchObject({
      worktrees: [{ id: 'wt-1', label: 'Updated during archive' }],
    });
  } finally {
    await native.rm(root, { recursive: true, force: true });
    for (const name of [
      'mkdir',
      'readFile',
      'stat',
      'rename',
      'unlink',
      'writeFile',
      'open',
    ] as const)
      jest.mocked(fs[name]).mockReset();
    // The unchanged writer does not consume the atomic helper's one-shot mock.
    jest
      .mocked(writeFileAtomically)
      .mockReset()
      .mockImplementation((path, data, options) =>
        fs.writeFile(path, data, options?.encoding ?? 'utf8'),
      );
  }
});

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve: (): void => {
      resolve?.();
    },
  };
}

function expectWrittenString(contents: unknown): string {
  if (typeof contents !== 'string') {
    throw new Error('Expected project worktree writes to be strings');
  }

  return contents;
}

/** Runs every pending promise continuation, however deep the await chain. */
async function drainEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('workspace-persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedMkdir.mockResolvedValue(undefined);
  });

  it.each(['committed', 'failed'] as const)(
    'publishes pipeline seen only after a %s worktree write',
    async (outcome): Promise<void> => {
      resetForeignActivitySources();
      const event = {
        type: 'failed' as const,
        executionId: 'exec-seen',
        projectId: 'ws-seen',
        worktreeId: 'wt-1',
      };
      publishForeignPipelineQueueActivity(event);
      publishForeignPipelineQueueActivity({
        ...event,
        executionId: 'exec-unseen',
      });
      publishForeignPipelineQueueActivity({
        ...event,
        projectId: 'other-workspace',
      });
      publishForeignPipelineQueueActivity({
        ...event,
        worktreeId: 'other-worktree',
      });
      mockedReadFile.mockResolvedValue(JSON.stringify(buildWorktreesFile()));
      const pending = createDeferred();
      mockedWriteFile.mockImplementationOnce(async (): Promise<void> => {
        await pending.promise;
        if (outcome === 'failed') throw new Error('write failed');
      });
      const write = writeWorkspaceWorktrees(
        'ws-seen',
        buildWorktreesFile().worktrees.map((worktree) => ({
          ...worktree,
          seenPipelineExecutionIds: ['exec-seen'],
        })),
      );
      await flushMicrotasks();
      expect(
        foreignActivitySourceSnapshot().operations.every(
          (operation) => operation.unreadToken !== null,
        ),
      ).toBe(true);
      pending.resolve();
      if (outcome === 'failed')
        await expect(write).rejects.toThrow('write failed');
      else await write;
      expect(
        foreignActivitySourceSnapshot().operations.map(
          (operation) => operation.unreadToken,
        ),
      ).toEqual([
        outcome === 'committed' ? null : 'exec-seen:failed',
        'exec-unseen:failed',
        'exec-seen:failed',
        'exec-seen:failed',
      ]);
      resetForeignActivitySources();
    },
  );

  describe('parseWorktreesFileReconciliationSnapshot', () => {
    it('preserves valid populated and empty version 1 snapshots', () => {
      const populated = buildWorktreesFile();
      // The parser intentionally narrows rows to reconciliation identity
      // (id/branchName/createdAt) instead of echoing the raw parsed objects.
      expect(
        parseWorktreesFileReconciliationSnapshot(JSON.stringify(populated)),
      ).toEqual(
        populated.worktrees.map((row) => ({
          id: row.id,
          branchName: row.branchName,
          createdAt: row.createdAt,
        })),
      );
      expect(
        parseWorktreesFileReconciliationSnapshot(
          JSON.stringify({ version: 1, worktrees: [] }),
        ),
      ).toEqual([]);
    });

    it.each([
      '{',
      JSON.stringify({ version: 2, worktrees: [] }),
      JSON.stringify([]),
      JSON.stringify({ version: 1 }),
      JSON.stringify({
        version: 1,
        worktrees: [{ id: 'wt-1', branchName: 'feature' }],
      }),
    ])('rejects invalid reconciliation content', (content) => {
      expect(parseWorktreesFileReconciliationSnapshot(content)).toBeNull();
    });
  });

  it('tracks successful desktop worktree writes for two seconds', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedWriteFile.mockResolvedValue(undefined);

    expect(wasRecentWorktreesSelfWrite('ws-self-write')).toBe(false);
    await writeWorkspaceWorktrees('ws-self-write', []);
    expect(wasRecentWorktreesSelfWrite('ws-self-write')).toBe(true);

    jest.advanceTimersByTime(2_001);
    expect(wasRecentWorktreesSelfWrite('ws-self-write')).toBe(false);
    jest.useRealTimers();
  });

  it('tracks a desktop worktree write while it is in flight and forgets a failed one', async () => {
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    let failWrite: (error: Error) => void = () => undefined;
    let writeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    mockedWriteFile.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failWrite = reject;
          writeStarted();
        }),
    );

    const write = writeWorkspaceWorktrees('ws-in-flight', []);
    await started;
    expect(wasRecentWorktreesSelfWrite('ws-in-flight')).toBe(true);

    failWrite(new Error('ENOSPC'));
    await expect(write).rejects.toThrow('ENOSPC');
    expect(wasRecentWorktreesSelfWrite('ws-in-flight')).toBe(false);
  });

  it('keeps concurrent in-flight worktree writes tracked until the last settles', () => {
    const { beginWorktreesSelfWrite } = workspacePersistenceTestExports;
    const first = beginWorktreesSelfWrite('ws-concurrent');
    const second = beginWorktreesSelfWrite('ws-concurrent');

    first();
    first();
    expect(wasRecentWorktreesSelfWrite('ws-concurrent')).toBe(true);
    expect(wasRecentWorktreesSelfWrite('ws-other')).toBe(false);
    second();
    expect(wasRecentWorktreesSelfWrite('ws-concurrent')).toBe(false);
  });

  it('matches the last self-written worktrees payload by content, beyond the time window', async () => {
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedWriteFile.mockResolvedValue(undefined);

    expect(isWorktreesSelfWriteContent('ws-content', '{}')).toBe(false);
    await writeWorkspaceWorktrees('ws-content', []);

    const writeCall = mockedWriteFile.mock.calls[0];
    if (!writeCall) {
      throw new Error('Expected a worktrees write');
    }
    const written = expectWrittenString(writeCall[1]);

    expect(isWorktreesSelfWriteContent('ws-content', written)).toBe(true);
    // External content (e.g. the CLI appending a worktree) never matches.
    expect(isWorktreesSelfWriteContent('ws-content', `${written}\n`)).toBe(
      false,
    );
    // Other workspaces are keyed independently.
    expect(isWorktreesSelfWriteContent('ws-other', written)).toBe(false);

    // Once the fingerprint is cleared (the watcher observed external
    // content), a byte-exact external revert to the old desktop payload must
    // no longer be treated as a self-write echo (desktop A → CLI B → CLI A).
    clearWorktreesSelfWriteTracking('ws-content');
    expect(isWorktreesSelfWriteContent('ws-content', written)).toBe(false);
    expect(wasRecentWorktreesSelfWrite('ws-content')).toBe(false);
  });

  it('reports a present but malformed owner without retaining the binding', async (): Promise<void> => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repos: [],
        owner: { type: 'organization', organizationId: 'not-a-uuid' },
      }),
    );

    const result = await readWorkspaceConfigDetailed('ws-malformed-owner');

    expect(result).toMatchObject({ authority: 'ok', ownerMalformed: true });
    expect(result.config.owner).toBeUndefined();
  });

  it('reports a persisted null owner as malformed', async (): Promise<void> => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repos: [],
        owner: null,
      }),
    );

    const result = await readWorkspaceConfigDetailed('ws-null-owner');

    expect(result).toMatchObject({ authority: 'ok', ownerMalformed: true });
    expect(result.config.owner).toBeUndefined();
  });

  it.each([undefined, false, true])(
    'preserves Always show (%s) for temporary multi-repo configs',
    async (alwaysShow) => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          type: 'multi-repo',
          repos: [],
          temporary: true,
          alwaysShow,
        }),
      );
      const config = await readWorkspaceConfig('temporary');
      expect(config.temporary).toBe(true);
      expect(config.alwaysShow).toBe(alwaysShow);
    },
  );

  it.each([
    { type: 'multi-repo', temporary: false },
    { type: 'multi-repo' },
    { type: 'single-repo', temporary: true },
    { type: 'cowork', temporary: true },
  ])(
    'keeps the default Always show for other workspace configs (%j)',
    async (fields) => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ version: 1, repos: [], ...fields }),
      );
      expect((await readWorkspaceConfig('permanent')).alwaysShow).toBe(true);
    },
  );

  it('reports an absent owner as not malformed', async (): Promise<void> => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, type: 'single-repo', repos: [] }),
    );

    const result = await readWorkspaceConfigDetailed('ws-no-owner');

    expect(result).toMatchObject({ authority: 'ok', ownerMalformed: false });
    expect(result.config.owner).toBeUndefined();
  });

  it.each([undefined, true, false, 'true'])(
    'normalizes private memory value %p without inventing false',
    async (value): Promise<void> => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          type: 'cowork',
          repos: [],
          ...(value === undefined ? {} : { privateMemory: value }),
        }),
      );
      const read = await readWorkspaceConfigDetailed('ws-private-memory');
      expect(read.config.privateMemory).toBe(
        typeof value === 'boolean' ? value : undefined,
      );
      expect(read.memoryMalformed).toBe(value === 'true');
    },
  );

  it('normalizes legacy bundleIds selections when reading project config', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
        defaultPluginSelections: {
          bundleIds: ['legacy-collection'],
          skillRefs: [],
          pluginRefs: [
            {
              marketplaceId: 'unstoppable-domains-plugins',
              pluginName: 'ud-git',
            },
          ],
          mcpServerRefs: [],
        },
      }),
    );

    await expect(readWorkspaceConfig('ws-legacy')).resolves.toMatchObject({
      defaultPluginSelections: {
        collectionIds: ['legacy-collection'],
        skillRefs: [],
        pluginRefs: [
          {
            marketplaceId: 'unstoppable-domains-plugins',
            pluginName: 'ud-git',
          },
        ],
        mcpServerRefs: [],
      },
    });
  });

  it('reads legacy account MCP refs in the shared server key shape', async (): Promise<void> => {
    const flags = getFeatureFlagService();
    const isEnabled = flags.isEnabled.bind(flags);
    const spy = jest
      .spyOn(flags, 'isEnabled')
      .mockImplementation(
        (key): boolean =>
          key === CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key ||
          isEnabled(key),
      );
    mockListAccountMcpConnections.mockResolvedValue([
      {
        id: 'connection-github',
        serverKey: 'github',
        configId: 'default',
        kind: 'CURATED',
      },
    ]);
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: 'account:connection-github', configId: 'default' },
            { serverId: 'account:deleted', configId: 'default' },
            { serverId: 'device-server', configId: 'default' },
          ],
        },
        disabledGlobalPluginSelections: {
          mcpServerRefs: [
            { serverId: 'account:connection-github', configId: 'default' },
          ],
        },
      }),
    );
    try {
      const config = await readWorkspaceConfig('ws-account-refs');
      expect(config.defaultPluginSelections?.mcpServerRefs).toEqual([
        { serverId: 'github', configId: 'default' },
        { serverId: 'device-server', configId: 'default' },
      ]);
      expect(config.disabledGlobalPluginSelections).toEqual({
        mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('writes project config plugin selections in canonical shape', async () => {
    await writeWorkspaceConfig('ws-write', {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      defaultPluginSelections: {
        bundleIds: ['legacy-collection'],
        skillRefs: [],
        pluginRefs: [],
      } as unknown as WorkspaceConfigFile['defaultPluginSelections'],
      alwaysShow: true,
    });

    const writeCall = mockedWriteFile.mock.calls[0];
    const writeContents = writeCall?.[1];
    if (typeof writeContents !== 'string') {
      throw new Error('Expected project config write contents to be a string');
    }

    const parsed = JSON.parse(writeContents) as {
      defaultPluginSelections?: unknown;
    };
    expect(parsed.defaultPluginSelections).toEqual({
      collectionIds: ['legacy-collection'],
      skillRefs: [],
      pluginRefs: [],
    });
  });

  describe('project plugin defaults changes', (): void => {
    const previousDefaults = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'old' }],
      mcpServerRefs: [],
    };
    const baseConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      defaultPluginSelections: previousDefaults,
    };

    afterEach((): void => {
      setBeforeProjectPluginDefaultsChangeHandler(undefined);
    });

    it('normalizes chats against the replaced defaults before writing, then bumps the revision', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(baseConfig));
      const order: string[] = [];
      const handler = jest.fn((): Promise<void> => {
        order.push('normalize');
        return Promise.resolve();
      });
      mockedWriteFile.mockImplementation((): Promise<void> => {
        order.push('write');
        return Promise.resolve();
      });
      setBeforeProjectPluginDefaultsChangeHandler(handler);
      const before = getProjectPluginDefaultsRevision('ws-defaults');

      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          ...baseConfig,
          disabledGlobalPluginSelections: {
            pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'off' }],
          },
        }),
      );
      await writeWorkspaceConfig('ws-defaults', {
        ...baseConfig,
        defaultPluginSelections: {
          ...previousDefaults,
          pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'new' }],
        },
      });

      // Legacy chats are measured against the layers they ran under.
      expect(handler).toHaveBeenCalledWith('ws-defaults', previousDefaults, {
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'off' }],
      });
      expect(order).toEqual(['normalize', 'write']);
      expect(getProjectPluginDefaultsRevision('ws-defaults')).toBe(before + 1);
    });

    it('leaves chats and sessions alone when the defaults are unchanged', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(baseConfig));
      mockedWriteFile.mockResolvedValue(undefined);
      const handler = jest.fn((): Promise<void> => Promise.resolve());
      setBeforeProjectPluginDefaultsChangeHandler(handler);
      const before = getProjectPluginDefaultsRevision('ws-defaults');

      await writeWorkspaceConfig('ws-defaults', {
        ...baseConfig,
        alwaysShow: false,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(getProjectPluginDefaultsRevision('ws-defaults')).toBe(before);
    });

    // The project's rejections of global defaults are part of what its chats
    // inherit, so changing them must recreate those chats' sessions too. Only
    // replacing the defaults needs the one-time legacy chat normalization.
    it('bumps the revision without normalizing chats when only the project tombstones change', async (): Promise<void> => {
      const offRefs = [
        { marketplaceId: 'mkt', pluginName: 'global-a' },
        { marketplaceId: 'mkt', pluginName: 'global-b' },
      ];
      mockedReadFile.mockResolvedValue(JSON.stringify(baseConfig));
      mockedWriteFile.mockImplementation((_path, data): Promise<void> => {
        mockedReadFile.mockResolvedValue(typeof data === 'string' ? data : '');
        return Promise.resolve();
      });
      const handler = jest.fn((): Promise<void> => Promise.resolve());
      setBeforeProjectPluginDefaultsChangeHandler(handler);
      const before = getProjectPluginDefaultsRevision('ws-defaults');

      await writeWorkspaceConfig('ws-defaults', {
        ...baseConfig,
        disabledGlobalPluginSelections: { pluginRefs: offRefs },
      });
      expect(getProjectPluginDefaultsRevision('ws-defaults')).toBe(before + 1);

      await writeWorkspaceConfig('ws-defaults', {
        ...baseConfig,
        disabledGlobalPluginSelections: { pluginRefs: [...offRefs].reverse() },
      });
      expect(getProjectPluginDefaultsRevision('ws-defaults')).toBe(before + 1);
      expect(handler).not.toHaveBeenCalled();
    });

    it('refuses the new defaults while chat normalization fails', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(baseConfig));
      mockedWriteFile.mockResolvedValue(undefined);
      setBeforeProjectPluginDefaultsChangeHandler(
        (): Promise<void> =>
          Promise.reject(new Error('chat storage unavailable')),
      );
      const before = getProjectPluginDefaultsRevision('ws-defaults');

      await expect(
        writeWorkspaceConfig('ws-defaults', {
          ...baseConfig,
          defaultPluginSelections: undefined,
        }),
      ).rejects.toThrow(PROJECT_PLUGIN_DEFAULTS_NORMALIZATION_FAILED);

      expect(mockedWriteFile).not.toHaveBeenCalled();
      expect(getProjectPluginDefaultsRevision('ws-defaults')).toBe(before);
    });

    it('still writes other settings while chat normalization fails', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(baseConfig));
      mockedWriteFile.mockResolvedValue(undefined);
      const handler = jest.fn(
        (): Promise<void> =>
          Promise.reject(new Error('chat storage unavailable')),
      );
      setBeforeProjectPluginDefaultsChangeHandler(handler);

      await writeWorkspaceConfig('ws-defaults', {
        ...baseConfig,
        alwaysShow: true,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('project plugin defaults reads', (): void => {
    const pluginA = { marketplaceId: 'mkt', pluginName: 'plug-a' };
    const pluginB = { marketplaceId: 'mkt', pluginName: 'plug-b' };
    function configWith(pluginRefs: (typeof pluginA)[]): WorkspaceConfigFile {
      return {
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs,
        },
      };
    }
    function configReads(workspaceId: string): number {
      return mockedReadFile.mock.calls.filter(
        ([path]) => path === `/tmp/${workspaceId}/workspace.json`,
      ).length;
    }

    it('rereads a config it could not read instead of keeping the failure', async (): Promise<void> => {
      mockedReadFile.mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'EBUSY' }),
      );
      expect(
        (await readProjectPluginDefaults('ws-unreadable'))
          .defaultPluginSelections,
      ).toBeUndefined();

      mockedReadFile.mockResolvedValue(JSON.stringify(configWith([pluginA])));
      expect(
        (await readProjectPluginDefaults('ws-unreadable'))
          .defaultPluginSelections?.pluginRefs,
      ).toEqual([pluginA]);
      expect(configReads('ws-unreadable')).toBe(2);
    });

    it('rereads after a write that failed part way', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(configWith([pluginA])));
      await readProjectPluginDefaults('ws-failed-write');
      mockedWriteFile.mockImplementationOnce((): Promise<void> => {
        mockedReadFile.mockResolvedValue(JSON.stringify(configWith([pluginB])));
        return Promise.reject(new Error('disk full'));
      });

      await expect(
        writeWorkspaceConfig('ws-failed-write', configWith([pluginB])),
      ).rejects.toThrow('disk full');

      expect(
        (await readProjectPluginDefaults('ws-failed-write'))
          .defaultPluginSelections?.pluginRefs,
      ).toEqual([pluginB]);
    });

    it('serves the new defaults to whoever the revision bump notifies', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(configWith([pluginA])));
      mockedWriteFile.mockImplementation((_path, data): Promise<void> => {
        mockedReadFile.mockResolvedValue(typeof data === 'string' ? data : '');
        return Promise.resolve();
      });
      await readProjectPluginDefaults('ws-notified');
      let seen: Promise<ProjectPluginDefaults> | undefined;
      const unsubscribe = subscribePluginDefaultsRevision((): void => {
        seen = readProjectPluginDefaults('ws-notified');
      });

      try {
        await writeWorkspaceConfig('ws-notified', configWith([pluginB]));
      } finally {
        unsubscribe();
      }

      expect((await seen)?.defaultPluginSelections?.pluginRefs).toEqual([
        pluginB,
      ]);
    });
  });

  it('normalizes workspace owners on write and omits malformed owners', async (): Promise<void> => {
    const owner: NonNullable<WorkspaceConfigFile['owner']> & {
      extra: string;
    } = {
      type: 'organization',
      organizationId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
      projectId: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
      instanceId: 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC',
      bindingGeneration: 1,
      extra: 'discard me',
    };
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      owner,
    };

    await writeWorkspaceConfig('ws-owner', config, { ownership: 'replace' });

    const normalized: unknown = JSON.parse(
      expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]),
    );
    expect(normalized).toHaveProperty('owner', {
      type: 'organization',
      organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      instanceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      bindingGeneration: 1,
    });

    Reflect.deleteProperty(owner, 'projectId');
    await writeWorkspaceConfig('ws-owner', config, { ownership: 'replace' });

    const malformed: unknown = JSON.parse(
      expectWrittenString(mockedWriteFile.mock.calls[1]?.[1]),
    );
    expect(malformed).not.toHaveProperty('owner');
  });

  describe('inherited organization hook bindings', () => {
    const owner = {
      type: 'organization' as const,
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      bindingGeneration: 1,
    };
    const source = {
      'pr:create': [
        { type: 'pipeline' as const, source: 'bundled' as const, id: 'review' },
      ],
    };
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      owner,
    };
    let flagSpy: jest.SpyInstance;
    beforeEach(() => {
      flagSpy = jest
        .spyOn(getFeatureFlagService(), 'isEnabled')
        .mockReturnValue(true);
      mockedReadFile.mockResolvedValue(JSON.stringify(config));
      mockedWriteFile.mockResolvedValue(undefined);
    });
    afterEach(() => flagSpy.mockRestore());
    const repair = (): ReturnType<
      typeof ensureOrganizationSourceHookBindings
    > =>
      ensureOrganizationSourceHookBindings({
        workspaceId: 'ws-hook-binding',
        source,
        local: undefined,
        owner,
      });

    it('uses the canonical owner and retains unrelated current settings', async () => {
      const currentOwner = {
        ...owner,
        organizationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      };
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          ...config,
          owner: currentOwner,
          scripts: { launch: 'npm start' },
          hooks: { 'pr:merge': null },
        }),
      );
      const { hooks: bound, owner: boundOwner } = await repair();
      expect(boundOwner).toEqual(currentOwner);
      expect(bound).toMatchObject({
        'pr:merge': null,
        'pr:create': [
          { executionContext: `org:${currentOwner.organizationId}` },
        ],
      });
      const payload: unknown = JSON.parse(
        expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]),
      );
      expect(payload).toMatchObject({
        owner: currentOwner,
        scripts: { launch: 'npm start' },
        hooks: bound,
      });
    });

    it('returns a concurrently disabled hook without writing', async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ ...config, hooks: { 'pr:create': null } }),
      );
      await expect(repair()).resolves.toEqual({
        hooks: { 'pr:create': null },
        owner,
      });
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it.each([undefined, { type: 'organization' }])(
      'refuses a missing or malformed canonical owner (%j)',
      async (currentOwner) => {
        mockedReadFile.mockResolvedValue(
          JSON.stringify({ ...config, owner: currentOwner }),
        );
        expect((await repair()).hooks).toBeUndefined();
        expect(mockedWriteFile).not.toHaveBeenCalled();
      },
    );

    it('does not return a binding when its durable write fails', async () => {
      mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));
      await expect(repair()).rejects.toThrow('disk full');
    });

    it('avoids reads and writes when the organization feature is off', async () => {
      flagSpy.mockReturnValue(false);
      await expect(repair()).resolves.toEqual({ hooks: undefined, owner });
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('retains a curated pipeline binding across reread and repair without another write', async () => {
      const curatedSource = {
        'pr:create': [
          {
            type: 'pipeline' as const,
            source: 'curated' as const,
            id: 'review',
          },
        ],
      };
      const { hooks } = await ensureOrganizationSourceHookBindings({
        workspaceId: 'ws-hook-binding',
        source: curatedSource,
        local: undefined,
        owner,
      });
      const persisted = expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]);
      mockedReadFile.mockResolvedValue(persisted);
      mockedWriteFile.mockClear();
      const reread = await readWorkspaceConfig('ws-hook-binding');
      expect(reread.hooks).toEqual(hooks);
      await expect(
        ensureOrganizationSourceHookBindings({
          workspaceId: 'ws-hook-binding',
          source: curatedSource,
          local: reread.hooks,
          owner: reread.owner,
        }),
      ).resolves.toEqual({ hooks, owner });
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
    it('does not write again on subsequent resolution', async () => {
      const { hooks } = await repair();
      mockedReadFile.mockClear();
      mockedWriteFile.mockClear();
      const again = await ensureOrganizationSourceHookBindings({
        workspaceId: 'ws-hook-binding',
        source,
        local: hooks,
        owner,
      });
      expect(again.hooks).toBe(hooks);
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('updateWorkspaceConfig', (): void => {
    const onDisk = {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      scripts: { launch: 'npm start' },
    };

    it('edits the authoritative config inside the write queue and keeps the rest', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(onDisk));
      await expect(
        updateWorkspaceConfig('ws-update', (config) => {
          config.hooks = { 'pr:create': null };
          return 'edited';
        }),
      ).resolves.toBe('edited');
      const written: unknown = JSON.parse(
        expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]),
      );
      expect(written).toMatchObject({
        scripts: { launch: 'npm start' },
        hooks: { 'pr:create': null },
      });
    });

    it('keeps private memory and its managed marker through unrelated edits', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          ...onDisk,
          privateMemory: false,
          privateMemoryManagedBy: 'organization',
          owner: {
            type: 'organization',
            organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            bindingGeneration: 1,
          },
        }),
      );
      await updateWorkspaceConfig('ws-managed', (config) => {
        config.alwaysShow = false;
      });
      const written: unknown = JSON.parse(
        expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]),
      );
      expect(written).toMatchObject({
        privateMemory: false,
        privateMemoryManagedBy: 'organization',
        alwaysShow: false,
      });
    });

    it('tells the update whether it read the file or the default config', async (): Promise<void> => {
      mockedReadFile.mockResolvedValueOnce(JSON.stringify(onDisk));
      const present = await updateWorkspaceConfig(
        'ws-update',
        (_config, read) => read,
        { shouldWrite: (): boolean => false },
      );
      mockedReadFile.mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
      const absent = await updateWorkspaceConfig(
        'ws-gone',
        (_config, read) => read,
        { shouldWrite: (): boolean => false },
      );
      expect(present).toEqual({
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
      });
      expect(absent).toEqual({
        authority: 'absent',
        ownerMalformed: false,
        memoryMalformed: false,
      });
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('does not write when shouldWrite declines the result', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(onDisk));
      await expect(
        updateWorkspaceConfig('ws-update', () => 0, {
          shouldWrite: (changes): boolean => changes > 0,
        }),
      ).resolves.toBe(0);
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('leaves a missing workspace absent when shouldWrite declines', async (): Promise<void> => {
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
      await expect(
        updateWorkspaceConfig('ws-gone', (config) => config.repos.length, {
          shouldWrite: (repos): boolean => repos > 0,
        }),
      ).resolves.toBe(0);
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('ownership is main-owned (CAN-3415)', (): void => {
    const owner = {
      type: 'organization' as const,
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      bindingGeneration: 3,
    };
    const ownershipTransfer = {
      version: 1 as const,
      previousOwner: { type: 'personal' as const },
      organizationId: owner.organizationId,
      projectId: owner.projectId,
      convertedAt: '2026-09-27T10:00:00.000Z',
    };
    const onDisk = {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      personalCatalogId: '11111111-1111-4111-8111-111111111111',
      owner,
      ownershipTransfer,
    };

    it('keeps the on-disk owner and conversion record on an ordinary write', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(JSON.stringify(onDisk));
      // A renderer that has not reloaded since the conversion still holds a
      // Personal item; its save must not undo the conversion.
      await writeWorkspaceConfig('ws-converted', {
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
        alwaysShow: false,
      });

      const written: unknown = JSON.parse(
        expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]),
      );
      expect(written).toMatchObject({
        alwaysShow: false,
        owner,
        ownershipTransfer,
        personalCatalogId: onDisk.personalCatalogId,
      });
    });

    it('writes the caller ownership for a workspace with no config yet', async (): Promise<void> => {
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
      await writeWorkspaceConfig('ws-new', {
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
        owner,
      });
      const written: unknown = JSON.parse(
        expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]),
      );
      expect(written).toHaveProperty('owner', owner);
    });

    it('updates only ownership, and declines without writing', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          ...onDisk,
          owner: undefined,
          ownershipTransfer: undefined,
        }),
      );
      await expect(
        updateWorkspaceOwnership('ws-convert', (current) =>
          current.owner === undefined ? { owner, ownershipTransfer } : null,
        ),
      ).resolves.toBe('written');
      const written: unknown = JSON.parse(
        expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]),
      );
      expect(written).toMatchObject({
        repoPath: '/repo',
        personalCatalogId: onDisk.personalCatalogId,
        owner,
        ownershipTransfer,
      });

      mockedWriteFile.mockClear();
      mockedReadFile.mockResolvedValue(JSON.stringify(onDisk));
      await expect(
        updateWorkspaceOwnership('ws-convert', (current) =>
          current.owner === undefined ? { owner, ownershipTransfer } : null,
        ),
      ).resolves.toBe('declined');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('refuses to rewrite an owner it cannot read', async (): Promise<void> => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ ...onDisk, owner: { type: 'organization' } }),
      );
      const update = jest.fn(() => ({ owner: undefined }));
      await expect(updateWorkspaceOwnership('ws-bad', update)).resolves.toBe(
        'unreadable',
      );
      expect(update).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });

  it('defaults a missing workspace item sort mode to manual', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
      }),
    );
    await expect(readWorkspaceConfig('ws-sort')).resolves.toMatchObject({
      itemSortMode: 'manual',
    });

    await writeWorkspaceConfig('ws-sort', {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      itemSortMode: 'manual',
      alwaysShow: false,
    });
    const writeContents = mockedWriteFile.mock.calls.at(-1)?.[1];
    if (typeof writeContents !== 'string') {
      throw new Error('Expected project config write contents to be a string');
    }
    expect(JSON.parse(writeContents)).not.toHaveProperty('itemSortMode');
  });

  it('normalizes and persists an explicit last-updated item sort mode', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
        itemSortMode: 'last-updated',
      }),
    );
    await expect(readWorkspaceConfig('ws-sort')).resolves.toMatchObject({
      itemSortMode: 'last-updated',
    });

    await writeWorkspaceConfig('ws-sort', {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
      itemSortMode: 'last-updated',
      alwaysShow: false,
    });
    const writeContents = mockedWriteFile.mock.calls.at(-1)?.[1];
    if (typeof writeContents !== 'string') {
      throw new Error('Expected project config write contents to be a string');
    }
    expect(JSON.parse(writeContents)).toMatchObject({
      itemSortMode: 'last-updated',
    });
  });

  it('round-trips the durable workspace-template publication key', async () => {
    const publicationKey = 'a3c7b87a-a05a-4787-a9a4-38c930d80aef';
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'cowork',
        repos: [],
        sharedTemplatePublicationKey: publicationKey,
      }),
    );

    await expect(readWorkspaceConfig('ws-template')).resolves.toMatchObject({
      sharedTemplatePublicationKey: publicationKey,
    });

    await writeWorkspaceConfig('ws-template', {
      version: 1,
      type: 'cowork',
      repos: [],
      sharedTemplatePublicationKey: publicationKey,
      alwaysShow: false,
    });
    const written = expectWrittenString(mockedWriteFile.mock.calls[0]?.[1]);
    expect(JSON.parse(written)).toMatchObject({
      sharedTemplatePublicationKey: publicationKey,
    });
  });

  it('serializes concurrent worktree updates for the same project file', async () => {
    let persisted = JSON.stringify(buildWorktreesFile());
    const firstWrite = createDeferred();
    let writeCount = 0;

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      writeCount += 1;
      const nextContents = expectWrittenString(contents);

      if (writeCount === 1) {
        return firstWrite.promise.then(() => {
          persisted = nextContents;
        });
      }

      persisted = nextContents;
      return Promise.resolve();
    });

    const firstUpdate = updateWorkspaceWorktree('ws-1', 'wt-1', (worktree) => ({
      ...worktree,
      trackedRepoBaseBranches: {
        ...(worktree.trackedRepoBaseBranches ?? {}),
        repoA: 'main',
      },
    }));
    await drainEventLoop();

    const secondUpdate = updateWorkspaceWorktree(
      'ws-1',
      'wt-1',
      (worktree) => ({
        ...worktree,
        trackedRepoBaseBranches: {
          ...(worktree.trackedRepoBaseBranches ?? {}),
          repoB: 'develop',
        },
      }),
    );
    await drainEventLoop();

    expect(mockedWriteFile).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await firstUpdate;
    await secondUpdate;

    const parsed = JSON.parse(persisted) as WorktreesFile;
    expect(parsed.worktrees[0]?.trackedRepoBaseBranches).toEqual({
      repoA: 'main',
      repoB: 'develop',
    });
    expect(
      mockedReadFile.mock.calls.filter(
        ([path]) => typeof path === 'string' && path.endsWith('worktrees.json'),
      ),
    ).toHaveLength(2);
  });

  it('skips rewriting the file when the updater returns the original worktree', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(buildWorktreesFile()));

    const updated = await updateWorkspaceWorktree(
      'ws-1',
      'wt-1',
      (worktree) => worktree,
    );

    expect(updated).toBe(true);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('persists hidden worktree state and omits hidden when cleared', async () => {
    let persisted = JSON.stringify(buildWorktreesFile());

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await updateWorkspaceWorktree('ws-1', 'wt-1', (worktree) => ({
      ...worktree,
      hidden: true,
    }));

    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/base',
          createdAt: '2026-04-16T00:00:00.000Z',
          trackedRepoBaseBranches: {},
          hidden: true,
        },
      ],
    });

    await updateWorkspaceWorktree('ws-1', 'wt-1', (worktree) => {
      const next = { ...worktree };
      delete next.hidden;
      return next;
    });

    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/base',
          createdAt: '2026-04-16T00:00:00.000Z',
          trackedRepoBaseBranches: {},
        },
      ],
    });
  });

  it('preserves a backend-promoted git-ready phase over stale pending writes', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'wt-1',
            branchName: 'feature/canonical',
            createdAt: '2026-04-16T00:00:00.000Z',
            setupPhase: 'git-ready',
            trackedRepoBaseBranches: {
              repoA: 'main',
            },
          },
        ],
      } satisfies WorktreesFile),
    );

    await writeWorkspaceWorktrees('ws-1', [
      {
        id: 'wt-1',
        branchName: 'reserved-name',
        createdAt: '2026-04-16T00:00:00.000Z',
        setupPhase: 'git-pending',
      },
    ]);

    // The only write records the legacy row's replica identity (CAN-3808).
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    const persistedContents = mockedWriteFile.mock.calls[0]?.[1];
    if (typeof persistedContents !== 'string')
      throw new Error('Expected stored worktrees');

    expect(JSON.parse(persistedContents)).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/canonical',
          createdAt: '2026-04-16T00:00:00.000Z',
          setupPhase: 'git-ready',
          trackedRepoBaseBranches: {
            repoA: 'main',
          },
        },
      ],
    });
  });

  it('drops recently removed worktrees from stale full-file writes', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        worktrees: [],
      } satisfies WorktreesFile),
    );

    workspacePersistenceTestExports.markWorktreeRecentlyRemoved(
      'ws-stale-save',
      'wt-removed',
      '2026-04-16T00:00:00.000Z',
    );

    await writeWorkspaceWorktrees('ws-stale-save', [
      {
        id: 'wt-removed',
        branchName: 'feature/removed',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
      {
        id: 'wt-active',
        branchName: 'feature/active',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    const writeCall = mockedWriteFile.mock.calls[0];
    const writeContents = writeCall?.[1];
    if (typeof writeContents !== 'string') {
      throw new Error('Expected worktrees write contents to be a string');
    }

    expect(JSON.parse(writeContents)).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'wt-active',
          branchName: 'feature/active',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
      ],
    });
  });

  it('keeps a legitimate recreated worktree when only the id matches a tombstone', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        worktrees: [],
      } satisfies WorktreesFile),
    );

    workspacePersistenceTestExports.markWorktreeRecentlyRemoved(
      'ws-recreated',
      'wt-reused',
      '2026-04-16T00:00:00.000Z',
    );

    await writeWorkspaceWorktrees('ws-recreated', [
      {
        id: 'wt-reused',
        branchName: 'feature/recreated',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
    ]);

    const writeCall = mockedWriteFile.mock.calls[0];
    const writeContents = writeCall?.[1];
    if (typeof writeContents !== 'string') {
      throw new Error('Expected worktrees write contents to be a string');
    }

    expect(JSON.parse(writeContents)).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'wt-reused',
          branchName: 'feature/recreated',
          createdAt: '2026-04-17T00:00:00.000Z',
        },
      ],
    });
  });

  it('prevents stale full-file writes from resurrecting a removed worktree', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-removed',
          branchName: 'feature/removed',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
        {
          id: 'wt-active',
          branchName: 'feature/active',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    const removed = await removeWorkspaceWorktrees(
      'ws-archive',
      (worktree) => worktree.id === 'wt-removed',
    );

    expect(removed).toEqual([
      {
        id: 'wt-removed',
        branchName: 'feature/removed',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    await writeWorkspaceWorktrees('ws-archive', [
      {
        id: 'wt-removed',
        branchName: 'feature/removed',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
      {
        id: 'wt-active',
        branchName: 'feature/active',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'wt-active',
          branchName: 'feature/active',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
      ],
    });
  });

  it('persists surviving children at the deleted parent position in sibling order', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'parent',
          branchName: 'feature/parent',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
        {
          id: 'unrelated',
          branchName: 'feature/unrelated',
          createdAt: '2026-04-16T00:01:00.000Z',
        },
        {
          id: 'child-1',
          branchName: 'feature/child-1',
          createdAt: '2026-04-16T00:02:00.000Z',
        },
        {
          id: 'child-2',
          branchName: 'feature/child-2',
          createdAt: '2026-04-16T00:03:00.000Z',
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await removeWorkspaceWorktrees(
      'ws-ordered-archive',
      (worktree) => worktree.id === 'parent',
      ['child-1', 'child-2', 'unrelated'],
    );

    const persistedWorktrees =
      await readWorkspaceWorktrees('ws-ordered-archive');
    expect(persistedWorktrees.map((worktree) => worktree.id)).toEqual([
      'child-1',
      'child-2',
      'unrelated',
    ]);
  });

  it('preserves a newer persisted reorder during asynchronous archive cleanup', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'parent',
          branchName: 'feature/parent',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
        {
          id: 'unrelated',
          branchName: 'feature/unrelated',
          createdAt: '2026-04-16T00:01:00.000Z',
        },
        {
          id: 'child-2',
          branchName: 'feature/child-2',
          createdAt: '2026-04-16T00:03:00.000Z',
        },
        {
          id: 'child-1',
          branchName: 'feature/child-1',
          createdAt: '2026-04-16T00:02:00.000Z',
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await removeWorkspaceWorktrees(
      'ws-concurrent-archive',
      (worktree) => worktree.id === 'parent',
      ['child-1', 'child-2', 'unrelated'],
      ['unrelated', 'child-1', 'child-2'],
    );

    const persistedWorktrees = await readWorkspaceWorktrees(
      'ws-concurrent-archive',
    );
    expect(persistedWorktrees.map((worktree) => worktree.id)).toEqual([
      'unrelated',
      'child-2',
      'child-1',
    ]);
  });

  it('preserves concurrently-added worktrees absent from a stale full-file write', async () => {
    // Reproduces the Split PR data-loss bug: while a stale renderer snapshot is
    // in flight, the splitter appends child worktrees directly to worktrees.json.
    // A subsequent full-file save from the stale snapshot must NOT drop those
    // children, because they were never removed (no tombstone).
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-original',
          branchName: 'feature/original',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
        {
          id: 'wt-child-1',
          branchName: 'feature/child-1',
          createdAt: '2026-04-16T00:01:00.000Z',
          trackedBaseBranch: 'feature/integration',
          branchGroupingOverride: 'group',
        },
        {
          id: 'wt-child-2',
          branchName: 'feature/child-2',
          createdAt: '2026-04-16T00:02:00.000Z',
          trackedBaseBranch: 'feature/child-1',
          branchGroupingOverride: 'group',
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    // Stale renderer snapshot: only knows about the original worktree.
    await writeWorkspaceWorktrees('ws-split', [
      {
        id: 'wt-original',
        branchName: 'feature/original',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    const parsed = JSON.parse(persisted) as WorktreesFile;
    const ids = parsed.worktrees.map((worktree) => worktree.id).sort();
    expect(ids).toEqual(['wt-child-1', 'wt-child-2', 'wt-original']);
    // Concurrently-added children keep their persisted fields intact.
    expect(
      parsed.worktrees.find((worktree) => worktree.id === 'wt-child-1'),
    ).toEqual({
      id: 'wt-child-1',
      branchName: 'feature/child-1',
      createdAt: '2026-04-16T00:01:00.000Z',
      trackedBaseBranch: 'feature/integration',
      branchGroupingOverride: 'group',
    });
  });

  it.each([
    {
      current: {
        hidden: true,
        branchGroupingOverride: 'ungroup',
        label: 'Canonical label',
      },
      stale: {},
    },
    {
      current: {},
      stale: {
        hidden: true,
        branchGroupingOverride: 'group',
        label: 'Old label',
      },
    },
  ])(
    'preserves targeted visibility and grouping, including explicit clears: %j',
    async ({ current, stale }) => {
      const row: WorktreeData = {
        id: 'targeted-metadata',
        branchName: 'main',
        createdAt: '2026-04-16T00:00:00.000Z',
      };
      let persisted = JSON.stringify({
        version: 1,
        worktrees: [{ ...row, ...current }],
      });
      mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
      mockedWriteFile.mockImplementation((_path, contents) => {
        persisted = expectWrittenString(contents);
        return Promise.resolve();
      });
      await writeWorkspaceWorktrees('ws-targeted-order-metadata', [
        { ...row, ...stale },
      ]);
      const actual: unknown = JSON.parse(persisted);
      expect(actual).toEqual({
        version: 1,
        worktrees: [{ ...row, ...current }],
      });
    },
  );

  it.each(['snapshot-first', 'reorder-first'])(
    'preserves canonical order and inventory with a queued %s write',
    async (writeOrder) => {
      const workspaceId = `ws-order-${writeOrder}`;
      const makeRow = (id: string): WorktreeData => ({
        id,
        branchName: id,
        createdAt: '2026-04-16T00:00:00.000Z',
      });
      const stale = [
        { ...makeRow('a'), seenPipelineExecutionIds: ['seen'] },
        makeRow('hidden'),
        makeRow('b'),
        makeRow('archived'),
      ];
      let persisted = JSON.stringify({
        version: 1,
        worktrees: [
          {
            ...makeRow('a'),
            pinned: true,
            trackedBaseBranch: 'main',
            branchGroupingOverride: 'ungroup',
          },
          { ...makeRow('hidden'), hidden: true },
          makeRow('created'),
          makeRow('b'),
          makeRow('archived'),
        ],
      } satisfies WorktreesFile);
      mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
      mockedWriteFile.mockImplementation((_path, contents) => {
        persisted = expectWrittenString(contents);
        return Promise.resolve();
      });
      await removeWorkspaceWorktrees(
        workspaceId,
        (row) => row.id === 'archived',
      );

      const firstWriteEntered = createDeferred();
      const releaseFirstWrite = createDeferred();
      const writes: string[] = [];
      mockedWriteFile.mockImplementation(async (_path, contents) => {
        const next = expectWrittenString(contents);
        writes.push(next);
        if (writes.length === 1) {
          firstWriteEntered.resolve();
          await releaseFirstWrite.promise;
        }
        persisted = next;
      });
      const save = (): Promise<void> =>
        writeWorkspaceWorktrees(workspaceId, stale);
      const reorder = (): Promise<WorktreeData[]> =>
        updateWorkspaceWorktrees(workspaceId, (current) => {
          const visible = current.filter((row) => !row.hidden);
          const moved = visible.splice(
            visible.findIndex((row) => row.id === 'b'),
            1,
          );
          visible.unshift(...moved);
          let index = 0;
          return current.map((row) => (row.hidden ? row : visible[index++]));
        });
      const first = writeOrder === 'snapshot-first' ? save() : reorder();
      await firstWriteEntered.promise;
      const second = writeOrder === 'snapshot-first' ? reorder() : save();
      await flushMicrotasks();
      expect(writes).toHaveLength(1);
      releaseFirstWrite.resolve();
      await Promise.all([first, second]);

      // Assert the ordinary save itself, as well as the final targeted order.
      // This catches loss of the newly created row's canonical position even
      // when the subsequent targeted reorder would hide that earlier damage.
      const snapshotWrite: unknown = JSON.parse(
        writes[writeOrder === 'snapshot-first' ? 0 : 1],
      );
      expect(snapshotWrite).toMatchObject({
        worktrees: (writeOrder === 'snapshot-first'
          ? ['a', 'hidden', 'created', 'b']
          : ['b', 'hidden', 'a', 'created']
        ).map((id) => ({ id })),
      });
      const final: unknown = JSON.parse(persisted);
      expect(final).toEqual({
        version: 1,
        worktrees: [
          makeRow('b'),
          { ...makeRow('hidden'), hidden: true },
          {
            ...makeRow('a'),
            seenPipelineExecutionIds: ['seen'],
            pinned: true,
            trackedBaseBranch: 'main',
            branchGroupingOverride: 'ungroup',
          },
          makeRow('created'),
        ],
      });
    },
  );

  it('preserves main-owned chat badges across a stale full-file write', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-original',
          branchName: 'feature/original',
          createdAt: '2026-04-16T00:00:00.000Z',
          chatBadges: {
            version: 1,
            unreadChats: [{ chatId: 'chat-1', title: 'Review' }],
            approvalChats: [],
            needsHydration: false,
            updatedAt: '2026-07-17T00:00:00.000Z',
          },
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await writeWorkspaceWorktrees('ws-badges', [
      {
        id: 'wt-original',
        branchName: 'feature/renamed',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    const parsed: unknown = JSON.parse(persisted);
    expect(parsed).toEqual(
      expect.objectContaining({
        worktrees: [
          expect.objectContaining({
            branchName: 'feature/renamed',
            chatBadges: {
              version: 1,
              unreadChats: [{ chatId: 'chat-1', title: 'Review' }],
              approvalChats: [],
              needsHydration: false,
              updatedAt: '2026-07-17T00:00:00.000Z',
            },
          }),
        ],
      }),
    );
  });

  it('preserves the main-owned activity watermark across a stale full-file write', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-original',
          branchName: 'feature/original',
          createdAt: '2026-04-16T00:00:00.000Z',
          lastTouchedAt: '2026-09-01T12:00:00.000Z',
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await writeWorkspaceWorktrees('ws-activity', [
      {
        id: 'wt-original',
        branchName: 'feature/renamed',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    expect(JSON.parse(persisted)).toEqual(
      expect.objectContaining({
        worktrees: [
          expect.objectContaining({
            branchName: 'feature/renamed',
            lastTouchedAt: '2026-09-01T12:00:00.000Z',
          }),
        ],
      }),
    );
  });

  it('preserves main-owned pin state across a stale full-file write', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-original',
          branchName: 'feature/original',
          createdAt: '2026-04-16T00:00:00.000Z',
          pinned: true,
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await writeWorkspaceWorktrees('ws-pinned', [
      {
        id: 'wt-original',
        branchName: 'feature/renamed',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    expect(JSON.parse(persisted)).toEqual(
      expect.objectContaining({
        worktrees: [
          expect.objectContaining({
            branchName: 'feature/renamed',
            pinned: true,
          }),
        ],
      }),
    );
  });

  it('preserves main-owned tracked base branches across a stale full-file write', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-original',
          branchName: 'feature/original',
          createdAt: '2026-04-16T00:00:00.000Z',
          trackedBaseBranch: 'develop',
          trackedRepoBaseBranches: {
            'repo-a': 'develop',
          },
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await writeWorkspaceWorktrees('ws-base-branches', [
      {
        id: 'wt-original',
        branchName: 'feature/renamed',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    const parsed = JSON.parse(persisted) as WorktreesFile;
    expect(parsed.worktrees[0]).toMatchObject({
      branchName: 'feature/renamed',
      trackedBaseBranch: 'develop',
      trackedRepoBaseBranches: {
        'repo-a': 'develop',
      },
    });
  });

  describe.each([
    { scope: 'single-repo', hookKeys: ['project:pr:create'] },
    {
      scope: 'multi-repo',
      hookKeys: [
        'workspace-root:pr:create',
        'workspace-repo:web:pr:create',
        'workspace-repo:api:pr:create',
      ],
    },
  ])('hook pause persistence ($scope)', ({ hookKeys }) => {
    it.each(['pause', 'resume'])(
      'preserves targeted %s across a stale sidebar save',
      async (operation) => {
        const initial = buildWorktreesFile();
        if (operation === 'resume')
          initial.worktrees[0].pausedHookKeys = hookKeys;
        let persisted = JSON.stringify(initial);
        mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
        mockedWriteFile.mockImplementation((_filePath, contents) => {
          persisted = expectWrittenString(contents);
          return Promise.resolve();
        });
        const staleSnapshot = await readWorkspaceWorktrees('ws-hook-pause');
        await updateWorkspaceWorktree('ws-hook-pause', 'wt-1', (worktree) => {
          const next = { ...worktree };
          if (operation === 'pause') next.pausedHookKeys = hookKeys;
          else delete next.pausedHookKeys;
          return next;
        });
        await writeWorkspaceWorktrees('ws-hook-pause', staleSnapshot);
        expect(
          (await readWorkspaceWorktrees('ws-hook-pause'))[0]?.pausedHookKeys,
        ).toEqual(operation === 'pause' ? hookKeys : undefined);
      },
    );
  });

  it('does not restore grouping after a targeted base write beats a stale full-file save', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-original',
          branchName: 'feature/original',
          createdAt: '2026-04-16T00:00:00.000Z',
          trackedBaseBranch: 'main',
          branchGroupingParentWorktreeId: 'merged-parent',
        },
      ],
    } satisfies WorktreesFile);
    const staleRendererSnapshot = (JSON.parse(persisted) as WorktreesFile)
      .worktrees;

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await updateWorkspaceWorktrees('ws-base-branches', (worktrees) =>
      worktrees.map((worktree) => {
        const retargeted = {
          ...worktree,
          trackedBaseBranch: 'develop',
        };
        delete retargeted.branchGroupingParentWorktreeId;
        return retargeted;
      }),
    );
    await writeWorkspaceWorktrees('ws-base-branches', staleRendererSnapshot);

    const parsed = JSON.parse(persisted) as WorktreesFile;
    expect(parsed.worktrees[0]?.trackedBaseBranch).toBe('develop');
    expect(parsed.worktrees[0]?.branchGroupingParentWorktreeId).toBeUndefined();
  });

  it('does not introduce a tracked base into an untracked persisted worktree', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-original',
          branchName: 'feature/original',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await writeWorkspaceWorktrees('ws-base-branches', [
      {
        id: 'wt-original',
        branchName: 'feature/renamed',
        createdAt: '2026-04-16T00:00:00.000Z',
        trackedBaseBranch: 'main',
      },
    ]);

    const parsed = JSON.parse(persisted) as WorktreesFile;
    expect(parsed.worktrees[0]?.branchName).toBe('feature/renamed');
    expect(parsed.worktrees[0]?.trackedBaseBranch).toBeUndefined();
  });

  it('does not resurrect a cleared per-repo tracked base from a stale full-file write', async () => {
    let persisted = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-original',
          branchName: 'feature/original',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
      ],
    } satisfies WorktreesFile);

    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, contents) => {
      persisted = expectWrittenString(contents);
      return Promise.resolve();
    });

    await writeWorkspaceWorktrees('ws-base-branches', [
      {
        id: 'wt-original',
        branchName: 'feature/renamed',
        createdAt: '2026-04-16T00:00:00.000Z',
        trackedRepoBaseBranches: {
          'repo-a': 'develop',
        },
      },
    ]);

    const parsed = JSON.parse(persisted) as WorktreesFile;
    expect(parsed.worktrees[0]).toMatchObject({
      branchName: 'feature/renamed',
    });
    expect(parsed.worktrees[0]?.trackedRepoBaseBranches).toBeUndefined();
  });

  it('filters recently removed worktrees when reading a resurrected file', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'wt-removed',
            branchName: 'feature/removed',
            createdAt: '2026-04-16T00:00:00.000Z',
          },
          {
            id: 'wt-active',
            branchName: 'feature/active',
            createdAt: '2026-04-16T00:00:00.000Z',
          },
        ],
      } satisfies WorktreesFile),
    );

    workspacePersistenceTestExports.markWorktreeRecentlyRemoved(
      'ws-read',
      'wt-removed',
      '2026-04-16T00:00:00.000Z',
    );

    await expect(readWorkspaceWorktrees('ws-read')).resolves.toEqual([
      {
        id: 'wt-active',
        branchName: 'feature/active',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
    ]);
    const writeCall = mockedWriteFile.mock.calls[0];
    const writeContents = writeCall?.[1];
    if (typeof writeContents !== 'string') {
      throw new Error('Expected worktrees write contents to be a string');
    }
    expect(JSON.parse(writeContents)).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'wt-active',
          branchName: 'feature/active',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
      ],
    });
  });

  it('normalizes planDetection on read (drops invalid custom rules)', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        type: 'multi-repo',
        repos: [],
        planDetection: {
          disabledRuleIds: ['superpowers-designs'],
          customRules: [
            {
              id: 'ok',
              label: 'OK',
              kind: 'include',
              pattern: 'p/*.md',
              enabled: true,
            },
            { id: 'bad', kind: 'nope' },
          ],
        },
      }),
    );
    const config = await readWorkspaceConfig('ws1');
    expect(config.planDetection?.disabledRuleIds).toEqual([
      'superpowers-designs',
    ]);
    expect(config.planDetection?.customRules).toHaveLength(1);
    expect(config.planDetection?.customRules?.[0].id).toBe('ok');
  });

  it('persists planDetection through writeWorkspaceConfig and strips invalid rules', async () => {
    // Include an invalid customRule (kind: 'nope') alongside a valid one.
    // writeWorkspaceConfig must pass the input through normalizeWorkspacePlanDetection;
    // the invalid rule must be absent from the written JSON.
    await writeWorkspaceConfig('ws-write-plan', {
      version: 1,
      type: 'multi-repo',
      repos: [],
      alwaysShow: true,
      planDetection: {
        disabledRuleIds: ['superpowers-designs'],
        customRules: [
          {
            id: 'my-rule',
            label: 'My Rule',
            kind: 'include',
            pattern: 'docs/*.md',
            enabled: true,
          },
          { id: 'bad', kind: 'nope' } as unknown as PlanDetectionRule,
        ],
      },
    });

    const writeCall = mockedWriteFile.mock.calls[0];
    const writeContents = writeCall?.[1];
    if (typeof writeContents !== 'string') {
      throw new Error('Expected project config write contents to be a string');
    }

    const parsed = JSON.parse(writeContents) as { planDetection?: unknown };
    expect(parsed.planDetection).toEqual({
      disabledRuleIds: ['superpowers-designs'],
      customRules: [
        {
          id: 'my-rule',
          label: 'My Rule',
          kind: 'include',
          pattern: 'docs/*.md',
          enabled: true,
        },
      ],
    });
  });

  it('prunes recently removed worktrees before applying incremental updates', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'wt-removed',
            branchName: 'feature/removed',
            createdAt: '2026-04-16T00:00:00.000Z',
          },
          {
            id: 'wt-active',
            branchName: 'feature/active',
            createdAt: '2026-04-16T00:00:00.000Z',
          },
        ],
      } satisfies WorktreesFile),
    );

    workspacePersistenceTestExports.markWorktreeRecentlyRemoved(
      'ws-update-prune',
      'wt-removed',
      '2026-04-16T00:00:00.000Z',
    );

    await updateWorkspaceWorktree(
      'ws-update-prune',
      'wt-active',
      (worktree) => ({
        ...worktree,
        hidden: true,
      }),
    );

    const writeCall = mockedWriteFile.mock.calls[0];
    const writeContents = writeCall?.[1];
    if (typeof writeContents !== 'string') {
      throw new Error('Expected worktrees write contents to be a string');
    }
    expect(JSON.parse(writeContents)).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'wt-active',
          branchName: 'feature/active',
          createdAt: '2026-04-16T00:00:00.000Z',
          hidden: true,
        },
      ],
    });
  });

  it('round-trips a cowork project config', async () => {
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'cowork',
      repos: [],
      externalPath: '/Users/me/My Folder',
      alwaysShow: true,
      installedFromTemplateExternalId: '4f4f51c1-a72b-4e12-9320-a038b90189f0',
      installedFromTemplateContentHash: 'c'.repeat(64),
      cowork: {
        createdAt: '2026-07-06T00:00:00.000Z',
        description: 'Personal research',
        defaultModel: 'claude-fable-5',
        presets: [{ id: 'p1', name: 'Default', pluginSelections: {} }],
        archiveRetentionDays: 30,
        startPage: { kind: 'file', path: 'README.md' },
      },
      startPage: null,
    };

    await writeWorkspaceConfig('cw-1', config);

    const written = expectWrittenString(mockedWriteFile.mock.calls[0][1]);
    mockedReadFile.mockResolvedValue(written);
    const read = await readWorkspaceConfig('cw-1');

    expect(read.type).toBe('cowork');
    expect(read.externalPath).toBe('/Users/me/My Folder');
    expect(read.cowork).toEqual(config.cowork);
    expect(read.startPage).toBeNull();
    expect(read.installedFromTemplateExternalId).toBe(
      config.installedFromTemplateExternalId,
    );
    expect(read.installedFromTemplateContentHash).toBe(
      config.installedFromTemplateContentHash,
    );
  });

  it('keeps absent and null code-project start-page overrides distinct', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
      }),
    );
    await expect(
      readWorkspaceConfig('start-page-absent'),
    ).resolves.not.toHaveProperty('startPage');

    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
        startPage: null,
      }),
    );
    await expect(readWorkspaceConfig('start-page-null')).resolves.toMatchObject(
      {
        startPage: null,
      },
    );
  });

  // Both fields survive a write→read→write cycle or they do not survive at
  // all: every caller that stamps a Blueprint seed does read-modify-write
  // through this pair, so a field the normalizer drops is reverted silently
  // one save later rather than failing anywhere visible.
  it('round-trips the curated Blueprint seed stamp and starter prompts', async () => {
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'cowork',
      repos: [],
      seededFromBlueprintExternalId: '6b589a6d-3747-4dd4-a6f6-6aa1a0d18de1',
      cowork: {
        createdAt: '2026-09-11T00:00:00.000Z',
        starterPrompts: [{ id: 'ws-1', text: 'Draft a launch announcement' }],
      },
    };

    await writeWorkspaceConfig('cw-seed', config);
    const written = expectWrittenString(mockedWriteFile.mock.calls[0][1]);
    mockedReadFile.mockResolvedValue(written);
    const read = await readWorkspaceConfig('cw-seed');

    expect(read.seededFromBlueprintExternalId).toBe(
      config.seededFromBlueprintExternalId,
    );
    expect(read.cowork?.starterPrompts).toEqual(config.cowork?.starterPrompts);

    // An explicit empty list is "show no starters" and must not collapse into
    // the absent/"use the generic pool" answer.
    mockedWriteFile.mockClear();
    await writeWorkspaceConfig('cw-seed', {
      ...config,
      cowork: { ...config.cowork, starterPrompts: [] },
    });
    mockedReadFile.mockResolvedValue(
      expectWrittenString(mockedWriteFile.mock.calls[0][1]),
    );
    await expect(readWorkspaceConfig('cw-seed')).resolves.toMatchObject({
      cowork: { starterPrompts: [] },
    });
  });

  it('drops unreadable starter prompts instead of persisting them', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'cowork',
        repos: [],
        cowork: { starterPrompts: [{ id: 'ws-1' }] },
      }),
    );
    const read = await readWorkspaceConfig('cw-bad-starters');
    expect(read.cowork?.starterPrompts).toBeUndefined();
  });

  it('does not coerce a cowork config to multi-repo on read', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
    );
    const read = await readWorkspaceConfig('cw-2');
    expect(read.type).toBe('cowork');
  });

  it('reads legacy folderPath as externalPath (read-compat)', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'cowork',
        repos: [],
        folderPath: '/legacy/path',
      }),
    );
    const read = await readWorkspaceConfig('cw-legacy');
    expect(read.externalPath).toBe('/legacy/path');
  });

  it('reads externalPath for non-cowork configs but strips cowork settings', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: '/repo',
        repos: [],
        externalPath: '/stray',
        cowork: { description: 'stray' },
      }),
    );
    const read = await readWorkspaceConfig('cw-3');
    expect(read.externalPath).toBe('/stray');
    expect(read.cowork).toBeUndefined();
  });
});

describe('Personal catalog identity (CAN-2963)', (): void => {
  it('mints inside the save chain using the latest repos and reuses the ID', async (): Promise<void> => {
    let disk = JSON.stringify({ version: 1, type: 'multi-repo', repos: [] });
    const entered = createDeferred();
    const release = createDeferred();
    mockedReadFile.mockImplementation(
      (): Promise<string> => Promise.resolve(disk),
    );
    mockedWriteFile.mockImplementationOnce(
      async (_path, data): Promise<void> => {
        entered.resolve();
        await release.promise;
        disk = expectWrittenString(data);
      },
    );
    mockedWriteFile.mockImplementation((_path, data): Promise<void> => {
      disk = expectWrittenString(data);
      return Promise.resolve();
    });
    const save = writeWorkspaceConfig('mint-race', {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'new', name: 'New', repoPath: '/new' }],
    });
    await entered.promise;
    const mint = ensurePersonalCatalogId(
      'mint-race',
      (): Promise<boolean> => Promise.resolve(true),
    );
    release.resolve();
    await save;
    const id = await mint;
    expect(JSON.parse(disk)).toMatchObject({
      personalCatalogId: id,
      repos: [{ id: 'new' }],
    });
    expect(id).toEqual(expect.any(String));
    expect(
      await ensurePersonalCatalogId(
        'mint-race',
        (): Promise<boolean> => Promise.resolve(true),
      ),
    ).toBe(id);
  });
  it('treats a 36-character non-UUID as absent', async (): Promise<void> => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'cowork',
        repos: [],
        personalCatalogId: '-'.repeat(36),
      }),
    );
    expect(
      (await readWorkspaceConfig('invalid')).personalCatalogId,
    ).toBeUndefined();
  });
  it('preserves a newly minted ID across overlapping saves', async (): Promise<void> => {
    const personalCatalogId = '11111111-1111-4111-8111-111111111111';
    let disk = JSON.stringify({ version: 1, type: 'cowork', repos: [] });
    const entered = createDeferred();
    const release = createDeferred();
    mockedReadFile.mockImplementation(
      (): Promise<string> => Promise.resolve(disk),
    );
    mockedWriteFile.mockImplementationOnce(
      async (_path, data): Promise<void> => {
        entered.resolve();
        await release.promise;
        disk = expectWrittenString(data);
      },
    );
    mockedWriteFile.mockImplementation(async (_path, data): Promise<void> => {
      await fresh;
      disk = expectWrittenString(data);
    });
    const fresh = writeWorkspaceConfig('overlap', {
      version: 1,
      type: 'cowork',
      repos: [],
      personalCatalogId,
    });
    await entered.promise;
    const older = writeWorkspaceConfig('overlap', {
      version: 1,
      type: 'cowork',
      repos: [],
    });
    await new Promise<void>((resolve): void => {
      setImmediate(resolve);
    });
    release.resolve();
    await Promise.all([fresh, older]);
    // The stale save must not run its read-fallback-write before the mint commits.
    expect(mockedWriteFile.mock.calls.at(-1)?.[1]).toContain(personalCatalogId);
    expect(JSON.parse(disk)).toHaveProperty(
      'personalCatalogId',
      personalCatalogId,
    );
  });
  it('preserves a persisted catalog UUID when an older caller omits it', async (): Promise<void> => {
    const personalCatalogId = '11111111-1111-4111-8111-111111111111';
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        type: 'cowork',
        repos: [],
        personalCatalogId,
      }),
    );
    expect((await readWorkspaceConfig('personal')).personalCatalogId).toBe(
      personalCatalogId,
    );
    await writeWorkspaceConfig('personal', {
      version: 1,
      type: 'cowork',
      repos: [],
    });
    const call = mockedWriteFile.mock.calls.at(-1);
    const body = call?.[1];
    if (typeof body !== 'string') throw new Error('Expected serialized config');
    expect(JSON.parse(body)).toHaveProperty(
      'personalCatalogId',
      personalCatalogId,
    );
  });
});
