import type {
  FileIndexResponse,
  HomeDiscoverEnvironmentRequest,
  HomeFileIndexRequest,
  WorkspaceConfigFile,
  WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import type { RepoShadowInfo } from '../lib/repo-shadow';
import type * as PreferencesStoreModule from '../lib/preferences-store';

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest
    .fn()
    .mockImplementation((p: string) => Promise.resolve(p)),
}));
jest.mock('../lib/paths', () => ({
  getCoworkWorkspaceRootDir: jest.fn(),
}));
jest.mock('../lib/repo-shadow', () => ({
  ensureRepoShadow: jest.fn(),
}));
jest.mock('../lib/git', () => ({
  getRemoteUrlStrict: jest
    .fn()
    .mockResolvedValue('git@example.com:org/repo.git'),
  isGitRepo: jest.fn().mockResolvedValue(true),
  listBranches: jest.fn(),
}));
jest.mock('../lib/git-default-branch', () => ({
  resolveFreshDefaultBranch: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));
jest.mock('../lib/app-advisor-workspace', () => ({
  ensureAppAdvisorHomeScaffold: jest.fn(),
}));
jest.mock('../ipc/worktree-discovery', () => ({
  runProviderDiscovery: jest.fn(),
}));
jest.mock('../services/files-service', () => ({
  buildFileIndexes: jest.fn(),
}));
jest.mock('../lib/file-system-listing', () => ({
  buildFileIndex: jest.fn(),
}));
jest.mock('../lib/file-glob-matcher', () => ({
  buildFileGlobMatcher: jest.fn(),
}));
jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  );
  return {
    ...actual,
    readPreferencesFile: jest.fn(),
  };
});

import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { ensureRepoShadow } from '../lib/repo-shadow';
import { getRemoteUrlStrict, isGitRepo, listBranches } from '../lib/git';
import { resolveFreshDefaultBranch } from '../lib/git-default-branch';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { ensureAppAdvisorHomeScaffold } from '../lib/app-advisor-workspace';
import { runProviderDiscovery } from '../ipc/worktree-discovery';
import { buildFileIndexes } from '../services/files-service';
import { buildFileIndex } from '../lib/file-system-listing';
import { buildFileGlobMatcher } from '../lib/file-glob-matcher';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import {
  handleHomeDiscoverEnvironment,
  handleConfigurationComposerAdvisorEnvironment,
  handleHomeFileIndex,
  handleListBranchTargets,
  resolveHomeBranchRepoPath,
  resolveHomeDiscoveryCwd,
} from '../ipc/home-surface';

const mockedReadConfig = jest.mocked(readWorkspaceConfig);
const mockedGetCoworkRootDir = jest.mocked(getCoworkWorkspaceRootDir);
const mockedEnsureRepoShadow = jest.mocked(ensureRepoShadow);
const mockedGetRemoteUrlStrict = jest.mocked(getRemoteUrlStrict);
const mockedIsGitRepo = jest.mocked(isGitRepo);
const mockedListBranches = jest.mocked(listBranches);
const mockedResolveFreshDefaultBranch = jest.mocked(resolveFreshDefaultBranch);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedEnsureAppAdvisorHomeScaffold = jest.mocked(
  ensureAppAdvisorHomeScaffold,
);
const mockedRunProviderDiscovery = jest.mocked(runProviderDiscovery);
const mockedBuildFileIndexes = jest.mocked(buildFileIndexes);
const mockedBuildFileIndex = jest.mocked(buildFileIndex);
const mockedBuildFileGlobMatcher = jest.mocked(buildFileGlobMatcher);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);

