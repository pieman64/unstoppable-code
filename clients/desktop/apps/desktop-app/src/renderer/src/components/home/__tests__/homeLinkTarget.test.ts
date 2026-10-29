import type {
  CoworkSidebarItem,
  LinearTicketSearchResult,
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  describeHomeLinkPlan,
  materializeHomeLinkPlan,
  pruneDismissedHomeLinkKeys,
  resolveHomeLink,
  selectHomeLink,
  type HomeLinkMaterializeDeps,
  type HomeLinkPlan,
  type HomeLinkResolveContext,
  type HomeLinkResolveDeps,
  type HomeLinkSelection,
} from '../homeLinkTarget';

function repoProject(id: string, repoPath = `/repos/${id}`): SidebarItem {
  const project: SingleRepoSidebarItem = {
    id,
    type: 'single-repo',
    name: id,
    repoPath,
    color: '#123456',
    order: 0,
    collapsed: false,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
  return project;
}

function chatsProject(id = 'chats'): SidebarItem {
  const project: CoworkSidebarItem = {
    id,
    type: 'cowork',
    name: 'Chats',
    color: '#123456',
    order: 0,
    collapsed: false,
  };
  return project;
}

const SLUGS: Record<string, { owner: string; repo: string } | null> = {
  '/repos/app': { owner: 'Acme', repo: 'App' },
  '/repos/app-copy': { owner: 'acme', repo: 'app' },
  '/repos/other': { owner: 'acme', repo: 'other' },
  '/repos/no-origin': null,
};

function deps(
  overrides: Partial<HomeLinkResolveDeps> = {},
): HomeLinkResolveDeps {
  return {
    getRepoSlug: jest.fn((repoPath: string) =>
      Promise.resolve(SLUGS[repoPath] ?? null),
    ),
    resolvePullRequest: jest.fn(() =>
      Promise.resolve({
        number: 7,
        title: 'Fix',
        headRefName: 'fix/login',
        baseRefName: 'main',
        url: 'https://github.com/acme/app/pull/7',
      }),
    ),
    searchLinearIssues: jest.fn(() => Promise.resolve([])),
    listUserGitHubRepos: jest.fn(() => Promise.resolve([])),
    ...overrides,
  };
}

function context(
  overrides: Partial<HomeLinkResolveContext> = {},
): HomeLinkResolveContext {
  return {
    workspaceId: 'chats',
    workspaceSelectionExplicit: false,
    projects: [chatsProject(), repoProject('app'), repoProject('other')],
    otherScopeProjects: [],
    canCreatePersonalProject: true,
    ...overrides,
  };
}

function single(text: string): HomeLinkSelection {
  const selection = selectHomeLink(text, [], null);
  if (selection.kind !== 'single') throw new Error(selection.kind);
  return selection;
}

function issue(
  overrides: Partial<LinearTicketSearchResult> = {},
): LinearTicketSearchResult {
  return {
    id: 'issue-1',
    identifier: 'CAN-1',
    title: 'Login bug',
    url: 'https://linear.app/acme/issue/CAN-1',
    description: null,
    priority: 2,
    priorityLabel: 'High',
    branchName: 'aq/can-1-login-bug',
    ...overrides,
  };
}

describe('selectHomeLink', () => {
  it.each([
    'ordinary draft '.repeat(8000),
    Array.from({ length: 101 }, (_, index) => `CAN-${index + 1}`).join(' '),
  ])(
    'lets the whole incomplete draft be dismissed without removing text',
    (text) => {
      const selection = selectHomeLink(text, [], null);
      expect(selection.kind).toBe('ambiguous');
      expect(selectHomeLink(text, selection.referenceKeys, null).kind).toBe(
        'none',
      );
      expect(
        selectHomeLink(`${text} changed`, selection.referenceKeys, null).kind,
      ).toBe('ambiguous');
    },
  );

  it('treats a PR plus its own repository as one target', () => {
    const selection = selectHomeLink(
      'see https://github.com/acme/app and https://github.com/acme/app/pull/7.',
      [],
      null,
    );
    expect(selection.kind).toBe('single');
    expect(selection.kind === 'single' && selection.key).toBe(
      'github.com/acme/app/pull/7',
    );
  });

  it('requires a choice among distinct links, honoring an explicit choice', () => {
    const text =
      'https://github.com/acme/app/pull/7 https://github.com/acme/other';
    expect(selectHomeLink(text, [], null).kind).toBe('ambiguous');
    const chosen = selectHomeLink(text, [], 'github.com/acme/other');
    expect(chosen.kind === 'single' && chosen.reference.kind).toBe(
      'repository',
    );
  });

  it('ignores dismissed references and prunes dismissals for removed links', () => {
    const text = 'https://github.com/acme/app/pull/7';
    expect(
      selectHomeLink(text, ['github.com/acme/app/pull/7'], null).kind,
    ).toBe('none');
    expect(
      pruneDismissedHomeLinkKeys(['github.com/acme/app/pull/7'], []),
    ).toEqual([]);
  });

  it('marks identifiers without a Linear URL as bare', () => {
    expect(single('look at CAN-12').kind === 'single').toBe(true);
    const bare = single('look at CAN-12');
    const linked = single('https://linear.app/acme/issue/CAN-12/title');
    expect(bare.kind === 'single' && bare.bareIdentifier).toBe(true);
    expect(linked.kind === 'single' && linked.bareIdentifier).toBe(false);
  });
});

describe('resolveHomeLink', () => {
  it('blocks creation when the capped cached listing cannot confirm the repository', async () => {
    const result = await resolveHomeLink(
      single('https://github.com/acme/new'),
      context({ projects: [chatsProject()] }),
      deps(),
    );
    expect(result.status).toBe('blocked');
  });

  it('does not duplicate a project with an unreadable origin in another context', async () => {
    const result = await resolveHomeLink(
      single('https://github.com/acme/new'),
      context({
        projects: [chatsProject()],
        otherScopeProjects: [repoProject('unknown', '/repos/no-origin')],
      }),
      deps(),
    );
    expect(result.status).toBe('blocked');
  });

  it('keeps a failed bare issue lookup actionable rather than ordinary chat', async () => {
    const result = await resolveHomeLink(
      single('CAN-1'),
      context(),
      deps({
        searchLinearIssues: jest
          .fn()
          .mockRejectedValue(
            new Error('Reconnect Linear to look up this issue.'),
          ),
      }),
    );
    expect(result.status).toBe('blocked');
  });

  it('offers every candidate rather than truncating the choice', async () => {
    const { ambiguousHomeLinkResolution } = await import('../homeLinkTarget');
    const selection = selectHomeLink(
      'https://github.com/o/a https://github.com/o/b https://github.com/o/c https://github.com/o/d',
      [],
      null,
    );
    if (selection.kind !== 'ambiguous') throw new Error('Expected ambiguity');
    const result = ambiguousHomeLinkResolution(selection);
    expect(result.status === 'blocked' && result.actions).toHaveLength(4);
  });
  it('previews an existing project case-insensitively with the PR head', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/ACME/app/pull/7'),
      context(),
      deps(),
    );
    expect(resolution).toEqual({
      status: 'ready',
      plan: {
        kind: 'existing-project',
        workspaceId: 'app',
        workspaceName: 'app',
        repoPath: '/repos/app',
        repositoryKey: 'github.com/acme/app',
        branchTarget: {
          kind: 'pr',
          number: 7,
          title: 'Fix',
          headRefName: 'fix/login',
          url: 'https://github.com/acme/app/pull/7',
        },
      },
    });
  });

  it('uses the default branch for a /tree/<ref> repository link', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/app/tree/release'),
      context(),
      deps(),
    );
    expect(
      resolution.status === 'ready' &&
        resolution.plan.kind === 'existing-project' &&
        resolution.plan.branchTarget,
    ).toEqual({ kind: 'new-worktree' });
  });

  it('blocks an explicitly selected project for another repository', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/app'),
      context({ workspaceId: 'other', workspaceSelectionExplicit: true }),
      deps(),
    );
    expect(resolution.status).toBe('blocked');
    expect(resolution.status === 'blocked' && resolution.actions).toEqual([
      { kind: 'use-project', workspaceId: 'app', label: 'Use app' },
    ]);
  });

  it('lets an inherited selection resolve to the matching project', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/app'),
      context({ workspaceId: 'other', workspaceSelectionExplicit: false }),
      deps(),
    );
    expect(resolution.status === 'ready' && resolution.plan.kind).toBe(
      'existing-project',
    );
  });

  it('asks which project when several match', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/app'),
      context({
        projects: [repoProject('app'), repoProject('copy', '/repos/app-copy')],
      }),
      deps(),
    );
    expect(resolution.status === 'blocked' && resolution.actions).toHaveLength(
      2,
    );
  });

  it('does not offer creation when a project origin is unreadable', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/new'),
      context({
        projects: [repoProject('mystery', '/repos/no-origin')],
      }),
      deps(),
    );
    expect(resolution.status).toBe('blocked');
  });

  it('requests a context switch for a project in another context', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/app'),
      context({
        projects: [chatsProject()],
        otherScopeProjects: [repoProject('app')],
      }),
      deps(),
    );
    expect(resolution.status === 'blocked' && resolution.message).toMatch(
      /another context/,
    );
  });

  it('plans a Personal project with a pending PR when none exists', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/new/pull/3'),
      context({ projects: [chatsProject()] }),
      deps({
        listUserGitHubRepos: jest.fn(() =>
          Promise.resolve([
            {
              fullName: 'acme/new',
              ownerLogin: 'acme',
              name: 'new',
              description: null,
              cloneUrl: 'https://github.com/acme/new.git',
              sshUrl: '',
              htmlUrl: '',
              isPrivate: true,
              isFork: false,
              isArchived: true,
              defaultBranch: 'main',
              updatedAt: null,
            },
          ]),
        ),
      }),
    );
    expect(resolution.status === 'ready' && resolution.plan).toEqual({
      kind: 'create-project',
      repository: {
        owner: 'acme',
        repo: 'new',
        repositoryKey: 'github.com/acme/new',
        cloneUrl: 'https://github.com/acme/new.git',
        isArchived: true,
      },
      pending: {
        kind: 'pr',
        number: 3,
        url: 'https://github.com/acme/new/pull/3',
      },
    });
    if (resolution.status === 'ready') {
      expect(describeHomeLinkPlan(resolution.plan).detail).toBe(
        'Adds acme/new as a Personal project (archived repository). Validates the PR after checkout before creating the worktree.',
      );
    }
  });

  it('blocks creation from an organization context', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/new'),
      context({ projects: [chatsProject()], canCreatePersonalProject: false }),
      deps(),
    );
    expect(resolution.status === 'blocked' && resolution.message).toMatch(
      /Switch to Personal/,
    );
  });

  it('distinguishes GitHub credential failures', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/new'),
      context({ projects: [chatsProject()] }),
      deps({
        listUserGitHubRepos: jest.fn(() =>
          Promise.reject(new Error('GitHub token is not configured')),
        ),
      }),
    );
    expect(
      resolution.status === 'blocked' &&
        resolution.actions.map((action) => action.kind),
    ).toEqual(['sign-in-github', 'retry']);
  });

  it('keeps Settings for a GitHub resource it cannot find', async () => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/new'),
      context({ projects: [chatsProject()] }),
      deps({
        listUserGitHubRepos: jest
          .fn()
          .mockRejectedValue(new Error('HTTP 404 Not Found')),
      }),
    );
    expect(
      resolution.status === 'blocked' &&
        resolution.actions.map((action) => action.kind),
    ).toEqual(['connect-github', 'retry']);
  });

  it.each([
    ['HTTP 404 Not Found', /not found or.*access/],
    ['HTTP 429 Too Many Requests', /rate limiting/],
    ['fetch failed', /Couldn’t reach GitHub/],
  ])('classifies the GitHub access failure %s', async (message, expected) => {
    const resolution = await resolveHomeLink(
      single('https://github.com/acme/new'),
      context({ projects: [chatsProject()] }),
      deps({
        listUserGitHubRepos: jest.fn().mockRejectedValue(new Error(message)),
      }),
    );
    expect(resolution.status === 'blocked' && resolution.message).toMatch(
      expected,
    );
  });

  describe('Linear issues', () => {
    it('routes a complete, unique PR attachment through the PR', async () => {
      const resolution = await resolveHomeLink(
        single('https://linear.app/acme/issue/CAN-1'),
        context(),
        deps({
          searchLinearIssues: jest.fn(() =>
            Promise.resolve([
              issue({
                attachments: [
                  { url: 'https://github.com/acme/app/pull/7' },
                  { url: 'https://github.com/acme/app' },
                ],
                attachmentsComplete: true,
              }),
            ]),
          ),
        }),
      );
      expect(
        resolution.status === 'ready' &&
          resolution.plan.kind === 'existing-project' &&
          resolution.plan.branchTarget.kind,
      ).toBe('pr');
    });

    it('does not carry an attachment choice into another Linear issue', async () => {
      const host = deps({
        searchLinearIssues: jest.fn((query: string) =>
          Promise.resolve([
            issue({
              identifier: query,
              attachmentsComplete: true,
              attachments: [
                { url: 'https://github.com/acme/app/pull/7' },
                { url: 'https://github.com/acme/app/pull/8' },
              ],
            }),
          ]),
        ),
      });
      const selected = context({
        chosenAttachmentKey: 'github.com/acme/app/pull/7',
        chosenAttachmentReferenceKey: 'linear:CAN-1',
      });
      expect(
        (await resolveHomeLink(single('CAN-1'), selected, host)).status,
      ).toBe('ready');
      expect(
        (await resolveHomeLink(single('CAN-2'), selected, host)).status,
      ).toBe('blocked');
    });

    it('uses the issue branch for a repository-only attachment', async () => {
      const resolution = await resolveHomeLink(
        single('CAN-1'),
        context(),
        deps({
          searchLinearIssues: jest.fn(() =>
            Promise.resolve([
              issue({
                attachments: [{ url: 'https://github.com/acme/app' }],
                attachmentsComplete: true,
              }),
            ]),
          ),
        }),
      );
      expect(
        resolution.status === 'ready' &&
          resolution.plan.kind === 'existing-project' &&
          resolution.plan.branchTarget,
      ).toEqual({
        kind: 'linear-issue',
        identifier: 'CAN-1',
        title: 'Login bug',
        branchName: 'aq/can-1-login-bug',
      });
    });

    it('never infers a repository from incomplete attachments or a lone project', async () => {
      const resolution = await resolveHomeLink(
        single('CAN-1'),
        context({ projects: [repoProject('app')], workspaceId: 'app' }),
        deps({
          searchLinearIssues: jest.fn(() =>
            Promise.resolve([
              issue({
                attachments: [{ url: 'https://github.com/acme/app' }],
                attachmentsComplete: false,
              }),
            ]),
          ),
        }),
      );
      expect(resolution.status === 'blocked' && resolution.actions).toEqual([
        { kind: 'choose-project' },
      ]);
    });

    it('accepts an explicit project choice without repository evidence', async () => {
      const resolution = await resolveHomeLink(
        single('CAN-1'),
        context({ workspaceId: 'other', workspaceSelectionExplicit: true }),
        deps({
          searchLinearIssues: jest.fn(() => Promise.resolve([issue()])),
        }),
      );
      expect(
        resolution.status === 'ready' &&
          resolution.plan.kind === 'existing-project' &&
          resolution.plan.workspaceId,
      ).toBe('other');
    });

    it('blocks conflicting repository attachments', async () => {
      const resolution = await resolveHomeLink(
        single('CAN-1'),
        context(),
        deps({
          searchLinearIssues: jest.fn(() =>
            Promise.resolve([
              issue({
                attachments: [
                  { url: 'https://github.com/acme/app' },
                  { url: 'https://github.com/acme/other' },
                ],
                attachmentsComplete: true,
              }),
            ]),
          ),
        }),
      );
      expect(resolution.status === 'blocked' && resolution.message).toMatch(
        /more than one repository/,
      );
    });

    it('requires an exact identifier match', async () => {
      const resolution = await resolveHomeLink(
        single('https://linear.app/acme/issue/CAN-1'),
        context(),
        deps({
          searchLinearIssues: jest.fn(() =>
            Promise.resolve([issue({ identifier: 'CAN-10' })]),
          ),
        }),
      );
      expect(resolution.status).toBe('blocked');
    });

    it('blocks an unknown bare identifier until its intent is dismissed', async () => {
      const resolution = await resolveHomeLink(
        single('upgrade to GPT-4'),
        context(),
        deps(),
      );
      expect(resolution.status).toBe('blocked');
    });
  });
});

