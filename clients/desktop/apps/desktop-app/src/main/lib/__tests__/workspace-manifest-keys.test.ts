// CAN-5520: the core-runtime manifest key lists name every field the desktop
// config write emits, in its order, so another host editing a manifest can
// place a field where the desktop would.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_MANIFEST_KEYS,
  WORKSPACE_MANIFEST_REPOSITORY_KEYS,
} from '@canopy/core-runtime/node/w5/workspace-metadata/manifest-keys';
import { getWorkspaceConfigPath } from '../paths';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import { updateWorkspaceConfig } from '../workspace-persistence';

const WORKSPACE_ID = 'keys-ws';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The keys' positions in `order`; -1 for a key it does not list. */
function positions(
  keys: readonly string[],
  order: readonly string[],
): number[] {
  return keys.map((key) => order.indexOf(key));
}

describe('workspace manifest key order', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-keys-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems([
      {
        id: WORKSPACE_ID,
        name: 'Keys',
        type: 'multi-repo',
        color: '#0EA5E9',
        collapsed: false,
        order: 0,
        repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
        worktrees: [],
      },
    ]);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes known fields only, in the shared order', async () => {
    await updateWorkspaceConfig(WORKSPACE_ID, (config): void => {
      config.privateMemory = true;
      config.itemSortMode = 'last-updated';
      config.externalPath = '/external';
      config.sharedTemplatePublicationKey = 'publication';
      config.sharedTemplateExternalId = 'template';
      config.sharedTemplateContentHash = 'hash';
      config.installedFromTemplateExternalId = 'installed';
      config.installedFromTemplateContentHash = 'installed-hash';
      config.seededFromBlueprintExternalId = 'blueprint';
      config.sourceRepoPath = '/source';
      config.scripts = { test: 'pnpm test' };
      config.suppressedRepoIds = ['repo-b'];
      config.alwaysShow = true;
      config.recommendedPluginOptOutKeys = ['plugin'];
      config.temporary = true;
      config.planDetection = { disabledRuleIds: ['plan-md'] };
      config.archiveRetentionDays = 7;
      config.autoArchiveDays = 3;
      config.autoArchiveDeleteBranch = true;
      config.startPage = null;
      config.temporarySourceWorkspaceIds = ['source-ws'];
      config.temporaryRepoIdentityKeys = ['identity'];
      config.repos = [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/a',
          source: 'manifest',
          manifestUrl: 'https://example.com/a.git',
          scripts: { lint: 'eslint' },
        },
      ];
    });

    const manifest: unknown = JSON.parse(
      await readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8'),
    );
    if (!isRecord(manifest)) throw new Error('Expected a manifest');
    const repos: unknown = manifest.repos;
    const repo: unknown = Array.isArray(repos) ? repos.at(0) : undefined;
    if (!isRecord(repo)) throw new Error('Expected a repository');

    const keys = Object.keys(manifest);
    expect(keys.length).toBeGreaterThan(20);
    const topLevel = positions(keys, WORKSPACE_MANIFEST_KEYS);
    expect(topLevel).not.toContain(-1);
    expect(topLevel).toEqual([...topLevel].sort((a, b) => a - b));
    const repoKeys = positions(
      Object.keys(repo),
      WORKSPACE_MANIFEST_REPOSITORY_KEYS,
    );
    expect(repoKeys).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
