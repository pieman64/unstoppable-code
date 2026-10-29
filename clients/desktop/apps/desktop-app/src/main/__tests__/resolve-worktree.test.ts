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
  getSharedContainerRunRepoDir,
  getSharedContainerRunRootDir,
} from '../lib/paths';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  getWorkspaceExternalPath,
  getWorkspaceType,
} from '../lib/workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';

const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedReadFile = jest.mocked(readFile);
const mockedGetWorkspaceType = jest.mocked(getWorkspaceType);
const mockedGetWorkspaceExternalPath = jest.mocked(getWorkspaceExternalPath);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);

const COWORK_ID = 'cw-registered';

describe('readPersistedWorktreeBranch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetWorkspaceType.mockReturnValue(null);
  });

  it('returns the branch with the resolved worktree id', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'wt-1',
            branchName: 'wt-1-1713571200123',
            createdAt: '2026-08-03T00:00:00.000Z',
          },
        ],
      }),
    );

    await expect(
      readPersistedWorktreeBranch('project-1', 'wt-1'),
    ).resolves.toEqual({
      worktreeId: 'wt-1',
      branchName: 'wt-1-1713571200123',
    });
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
  ])('returns null for malformed persisted data', async (raw) => {
    mockedReadFile.mockResolvedValue(raw);

    await expect(
      readPersistedWorktreeBranch('project-1', 'wt-1'),
    ).resolves.toBeNull();
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
