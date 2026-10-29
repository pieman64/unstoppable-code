import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';

jest.mock('../lib/canopy-json', () => ({
  hasManifestRepos: jest.fn((manifest: { repos?: unknown[] } | null) =>
    Array.isArray(manifest?.repos),
  ),
  readCanopyJson: jest.fn(),
}));
jest.mock('../lib/workspace-drift', () => ({
  computeWorkspaceDriftIssues: jest.fn(() =>
    Promise.resolve({
      issues: [],
      targetRepoPath: '/mock/source',
      targetCanopyJsonPath: '/mock/source/canopy.json',
    }),
  ),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: jest.fn((repoPath: string) =>
    Promise.resolve(repoPath),
  ),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn((sourceRepoPath: string) =>
    Promise.resolve(sourceRepoPath),
  ),
}));
jest.mock('../lib/workspace-reference-repo-poller', () => ({
  getCachedStatus: jest.fn(() => null),
  requestRefresh: jest.fn(() => Promise.resolve()),
}));

import { readCanopyJson } from '../lib/canopy-json';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import {
  readEffectiveWorkspaceConfig,
  readWorkspaceSettingsData,
} from '../lib/workspace-source';

const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedResolveProjectReferenceRepoPath = jest.mocked(
  resolveProjectReferenceRepoPath,
);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);

function createWorkspaceConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: '/mock/source',
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/mock/repo-a',
        source: 'manifest',
        manifestUrl: 'https://example.com/repo-a.git',
      },
    ],
    ...overrides,
  };
}

function createSingleRepoConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: '/mock/tracked-worktree',
    repos: [],
    alwaysShow: true,
    ...overrides,
  };
}

describe('workspace-source', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps manifest repos classified as manifest', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://example.com/repo-a.git',
        },
      ],
    });

    const result = await readEffectiveWorkspaceConfig('workspace-1');

    expect(result.repos).toEqual([
      expect.objectContaining({
        id: 'repo-a',
        source: 'manifest',
        manifestUrl: 'https://example.com/repo-a.git',
      }),
    ]);
  });

  it('downgrades repos missing from canopy.json to local even if persisted as manifest', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [],
    });

    const result = await readEffectiveWorkspaceConfig('workspace-1');

    expect(result.repos).toEqual([
      expect.objectContaining({
        id: 'repo-a',
        source: 'local',
      }),
    ]);
  });

  it('loads single-repo settings data from the canonical reference repo path', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/mock/source');
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      scripts: {
        setup: 'npm install',
      },
    });

    const result = await readWorkspaceSettingsData('workspace-1');

    expect(result.referenceRepoPath).toBe('/mock/source');
    expect(result.manifest).toEqual({
      version: 1,
      scripts: {
        setup: 'npm install',
      },
    });
    expect(mockedReadCanopyJson).toHaveBeenCalledWith('/mock/source');
  });

  it('keeps manifest null when the canonical canopy.json is missing', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/mock/source');
    mockedReadCanopyJson.mockResolvedValue(null);

    const result = await readWorkspaceSettingsData('workspace-1');

    expect(result.referenceRepoPath).toBe('/mock/source');
    expect(result.manifest).toBeNull();
  });

  it('rejects single-repo settings data when the canonical canopy.json is invalid', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/mock/source');
    mockedReadCanopyJson.mockRejectedValue(new Error('canopy.json is invalid'));

    await expect(readWorkspaceSettingsData('workspace-1')).rejects.toThrow(
      'canopy.json is invalid',
    );
  });
});