describe('handleConfigurationComposerAdvisorEnvironment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedEnsureAppAdvisorHomeScaffold.mockResolvedValue();
    mockedResolveWorktreeCwd.mockReturnValue('/advisor/home');
  });
  afterEach(() => jest.clearAllMocks());

  it('rejects unsupported providers before preparing the Advisor home', async () => {
    await expect(
      handleConfigurationComposerAdvisorEnvironment({
        providerType: 'other',
      }),
    ).rejects.toThrow('Unsupported App Advisor discovery provider');
    expect(mockedEnsureAppAdvisorHomeScaffold).not.toHaveBeenCalled();
  });

  it('scaffolds the Advisor home and forwards provider and plugin selections', async () => {
    const discovery = {
      slashCommands: [],
      mcpServers: [],
      discoveredAt: 'now',
    };
    const pluginSelections = {
      collectionIds: ['collection'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockedRunProviderDiscovery.mockResolvedValue(discovery);
    mockedBuildFileIndexes.mockResolvedValue({
      repos: [
        {
          repoId: 'files',
          repoName: 'Files',
          absolutePath: '/advisor/home',
          rootKind: 'standalone',
          files: [],
        },
        {
          repoId: 'attachments',
          repoName: 'Attachments',
          absolutePath: '/advisor/home/attachments',
          rootKind: 'attachments',
          files: [],
        },
      ],
    });

    await expect(
      handleConfigurationComposerAdvisorEnvironment({
        providerType: 'claude',
        pluginSelections,
      }),
    ).resolves.toEqual({
      discovery,
      repos: [expect.objectContaining({ repoId: 'files' })],
    });
    expect(mockedEnsureAppAdvisorHomeScaffold).toHaveBeenCalledTimes(1);
    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
    );
    expect(mockedBuildFileIndexes).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
    });
    expect(mockedRunProviderDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/advisor/home',
        providerType: 'claude',
        pluginSelections,
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
      }),
    );
  });
});

function buildConfig(
  overrides: Partial<WorkspaceConfigFile>,
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repos: [],
    ...overrides,
  };
}

const singleRepoConfigFixture: WorkspaceConfigFile = buildConfig({
  type: 'single-repo',
  repoPath: '/Users/me/repo',
});

const nonSourceMultiRepoConfigFixture: WorkspaceConfigFile = buildConfig({
  type: 'multi-repo',
});

describe('handleListBranchTargets', () => {
  it('uses advisory default-branch freshness for Home branch discovery', async () => {
    mockedReadConfig.mockResolvedValue(singleRepoConfigFixture);
    mockedListBranches.mockResolvedValue({
      branches: [],
      defaultBranch: 'trunk',
    });
    mockedResolveFreshDefaultBranch.mockResolvedValue('trunk');

    await expect(
      handleListBranchTargets({ workspaceId: 'ws-1' }),
    ).resolves.toEqual({
      supported: true,
      branches: [],
      defaultBranch: 'trunk',
    });

    expect(mockedListBranches).toHaveBeenCalledWith(
      '/Users/me/repo',
      expect.objectContaining({
        resolveDefaultBranch: mockedResolveFreshDefaultBranch,
      }),
    );
  });
});

function buildMultiRepoConfig(
  prefix: string,
  overrides?: Partial<WorkspaceConfigFile>,
): WorkspaceConfigFile {
  return buildConfig({
    type: 'multi-repo',
    sourceRepoPath: `/Users/me/${prefix}-src`,
    repos: [
      { id: 'web', name: 'Web', repoPath: `/Users/me/${prefix}-web` },
      { id: 'api', name: 'Api', repoPath: `/Users/me/${prefix}-api` },
    ],
    ...overrides,
  });
}

/**
 * Ensures per-repoPath shadows deterministically: every repo path maps to a
 * `/shadows{repoPath}/checkout` shadow checkout.
 */
function installPathKeyedShadows(): void {
  mockedEnsureRepoShadow.mockImplementation((repoPath: string) =>
    Promise.resolve(
      buildRepoShadowInfo({
        repoPath,
        shadowPath: `/shadows${repoPath}/checkout`,
      }),
    ),
  );
}

