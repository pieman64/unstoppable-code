import type * as ScriptResolver from '../lib/script-resolver';
import type { ResolvedScriptMap } from '../lib/script-resolver';

const mockGetWorkspaceType = jest.fn<string | null, [string]>(
  () => 'single-repo',
);
const mockReadAllSidebarItems = jest.fn(() =>
  Promise.resolve({
    items: [
      {
        type: 'single-repo',
        id: 'project',
        name: 'Project',
        repoPath: '/repos/project',
        scripts: { launch: 'npm run dev' },
      },
    ],
  }),
);
const mockResolveProjectScripts = jest.fn<
  Promise<ResolvedScriptMap>,
  [unknown, string | undefined]
>(() =>
  Promise.resolve({
    setup: {
      definition: { command: 'npm ci && npm run build:deps' },
      source: 'repo-canopy',
    },
  }),
);
const mockResolveWorkspaceRepoScripts = jest.fn<
  Promise<ResolvedScriptMap>,
  [string, string, unknown]
>(() =>
  Promise.resolve({
    setup: { definition: { command: 'pnpm install' }, source: 'repo-canopy' },
  }),
);
const mockResolveWorkspaceRootScripts = jest.fn<
  Promise<ResolvedScriptMap>,
  [string, unknown]
>(() =>
  Promise.resolve({
    'before-setup': {
      definition: { command: './scripts/bootstrap.sh' },
      source: 'workspace-hook',
    },
    'after-setup': {
      definition: { command: './scripts/link.sh' },
      source: 'workspace-hook',
    },
  }),
);

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: (id: string): string | null => mockGetWorkspaceType(id),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): ReturnType<typeof mockReadAllSidebarItems> =>
    mockReadAllSidebarItems(),
}));
jest.mock('../lib/script-resolver', () => ({
  ...jest.requireActual<typeof ScriptResolver>('../lib/script-resolver'),
  resolveProjectScripts: (
    project: unknown,
    repoPathOverride?: string,
  ): Promise<ResolvedScriptMap> =>
    mockResolveProjectScripts(project, repoPathOverride),
  resolveWorkspaceRepoScripts: (
    workspaceId: string,
    repoId: string,
    paths: unknown,
  ): Promise<ResolvedScriptMap> =>
    mockResolveWorkspaceRepoScripts(workspaceId, repoId, paths),
  resolveWorkspaceRootScripts: (
    workspaceId: string,
    paths: unknown,
  ): Promise<ResolvedScriptMap> =>
    mockResolveWorkspaceRootScripts(workspaceId, paths),
}));

import { resolveIsolatedDelegationSetupHint } from '../agents/delegation/setup-hint';

beforeEach(() => {
  mockGetWorkspaceType.mockReset().mockReturnValue('single-repo');
  mockReadAllSidebarItems.mockClear();
  mockResolveProjectScripts.mockClear();
  mockResolveWorkspaceRepoScripts.mockClear();
  mockResolveWorkspaceRootScripts.mockClear();
});

