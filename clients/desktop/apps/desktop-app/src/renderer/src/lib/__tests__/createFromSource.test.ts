/**
 * @jest-environment jsdom
 */
import type {
  LinearTicketSearchResult,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  buildLinearTaskText,
  createOptionsForBranch,
  createOptionsForLinear,
  createOptionsForPr,
  isWorkspaceEligibleForCreateFrom,
  replaceGeneratedTaskText,
  resolveCreateFromTarget,
  resolveCreateFromReferenceInput,
  workspaceRepoPathForCreateFrom,
} from '@/lib/createFromSource';

const TICKET: LinearTicketSearchResult = {
  id: 'ticket-1',
  identifier: 'ECW-8121',
  title: 'create worktree from existing branch/PR/issue',
  description: 'Conductor parity.',
  url: 'https://linear.app/acme/issue/ECW-8121',
  priority: 0,
  priorityLabel: 'No priority',
  branchName: 'ryan/ecw-8121-create-worktree',
};

const SINGLE_REPO_WORKSPACE: SidebarItem = {
  id: 'ws-1',
  name: 'Demo',
  type: 'single-repo',
  repoPath: '/repos/demo',
  color: 'green',
  collapsed: false,
  order: 0,
  worktrees: [],
};

const MULTI_REPO_WORKSPACE_NO_SOURCE: SidebarItem = {
  id: 'ws-multi',
  name: 'Multi Demo',
  type: 'multi-repo',
  color: 'blue',
  collapsed: false,
  order: 0,
  repos: [],
  worktrees: [],
};

const MULTI_REPO_WORKSPACE_WITH_SOURCE: SidebarItem = {
  id: 'ws-multi-source',
  name: 'Multi Demo Source',
  type: 'multi-repo',
  color: 'blue',
  collapsed: false,
  order: 0,
  repos: [],
  worktrees: [],
  sourceRepoPath: '/repos/multi-source',
};

const resolvePullRequestMock = jest.fn();
const searchLinearIssuesMock = jest.fn();
const homeListBranchTargetsMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      resolvePullRequest: resolvePullRequestMock,
      searchLinearIssues: searchLinearIssuesMock,
      homeListBranchTargets: homeListBranchTargetsMock,
    },
  });
});

describe('pure mappers', () => {
  it('normalizes detected Linear URLs when Linear is available', () => {
    expect(
      resolveCreateFromReferenceInput(
        'https://linear.app/acme/issue/ecw-8121/details',
        true,
      ),
    ).toEqual({
      detected: { mode: 'linear', value: 'ECW-8121' },
      referenceQuery: 'ECW-8121',
    });
    expect(
      resolveCreateFromReferenceInput(
        'https://linear.app/acme/issue/ecw-8121/details',
        false,
      ).referenceQuery,
    ).toBe('https://linear.app/acme/issue/ecw-8121/details');
  });

  it('maps branch and PR sources to existingBranch', () => {
    expect(createOptionsForBranch('feature/foo')).toEqual({
      existingBranch: 'feature/foo',
    });
    expect(
      createOptionsForPr({
        number: 9,
        title: 'T',
        headRefName: 'feat/head',
        baseRefName: 'develop',
        url: 'https://github.com/o/r/pull/9',
      }),
    ).toEqual({ existingBranch: 'feat/head' });
  });

  it('defers Linear branch existence resolution to the backend', () => {
    expect(createOptionsForLinear(TICKET)).toEqual({
      suggestedBranch: 'ryan/ecw-8121-create-worktree',
    });
  });

  it('builds Linear task text with and without description', () => {
    expect(buildLinearTaskText(TICKET)).toBe(
      'ECW-8121: create worktree from existing branch/PR/issue\n\nConductor parity.',
    );
    expect(buildLinearTaskText({ ...TICKET, description: null })).toBe(
      'ECW-8121: create worktree from existing branch/PR/issue',
    );
  });

  it('replaces only empty or previously generated task text', () => {
    expect(replaceGeneratedTaskText('', '', 'PR B')).toBe('PR B');
    expect(replaceGeneratedTaskText('PR A', 'PR A', 'PR B')).toBe('PR B');
    expect(replaceGeneratedTaskText('User context', 'PR A', 'PR B')).toBe(
      'User context',
    );
  });

  it('resolves the project repo path per type', () => {
    expect(workspaceRepoPathForCreateFrom(SINGLE_REPO_WORKSPACE)).toBe(
      '/repos/demo',
    );
    expect(
      workspaceRepoPathForCreateFrom(MULTI_REPO_WORKSPACE_WITH_SOURCE),
    ).toBe('/repos/multi-source');
    expect(
      workspaceRepoPathForCreateFrom(MULTI_REPO_WORKSPACE_NO_SOURCE),
    ).toBeNull();
  });

  it('only allows create-from for projects with a source repository', () => {
    expect(isWorkspaceEligibleForCreateFrom(SINGLE_REPO_WORKSPACE)).toBe(true);
    expect(
      isWorkspaceEligibleForCreateFrom(MULTI_REPO_WORKSPACE_WITH_SOURCE),
    ).toBe(true);
    expect(
      isWorkspaceEligibleForCreateFrom(MULTI_REPO_WORKSPACE_NO_SOURCE),
    ).toBe(false);
  });
});

