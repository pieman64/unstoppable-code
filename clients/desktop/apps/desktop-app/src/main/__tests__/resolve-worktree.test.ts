jest.mock('node:fs/promises');

jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(),
  isCoworkWorkspace: jest.fn(
    (id: string) => id === 'cw-registered' || id === 'standalone-chat',
  ),
  getWorkspaceExternalPath: jest.fn(() => null),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

import { readFile } from 'node:fs/promises';
import { getCurrentBranch } from '../lib/git';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  doesBranchMatchWorktreeId,
  isBranchPromptSent,
  readPersistedWorktreeBranch,
  resolveChatArchivesFilePath,
  resolveChatTabsFilePath,
  resolveDetectedPlansFilePath,
  resolveTrackedPlansFilePath,
  resolveWorktreeTargetIds,
  resolveWorktreeCwd,
  resolveWorktreeSummaryFilePath,
} from '../lib/resolve-worktree';
import {
  getAppAdvisorHomeDir,
  getChatArchivesFilePath,
  getPipelineEditorHomeDir,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceHomeDir,
  getProjectWorktreesFilePath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
  getSharedContainerRunRepoDir,
  getSharedContainerRunRootDir,
} from '../lib/paths';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { __setDesktopW5FileStoreForTests } from '../lib/w5-commit-log-file-store';
import { nodeW5FileStore, type W5FileRead } from '../lib/w5-file-store';
import { markWorkspaceWorktreeRecentlyRemoved } from '../lib/workspace-persistence';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  getWorkspaceExternalPath,
  getWorkspaceType,
} from '../lib/workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';

const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetWorkspaceType = jest.mocked(getWorkspaceType);
const mockedGetWorkspaceExternalPath = jest.mocked(getWorkspaceExternalPath);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);

const COWORK_ID = 'cw-registered';