describe('isolated delegation setup hint', () => {
  it('reads the setup script from the delegate checkout with the project overrides and tells Claude to start it in the background', async () => {
    const hint = await resolveIsolatedDelegationSetupHint({
      projectId: 'project',
      delegateCwd: '/data/delegation/worktrees/child',
      harness: 'claude',
    });
    expect(mockResolveProjectScripts).toHaveBeenCalledWith(
      { repoPath: '/repos/project', scripts: { launch: 'npm run dev' } },
      '/data/delegation/worktrees/child',
    );
    expect(hint).toContain('npm ci && npm run build:deps');
    expect(hint).toContain('setup script has not run');
    expect(hint).toContain("parent's uncommitted changes are not included");
    // Claude-managed background tasks are allowed; shell detachment is not.
    expect(hint).toContain('run_in_background: true');
    expect(hint).toContain('output file');
    expect(hint).not.toMatch(/foreground|nohup|TaskOutput/);
  });

  it('gives Codex delegates sandbox-aware guidance with a pollable exec session', async () => {
    const hint = await resolveIsolatedDelegationSetupHint({
      projectId: 'project',
      delegateCwd: '/data/delegation/worktrees/child',
      harness: 'codex',
    });
    expect(hint).toContain('npm ci && npm run build:deps');
    expect(hint).toContain('exec_command');
    expect(hint).toContain('write_stdin');
    expect(hint).toContain('network');
    expect(hint).not.toContain('Bash');
  });

  it('returns nothing when no setup script is configured', async () => {
    mockResolveProjectScripts.mockResolvedValueOnce({
      launch: { definition: { command: 'npm run dev' }, source: 'repo-canopy' },
      setup: { source: 'local-disabled' },
    });
    await expect(
      resolveIsolatedDelegationSetupHint({
        projectId: 'project',
        delegateCwd: '/data/delegation/worktrees/child',
        harness: 'claude',
      }),
    ).resolves.toBeUndefined();
  });

  it('uses the selected child repository setup script in a multi-repo project', async () => {
    mockGetWorkspaceType.mockReturnValue('multi-repo');
    const hint = await resolveIsolatedDelegationSetupHint({
      projectId: 'workspace',
      selectedRepoId: 'api',
      delegateCwd: '/data/delegation/worktrees/child',
      harness: 'claude',
    });
    expect(mockResolveWorkspaceRepoScripts).toHaveBeenCalledWith(
      'workspace',
      'api',
      { repoPath: '/data/delegation/worktrees/child' },
    );
    expect(hint).toContain('pnpm install');
    expect(mockReadAllSidebarItems).not.toHaveBeenCalled();
  });

  it('lists the workspace-root setup hooks in order for a root checkout', async () => {
    mockGetWorkspaceType.mockReturnValue('multi-repo');
    const hint = await resolveIsolatedDelegationSetupHint({
      projectId: 'workspace',
      delegateCwd: '/data/delegation/worktrees/child',
      harness: 'claude',
    });
    expect(mockResolveWorkspaceRootScripts).toHaveBeenCalledWith('workspace', {
      workspaceRootPath: '/data/delegation/worktrees/child',
    });
    const before = hint?.indexOf('./scripts/bootstrap.sh') ?? -1;
    const after = hint?.indexOf('./scripts/link.sh') ?? -1;
    expect(before).toBeGreaterThanOrEqual(0);
    expect(after).toBeGreaterThan(before);
  });

  it('flags an interactive setup script instead of implying it can run unattended', async () => {
    mockResolveProjectScripts.mockResolvedValueOnce({
      setup: {
        definition: { command: './setup.sh', interactive: true },
        source: 'repo-canopy',
      },
    });
    const hint = await resolveIsolatedDelegationSetupHint({
      projectId: 'project',
      delegateCwd: '/data/delegation/worktrees/child',
      harness: 'claude',
    });
    expect(hint).toContain('./setup.sh');
    expect(hint).toContain('interactive');
  });

  it('bounds an oversized setup command', async () => {
    mockResolveProjectScripts.mockResolvedValueOnce({
      setup: {
        definition: { command: `echo ${'x'.repeat(10_000)}` },
        source: 'repo-canopy',
      },
    });
    const hint = await resolveIsolatedDelegationSetupHint({
      projectId: 'project',
      delegateCwd: '/data/delegation/worktrees/child',
      harness: 'claude',
    });
    expect(hint?.length ?? 0).toBeLessThan(6_000);
    expect(hint).toContain('truncated');
  });

  it.each([
    ['cowork', 'cowork'],
    ['unregistered', null],
  ])(
    'returns nothing for a %s workspace',
    async (_label, workspaceType: string | null) => {
      mockGetWorkspaceType.mockReturnValue(workspaceType);
      await expect(
        resolveIsolatedDelegationSetupHint({
          projectId: 'project',
          delegateCwd: '/data/delegation/worktrees/child',
          harness: 'claude',
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('never blocks launch when script configuration cannot be read', async () => {
    mockResolveProjectScripts.mockRejectedValueOnce(
      new Error('invalid canopy.json'),
    );
    await expect(
      resolveIsolatedDelegationSetupHint({
        projectId: 'project',
        delegateCwd: '/data/delegation/worktrees/child',
        harness: 'claude',
      }),
    ).resolves.toBeUndefined();
  });
});