describe('materializeHomeLinkPlan', () => {
  const createPlan: HomeLinkPlan = {
    kind: 'create-project',
    repository: {
      owner: 'acme',
      repo: 'new',
      repositoryKey: 'github.com/acme/new',
      cloneUrl: 'https://github.com/acme/new.git',
      isArchived: false,
    },
    pending: {
      kind: 'pr',
      number: 3,
      url: 'https://github.com/acme/new/pull/3',
    },
  };

  function materializeDeps(
    projects: SidebarItem[],
    overrides: Partial<HomeLinkMaterializeDeps> = {},
  ): HomeLinkMaterializeDeps {
    const slugs: Record<string, { owner: string; repo: string }> = {
      '/repos/new': { owner: 'acme', repo: 'new' },
    };
    return {
      ...deps({
        getRepoSlug: jest.fn((repoPath: string) =>
          Promise.resolve(slugs[repoPath] ?? SLUGS[repoPath] ?? null),
        ),
      }),
      getProjects: () => projects,
      canCreatePersonalProject: () => true,
      getDefaultCloneDirectory: jest.fn(() => Promise.resolve('/clones')),
      probeCloneDestination: jest.fn(() =>
        Promise.resolve({
          repoName: 'new',
          candidateExists: false,
          reusablePath: null,
        }),
      ),
      addLocalRepo: jest.fn(),
      addRemoteRepo: jest.fn(() => {
        projects.push(repoProject('new'));
        return Promise.resolve('new');
      }),
      listBranches: jest.fn(() => Promise.resolve([])),
      createJobId: () => 'job-1',
      ...overrides,
    };
  }

  it('cancels after registration without validating the PR or creating more resources', async () => {
    const controller = new AbortController();
    const projects = [chatsProject()];
    const host = materializeDeps(projects, {
      signal: controller.signal,
      addRemoteRepo: jest.fn(() => {
        projects.push(repoProject('new'));
        controller.abort();
        return Promise.resolve('new');
      }),
    });
    const result = await materializeHomeLinkPlan(createPlan, host);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/new remains available/);
    expect(host.resolvePullRequest).not.toHaveBeenCalled();
  });

  it('flags a clone that failed on GitHub credentials, keeping its message', async () => {
    const host = materializeDeps([chatsProject()], {
      addRemoteRepo: jest.fn(() =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'workspace:add-from-remote': GitHubAuthFailureError: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
          ),
        ),
      ),
    });
    expect(await materializeHomeLinkPlan(createPlan, host)).toEqual({
      ok: false,
      message:
        "Couldn’t add acme/new: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      retryable: true,
      githubAuthFailure: true,
    });
  });

  it('does not flag an ordinary clone failure', async () => {
    const host = materializeDeps([chatsProject()], {
      addRemoteRepo: jest.fn(() =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'workspace:add-from-remote': Error: fatal: could not read Username for 'git@github.com'",
          ),
        ),
      ),
    });
    const result = await materializeHomeLinkPlan(createPlan, host);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('githubAuthFailure');
  });

  it('blocks a matching project that appears in another context during the probe', async () => {
    const elsewhere: SidebarItem[] = [];
    const host = materializeDeps([chatsProject()], {
      getOtherScopeProjects: () => elsewhere,
      probeCloneDestination: jest.fn(() => {
        elsewhere.push(repoProject('new'));
        return Promise.resolve({
          repoName: 'new',
          candidateExists: true,
          reusablePath: '/repos/new',
        });
      }),
    });
    const result = await materializeHomeLinkPlan(createPlan, host);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/other context/);
    expect(host.addLocalRepo).not.toHaveBeenCalled();
    expect(host.addRemoteRepo).not.toHaveBeenCalled();
  });

  it('rechecks registration after the probe and reuses a project that appeared', async () => {
    const projects = [chatsProject()];
    const host = materializeDeps(projects, {
      probeCloneDestination: jest.fn(() => {
        projects.push(repoProject('new'));
        return Promise.resolve({
          repoName: 'new',
          candidateExists: true,
          reusablePath: '/repos/new',
        });
      }),
    });
    expect((await materializeHomeLinkPlan(createPlan, host)).ok).toBe(true);
    expect(host.addLocalRepo).not.toHaveBeenCalled();
    expect(host.addRemoteRepo).not.toHaveBeenCalled();
  });

  it('revalidates an existing PR and uses its current head', async () => {
    const projects = [repoProject('app')];
    const host = materializeDeps(projects, {
      resolvePullRequest: jest.fn().mockResolvedValue({
        number: 7,
        headRefName: 'new-head',
        title: 'Fix',
        url: 'https://github.com/acme/app/pull/7',
      }),
    });
    const result = await materializeHomeLinkPlan(
      {
        kind: 'existing-project',
        workspaceId: 'app',
        workspaceName: 'app',
        repoPath: '/repos/app',
        repositoryKey: 'github.com/acme/app',
        branchTarget: {
          kind: 'pr',
          number: 7,
          title: 'Fix',
          headRefName: 'old-head',
          url: 'https://github.com/acme/app/pull/7',
        },
      },
      host,
    );
    expect(result.ok && result.branchTarget).toMatchObject({
      headRefName: 'new-head',
    });
  });

  it('blocks an existing project whose repository identity changed', async () => {
    const host = materializeDeps([repoProject('app')], {
      getRepoSlug: jest
        .fn()
        .mockResolvedValue({ owner: 'acme', repo: 'other' }),
    });
    const result = await materializeHomeLinkPlan(
      {
        kind: 'existing-project',
        workspaceId: 'app',
        workspaceName: 'app',
        repoPath: '/repos/app',
        repositoryKey: 'github.com/acme/app',
        branchTarget: { kind: 'new-worktree' },
      },
      host,
    );
    expect(result.ok).toBe(false);
  });

  it('clones, then resolves the pending PR in the new project', async () => {
    const projects = [chatsProject()];
    const hostDeps = materializeDeps(projects);
    await expect(
      materializeHomeLinkPlan(createPlan, hostDeps),
    ).resolves.toMatchObject({
      ok: true,
      workspaceId: 'new',
      branchTarget: { kind: 'pr' },
    });
    expect(hostDeps.addRemoteRepo).toHaveBeenCalledWith(
      'https://github.com/acme/new.git',
      '/clones',
      'job-1',
    );
  });

  it('registers a validated reusable checkout instead of cloning', async () => {
    const projects = [chatsProject()];
    const hostDeps = materializeDeps(projects, {
      probeCloneDestination: jest.fn(() =>
        Promise.resolve({
          repoName: 'new',
          candidateExists: true,
          reusablePath: '/repos/new',
        }),
      ),
      addLocalRepo: jest.fn(() => {
        projects.push(repoProject('new'));
        return Promise.resolve('new');
      }),
    });
    const result = await materializeHomeLinkPlan(createPlan, hostDeps);
    expect(result.ok).toBe(true);
    expect(hostDeps.addLocalRepo).toHaveBeenCalledWith('/repos/new');
    expect(hostDeps.addRemoteRepo).not.toHaveBeenCalled();
  });

  it('reuses a project registered since the preview', async () => {
    const hostDeps = materializeDeps([repoProject('new')]);
    const result = await materializeHomeLinkPlan(createPlan, hostDeps);
    expect(result.ok && result.workspaceId).toBe('new');
    expect(hostDeps.addRemoteRepo).not.toHaveBeenCalled();
  });

  it('reports partial success when the PR fails after cloning', async () => {
    const projects = [chatsProject()];
    const hostDeps = materializeDeps(projects, {
      resolvePullRequest: jest.fn(() =>
        Promise.reject(new Error('Fork pull requests are not supported.')),
      ),
    });
    const result = await materializeHomeLinkPlan(createPlan, hostDeps);
    expect(result).toEqual({
      ok: false,
      message:
        'Added new as a project, but couldn’t open PR #3: Fork pull requests are not supported.',
      retryable: true,
    });
    // The registered project stays for the retry to reuse.
    expect(projects.map((project) => project.id)).toContain('new');
  });

  it('refuses a duplicate submission for the same repository', async () => {
    let finishClone: (id: string) => void = () => undefined;
    const projects = [chatsProject()];
    const hostDeps = materializeDeps(projects, {
      addRemoteRepo: jest.fn(
        () =>
          new Promise<string>((resolve) => {
            finishClone = (id): void => {
              projects.push(repoProject('new'));
              resolve(id);
            };
          }),
      ),
    });
    const first = materializeHomeLinkPlan(createPlan, hostDeps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      materializeHomeLinkPlan(createPlan, hostDeps),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        message: 'acme/new is already being added.',
      }),
    );
    finishClone('new');
    await expect(first).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it('fails an existing-project plan whose project disappeared', async () => {
    const result = await materializeHomeLinkPlan(
      {
        kind: 'existing-project',
        workspaceId: 'gone',
        workspaceName: 'Gone',
        branchTarget: { kind: 'new-worktree' },
      },
      materializeDeps([chatsProject()]),
    );
    expect(result.ok).toBe(false);
  });
});