describe('persisted worktree reads through core.worktree.get', () => {
  const files = new Map<string, W5FileRead>();
  const replaced: string[] = [];
  let runtime: DesktopCanopyDispatcher | null = null;

  function stored(path: string, value: unknown): void {
    files.set(path, { state: 'present', raw: JSON.stringify(value) });
  }

  function storedRows(rows: unknown): void {
    stored(getWorkspaceWorktreesFilePath('project-1'), {
      version: 1,
      worktrees: rows,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetWorkspaceType.mockReturnValue(null);
    files.clear();
    replaced.length = 0;
    // Only reads through the W5 repositories see these files.
    __setDesktopW5FileStoreForTests({
      read: (path) => Promise.resolve(files.get(path) ?? { state: 'absent' }),
      replace: (path) => {
        replaced.push(path);
        return Promise.reject(new Error('Reads never write'));
      },
    });
    stored(getWorkspaceIndexFilePath(), {
      version: 1,
      workspaces: [
        { id: 'project-1', name: 'One', type: 'single-repo', color: 'blue' },
      ],
    });
    runtime = createDesktopRuntime();
    setDesktopCanopyRuntime(runtime);
  });

  afterEach(async () => {
    jest.mocked(readFile).mockReset();
    setDesktopCanopyRuntime(null);
    await runtime?.shutdown();
    runtime = null;
    __setDesktopW5FileStoreForTests(nodeW5FileStore);
  });

  it('returns the branch and the prompt flag of the worktree row', async () => {
    storedRows([
      {
        id: 'wt-1',
        branchName: 'wt-1-1713571200123',
        createdAt: '2026-08-03T00:00:00.000Z',
        branchPromptSent: true,
      },
      {
        id: 'wt-2',
        branchName: 'feature/two',
        createdAt: '2026-08-03T00:00:00.000Z',
        branchPromptSent: 'yes',
      },
    ]);

    await expect(
      readPersistedWorktreeBranch('project-1', 'wt-1'),
    ).resolves.toEqual({
      worktreeId: 'wt-1',
      branchName: 'wt-1-1713571200123',
    });
    await expect(isBranchPromptSent('project-1', 'wt-1')).resolves.toBe(true);
    await expect(isBranchPromptSent('project-1', 'wt-2')).resolves.toBe(false);
    await expect(isBranchPromptSent('project-1', 'wt-3')).resolves.toBe(false);
  });

  it.each([
    '{',
    JSON.stringify({ version: 2, worktrees: [] }),
    JSON.stringify({ version: 1, worktrees: 'invalid' }),
    JSON.stringify({
      version: 1,
      worktrees: [{ id: 'wt-1', branchName: 42, createdAt: 'today' }],
    }),
    JSON.stringify({
      version: 1,
      worktrees: [{ id: 'wt-1', branchName: 'feature/test' }],
    }),
    // Any row the list cannot read leaves every branch unproven.
    JSON.stringify({
      version: 1,
      worktrees: [
        { id: 'wt-1', branchName: 'feature/test', createdAt: 'today' },
        { id: 'wt-2', branchName: 'feature/other' },
      ],
    }),
  ])('returns null for malformed persisted data', async (raw) => {
    files.set(getWorkspaceWorktreesFilePath('project-1'), {
      state: 'present',
      raw,
    });

    await expect(
      readPersistedWorktreeBranch('project-1', 'wt-1'),
    ).resolves.toBeNull();
  });

  it('reads nothing for a workspace the index does not list', async () => {
    stored(getWorkspaceWorktreesFilePath('project-2'), {
      version: 1,
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/test',
          createdAt: 'today',
          branchPromptSent: true,
        },
      ],
    });

    await expect(
      readPersistedWorktreeBranch('project-2', 'wt-1'),
    ).resolves.toBeNull();
    await expect(isBranchPromptSent('project-2', 'wt-1')).resolves.toBe(false);
  });

  it('no longer reads a legacy project worktrees.json for a non-workspace id', async () => {
    const legacyPath = getProjectWorktreesFilePath('legacy-project');
    const legacyList = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/test',
          createdAt: 'today',
          branchPromptSent: true,
        },
      ],
    });
    // Served on both read paths, so a return to the raw file read fails here.
    files.set(legacyPath, { state: 'present', raw: legacyList });
    jest
      .mocked(readFile)
      .mockImplementation((path) =>
        path === legacyPath
          ? Promise.resolve(legacyList)
          : Promise.reject(new Error('ENOENT')),
      );

    await expect(
      readPersistedWorktreeBranch('legacy-project', 'wt-1'),
    ).resolves.toBeNull();
    await expect(isBranchPromptSent('legacy-project', 'wt-1')).resolves.toBe(
      false,
    );
  });

  it('leaves out a row this process removed, without rewriting the list', async () => {
    storedRows([
      {
        id: 'wt-1',
        branchName: 'feature/test',
        createdAt: 'today',
        branchPromptSent: true,
      },
    ]);
    markWorkspaceWorktreeRecentlyRemoved('project-1', 'wt-1', 'today');

    await expect(
      readPersistedWorktreeBranch('project-1', 'wt-1'),
    ).resolves.toBeNull();
    await expect(isBranchPromptSent('project-1', 'wt-1')).resolves.toBe(false);
    expect(replaced).toEqual([]);
  });

  it('degrades to no value while the runtime is unavailable', async () => {
    storedRows([
      {
        id: 'wt-1',
        branchName: 'feature/test',
        createdAt: 'today',
        branchPromptSent: true,
      },
    ]);
    setDesktopCanopyRuntime(null);

    await expect(
      readPersistedWorktreeBranch('project-1', 'wt-1'),
    ).resolves.toBeNull();
    await expect(isBranchPromptSent('project-1', 'wt-1')).resolves.toBe(false);
  });
});

describe('doesBranchMatchWorktreeId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes the project root repo when matching multi-repo branches', async () => {
    mockedGetWorkspaceType.mockReturnValue('multi-repo');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: '__workspace_root__',
        repoName: 'Workspace root',
        repoPath: '/workspaces/ws-1/wt-1',
      },
      {
        repoId: 'api',
        repoName: 'API',
        repoPath: '/workspaces/ws-1/wt-1/repos/api',
      },
    ]);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('wt-1')
      .mockResolvedValueOnce('feature/api');

    const result = await doesBranchMatchWorktreeId(
      'ws-1',
      'wt-1',
      '/workspaces/ws-1/wt-1',
    );

    expect(result).toEqual({
      matches: true,
      matchingRepos: ['__workspace_root__'],
    });
  });

  it('treats setup-generated numeric suffixes as unrenamed placeholder branches', async () => {
    mockedGetWorkspaceType.mockReturnValue(null);
    mockedGetCurrentBranch.mockResolvedValue('wt-1-2');

    const result = await doesBranchMatchWorktreeId(
      'project-1',
      'wt-1',
      '/worktrees/project-1/wt-1',
    );

    expect(result).toEqual({ matches: true });
  });

  it('treats timestamped default branches as unrenamed placeholder branches', async () => {
    mockedGetWorkspaceType.mockReturnValue(null);
    mockedGetCurrentBranch.mockResolvedValue('wt-1-1713571200123');

    const result = await doesBranchMatchWorktreeId(
      'project-1',
      'wt-1',
      '/worktrees/project-1/wt-1',
    );

    expect(result).toEqual({ matches: true });
  });

  it('treats setup-generated numeric suffixes as placeholders in multi-repo projects', async () => {
    mockedGetWorkspaceType.mockReturnValue('multi-repo');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: '__workspace_root__',
        repoName: 'Workspace root',
        repoPath: '/workspaces/ws-1/wt-1',
      },
      {
        repoId: 'api',
        repoName: 'API',
        repoPath: '/workspaces/ws-1/wt-1/repos/api',
      },
    ]);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('wt-1-2')
      .mockResolvedValueOnce('feature/api');

    const result = await doesBranchMatchWorktreeId(
      'ws-1',
      'wt-1',
      '/workspaces/ws-1/wt-1',
    );

    expect(result).toEqual({
      matches: true,
      matchingRepos: ['__workspace_root__'],
    });
  });

  it('does not treat arbitrary prefixed branches as unrenamed placeholders', async () => {
    mockedGetWorkspaceType.mockReturnValue(null);
    mockedGetCurrentBranch.mockResolvedValue('wt-1-feature');

    const result = await doesBranchMatchWorktreeId(
      'project-1',
      'wt-1',
      '/worktrees/project-1/wt-1',
    );

    expect(result).toEqual({ matches: false });
  });
});

