jest.mock('../lib/canopy-json', () => ({
  getCanopyJsonPath: jest.fn((repoPath: string) => `${repoPath}/canopy.json`),
  readCanopyJson: jest.fn(),
}));
jest.mock('../lib/fs-utils', () => ({
  safeReadJson: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getBundleConfigFilePath: jest.fn(
    (bundleId: string) => `/bundles/${bundleId}.json`,
  ),
  getCollectionConfigFilePath: jest.fn(
    (collectionId: string) => `/collections/${collectionId}.json`,
  ),
  getWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/workspaces/${workspaceId}/worktrees/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
}));
// The plugins boundary (CAN-3817) edits the config read inside the write
// queue; here that read and write are the mocked ones.
jest.mock('../lib/workspace-persistence', () => {
  const readWorkspaceConfig = jest.fn<Promise<WorkspaceConfigFile>, [string]>();
  const writeWorkspaceConfig = jest.fn<
    Promise<void>,
    [string, WorkspaceConfigFile]
  >();
  return {
    readWorkspaceConfig,
    writeWorkspaceConfig,
    updateWorkspaceConfig: async <T>(
      workspaceId: string,
      update: (
        config: WorkspaceConfigFile,
        read: {
          authority: 'ok';
          ownerMalformed: false;
          memoryMalformed: false;
        },
      ) => T | Promise<T>,
      options?: { shouldWrite?: (result: T) => boolean },
    ): Promise<T> => {
      const config = structuredClone(await readWorkspaceConfig(workspaceId));
      const result = await update(config, {
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
      });
      if (!options?.shouldWrite || options.shouldWrite(result)) {
        await writeWorkspaceConfig(workspaceId, config);
      }
      return result;
    },
  };
});
jest.mock('../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: jest.fn(),
  matchShareablePluginRef: jest.fn(),
}));
jest.mock('../skills/skill-service', () => ({
  installSkills: jest.fn(),
}));
jest.mock('../plugins/plugin-service', () => ({
  addMarketplace: jest.fn(),
  installPlugin: jest.fn(),
  loadMarketplaces: jest.fn(),
  refreshMarketplaces: jest.fn(),
}));
jest.mock('../pipelines/pipeline-package-service', () => ({
  probePipelinePackageRequirement: jest.fn(),
  evaluatePipelinePackageRequirements: jest.fn(
    async (
      requirements: unknown[],
      probe: (requirement: unknown) => Promise<unknown>,
    ) => ({
      status: 'setup_required',
      requirements: await Promise.all(requirements.map(probe)),
    }),
  ),
}));

import type { ShareablePluginRef } from '@canopy/desktop-shared/plugin-refs';
import type {
  CanopyJsonFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { readCanopyJson } from '../lib/canopy-json';
import { safeReadJson } from '../lib/fs-utils';
import {
  applyRecommendedPlugins,
  inspectRecommendedPlugins,
} from '../lib/recommended-plugins';
import {
  readWorkspaceConfig,
  writeWorkspaceConfig,
} from '../lib/workspace-persistence';
import {
  loadShareablePluginCatalog,
  matchShareablePluginRef,
} from '../plugins/shareable-plugin-resolution';
import {
  addMarketplace,
  loadMarketplaces,
  refreshMarketplaces,
} from '../plugins/plugin-service';
import { installSkills } from '../skills/skill-service';
import { probePipelinePackageRequirement } from '../pipelines/pipeline-package-service';

const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedSafeReadJson = jest.mocked(safeReadJson);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedWriteWorkspaceConfig = jest.mocked(writeWorkspaceConfig);
const mockedLoadShareablePluginCatalog = jest.mocked(
  loadShareablePluginCatalog,
);
const mockedMatchShareablePluginRef = jest.mocked(matchShareablePluginRef);
const mockedInstallSkills = jest.mocked(installSkills);
const mockedAddMarketplace = jest.mocked(addMarketplace);
const mockedLoadMarketplaces = jest.mocked(loadMarketplaces);
const mockedRefreshMarketplaces = jest.mocked(refreshMarketplaces);
const mockedProbeRequirement = jest.mocked(probePipelinePackageRequirement);

const builtinSkillRef: ShareablePluginRef = {
  type: 'skill',
  source: { type: 'builtin', id: 'canopy' },
  skill_name: 'canopy-config',
};

const githubSkillRef: ShareablePluginRef = {
  type: 'skill',
  source: { type: 'github', repo: 'org/skills' },
  skill_name: 'reviewer',
};

const claudePluginRef: ShareablePluginRef = {
  type: 'claude_plugin',
  marketplace: { type: 'github', repo: 'org/marketplace' },
  plugin_name: 'browser',
};

function createWorkspaceConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repos/repo-a',
      },
    ],
    alwaysShow: true,
    ...overrides,
  };
}

