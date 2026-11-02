// CAN-3819: core.workspace.sourceRepo.initialize. Runs the real sidebar,
// persistence and source-control modules against a temporary data dir; only
// Git and pipeline policy are mocked.
const mockPipelineBindingsEnabled = jest.fn(() => false);
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): {
    isEnabled: typeof mockPipelineBindingsEnabled;
  } => ({ isEnabled: mockPipelineBindingsEnabled }),
}));
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
import * as persistence from '../workspace-persistence';
import { applyWorkspaceManifestDecision } from '../workspace-record-decision-port';
import {
  initializeWorkspaceSourceRepo,
  WorkspaceSourceRepoRefusedError,
  type WorkspaceSourceRepoRefusal,
} from '../workspace-source-control';

type JsonRecord = Record<string, unknown>;

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    mockPipelineBindingsEnabled.mockReset().mockReturnValue(false);
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-source-init-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems([workspace()]);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
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
      return 'test-commit-sha';
    });

    const result = await initializeWorkspaceSourceRepo({
      workspaceId: 'suite',
      source: 'workspace_settings',
    });

    const manifest = await readManifest('suite');
    expect(manifest.sourceRepoPath).toBe(result.sourceRepoPath);
    expect(manifest.repos).toEqual([{ ...REPO_A, source: 'local' }, REPO_B]);
  });

  it.each([true, false])(
    'observes pipeline policy inside the contended manifest updater (enabled=%s)',
    async (enabled) => {
      mockPipelineBindingsEnabled.mockReturnValue(true);
      await updateWorkspaceConfig('suite', (config) => {
        config.hooks = {
          setup: [
            { type: 'chat', prompt: 'run', executionContext: 'local:machine' },
          ],
        };
      });
      mockPipelineBindingsEnabled.mockReturnValue(!enabled);
      const entered = signal();
      const release = signal();
      const held = updateWorkspaceConfig('suite', async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = signal();
      const update = persistence.updateWorkspaceConfig;
      jest
        .spyOn(persistence, 'updateWorkspaceConfig')
        .mockImplementationOnce((...args) => {
          const pending = update(...args);
          queued.resolve();
          return pending;
        });
      const initialization = initializeWorkspaceSourceRepo({
        workspaceId: 'suite',
        source: 'workspace_settings',
      });
      try {
        await Promise.race([
          queued.promise,
          initialization.then(() => {
            throw new Error('Expected a queued source record');
          }),
        ]);
        mockPipelineBindingsEnabled.mockReturnValue(enabled);
      } finally {
        release.resolve();
        await held;
      }
      await initialization;
      expect((await readManifest('suite')).hooks).toEqual(
        enabled
          ? {
              setup: [
                {
                  type: 'chat',
                  prompt: 'run',
                  executionContext: 'local:machine',
                  localExecutionContextOverlay: true,
                },
              ],
            }
          : undefined,
      );
    },
  );

  it.each(['absent', 'bound'] as const)(
    'refuses a %s source record before observing pipeline policy',
    async (state) => {
      if (state === 'bound') {
        await updateWorkspaceConfig('suite', (config) => {
          config.sourceRepoPath = '/existing';
        });
      }
      mockPipelineBindingsEnabled.mockClear();
      await expect(
        applyWorkspaceManifestDecision(
          state === 'absent' ? 'missing' : 'suite',
          {
            kind: 'workspace.source.initialize',
            repositories: [],
            sourceRepoPath: '/new',
          },
        ),
      ).rejects.toMatchObject({
        reason: state === 'absent' ? 'not-found' : 'already-initialized',
      });
      expect(mockPipelineBindingsEnabled).not.toHaveBeenCalled();
    },
  );

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
      return 'test-commit-sha';
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