describe('resolveCreateFromTarget', () => {
  it('resolves a branch reference without any IPC', async () => {
    const resolved = await resolveCreateFromTarget(
      'branch',
      '  feature/foo ',
      SINGLE_REPO_WORKSPACE,
    );
    expect(resolved.createOptions).toEqual({ existingBranch: 'feature/foo' });
    expect(resolved.resolvedLabel).toBe('branch feature/foo');
    expect(resolvePullRequestMock).not.toHaveBeenCalled();
  });

  it('rejects a blank branch reference', async () => {
    await expect(
      resolveCreateFromTarget('branch', '   ', SINGLE_REPO_WORKSPACE),
    ).rejects.toThrow('branch name is required');
  });

  it('rejects a PR reference when the project has no repository', async () => {
    await expect(
      resolveCreateFromTarget('pr', '#5', MULTI_REPO_WORKSPACE_NO_SOURCE),
    ).rejects.toThrow('no repository');
    expect(resolvePullRequestMock).not.toHaveBeenCalled();
  });

  it('resolves a PR reference through window.api.resolvePullRequest', async () => {
    resolvePullRequestMock.mockResolvedValue({
      number: 1825,
      title: 'Perf',
      headRefName: 'tirish/perf',
      baseRefName: 'develop',
      url: 'https://github.com/o/r/pull/1825',
    });

    const resolved = await resolveCreateFromTarget(
      'pr',
      '#1825',
      SINGLE_REPO_WORKSPACE,
    );

    expect(resolvePullRequestMock).toHaveBeenCalledWith({
      repoPath: '/repos/demo',
      reference: '#1825',
    });
    expect(resolved.createOptions).toEqual({ existingBranch: 'tirish/perf' });
    expect(resolved.resolvedLabel).toContain('#1825');
  });

  it('resolves a Linear reference to the exact identifier match', async () => {
    searchLinearIssuesMock.mockResolvedValue([
      { ...TICKET, identifier: 'ECW-812', id: 'other' },
      TICKET,
    ]);
    const resolved = await resolveCreateFromTarget(
      'linear',
      'https://linear.app/acme/issue/ECW-8121/x',
      SINGLE_REPO_WORKSPACE,
    );

    expect(searchLinearIssuesMock).toHaveBeenCalledWith('ECW-8121');
    expect(resolved.createOptions).toEqual({
      suggestedBranch: 'ryan/ecw-8121-create-worktree',
    });
    expect(homeListBranchTargetsMock).not.toHaveBeenCalled();
    expect(resolved.prefillText).toContain('ECW-8121:');
  });

  it('throws when no Linear issue matches', async () => {
    searchLinearIssuesMock.mockResolvedValue([]);
    await expect(
      resolveCreateFromTarget('linear', 'ECW-9999', SINGLE_REPO_WORKSPACE),
    ).rejects.toThrow('No Linear issue found');
  });

  it('throws when Linear search only returns a different issue', async () => {
    searchLinearIssuesMock.mockResolvedValue([
      { ...TICKET, identifier: 'ECW-9998', id: 'different-ticket' },
    ]);

    await expect(
      resolveCreateFromTarget('linear', 'ECW-9999', SINGLE_REPO_WORKSPACE),
    ).rejects.toThrow('No Linear issue found');
    expect(homeListBranchTargetsMock).not.toHaveBeenCalled();
  });
});