describe('resolveWorktreeCwd', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects invalid selectedRepoId values for multi-repo projects', () => {
    mockedGetWorkspaceType.mockReturnValue('multi-repo');

    expect(() => resolveWorktreeCwd('ws-1', 'wt-1', '../outside')).toThrow(
      'Invalid selectedRepoId: must be lowercase alphanumeric with hyphens',
    );
  });

  it('resolves shared-container terminals within the writable run root', () => {
    expect(
      resolveWorktreeCwd(SHARED_CONTAINER_VIEWER_PROJECT_ID, 'container-1'),
    ).toBe(getSharedContainerRunRootDir('container-1'));
    expect(
      resolveWorktreeCwd(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        'container-1',
        'repo-1',
      ),
    ).toBe(getSharedContainerRunRepoDir('container-1', 'repo-1'));
    expect(
      resolveWorktreeCwd(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        'container-1',
        'repo_with-underscore',
      ),
    ).toBe(getSharedContainerRunRepoDir('container-1', 'repo_with-underscore'));
  });
});

describe('resolveWorktreeCwd cowork', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes a registered cowork project to its managed home dir', () => {
    mockedGetWorkspaceType.mockReturnValue(null);

    expect(resolveWorktreeCwd(COWORK_ID, 'home')).toBe(
      getWorkspaceHomeDir(COWORK_ID),
    );
  });

  it('routes the standalone sentinel to the migrated cowork project home dir', () => {
    mockedGetWorkspaceType.mockReturnValue(null);

    // No cowork-migration-map cache entry is loaded in this test, so the
    // resolver's identity fallback applies: the legacy chat-project id is
    // used verbatim as the workspace id (matches pre-migration/pre-Plan-5
    // behavior where the renderer still sends the legacy id).
    expect(resolveWorktreeCwd(STANDALONE_CHAT_PROJECT_ID, 'default')).toBe(
      getWorkspaceHomeDir('default'),
    );
  });

  it('routes a cowork project with a registered external path to that folder', () => {
    mockedGetWorkspaceType.mockReturnValue(null);
    mockedGetWorkspaceExternalPath.mockImplementation((id: string) =>
      id === COWORK_ID ? '/Users/me/attached-folder' : null,
    );

    expect(resolveWorktreeCwd(COWORK_ID, 'home')).toBe(
      '/Users/me/attached-folder',
    );
  });

  it('falls back to the managed home dir when no external path is registered', () => {
    mockedGetWorkspaceType.mockReturnValue(null);
    mockedGetWorkspaceExternalPath.mockReturnValue(null);

    expect(resolveWorktreeCwd(COWORK_ID, 'home')).toBe(
      getWorkspaceHomeDir(COWORK_ID),
    );
  });

  it('routes every App Advisor entry to the shared App Advisor home', () => {
    mockedGetWorkspaceType.mockReturnValue(null);

    expect(resolveWorktreeCwd(APP_ADVISOR_PROJECT_ID, 'entry-a')).toBe(
      getAppAdvisorHomeDir(),
    );
    expect(resolveWorktreeCwd(APP_ADVISOR_PROJECT_ID, 'entry-b')).toBe(
      getAppAdvisorHomeDir(),
    );
  });
});

describe('resolve*FilePath cowork throws', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves cowork summaries but still throws for cowork tracked/detected plans', () => {
    // Cowork workspaces get the shared Summary card (workspaces/{id}/
    // summaries/home.json); plans remain worktree-only.
    mockedGetWorkspaceType.mockReturnValue('cowork');
    expect(resolveWorktreeSummaryFilePath(COWORK_ID, 'home')).toContain(
      'summaries',
    );

    mockedGetWorkspaceType.mockReturnValue(null);
    expect(() => resolveTrackedPlansFilePath(COWORK_ID, 'home')).toThrow();
    expect(() => resolveDetectedPlansFilePath(COWORK_ID, 'home')).toThrow();
  });
});

