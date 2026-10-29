import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';

jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
  getProjectConfigFileCandidates: (repoPath: string): string[] => [
    `${repoPath}/canopy.json`,
  ],
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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCanopyJson } from '../lib/canopy-json';
import {
  getApprovalSettingsRevision,
  getWorkspaceApprovalRulesRevision,
} from '../approvals/rule-revisions';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import {
  readWorkspaceApprovalsManifest,
  stopWorkspaceApprovalsManifestWatchers,
} from '../lib/workspace-approvals-manifest';

const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedResolveProjectReferenceRepoPath = jest.mocked(
  resolveProjectReferenceRepoPath,
);
const mockedResolveWorkspaceReferenceRepoPath = jest.mocked(
  resolveWorkspaceReferenceRepoPath,
);

function createSingleRepoConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: '/mock/repo',
    repos: [],
    alwaysShow: true,
    ...overrides,
  };
}

function createMultiRepoConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    repos: [],
    alwaysShow: true,
    ...overrides,
  };
}

function createCoworkConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'cowork',
    repos: [],
    alwaysShow: true,
    ...overrides,
  };
}

describe('readWorkspaceApprovalsManifest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    stopWorkspaceApprovalsManifestWatchers();
  });

  it("changes the approval settings revision when a read sees the manifest's default mode change", async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      approvals: { defaultMode: 'ask' },
    });
    await readWorkspaceApprovalsManifest('observed');
    const settings = getApprovalSettingsRevision();
    const rules = getWorkspaceApprovalRulesRevision('observed');

    await readWorkspaceApprovalsManifest('observed');
    expect(getApprovalSettingsRevision()).toBe(settings);

    mockedReadCanopyJson.mockResolvedValue({ version: 1 });
    await expect(readWorkspaceApprovalsManifest('observed')).resolves.toEqual({
      rules: [],
    });
    expect(getApprovalSettingsRevision()).toBe(settings + 1);
    expect(getWorkspaceApprovalRulesRevision('observed')).toBe(rules + 1);
  });

  it('changes the approval settings revision when the watched manifest file is edited', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'canopy-approvals-manifest-'));
    try {
      mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
      mockedResolveProjectReferenceRepoPath.mockResolvedValue(repoRoot);
      mockedReadCanopyJson.mockResolvedValue({
        version: 1,
        approvals: { defaultMode: 'ask' },
      });
      await readWorkspaceApprovalsManifest('watched');
      const before = getApprovalSettingsRevision();

      writeFileSync(
        join(repoRoot, 'canopy.json'),
        JSON.stringify({ version: 1 }),
      );
      for (
        let attempt = 0;
        attempt < 500 && getApprovalSettingsRevision() === before;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }

      expect(getApprovalSettingsRevision()).toBeGreaterThan(before);
    } finally {
      stopWorkspaceApprovalsManifestWatchers();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('resolves the approvals block for a single-repo project', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/resolved/repo');
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      approvals: {
        defaultMode: 'auto',
        rules: [
          {
            id: 'rule-1',
            behavior: 'deny',
            target: { kind: 'command', pattern: 'rm -rf *' },
            createdAt: '2026-01-01T00:00:00.000Z',
            origin: 'canopy-json',
          },
        ],
      },
    });

    const result = await readWorkspaceApprovalsManifest('workspace-1');

    expect(mockedResolveProjectReferenceRepoPath).toHaveBeenCalledWith(
      '/mock/repo',
    );
    expect(mockedReadCanopyJson).toHaveBeenCalledWith('/resolved/repo');
    expect(result).toEqual({
      defaultMode: 'auto',
      rules: [expect.objectContaining({ id: 'rule-1', origin: 'canopy-json' })],
    });
  });

  it('resolves the approvals block for a source-backed multi-repo project', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createMultiRepoConfig({ sourceRepoPath: '/mock/source' }),
    );
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue(
      '/resolved/source',
    );
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      approvals: { defaultMode: 'ask' },
    });

    const result = await readWorkspaceApprovalsManifest('workspace-1');

    expect(mockedResolveWorkspaceReferenceRepoPath).toHaveBeenCalledWith(
      '/mock/source',
    );
    expect(result).toEqual({ defaultMode: 'ask', rules: [] });
  });

  it('returns an empty manifest for a multi-repo project with no sourceRepoPath', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createMultiRepoConfig());

    const result = await readWorkspaceApprovalsManifest('workspace-1');

    expect(mockedReadCanopyJson).not.toHaveBeenCalled();
    expect(result).toEqual({ rules: [] });
  });

  it('returns an empty manifest for a cowork project', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createCoworkConfig());

    const result = await readWorkspaceApprovalsManifest('workspace-1');

    expect(mockedReadCanopyJson).not.toHaveBeenCalled();
    expect(result).toEqual({ rules: [] });
  });

  it('returns an empty manifest when there is no approvals block', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/resolved/repo');
    mockedReadCanopyJson.mockResolvedValue({ version: 1 });

    const result = await readWorkspaceApprovalsManifest('workspace-1');

    expect(result).toEqual({ rules: [] });
  });

  it('returns an empty manifest when there is no canopy.json at all', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/resolved/repo');
    mockedReadCanopyJson.mockResolvedValue(null);

    const result = await readWorkspaceApprovalsManifest('workspace-1');

    expect(result).toEqual({ rules: [] });
  });

  it('returns an empty manifest when the manifest is invalid and readCanopyJson throws', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(createSingleRepoConfig());
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/resolved/repo');
    mockedReadCanopyJson.mockRejectedValue(new Error('canopy.json is invalid'));

    const result = await readWorkspaceApprovalsManifest('workspace-1');

    expect(result).toEqual({ rules: [] });
  });

  it('returns an empty manifest when reading the project config throws', async () => {
    mockedReadWorkspaceConfig.mockRejectedValue(new Error('disk error'));

    const result = await readWorkspaceApprovalsManifest('workspace-1');

    expect(result).toEqual({ rules: [] });
  });
});
