import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as CanopyPaths from '@canopy/desktop-shared/canopy-paths';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import {
  IPC_CHANNELS,
  type WorktreeDiscoveryEvent,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerPreferenceHandlers } from '../ipc/preferences';
import { triggerDiscovery } from '../ipc/worktree-discovery';
import { getWorkspaceWorktreesFilePath } from '../lib/paths';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';

let mockRoot = '';

jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  // Same array the checked writer reads; rows are swapped in place.
  const rows: CoreStorage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (namespaceId: string | null): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] =
          row.id === namespaceId
            ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
            : row;
      });
    },
  };
});
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (namespaceId: string | null) => void;
}>('@canopy/core-runtime/storage');
jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  ...jest.requireActual<typeof CanopyPaths>(
    '@canopy/desktop-shared/canopy-paths',
  ),
  getPrimaryBrandDataDir: (): string => join(mockRoot, 'primary'),
  getResolvedCanopyDataDir: (): ReturnType<
    typeof CanopyPaths.getResolvedCanopyDataDir
  > => ({
    path: join(mockRoot, 'primary'),
    source: 'primary',
    allCandidates: [join(mockRoot, 'primary')],
  }),
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => mockRoot),
}));
jest.mock('../agents/sdk-discovery', () => ({
  discoverWorktreeEnvironment: jest.fn(() =>
    Promise.resolve({ slashCommands: [{ name: 'found' }], mcpServers: [] }),
  ),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(() =>
    Promise.resolve({
      sdkPlugins: [],
      selectedCapabilityRoots: [],
      codexProcessEnv: {},
      warnings: [],
    }),
  ),
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(() =>
    Promise.resolve({
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    }),
  ),
}));

beforeEach(async () => {
  mockRoot = await mkdtemp(join(tmpdir(), 'w5-ipc-storage-'));
  setDaemonOwnedForTest(null);
  jest.clearAllMocks();
});

afterEach(async () => {
  await rm(mockRoot, { recursive: true, force: true });
});

describe('create primary data-dir workspace index seed', () => {
  const workspacesDir = (): string => join(mockRoot, 'primary', 'workspaces');

  function createPrimaryDataDir(): Promise<unknown> {
    registerPreferenceHandlers();
    const handler = jest
      .mocked(registerIpcHandler)
      .mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.preferencesCreatePrimaryDataDir,
      )?.[1];
    if (typeof handler !== 'function') throw new Error('handler missing');
    return Promise.resolve(Reflect.apply(handler, undefined, [{}]));
  }

  it('seeds the empty index once and keeps an existing index on EEXIST', async () => {
    await createPrimaryDataDir();
    const indexPath = join(workspacesDir(), 'index.json');
    expect(await readFile(indexPath, 'utf8')).toBe(
      JSON.stringify({ version: 1, workspaces: [] }, null, 2),
    );

    const existing = JSON.stringify({ version: 1, workspaces: [{ id: 'a' }] });
    await writeFile(indexPath, existing);
    await createPrimaryDataDir();

    expect(await readFile(indexPath, 'utf8')).toBe(existing);
    expect(await readdir(workspacesDir())).toEqual(['index.json']);
  });

  it('refuses a daemon-owned index before seeding it or adopting the directory', async () => {
    setDaemonOwnedForTest('workspace_index');

    await expect(createPrimaryDataDir()).rejects.toMatchObject({
      name: 'StorageWriteRefusedError',
      reason: 'daemon_owned',
      writer: 'electron_main',
    });

    await expect(readdir(join(mockRoot, 'primary'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('worktree-level discovery persistence', () => {
  // The project's list in the data dir; `name` is a field this version
  // does not read, which every write keeps.
  const worktreesPath = (): string =>
    getWorkspaceWorktreesFilePath('project-1');
  const row = (id: string, name: string): Record<string, string> => ({
    id,
    branchName: `branch-${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    name,
  });
  const window: SendableBrowserWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: jest.fn(),
      mainFrame: { detached: false, isDestroyed: () => false },
    },
  };

  function isSettledDiscovery(value: unknown): value is WorktreeDiscoveryEvent {
    return (
      typeof value === 'object' &&
      value !== null &&
      'discovery' in value &&
      value.discovery !== null
    );
  }

  async function discover(): Promise<WorktreeDiscoveryEvent> {
    const settled = new Promise<WorktreeDiscoveryEvent>((resolve) => {
      jest
        .mocked(sendToWindow)
        .mockImplementation((_window, _channel, event) => {
          if (isSettledDiscovery(event)) resolve(event);
          return true;
        });
    });
    triggerDiscovery('project-1', 'wt-1', () => window);
    return settled;
  }

  async function seedWorktrees(): Promise<string> {
    await mkdir(dirname(worktreesPath()), { recursive: true });
    const seeded = JSON.stringify({
      version: 1,
      worktrees: [row('wt-1', 'one'), row('wt-2', 'two')],
    });
    await writeFile(worktreesPath(), seeded);
    return seeded;
  }

  it('persists the discovery on its worktree and keeps the file shape', async () => {
    await seedWorktrees();

    const event = await discover();

    const persisted: unknown = JSON.parse(
      await readFile(worktreesPath(), 'utf8'),
    );
    expect(persisted).toEqual({
      version: 1,
      worktrees: [
        { ...row('wt-1', 'one'), discovery: event.discovery },
        row('wt-2', 'two'),
      ],
    });
    expect(await readFile(worktreesPath(), 'utf8')).toBe(
      JSON.stringify(persisted, null, 2),
    );
    expect(await readdir(dirname(worktreesPath()))).toEqual(['worktrees.json']);
  });

  it('refuses a daemon-owned worktree list and falls back to an empty discovery', async () => {
    const seeded = await seedWorktrees();
    setDaemonOwnedForTest('worktree_list');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const event = await discover();

    expect(event.discovery).toMatchObject({
      slashCommands: [],
      mcpServers: [],
    });
    expect(warn).toHaveBeenCalledWith(
      'Worktree discovery failed:',
      expect.objectContaining({
        reason: 'daemon_owned',
        writer: 'electron_main',
      }),
    );
    expect(await readFile(worktreesPath(), 'utf8')).toBe(seeded);
    expect(await readdir(dirname(worktreesPath()))).toEqual(['worktrees.json']);
    warn.mockRestore();
  });
});