describe('resolveChatTabsFilePath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps Pipeline Editor metadata outside its writable home directory', () => {
    mockedGetWorkspaceType.mockReturnValue(null);

    const filePath = resolveChatTabsFilePath(
      PIPELINE_EDITOR_PROJECT_ID,
      PIPELINE_EDITOR_WORKTREE_ID,
    );

    expect(filePath).not.toContain(`${getPipelineEditorHomeDir()}/`);
    expect(filePath).toContain(
      `/app-workspaces/${PIPELINE_EDITOR_PROJECT_ID}/chats/`,
    );
    // Aligns with the other app-managed chat workspaces (App Advisor,
    // plan-explore): the pipeline-editor lives under `app-workspaces`, not the
    // user workspaces root.
    expect(getPipelineEditorHomeDir()).toContain(
      `/app-workspaces/${PIPELINE_EDITOR_PROJECT_ID}`,
    );
    expect(filePath).toContain(
      `/app-workspaces/${PIPELINE_EDITOR_PROJECT_ID}/`,
    );
    expect(getPipelineEditorHomeDir()).toContain(
      `/app-workspaces/${PIPELINE_EDITOR_PROJECT_ID}/home`,
    );
  });

  it('resolves legacy standalone targets to the owning cowork project', () => {
    expect(
      resolveWorktreeTargetIds(STANDALONE_CHAT_PROJECT_ID, COWORK_ID),
    ).toEqual({ projectId: COWORK_ID, worktreeId: 'home' });
    expect(
      resolveWorktreeTargetIds(STANDALONE_CHAT_PROJECT_ID, 'missing'),
    ).toBeNull();
  });

  it('stores App Advisor Work Entry tabs under its app-managed root', () => {
    mockedGetWorkspaceType.mockReturnValue(null);

    expect(resolveChatTabsFilePath(APP_ADVISOR_PROJECT_ID, 'wt-1')).toEqual(
      expect.stringContaining('/app-workspaces/app-advisor/chats/wt-1.json'),
    );
  });

  it('rejects scope traversal before resolving a chat persistence path', () => {
    mockedGetWorkspaceType.mockReturnValue(null);

    expect(() => resolveChatTabsFilePath('../outside', 'wt-1')).toThrow(
      'Invalid projectId',
    );
    expect(() => resolveChatTabsFilePath('project-1', '../outside')).toThrow(
      'Invalid worktreeId',
    );
  });
});

describe('resolveChatArchivesFilePath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetWorkspaceType.mockReturnValue(null);
  });

  it('maps the standalone sentinel to the same cowork home scope as the tabs resolver', () => {
    // The v2 repository pins the legacy archive input from the first caller
    // of a scope. A sentinel-first admission (App Advisor watchers after an
    // upgrade) must therefore see the real `chat-archives/home.json`, not an
    // empty `workspaces/standalone-chat/chat-archives/{coworkId}.json`.
    expect(
      resolveChatArchivesFilePath(STANDALONE_CHAT_PROJECT_ID, COWORK_ID),
    ).toBe(
      getWorkspaceChatArchivesFilePath(
        resolveCoworkWorkspaceId(COWORK_ID),
        COWORK_HOME_WORKTREE_ID,
      ),
    );
    expect(
      resolveChatArchivesFilePath(STANDALONE_CHAT_PROJECT_ID, COWORK_ID),
    ).not.toContain(`/workspaces/${STANDALONE_CHAT_PROJECT_ID}/`);
  });

  it('keeps plan-explore and code-review archives on their existing paths', () => {
    expect(
      resolveChatArchivesFilePath(PLAN_EXPLORE_CHAT_PROJECT_ID, 'plan-1'),
    ).toBe(getChatArchivesFilePath(PLAN_EXPLORE_CHAT_PROJECT_ID, 'plan-1'));
    expect(
      resolveChatArchivesFilePath(CODE_REVIEW_CHAT_PROJECT_ID, 'proj--wt'),
    ).toBe(getChatArchivesFilePath(CODE_REVIEW_CHAT_PROJECT_ID, 'proj--wt'));
  });

  it('rejects scope traversal before resolving an archive path', () => {
    expect(() => resolveChatArchivesFilePath('../outside', 'wt-1')).toThrow(
      'Invalid projectId',
    );
    expect(() =>
      resolveChatArchivesFilePath('project-1', '../outside'),
    ).toThrow('Invalid worktreeId');
  });
});
