// CAN-3816: the renderer, portal and App Advisor entry points of the W5
// script, hook, plan detection and paused-hook commands, against the real
// sidebar and persistence modules on a temporary data dir.
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '../portal/portal-event-bus',
  );
  return { ...actual, notifyPortalStructureChanged: jest.fn() };
});
jest.mock('../services/hooks-service', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '../services/hooks-service',
  );
  return { ...actual, listHooks: jest.fn() };
});

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  PortalHookSummary,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { handlePortalHookPause } from '../portal/adapters/hooks-adapter';
import type { PortalAdapterContext } from '../portal/adapters/types';
import { getWorkspaceConfigPath, getWorkspaceDir } from '../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { listHooks } from '../services/hooks-service';
import {
  saveProjectScriptsFromService,
  saveWorkspaceScriptsFromService,
} from '../services/scripts-service';

const mockedListHooks = jest.mocked(listHooks);

const COWORK: CoworkSidebarItem = {
  id: 'cowork-a',
  name: 'Cowork A',
  type: 'cowork',
  color: '#7C3AED',
  collapsed: false,
  order: 0,
  cowork: { createdAt: '2026-09-01T00:00:00.000Z' },
};

const MULTI: MultiRepoSidebarItem = {
  id: 'multi-a',
  name: 'Multi A',
  type: 'multi-repo',
  color: '#0EA5E9',
  collapsed: false,
  order: 1,
  repos: [],
  worktrees: [
    {
      id: 'tree-a',
      branchName: 'tree-a-branch',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  ],
};

const SEEDED: SidebarItem[] = [COWORK, MULTI];

function hook(hookKey: string): PortalHookSummary {
  return {
    hookId: hookKey,
    hookKey,
    workspaceLocalId: 'multi-a',
    worktreeLocalId: 'tree-a',
  } as PortalHookSummary;
}

function pauseCommand(
  type: 'portal.hook.pause' | 'portal.hook.resume',
  hookKey: string,
): PortalCommandEnvelope<PortalCommandPayloadMap['portal.hook.pause']> {
  return {
    id: `${type}-${hookKey}`,
    type,
    payload: { projectId: 'multi-a', worktreeId: 'tree-a', hookKey },
  } as PortalCommandEnvelope<PortalCommandPayloadMap['portal.hook.pause']>;
}

function portalContext(failures: string[]): PortalAdapterContext {
  return {
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail: (_command, code, message): void => {
      failures.push(`${code}: ${message}`);
    },
  };
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

describe('W5 script and hook settings entry points (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-settings-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems(SEEDED);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('saves project scripts without changing the workspace type', async () => {
    await saveProjectScriptsFromService({
      projectId: 'cowork-a',
      scripts: { setup: 'npm ci' },
    });

    const written: unknown = JSON.parse(
      await readFile(getWorkspaceConfigPath('cowork-a'), 'utf8'),
    );
    expect(written).toMatchObject({
      type: 'cowork',
      scripts: { setup: 'npm ci' },
    });
  });

  it('never creates a manifest for a workspace that has none', async () => {
    await expect(
      saveWorkspaceScriptsFromService({
        workspaceId: 'missing',
        scripts: { setup: 'npm ci' },
      }),
    ).rejects.toThrow(/settings could not be read/);
    expect(await exists(getWorkspaceDir('missing'))).toBe(false);
  });

  it('keeps both of two competing portal pauses', async () => {
    mockedListHooks.mockResolvedValue([hook('hook-a'), hook('hook-b')]);
    const failures: string[] = [];

    await Promise.all([
      handlePortalHookPause(
        pauseCommand('portal.hook.pause', 'hook-a'),
        portalContext(failures),
      ),
      handlePortalHookPause(
        pauseCommand('portal.hook.pause', 'hook-b'),
        portalContext(failures),
      ),
    ]);

    expect(failures).toEqual([]);
    const [worktree] = await readWorkspaceWorktrees('multi-a');
    expect(worktree?.pausedHookKeys).toEqual(['hook-a', 'hook-b']);
  });

  it('keeps a competing portal resume', async () => {
    mockedListHooks.mockResolvedValue([hook('hook-a'), hook('hook-b')]);
    const failures: string[] = [];
    await handlePortalHookPause(
      pauseCommand('portal.hook.pause', 'hook-a'),
      portalContext(failures),
    );

    await Promise.all([
      handlePortalHookPause(
        pauseCommand('portal.hook.resume', 'hook-a'),
        portalContext(failures),
      ),
      handlePortalHookPause(
        pauseCommand('portal.hook.pause', 'hook-b'),
        portalContext(failures),
      ),
    ]);

    expect(failures).toEqual([]);
    const [worktree] = await readWorkspaceWorktrees('multi-a');
    expect(worktree?.pausedHookKeys).toEqual(['hook-b']);
  });
});