function createManifest(plugins: ShareablePluginRef[]): CanopyJsonFile {
  return {
    version: 1,
    plugins,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedReadWorkspaceConfig.mockResolvedValue(createWorkspaceConfig());
  mockedReadCanopyJson.mockResolvedValue(createManifest([]));
  mockedSafeReadJson.mockReturnValue(null);
  mockedLoadShareablePluginCatalog.mockResolvedValue({
    skills: [],
    marketplaces: [],
  });
  mockedMatchShareablePluginRef.mockImplementation((ref) => ({
    matchState: 'unmatched',
    ref,
    displayName: ref.type === 'skill' ? ref.skill_name : ref.plugin_name,
    displaySource:
      ref.type === 'skill'
        ? ref.source.type
        : ref.marketplace.type === 'github'
          ? ref.marketplace.repo
          : ref.marketplace.id,
  }));
  mockedWriteWorkspaceConfig.mockResolvedValue(undefined);
  mockedInstallSkills.mockResolvedValue({ success: true, data: undefined });
  mockedAddMarketplace.mockResolvedValue({ success: true, data: undefined });
  mockedLoadMarketplaces.mockReturnValue({
    success: true,
    data: { version: 1, lastRefreshed: '', marketplaces: [] },
  });
  mockedRefreshMarketplaces.mockReturnValue({
    success: true,
    data: { version: 1, lastRefreshed: '', marketplaces: [] },
  });
  mockedProbeRequirement.mockImplementation((requirement) =>
    Promise.resolve({
      ...requirement,
      status: 'missing',
    }),
  );
});

