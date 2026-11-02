jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));
jest.mock('../worktree-diff-stats-cache', () => ({
  getCachedWorktreeDiffStats: jest.fn(() => undefined),
}));
jest.mock('../worktree-runtime-status-service', () => ({
  getWorktreeRuntimeStatuses: jest.fn(() => Promise.resolve(new Map())),
}));
jest.mock('../project-avatar-cache', () => ({
  readProjectAvatarUrl: jest.fn(),
  retainProjectAvatarRepoPaths: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';
import type * as PreferencesStore from '../../lib/preferences-store';
import { readPreferencesFile } from '../../lib/preferences-store';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { serializeWorkspaceMutation } from '../../lib/chat-project-operation-queue';
import { getSidebarItemGroupsFilePath } from '../../lib/paths';
import { listWorkspacePortalEntities } from '../workspace-portal-service';

const previousDataDir = process.env.CANOPY_DATA_DIR;
let root = '';

const worktree = (id: string): WorktreeData => ({
  id,
  branchName: `feature/${id}`,
  createdAt: '2026-10-04T00:00:00Z',
});

const workspace: SidebarItem = {
  id: 'workspace-a',
  name: 'Code',
  type: 'single-repo',
  color: '#000000',
  repoPath: '/repo',
  collapsed: false,
  order: 0,
  worktrees: [worktree('wt-a'), worktree('wt-b')],
};

const storedGroups = {
  version: 1,
  groups: [
    {
      id: 'grp-1',
      name: 'Grouped',
      color: 'neutral',
      collapsed: false,
      memberIds: ['wt-a', 'wt-gone'],
    },
  ],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'portal-sidebar-groups-'));
  process.env.CANOPY_DATA_DIR = root;
  jest
    .mocked(readPreferencesFile)
    .mockResolvedValue(
      jest.requireActual<typeof PreferencesStore>('../../lib/preferences-store')
        .DEFAULT_PREFERENCES,
    );
  jest
    .mocked(readAllSidebarItems)
    .mockResolvedValue({ version: 1, items: [workspace] });
  const path = getSidebarItemGroupsFilePath(workspace.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(storedGroups));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
});

it('projects workspace groups while another workspace mutation holds the global queue', async () => {
  let release: () => void = (): void => undefined;
  const held = serializeWorkspaceMutation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      listWorkspacePortalEntities(),
      new Promise<'blocked'>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 1_000);
      }),
    ]);
    if (outcome === 'blocked')
      throw new Error('Portal listing waited on the workspace mutation queue');
    expect(
      outcome.find((entity) => entity.entityType === 'workspace')?.payload,
    ).toHaveProperty('itemGroups', [
      { ...storedGroups.groups[0], memberIds: ['wt-a'] },
    ]);
    // A projection never repairs the sidecar; registry writers own that.
    expect(
      JSON.parse(
        await readFile(getSidebarItemGroupsFilePath(workspace.id), 'utf8'),
      ),
    ).toEqual(storedGroups);
  } finally {
    clearTimeout(timer);
    release();
    await held;
  }
});
