import type * as CodeGraphEagerSeedModule from '../lib/code-graph-eager-seed';
import type { fingerprintCustomLanguageInputs } from '@canopy/code-graph/languages/custom-config';
import type { runCodeGraphWorkerEagerSeed } from '../code-graph/build-runner';
import type { withCodeGraphBaseVariantLeases } from '../lib/code-graph-base-store';
import type { readWorkspaceConfig } from '../lib/workspace-persistence';
import type { resolveWorktreeCodeGraphRepositories } from '../lib/worktree-repo-entries';

const mockRunCodeGraphWorkerEagerSeed: jest.MockedFunction<
  typeof runCodeGraphWorkerEagerSeed
> = jest.fn();
const mockWithCodeGraphBaseVariantLeases: jest.MockedFunction<
  typeof withCodeGraphBaseVariantLeases
> = jest.fn();
const mockFingerprintCustomLanguageInputs: jest.MockedFunction<
  typeof fingerprintCustomLanguageInputs
> = jest.fn();
const mockReadWorkspaceConfig: jest.MockedFunction<typeof readWorkspaceConfig> =
  jest.fn();
const mockResolveWorktreeCodeGraphRepositories: jest.MockedFunction<
  typeof resolveWorktreeCodeGraphRepositories
> = jest.fn();
const mockIsCodeGraphAvailableForWorkspace = jest.fn();
const mockIsE2eBuild = jest.fn();
const mockResolveWorktreeCwd = jest.fn();

jest.mock('../code-graph/build-runner', () => ({
  get runCodeGraphWorkerEagerSeed(): typeof mockRunCodeGraphWorkerEagerSeed {
    return mockRunCodeGraphWorkerEagerSeed;
  },
}));
jest.mock('../lib/code-graph-base-store', () => ({
  get withCodeGraphBaseVariantLeases(): typeof mockWithCodeGraphBaseVariantLeases {
    return mockWithCodeGraphBaseVariantLeases;
  },
}));
jest.mock('@canopy/code-graph/languages/custom-config', () => ({
  fingerprintCustomLanguageInputs: mockFingerprintCustomLanguageInputs,
}));
jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: (
    workspaceId: string,
    worktreeId: string,
  ): string => `/data/${workspaceId}/${worktreeId}/graph.db`,
}));
jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: (...args: unknown[]): boolean =>
    Boolean(mockIsCodeGraphAvailableForWorkspace(...args)),
}));
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => Boolean(mockIsE2eBuild()),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (...args: unknown[]): string =>
    String(mockResolveWorktreeCwd(...args)),
}));
jest.mock('../lib/workspace-persistence', () => ({
  get readWorkspaceConfig(): typeof mockReadWorkspaceConfig {
    return mockReadWorkspaceConfig;
  },
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  get resolveWorktreeCodeGraphRepositories(): typeof mockResolveWorktreeCodeGraphRepositories {
    return mockResolveWorktreeCodeGraphRepositories;
  },
}));

const { eagerSeedNewWorktreeCodeGraph } = jest.requireActual<
  typeof CodeGraphEagerSeedModule
>('../lib/code-graph-eager-seed');

