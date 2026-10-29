// CAN-3819: core.workspace.sourceRepo.initialize. Runs the real sidebar,
// persistence and source-control modules against a temporary data dir; only
// Git is mocked.
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
jest.mock('../git', () => ({
  initGitRepo: jest.fn(() => Promise.resolve()),
  stageAllChanges: jest.fn(() => Promise.resolve()),
  commitWithLocalIdentity: jest.fn(() => Promise.resolve()),
  getRemoteUrl: jest.fn(() => Promise.resolve(null)),
  getRepoRootFromWorktree: jest.fn((repoPath: string) =>
    Promise.resolve(repoPath),
  ),
}));

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MultiRepoSidebarItem } from '@canopy/desktop-shared/types';
import { commitWithLocalIdentity } from '../git';
import { getWorkspaceConfigPath } from '../paths';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import { updateWorkspaceConfig } from '../workspace-persistence';
import {
  initializeWorkspaceSourceRepo,
  WorkspaceSourceRepoRefusedError,
  type WorkspaceSourceRepoRefusal,
} from '../workspace-source-control';

type JsonRecord = Record<string, unknown>;

const REPO_A = { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' };
const REPO_B = { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readManifest(workspaceId: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceConfigPath(workspaceId), 'utf8'),
  );
  if (!isRecord(parsed)) throw new Error('Expected a manifest object');
  return parsed;
}

function workspace(): MultiRepoSidebarItem {
  return {
    id: 'suite',
    name: 'Suite',
    type: 'multi-repo',
    color: '#0EA5E9',
    collapsed: false,
    order: 0,
    repos: [{ ...REPO_A }],
    worktrees: [],
  };
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: WorkspaceSourceRepoRefusal,
  message: string,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceSourceRepoRefusedError);
  expect(error).toMatchObject({ reason, message });
}

describe('source repository initialization (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-source-init-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems([workspace()]);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps a repository added while the source repository was committed', async () => {
    jest.mocked(commitWithLocalIdentity).mockImplementationOnce(async () => {
      await updateWorkspaceConfig('suite', (config): void => {
        config.repos.push({ ...REPO_B });
      });
    });

    const result = await initializeWorkspaceSourceRepo({
      workspaceId: 'suite',
      source: 'workspace_settings',
    });

    const manifest = await readManifest('suite');
    expect(manifest.sourceRepoPath).toBe(result.sourceRepoPath);
    expect(manifest.repos).toEqual([{ ...REPO_A, source: 'local' }, REPO_B]);
  });

  it('names the repository after the project and records it', async () => {
    const result = await initializeWorkspaceSourceRepo({
      workspaceId: 'suite',
      source: 'workspace_settings',
    });

    expect(path.basename(result.sourceRepoPath)).toBe('suite');
    expect(result.manifest).toEqual({ version: 1, repos: [] });
    expect(
      JSON.parse(
        await readFile(path.join(result.sourceRepoPath, 'canopy.json'), 'utf8'),
      ),
    ).toEqual({ version: 1, repos: [] });
    expect(await readManifest('suite')).toMatchObject({
      sourceRepoPath: result.sourceRepoPath,
    });
  });

  it('refuses before creating anything', async () => {
    await expectRefusal(
      initializeWorkspaceSourceRepo({
        workspaceId: 'missing',
        source: 'workspace_settings',
      }),
      'not-found',
      'Project missing not found',
    );
    expect(existsSync(getWorkspaceConfigPath('missing'))).toBe(false);

    await updateWorkspaceConfig('suite', (config): void => {
      config.temporary = true;
    });
    await expectRefusal(
      initializeWorkspaceSourceRepo({
        workspaceId: 'suite',
        source: 'workspace_settings',
      }),
      'temporary',
      'Promote this temporary project before initializing source control.',
    );

    await updateWorkspaceConfig('suite', (config): void => {
      config.temporary = undefined;
      config.sourceRepoPath = '/repos/existing-source';
    });
    await expectRefusal(
      initializeWorkspaceSourceRepo({
        workspaceId: 'suite',
        source: 'workspace_settings',
      }),
      'already-initialized',
      'Project already has a source repository',
    );
    expect(existsSync(path.join(dataDir, 'repos', 'suite'))).toBe(false);
  });

  it('refuses a source repository recorded while its own was committed, keeping the folder', async () => {
    jest.mocked(commitWithLocalIdentity).mockImplementationOnce(async () => {
      await updateWorkspaceConfig('suite', (config): void => {
        config.sourceRepoPath = '/repos/other-source';
      });
    });

    await expectRefusal(
      initializeWorkspaceSourceRepo({
        workspaceId: 'suite',
        source: 'workspace_settings',
      }),
      'already-initialized',
      'Project already has a source repository',
    );
    expect((await readManifest('suite')).sourceRepoPath).toBe(
      '/repos/other-source',
    );
    expect(
      existsSync(path.join(dataDir, 'repos', 'suite', 'canopy.json')),
    ).toBe(true);
  });
});
