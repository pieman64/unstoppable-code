/* eslint-disable @typescript-eslint/no-require-imports */
import type {
  CanopyJsonFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';

jest.mock('../lib/canopy-json', () => ({
  getCanopyJsonPath: jest.fn((repoPath: string) => `${repoPath}/canopy.json`),
  hasManifestRepos: jest.fn(() => false),
  readCanopyJson: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
}));
jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn(),
}));

import { hasManifestRepos, readCanopyJson } from '../lib/canopy-json';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { computeWorkspaceDriftIssues } from '../lib/workspace-drift';
import { readWorkspaceConfig } from '../lib/workspace-persistence';

const mockedHasManifestRepos = jest.mocked(hasManifestRepos);
const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedResolveProjectReferenceRepoPath = jest.mocked(
  resolveProjectReferenceRepoPath,
);

function createSingleRepoConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: '/repos/tracked-worktree',
    repos: [],
    alwaysShow: true,
    ...overrides,
  };
}

/**
 * Re-import the module under a substituted brand so the assertions below prove
 * the copy is derived from the brand runtime rather than matching the default
 * brand's display name by coincidence.
 */
async function importWithBrand(displayName: string): Promise<{
  computeWorkspaceDriftIssues: typeof computeWorkspaceDriftIssues;
}> {
  return new Promise((resolve) => {
    jest.isolateModules(() => {
      jest.doMock('@canopy/brand/current', () => {
        const actual = jest.requireActual<{ BRAND: Record<string, unknown> }>(
          '@canopy/brand/current',
        );
        return {
          __esModule: true,
          BRAND: { ...actual.BRAND, displayName },
        };
      });
      const mod = require('../lib/workspace-drift') as {
        computeWorkspaceDriftIssues: typeof computeWorkspaceDriftIssues;
      };
      jest.dontMock('@canopy/brand/current');
      resolve(mod);
    });
  });
}

describe('computeWorkspaceDriftIssues', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the canonical reference repo path for single-repo projects', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/repos/source');
    mockedReadCanopyJson.mockResolvedValue(null);

    const result = await computeWorkspaceDriftIssues('workspace-1');

    expect(mockedResolveProjectReferenceRepoPath).toHaveBeenCalledWith(
      '/repos/tracked-worktree',
    );
    expect(mockedReadCanopyJson).toHaveBeenCalledWith('/repos/source');
    expect(result.targetRepoPath).toBe('/repos/source');
    expect(result.targetCanopyJsonPath).toBe('/repos/source/canopy.json');
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'missing-canopy-json',
        blocking: false,
      }),
    ]);
  });

  // Every drift message names the running product, so all of them must read the
  // active brand rather than the legacy `Canopy` literal.
  it('names the active brand in the repo URL mismatch issue', async () => {
    const manifest: CanopyJsonFile = {
      version: 1,
      repos: [{ id: 'api', name: 'API', url: 'https://example.test/new.git' }],
    };
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'api',
          name: 'API',
          repoPath: '/repos/api',
          source: 'manifest',
          manifestUrl: 'https://example.test/old.git',
        },
      ],
      alwaysShow: true,
    });
    mockedHasManifestRepos.mockReturnValue(true);
    mockedReadCanopyJson.mockResolvedValue(manifest);

    const { computeWorkspaceDriftIssues: computeWithBrand } =
      await importWithBrand('Acme Code');
    const result = await computeWithBrand('workspace-1', 'worktree-1');

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'manifest-repo-url-mismatch',
        message:
          'Repo "api" has a different URL in canopy.json than in Acme Code tracking.',
      }),
    ]);
  });
});