describe('eagerSeedNewWorktreeCodeGraph', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCodeGraphAvailableForWorkspace.mockReturnValue(true);
    mockIsE2eBuild.mockReturnValue(false);
    mockResolveWorktreeCwd.mockReturnValue('/worktrees/ws/new');
    mockResolveWorktreeCodeGraphRepositories.mockResolvedValue([
      { repoId: '__workspace_root__', rootPath: '/worktrees/ws/new' },
    ]);
    mockReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/source',
      repos: [],
    });
    mockFingerprintCustomLanguageInputs.mockResolvedValue({
      value: 'fingerprint',
      configPresent: false,
    });
    mockRunCodeGraphWorkerEagerSeed.mockResolvedValue({
      ok: true,
      status: 'seeded',
      source: 'workspace-shadow',
      durationMs: 10,
    });
    mockWithCodeGraphBaseVariantLeases.mockImplementation(async (inputs, fn) =>
      fn(
        inputs.map((input) => ({
          variantDir: `/bases/${input.repoId}`,
          identity: {
            repoId: input.repoId,
            canonicalRepoRoot: input.canonicalRepoPath,
            customLanguagesFingerprint: input.customLanguagesFingerprint,
          },
          destinationRootPath: input.destinationRootPath,
        })),
      ),
    );
  });

  it('prefers a copy-on-write shadow base for an explicit base worktree', async () => {
    await expect(
      eagerSeedNewWorktreeCodeGraph({
        workspaceId: 'ws',
        worktreeId: 'new',
        baseWorktreeId: 'base',
      }),
    ).resolves.toEqual({ status: 'seeded', source: 'workspace-shadow' });

    expect(mockRunCodeGraphWorkerEagerSeed).toHaveBeenCalledWith(
      'ws/new',
      expect.objectContaining({
        operation: 'eager-seed',
        targetDbPath: '/data/ws/new/graph.db',
      }),
      expect.objectContaining({
        priority: 'worktree',
        metadata: {
          scope: 'worktree',
          workspaceIds: ['ws'],
          worktreeId: 'new',
          label: 'new',
          trigger: 'worktree-eager-seed',
        },
      }),
    );
    expect(mockRunCodeGraphWorkerEagerSeed.mock.calls[0]?.[1].source.kind).toBe(
      'workspace-shadow',
    );
    expect(mockWithCodeGraphBaseVariantLeases).toHaveBeenCalled();
  });

  it('holds immutable-base leases while the utility worker seeds', async () => {
    await expect(
      eagerSeedNewWorktreeCodeGraph({
        workspaceId: 'ws',
        worktreeId: 'new',
      }),
    ).resolves.toEqual({ status: 'seeded', source: 'workspace-shadow' });

    expect(mockWithCodeGraphBaseVariantLeases).toHaveBeenCalledWith(
      [
        {
          canonicalRepoPath: '/repos/source',
          repoId: '__workspace_root__',
          customLanguagesFingerprint: 'fingerprint',
          destinationRootPath: '/worktrees/ws/new',
        },
      ],
      expect.any(Function),
    );
    expect(mockRunCodeGraphWorkerEagerSeed).toHaveBeenCalledWith(
      'ws/new',
      expect.objectContaining({
        operation: 'eager-seed',
        source: {
          kind: 'workspace-shadow',
          bases: [
            expect.objectContaining({
              variantDir: '/bases/__workspace_root__',
            }),
          ],
        },
      }),
      expect.any(Object),
    );
  });

  it('does not dispatch a partial multi-repository seed', async () => {
    mockResolveWorktreeCodeGraphRepositories.mockResolvedValue([
      { repoId: 'repo-a', rootPath: '/worktrees/ws/new/repos/a' },
      { repoId: 'repo-b', rootPath: '/worktrees/ws/new/repos/b' },
    ]);
    mockReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'repo-a', name: 'A', repoPath: '/repos/a' }],
    });

    await expect(
      eagerSeedNewWorktreeCodeGraph({
        workspaceId: 'ws',
        worktreeId: 'new',
      }),
    ).resolves.toEqual({ status: 'no-compatible-source' });
    expect(mockWithCodeGraphBaseVariantLeases).not.toHaveBeenCalled();
    expect(mockRunCodeGraphWorkerEagerSeed).not.toHaveBeenCalled();
  });

  it('falls back to an explicit live base when no shadow graph exists', async () => {
    mockRunCodeGraphWorkerEagerSeed
      .mockResolvedValueOnce({
        ok: true,
        status: 'no-compatible-source',
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 'seeded',
        source: 'base-worktree',
        durationMs: 8,
      });

    await expect(
      eagerSeedNewWorktreeCodeGraph({
        workspaceId: 'ws',
        worktreeId: 'new',
        baseWorktreeId: 'base',
      }),
    ).resolves.toEqual({ status: 'seeded', source: 'base-worktree' });
    expect(mockRunCodeGraphWorkerEagerSeed).toHaveBeenCalledTimes(2);
    expect(mockRunCodeGraphWorkerEagerSeed).toHaveBeenLastCalledWith(
      'ws/new',
      expect.objectContaining({
        source: {
          kind: 'base-worktree',
          dbPath: '/data/ws/base/graph.db',
        },
      }),
      expect.any(Object),
    );
  });

  it('falls back to an explicit live base when shadow seeding fails', async () => {
    mockRunCodeGraphWorkerEagerSeed
      .mockRejectedValueOnce(new Error('shadow graph disappeared'))
      .mockResolvedValueOnce({
        ok: true,
        status: 'seeded',
        source: 'base-worktree',
        durationMs: 8,
      });

    await expect(
      eagerSeedNewWorktreeCodeGraph({
        workspaceId: 'ws',
        worktreeId: 'new',
        baseWorktreeId: 'base',
      }),
    ).resolves.toEqual({ status: 'seeded', source: 'base-worktree' });
    expect(mockRunCodeGraphWorkerEagerSeed).toHaveBeenCalledTimes(2);
  });

  it('stays disabled in E2E builds', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    await expect(
      eagerSeedNewWorktreeCodeGraph({
        workspaceId: 'ws',
        worktreeId: 'new',
      }),
    ).resolves.toEqual({ status: 'disabled' });
    expect(mockRunCodeGraphWorkerEagerSeed).not.toHaveBeenCalled();
  });
});