function buildRepoShadowInfo(
  overrides: Partial<RepoShadowInfo>,
): RepoShadowInfo {
  return {
    repoPath: '/Users/me/repo',
    shadowPath: '/data/repo-shadows/k/checkout',
    defaultBranch: 'main',
    lastSyncAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('resolveHomeBranchRepoPath', () => {
  it('uses repoPath for single-repo projects', async () => {
    mockedReadConfig.mockResolvedValue(
      buildConfig({
        type: 'single-repo',
        repoPath: '/Users/me/repo',
      }),
    );
    await expect(resolveHomeBranchRepoPath('ws-1')).resolves.toBe(
      '/Users/me/repo',
    );
  });

  it('uses the source repo root for source-backed projects', async () => {
    mockedReadConfig.mockResolvedValue(
      buildConfig({
        type: 'multi-repo',
        sourceRepoPath: '/Users/me/workspace-src',
      }),
    );
    await expect(resolveHomeBranchRepoPath('ws-2')).resolves.toBe(
      '/Users/me/workspace-src',
    );
  });

  it('returns null for non-source multi-repo and cowork projects', async () => {
    mockedReadConfig.mockResolvedValue(
      buildConfig({
        type: 'multi-repo',
      }),
    );
    await expect(resolveHomeBranchRepoPath('ws-3')).resolves.toBeNull();

    mockedReadConfig.mockResolvedValue(
      buildConfig({
        type: 'cowork',
      }),
    );
    await expect(resolveHomeBranchRepoPath('ws-4')).resolves.toBeNull();
  });
});

describe('resolveHomeDiscoveryCwd', () => {
  it('routes worktree targets to the worktree cwd', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/worktrees/x');
    await expect(
      resolveHomeDiscoveryCwd('ws-1', {
        kind: 'worktree',
        worktreeId: 'wt-1',
      }),
    ).resolves.toBe('/worktrees/x');
  });

  it('routes cowork targets to the cowork root dir', async () => {
    mockedGetCoworkRootDir.mockReturnValue('/cowork/home');
    await expect(
      resolveHomeDiscoveryCwd('ws-2', { kind: 'cowork' }),
    ).resolves.toBe('/cowork/home');
  });

  it('routes baseline targets to the repo shadow', async () => {
    mockedReadConfig.mockResolvedValue(singleRepoConfigFixture);
    mockedEnsureRepoShadow.mockResolvedValue(
      buildRepoShadowInfo({
        shadowPath: '/data/repo-shadows/k/checkout',
      }),
    );
    await expect(
      resolveHomeDiscoveryCwd('ws-1', { kind: 'baseline' }),
    ).resolves.toBe('/data/repo-shadows/k/checkout');
  });

  it('uses the live checkout before accepting a stale shadow after origin removal', async () => {
    mockedReadConfig.mockResolvedValue(singleRepoConfigFixture);
    mockedEnsureRepoShadow.mockClear();
    mockedEnsureRepoShadow.mockResolvedValue(
      buildRepoShadowInfo({
        shadowPath: '/data/repo-shadows/obsolete/checkout',
      }),
    );
    mockedGetRemoteUrlStrict.mockResolvedValueOnce(null);

    await expect(
      resolveHomeDiscoveryCwd('ws-local', { kind: 'baseline' }),
    ).resolves.toBe('/Users/me/repo');
    expect(mockedEnsureRepoShadow).not.toHaveBeenCalled();
  });

  it('propagates an unexpected origin lookup failure after shadow failure', async () => {
    mockedReadConfig.mockResolvedValue(singleRepoConfigFixture);
    mockedEnsureRepoShadow.mockRejectedValue(
      new Error('shadow synchronization failed'),
    );
    mockedGetRemoteUrlStrict.mockRejectedValueOnce(
      new Error('git remote lookup failed'),
    );

    await expect(
      resolveHomeDiscoveryCwd('ws-remote-error', { kind: 'baseline' }),
    ).rejects.toThrow('git remote lookup failed');
  });

  it('returns null for baseline targets without a canonical repo', async () => {
    mockedReadConfig.mockResolvedValue(nonSourceMultiRepoConfigFixture);
    await expect(
      resolveHomeDiscoveryCwd('ws-3', { kind: 'baseline' }),
    ).resolves.toBeNull();
  });

  it('routes a child-repo-scoped baseline target to that repo’s own shadow', async () => {
    mockedReadConfig.mockResolvedValue(buildMultiRepoConfig('scope'));
    installPathKeyedShadows();
    await expect(
      resolveHomeDiscoveryCwd('ws-multi', { kind: 'baseline', repoId: 'web' }),
    ).resolves.toBe('/shadows/Users/me/scope-web/checkout');
    expect(mockedEnsureRepoShadow).toHaveBeenLastCalledWith(
      '/Users/me/scope-web',
    );
  });

  it('returns null for a child-repo-scoped baseline target with an unknown repo id', async () => {
    mockedReadConfig.mockResolvedValue(buildMultiRepoConfig('scope'));
    await expect(
      resolveHomeDiscoveryCwd('ws-multi', {
        kind: 'baseline',
        repoId: 'nope',
      }),
    ).resolves.toBeNull();
  });
});

describe('handleHomeDiscoverEnvironment cache', () => {
  function makeDiscovery(discoveredAt: string): WorktreeDiscovery {
    return {
      slashCommands: [],
      mcpServers: [],
      discoveredAt,
    };
  }

  it('reuses a warm cache entry without force, but re-runs and replaces it with force', async () => {
    // A unique cwd keeps this test isolated from the module-level cache used
    // by other tests/runs.
    mockedResolveWorktreeCwd.mockReturnValue('/worktrees/force-test');
    mockedRunProviderDiscovery
      .mockResolvedValueOnce(makeDiscovery('first'))
      .mockResolvedValueOnce(makeDiscovery('second'));

    const request: HomeDiscoverEnvironmentRequest = {
      workspaceId: 'ws-force',
      target: { kind: 'worktree', worktreeId: 'wt-force' },
    };

    // 1) Cold cache: runs discovery and caches 'first'.
    await expect(handleHomeDiscoverEnvironment(request)).resolves.toEqual({
      discovery: makeDiscovery('first'),
    });
    expect(mockedRunProviderDiscovery).toHaveBeenCalledTimes(1);

    // 2) Warm cache, no force: served from cache, no new discovery.
    await expect(handleHomeDiscoverEnvironment(request)).resolves.toEqual({
      discovery: makeDiscovery('first'),
    });
    expect(mockedRunProviderDiscovery).toHaveBeenCalledTimes(1);

    // 3) force: bypasses the fresh cache entry, re-runs, and replaces it.
    await expect(
      handleHomeDiscoverEnvironment({ ...request, force: true }),
    ).resolves.toEqual({ discovery: makeDiscovery('second') });
    expect(mockedRunProviderDiscovery).toHaveBeenCalledTimes(2);

    // 4) Warm cache again, no force: now serves the replaced 'second' entry.
    await expect(handleHomeDiscoverEnvironment(request)).resolves.toEqual({
      discovery: makeDiscovery('second'),
    });
    expect(mockedRunProviderDiscovery).toHaveBeenCalledTimes(2);
  });
});

describe('handleHomeDiscoverEnvironment discovery options', () => {
  beforeEach(() => {
    mockedRunProviderDiscovery.mockClear();
    mockedReadConfig.mockClear();
    mockedEnsureRepoShadow.mockClear();
    mockedGetRemoteUrlStrict.mockClear();
    mockedGetRemoteUrlStrict.mockResolvedValue('git@example.com:org/repo.git');
    mockedIsGitRepo.mockClear();
    mockedIsGitRepo.mockResolvedValue(true);
  });

  it('keeps baseline discovery in the repo shadow while forcing an empty MCP config', async () => {
    mockedReadConfig.mockResolvedValue(singleRepoConfigFixture);
    mockedEnsureRepoShadow.mockResolvedValue(
      buildRepoShadowInfo({
        shadowPath: '/data/repo-shadows/baseline/checkout',
      }),
    );
    mockedRunProviderDiscovery.mockResolvedValue({
      slashCommands: [{ name: 'project-command', description: 'Project' }],
      mcpServers: [],
      discoveredAt: 'baseline',
    });

    await handleHomeDiscoverEnvironment({
      workspaceId: 'ws-baseline-mcp',
      target: { kind: 'baseline' },
      force: true,
    });

    expect(mockedRunProviderDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/data/repo-shadows/baseline/checkout',
        safeProjectDiscovery: true,
        strictEmptyMcpConfig: true,
      }),
    );
  });

  it('resolves the draft as the chat it will create', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/worktrees/draft');
    mockedRunProviderDiscovery.mockResolvedValue({
      slashCommands: [],
      mcpServers: [],
      discoveredAt: 'draft',
    });

    await handleHomeDiscoverEnvironment({
      workspaceId: 'ws-draft',
      target: { kind: 'worktree', worktreeId: 'wt-1' },
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      force: true,
    });

    expect(mockedRunProviderDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        applyGlobalDefaults: true,
        draftPluginSelections: true,
      }),
    );
  });

  it('does not force an empty MCP config for checked-out worktree discovery', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/worktrees/checked-out');
    mockedRunProviderDiscovery.mockResolvedValue({
      slashCommands: [],
      mcpServers: [],
      discoveredAt: 'worktree',
    });

    await handleHomeDiscoverEnvironment({
      workspaceId: 'ws-worktree-mcp',
      target: { kind: 'worktree', worktreeId: 'wt-1' },
      force: true,
    });

    expect(mockedRunProviderDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/worktrees/checked-out',
        safeProjectDiscovery: false,
        strictEmptyMcpConfig: false,
      }),
    );
  });
});