describe('inspectRecommendedPlugins', () => {
  it('returns non-blocking readiness for canopy.json dependencies', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      dependencies: [
        {
          id: 'linear',
          kind: 'mcp',
          server: { catalog_id: 'linear' },
          required: true,
          fallback: 'block',
        },
      ],
    });

    const result = await inspectRecommendedPlugins({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(result.requirements).toEqual([
      expect.objectContaining({
        id: 'linear',
        kind: 'mcp',
        status: 'missing',
      }),
    ]);
  });

  it('reports installed, collection-selected, opted-out, and promptable recommendations', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({
        defaultPluginSelections: {
          collectionIds: ['abc123'],
          skillRefs: [],
          pluginRefs: [],
        },
        recommendedPluginOptOutKeys: ['skill:github:org/skills:reviewer'],
      }),
    );
    mockedReadCanopyJson.mockResolvedValue(
      createManifest([builtinSkillRef, githubSkillRef, claudePluginRef]),
    );
    mockedSafeReadJson.mockReturnValue({
      version: 2,
      collection: {
        id: 'abc123',
        name: 'Collection',
        description: '',
        skills: [{ sourceId: 'builtin', skillName: 'canopy-config' }],
        plugins: [],
        mcpServers: [],
        createdAt: '',
        updatedAt: '',
      },
    });
    mockedMatchShareablePluginRef.mockImplementation((ref) => {
      if (ref === builtinSkillRef) {
        return {
          matchState: 'matched',
          ref,
          catalogKey: 'builtin/app-config',
          selection: {
            kind: 'skill',
            sourceId: 'builtin',
            skillName: 'canopy-config',
          },
        };
      }
      if (ref === claudePluginRef) {
        return {
          matchState: 'matched',
          ref,
          catalogKey: 'market/browser',
          selection: {
            kind: 'plugin',
            marketplaceId: 'market',
            pluginName: 'browser',
          },
        };
      }
      return {
        matchState: 'unmatched',
        ref,
        displayName: 'reviewer',
        displaySource: 'org/skills',
      };
    });

    const result = await inspectRecommendedPlugins({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(result.sourcePath).toBe(
      '/workspaces/workspace-1/worktrees/wt-1/canopy.json',
    );
    expect(result.items).toMatchObject([
      {
        key: 'skill:builtin:app:canopy-config',
        installed: true,
        selectedByDefault: true,
        optedOut: false,
        action: 'none',
      },
      {
        key: 'skill:github:org/skills:reviewer',
        installed: false,
        selectedByDefault: false,
        optedOut: true,
        action: 'install-and-select',
      },
      {
        key: 'claude_plugin:github:org/marketplace:browser',
        installed: true,
        selectedByDefault: false,
        optedOut: false,
        action: 'select',
      },
    ]);
    expect(result.promptItems.map((item) => item.key)).toEqual([
      'claude_plugin:github:org/marketplace:browser',
    ]);
  });

  it('expands legacy Bundle defaults before Collection migration has run', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({
        defaultPluginSelections: {
          collectionIds: ['abc123'],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
    );
    mockedReadCanopyJson.mockResolvedValue(createManifest([builtinSkillRef]));
    mockedSafeReadJson.mockImplementation((filePath: string) => {
      if (filePath === '/collections/abc123.json') return null;
      if (filePath === '/bundles/abc123.json') {
        return {
          version: 1,
          bundle: {
            id: 'abc123',
            name: 'Legacy Bundle',
            description: '',
            skills: [{ sourceId: 'builtin', skillName: 'canopy-config' }],
            plugins: [],
            mcpServers: [],
            createdAt: '',
            updatedAt: '',
          },
        };
      }
      return null;
    });
    mockedMatchShareablePluginRef.mockImplementation((ref) => ({
      matchState: 'matched',
      ref,
      catalogKey: 'builtin/app-config',
      selection: {
        kind: 'skill',
        sourceId: 'builtin',
        skillName: 'canopy-config',
      },
    }));

    const result = await inspectRecommendedPlugins({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(result.items[0]?.selectedByDefault).toBe(true);
  });
});

describe('applyRecommendedPlugins', () => {
  it('installs a missing github skill, selects it, and applies partial opt-out edits', async () => {
    let skillInstalled = false;
    mockedReadWorkspaceConfig.mockResolvedValue(
      createWorkspaceConfig({
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
        recommendedPluginOptOutKeys: [
          'skill:github:org/skills:reviewer',
          'skill:github:org/skills:old',
        ],
      }),
    );
    mockedReadCanopyJson.mockResolvedValue(createManifest([githubSkillRef]));
    mockedInstallSkills.mockImplementation(() => {
      skillInstalled = true;
      return Promise.resolve({ success: true, data: undefined });
    });
    mockedMatchShareablePluginRef.mockImplementation((ref) =>
      skillInstalled
        ? {
            matchState: 'matched',
            ref,
            catalogKey: 'github-org-skills/reviewer',
            selection: {
              kind: 'skill',
              sourceId: 'github-org-skills',
              skillName: 'reviewer',
            },
          }
        : {
            matchState: 'unmatched',
            ref,
            displayName: 'reviewer',
            displaySource: 'org/skills',
          },
    );

    const result = await applyRecommendedPlugins({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      selectedKeys: ['skill:github:org/skills:reviewer'],
      optOutKeys: ['skill:github:org/other:thing'],
      clearOptOutKeys: ['skill:github:org/skills:old'],
    });

    expect(mockedInstallSkills).toHaveBeenCalledWith('org/skills', [
      'reviewer',
    ]);
    expect(result.results).toEqual([
      {
        key: 'skill:github:org/skills:reviewer',
        status: 'installed-and-selected',
      },
    ]);
    expect(result.defaultPluginSelections.skillRefs).toEqual([
      { sourceId: 'github-org-skills', skillName: 'reviewer' },
    ]);
    expect(result.recommendedPluginOptOutKeys).toEqual([
      'skill:github:org/other:thing',
    ]);
    const writeCall = mockedWriteWorkspaceConfig.mock.calls[0];
    expect(writeCall).toBeDefined();
    if (!writeCall) {
      throw new Error('Expected writeWorkspaceConfig to be called');
    }
    const [workspaceId, writtenConfig] = writeCall;
    expect(workspaceId).toBe('workspace-1');
    expect(writtenConfig.defaultPluginSelections?.skillRefs).toEqual([
      { sourceId: 'github-org-skills', skillName: 'reviewer' },
    ]);
    expect(writtenConfig.recommendedPluginOptOutKeys).toEqual([
      'skill:github:org/other:thing',
    ]);
  });

  it('does not opt out a selected plugin when installation fails', async () => {
    mockedReadCanopyJson.mockResolvedValue(createManifest([claudePluginRef]));

    const result = await applyRecommendedPlugins({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      selectedKeys: ['claude_plugin:github:org/marketplace:browser'],
      optOutKeys: ['claude_plugin:github:org/marketplace:browser'],
    });

    expect(result.results).toEqual([
      {
        key: 'claude_plugin:github:org/marketplace:browser',
        status: 'error',
        message:
          'Marketplace org/marketplace did not appear after registration.',
      },
    ]);
    expect(result.recommendedPluginOptOutKeys).toEqual([]);
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({
        recommendedPluginOptOutKeys: undefined,
      }),
    );
  });

  it('does not leak selections from an undefined default baseline into later inspections', async () => {
    mockedReadCanopyJson.mockResolvedValue(createManifest([builtinSkillRef]));
    mockedMatchShareablePluginRef.mockImplementation((ref) => ({
      matchState: 'matched',
      ref,
      catalogKey: 'builtin/app-config',
      selection: {
        kind: 'skill',
        sourceId: 'builtin',
        skillName: 'canopy-config',
      },
    }));

    const key = 'skill:builtin:app:canopy-config';
    const applied = await applyRecommendedPlugins({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      selectedKeys: [key],
      optOutKeys: [],
    });
    expect(applied.defaultPluginSelections.skillRefs).toEqual([
      { sourceId: 'builtin', skillName: 'canopy-config' },
    ]);

    const unrelatedInspection = await inspectRecommendedPlugins({
      workspaceId: 'workspace-2',
      worktreeId: 'wt-1',
    });

    expect(unrelatedInspection.items[0]?.selectedByDefault).toBe(false);
    expect(unrelatedInspection.promptItems.map((item) => item.key)).toEqual([
      key,
    ]);
  });
});