describe('handleHomeFileIndex', () => {
  beforeEach(() => {
    // This suite asserts on exact call counts (`toHaveBeenCalledTimes`,
    // `not.toHaveBeenCalled`) for mocks shared with earlier describe blocks
    // in this file (jest has no global `clearMocks` config), so calls must
    // be cleared per-test rather than relying on file-wide isolation.
    mockedEnsureRepoShadow.mockClear();
    mockedBuildFileIndex.mockClear();
    mockedBuildFileIndexes.mockClear();
    mockedReadConfig.mockClear();
    mockedGetCoworkRootDir.mockClear();
    mockedReadPreferencesFile.mockResolvedValue(DEFAULT_PREFERENCES);
    mockedBuildFileGlobMatcher.mockReturnValue({
      isIndexExcluded: jest.fn(() => false),
      patterns: [],
    });
  });

  it('worktree targets delegate to buildFileIndexes', async () => {
    const response: FileIndexResponse = {
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'repo-a',
          absolutePath: '/worktrees/wt-1',
          rootKind: 'git-repo',
          files: [],
        },
      ],
    };
    mockedBuildFileIndexes.mockResolvedValue(response);

    const request: HomeFileIndexRequest = {
      workspaceId: 'ws-1',
      target: { kind: 'worktree', worktreeId: 'wt-1' },
    };
    await expect(handleHomeFileIndex(request)).resolves.toEqual(response);
    expect(mockedBuildFileIndexes).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
  });

  it('cowork targets build a single RepoFileIndex over the cowork root, non-git-aware', async () => {
    mockedGetCoworkRootDir.mockReturnValue('/cowork/home');
    mockedBuildFileIndex.mockResolvedValue([
      {
        relativePath: 'notes.md',
        filename: 'notes.md',
        absolutePath: '/cowork/home/notes.md',
        isIgnored: false,
      },
    ]);

    const request: HomeFileIndexRequest = {
      workspaceId: 'ws-cowork',
      target: { kind: 'cowork' },
    };
    const result = await handleHomeFileIndex(request);

    expect(mockedBuildFileIndex).toHaveBeenCalledWith(
      '/cowork/home',
      expect.objectContaining({ gitAware: false }),
    );
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]).toMatchObject({
      absolutePath: '/cowork/home',
      rootKind: 'standalone',
    });
  });

  it('baseline targets resolve the repo shadow and build a single git-aware RepoFileIndex', async () => {
    mockedReadConfig.mockResolvedValue(singleRepoConfigFixture);
    mockedEnsureRepoShadow.mockResolvedValue(
      buildRepoShadowInfo({
        repoPath: '/Users/me/repo',
        shadowPath: '/data/repo-shadows/k/checkout',
      }),
    );
    mockedBuildFileIndex.mockResolvedValue([
      {
        relativePath: 'src/index.ts',
        filename: 'index.ts',
        absolutePath: '/data/repo-shadows/k/checkout/src/index.ts',
        isIgnored: false,
      },
    ]);

    const request: HomeFileIndexRequest = {
      workspaceId: 'ws-1',
      target: { kind: 'baseline' },
    };
    const result = await handleHomeFileIndex(request);

    expect(mockedBuildFileIndex).toHaveBeenCalledWith(
      '/data/repo-shadows/k/checkout',
      expect.objectContaining({ gitAware: true }),
    );
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]).toMatchObject({
      repoId: 'baseline',
      repoName: 'repo',
      absolutePath: '/data/repo-shadows/k/checkout',
      rootKind: 'git-repo',
    });
  });

  it('baseline indexes the live checkout before accepting a stale shadow after origin removal', async () => {
    mockedReadConfig.mockResolvedValue(
      buildConfig({
        type: 'multi-repo',
        sourceRepoPath: '/Users/me/local-source',
      }),
    );
    mockedEnsureRepoShadow.mockResolvedValue(
      buildRepoShadowInfo({
        repoPath: '/Users/me/local-source',
        shadowPath: '/data/repo-shadows/obsolete/checkout',
      }),
    );
    mockedGetRemoteUrlStrict.mockResolvedValueOnce(null);
    mockedBuildFileIndex.mockResolvedValue([]);

    const result = await handleHomeFileIndex({
      workspaceId: 'ws-local',
      target: { kind: 'baseline' },
      force: true,
    });

    expect(mockedBuildFileIndex).toHaveBeenCalledWith(
      '/Users/me/local-source',
      expect.objectContaining({ gitAware: true }),
    );
    expect(mockedEnsureRepoShadow).not.toHaveBeenCalled();
    expect(result.repos).toEqual([
      expect.objectContaining({
        repoId: '__workspace_root__',
        repoName: 'Project root',
        absolutePath: '/Users/me/local-source',
        rootKind: 'workspace-root',
      }),
    ]);
  });

  it('baseline targets return an empty index when the project has no canonical repo', async () => {
    mockedReadConfig.mockResolvedValue(nonSourceMultiRepoConfigFixture);

    const request: HomeFileIndexRequest = {
      workspaceId: 'ws-3',
      target: { kind: 'baseline' },
    };
    await expect(handleHomeFileIndex(request)).resolves.toEqual({
      repos: [],
    });
    expect(mockedEnsureRepoShadow).not.toHaveBeenCalled();
  });

  it('worktree targets scoped to a child repo pass the repoId filter through', async () => {
    const response: FileIndexResponse = { repos: [] };
    mockedBuildFileIndexes.mockResolvedValue(response);

    await handleHomeFileIndex({
      workspaceId: 'ws-1',
      target: { kind: 'worktree', worktreeId: 'wt-1', repoId: 'web' },
    });
    expect(mockedBuildFileIndexes).toHaveBeenCalledWith(
      { projectId: 'ws-1', worktreeId: 'wt-1' },
      { repoId: 'web' },
    );
  });

  it('multi-repo baseline targets index the source-root shadow plus one shadow per child repo', async () => {
    mockedReadConfig.mockResolvedValue(buildMultiRepoConfig('multi-a'));
    installPathKeyedShadows();
    mockedBuildFileIndex.mockResolvedValue([]);

    const result = await handleHomeFileIndex({
      workspaceId: 'ws-multi-a',
      target: { kind: 'baseline' },
      force: true,
    });

    expect(result.repos).toEqual([
      expect.objectContaining({
        repoId: '__workspace_root__',
        repoName: 'Project root',
        absolutePath: '/shadows/Users/me/multi-a-src/checkout',
        rootKind: 'workspace-root',
      }),
      expect.objectContaining({
        repoId: 'web',
        repoName: 'Web',
        absolutePath: '/shadows/Users/me/multi-a-web/checkout',
        rootKind: 'git-repo',
      }),
      expect.objectContaining({
        repoId: 'api',
        repoName: 'Api',
        absolutePath: '/shadows/Users/me/multi-a-api/checkout',
        rootKind: 'git-repo',
      }),
    ]);
    expect(mockedEnsureRepoShadow).toHaveBeenCalledWith(
      '/Users/me/multi-a-src',
    );
    expect(mockedEnsureRepoShadow).toHaveBeenCalledWith(
      '/Users/me/multi-a-web',
    );
    expect(mockedEnsureRepoShadow).toHaveBeenCalledWith(
      '/Users/me/multi-a-api',
    );
  });

  it('multi-repo baseline targets scoped to a child repo index only that repo’s shadow', async () => {
    mockedReadConfig.mockResolvedValue(buildMultiRepoConfig('multi-b'));
    installPathKeyedShadows();
    mockedBuildFileIndex.mockResolvedValue([]);

    const result = await handleHomeFileIndex({
      workspaceId: 'ws-multi-b',
      target: { kind: 'baseline', repoId: 'api' },
      force: true,
    });

    expect(result.repos).toEqual([
      expect.objectContaining({
        repoId: 'api',
        repoName: 'Api',
        absolutePath: '/shadows/Users/me/multi-b-api/checkout',
        rootKind: 'git-repo',
      }),
    ]);
    expect(mockedEnsureRepoShadow).toHaveBeenCalledTimes(1);
  });

  it('non-source multi-repo baseline targets still index each child repo shadow', async () => {
    mockedReadConfig.mockResolvedValue(
      buildMultiRepoConfig('multi-c', { sourceRepoPath: undefined }),
    );
    installPathKeyedShadows();
    mockedBuildFileIndex.mockResolvedValue([]);

    const result = await handleHomeFileIndex({
      workspaceId: 'ws-multi-c',
      target: { kind: 'baseline' },
      force: true,
    });

    expect(result.repos.map((repo) => repo.repoId)).toEqual(['web', 'api']);
    expect(result.repos.every((repo) => repo.rootKind === 'git-repo')).toBe(
      true,
    );
  });

  it('degrades to the remaining entries when one child repo cannot host a shadow', async () => {
    mockedReadConfig.mockResolvedValue(buildMultiRepoConfig('multi-d'));
    mockedEnsureRepoShadow.mockImplementation((repoPath: string) =>
      repoPath === '/Users/me/multi-d-web'
        ? Promise.reject(new Error('no remote default branch'))
        : Promise.resolve(
            buildRepoShadowInfo({
              repoPath,
              shadowPath: `/shadows${repoPath}/checkout`,
            }),
          ),
    );
    mockedBuildFileIndex.mockResolvedValue([]);

    const result = await handleHomeFileIndex({
      workspaceId: 'ws-multi-d',
      target: { kind: 'baseline' },
      force: true,
    });

    expect(result.repos.map((repo) => repo.repoId)).toEqual([
      '__workspace_root__',
      'api',
    ]);
  });

  it('degrades to the remaining entries when one child origin lookup fails', async () => {
    mockedReadConfig.mockResolvedValue(buildMultiRepoConfig('multi-origin'));
    mockedGetRemoteUrlStrict.mockImplementation((repoPath: string) =>
      repoPath === '/Users/me/multi-origin-web'
        ? Promise.reject(new Error('git remote lookup failed'))
        : Promise.resolve('git@example.com:org/repo.git'),
    );
    installPathKeyedShadows();
    mockedBuildFileIndex.mockResolvedValue([]);

    const result = await handleHomeFileIndex({
      workspaceId: 'ws-multi-origin',
      target: { kind: 'baseline' },
      force: true,
    });

    expect(result.repos.map((repo) => repo.repoId)).toEqual([
      '__workspace_root__',
      'api',
    ]);
  });

  it('reuses one shadow-keyed listing across projects referencing the same repo', async () => {
    installPathKeyedShadows();
    mockedBuildFileIndex.mockResolvedValue([
      {
        relativePath: 'shared.ts',
        filename: 'shared.ts',
        absolutePath: '/shadows/Users/me/shared-repo/checkout/shared.ts',
        isIgnored: false,
      },
    ]);

    // Two different workspaces — one single-repo, one multi-repo child —
    // referencing the same underlying repo path.
    mockedReadConfig.mockResolvedValueOnce(
      buildConfig({ type: 'single-repo', repoPath: '/Users/me/shared-repo' }),
    );
    const first = await handleHomeFileIndex({
      workspaceId: 'ws-shared-single',
      target: { kind: 'baseline' },
      force: true,
    });
    expect(first.repos[0]?.files.map((f) => f.filename)).toEqual(['shared.ts']);
    expect(mockedBuildFileIndex).toHaveBeenCalledTimes(1);

    mockedReadConfig.mockResolvedValueOnce(
      buildConfig({
        type: 'multi-repo',
        repos: [
          { id: 'shared', name: 'Shared', repoPath: '/Users/me/shared-repo' },
        ],
      }),
    );
    const second = await handleHomeFileIndex({
      workspaceId: 'ws-shared-multi',
      target: { kind: 'baseline', repoId: 'shared' },
    });

    // Same shadow → cached listing served without a second index build, but
    // the wrapper identity is workspace-relative (child repo id/name).
    expect(mockedBuildFileIndex).toHaveBeenCalledTimes(1);
    expect(second.repos[0]).toMatchObject({
      repoId: 'shared',
      repoName: 'Shared',
      absolutePath: '/shadows/Users/me/shared-repo/checkout',
    });
    expect(second.repos[0]?.files.map((f) => f.filename)).toEqual([
      'shared.ts',
    ]);
  });

  it('baseline targets reuse a warm cache entry keyed by shadow path, but force bypasses it', async () => {
    mockedReadConfig.mockResolvedValue(
      buildConfig({ type: 'single-repo', repoPath: '/Users/me/repo-cache' }),
    );
    mockedEnsureRepoShadow.mockResolvedValue(
      buildRepoShadowInfo({
        repoPath: '/Users/me/repo-cache',
        shadowPath: '/data/repo-shadows/cache-test/checkout',
      }),
    );
    mockedBuildFileIndex
      .mockResolvedValueOnce([
        {
          relativePath: 'a.ts',
          filename: 'a.ts',
          absolutePath: '/data/repo-shadows/cache-test/checkout/a.ts',
          isIgnored: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          relativePath: 'b.ts',
          filename: 'b.ts',
          absolutePath: '/data/repo-shadows/cache-test/checkout/b.ts',
          isIgnored: false,
        },
      ]);

    const request: HomeFileIndexRequest = {
      workspaceId: 'ws-cache',
      target: { kind: 'baseline' },
    };

    const first = await handleHomeFileIndex(request);
    expect(first.repos[0]?.files.map((f) => f.filename)).toEqual(['a.ts']);
    expect(mockedBuildFileIndex).toHaveBeenCalledTimes(1);

    const second = await handleHomeFileIndex(request);
    expect(second.repos[0]?.files.map((f) => f.filename)).toEqual(['a.ts']);
    expect(mockedBuildFileIndex).toHaveBeenCalledTimes(1);

    const third = await handleHomeFileIndex({ ...request, force: true });
    expect(third.repos[0]?.files.map((f) => f.filename)).toEqual(['b.ts']);
    expect(mockedBuildFileIndex).toHaveBeenCalledTimes(2);
  });
});
