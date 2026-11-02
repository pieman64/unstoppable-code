import type { ShareablePluginCatalog } from '../plugins/shareable-plugin-resolution';
import type { MarketplaceInfo, PluginInfo } from '@canopy/protocol/plugins';
import {
  installDesktopWorkspaceTemplateCapabilityPackages,
  prepareDesktopWorkspaceTemplateRefs,
  resolveDesktopWorkspaceTemplate,
} from '../plugins/workspace-template-import';

type WorkspaceTemplateRefPreparationDependencies = NonNullable<
  Parameters<typeof prepareDesktopWorkspaceTemplateRefs>[1]
>;
type AddMarketplace =
  WorkspaceTemplateRefPreparationDependencies['addMarketplace'];
type InstallPlugin =
  WorkspaceTemplateRefPreparationDependencies['installPlugin'];
type InstallSkills =
  WorkspaceTemplateRefPreparationDependencies['installSkills'];

function buildMarketplacePlugin(
  name: string,
  marketplaceId: string,
): PluginInfo {
  return {
    name,
    sourcePath: `/plugins/${name}`,
    marketplaceId,
    providerSupport: { claude: 'native', codex: 'native' },
    facets: {},
  };
}

const document = {
  version: 2 as const,
  name: 'Course',
  description: '',
  instructions: 'Tutor patiently.',
  plugins: [
    {
      type: 'skill' as const,
      source: { type: 'builtin' as const, id: 'app' },
      skill_name: 'research',
    },
    {
      type: 'plugin' as const,
      marketplace: { type: 'github' as const, repo: 'example/course' },
      plugin_name: 'teacher',
    },
  ],
  customSkills: [
    { clientKey: 'custom-1', name: 'flashcards', rawSkill: 'raw bytes' },
  ],
  starterPrompts: [],
};

describe('resolveDesktopWorkspaceTemplate', () => {
  it('maps packaged Blueprint MCP requirements to configured local refs', async () => {
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const result = await installDesktopWorkspaceTemplateCapabilityPackages(
      {
        projectId: 'project-1',
        externalId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'a'.repeat(64),
        package: {
          version: 1,
          digest,
          resources: [],
          environmentRequirements: [
            {
              id: 'mcp:linear',
              kind: 'mcp',
              displayName: 'linear',
              required: true,
              affectedSteps: [],
              setupHint: 'Connect Linear in Settings.',
            },
          ],
          totalFiles: 0,
          totalBytes: 0,
        },
      },
      {
        getPackage: () =>
          Promise.resolve({
            digest,
            manifest: {
              version: 1,
              pipelineContentHash: 'b'.repeat(64),
              resources: [],
              bindings: [],
              environmentRequirements: [
                {
                  id: 'mcp:linear',
                  kind: 'mcp',
                  displayName: 'linear',
                  required: true,
                  affectedSteps: [],
                  setupHint: 'Connect Linear in Settings.',
                },
              ],
              totalFiles: 0,
              totalBytes: 0,
            },
          }),
        getBlob: () => Promise.resolve(new Uint8Array()),
        installPackage: () =>
          Promise.resolve({
            supportingFileCount: 0,
            installedSkills: [
              {
                name: 'Helper',
                localName: 'helper',
                resourceId: 'helper',
              },
            ],
            uninstalledResourceLabels: [],
            keptLocalFiles: [],
          }),
        getMcpByCatalogId: () =>
          Promise.resolve({
            serverId: 'linear-local',
            transport: 'http',
            connectionStatus: 'connected',
            reachability: 'reachable',
            configs: [{ configId: 'linear-config', authStatus: 'connected' }],
          }),
        getMcpByName: () => Promise.resolve(null),
      },
    );

    expect(result).toEqual({
      skillRefs: [{ sourceId: 'custom:app', skillName: 'helper' }],
      mcpServerRefs: [{ serverId: 'linear-local', configId: 'linear-config' }],
      unmetRequirements: [],
    });
  });

  it('prepares portable refs, keeps matches, and writes custom skill bytes', async () => {
    const prepareRefs = jest.fn(() => Promise.resolve());
    const writeCustomSkill = jest.fn(() => ({ skillName: 'flashcards' }));
    const catalog = {
      skills: [
        {
          sourceId: 'builtin:app',
          name: 'research',
          shareableSource: { type: 'builtin', id: 'app' },
        },
      ],
      marketplaces: [
        {
          id: 'example-course',
          sourceUrl: 'https://github.com/example/course.git',
          plugins: [
            {
              name: 'teacher',
              cachePath: '/installed',
              externalSource: null,
              facets: {},
            },
          ],
        },
      ],
    } as unknown as ShareablePluginCatalog;

    const result = await resolveDesktopWorkspaceTemplate(document, {
      prepareRefs,
      loadCatalog: () => Promise.resolve(catalog),
      writeCustomSkill,
    });
    expect(prepareRefs).toHaveBeenCalledWith(document.plugins);
    expect(writeCustomSkill).toHaveBeenCalledWith({
      skillName: 'flashcards',
      rawSkill: 'raw bytes',
    });
    expect(result.selections.skillRefs).toEqual(
      expect.arrayContaining([
        { sourceId: 'builtin:app', skillName: 'research' },
        { sourceId: 'custom:app', skillName: 'flashcards' },
      ]),
    );
    expect(result.selections.pluginRefs).toEqual([
      { marketplaceId: 'example-course', pluginName: 'teacher' },
    ]);
    expect(result.unresolvedRefs).toEqual([]);
  });

  it('selects the account MCP servers a template carries', async () => {
    const mcpServerRefs = [
      { serverId: 'github', configId: 'default' },
      {
        serverId: 'custom:11111111-2222-4333-8444-555555555555',
        configId: 'default',
      },
    ];
    const result = await resolveDesktopWorkspaceTemplate(
      {
        ...document,
        version: 2,
        plugins: [],
        customSkills: [],
        starterPrompts: [],
        mcpServerRefs,
      },
      {
        prepareRefs: () => Promise.resolve(),
        loadCatalog: () => Promise.resolve({ skills: [], marketplaces: [] }),
        writeCustomSkill: () => ({ skillName: 'unused' }),
      },
    );
    expect(result.selections.mcpServerRefs).toEqual(mcpServerRefs);
  });

  it('reports refs still unmatched after marketplace preparation', async () => {
    const result = await resolveDesktopWorkspaceTemplate(document, {
      prepareRefs: () => Promise.resolve(),
      loadCatalog: () => Promise.resolve({ skills: [], marketplaces: [] }),
      writeCustomSkill: () => ({ skillName: 'flashcards' }),
    });
    expect(result.unresolvedRefs).toHaveLength(2);
  });

  it('adds each GitHub marketplace once and installs plugins sequentially', async () => {
    const refs = [
      {
        type: 'skill' as const,
        source: { type: 'github' as const, repo: 'Example/Course' },
        skill_name: 'research',
      },
      {
        type: 'plugin' as const,
        marketplace: { type: 'github' as const, repo: 'example/course' },
        plugin_name: 'teacher',
      },
      {
        type: 'plugin' as const,
        marketplace: { type: 'github' as const, repo: 'example/course' },
        plugin_name: 'grader',
      },
      {
        type: 'claude_plugin' as const,
        marketplace: { type: 'github' as const, repo: 'example/course' },
        plugin_name: 'writing-coach',
      },
      {
        type: 'plugin' as const,
        marketplace: { type: 'github' as const, repo: 'example/labs' },
        plugin_name: 'lab-assistant',
      },
    ];
    const operations: string[] = [];
    let activeInstalls = 0;
    const addMarketplace = jest.fn<
      ReturnType<AddMarketplace>,
      Parameters<AddMarketplace>
    >((repo: string): ReturnType<AddMarketplace> => {
      operations.push(`add:${repo}`);
      const plugins = [
        'teacher',
        'grader',
        'writing-coach',
        'lab-assistant',
      ].map((name) => buildMarketplacePlugin(name, repo));
      const providerStatus: MarketplaceInfo['providerStatus'] = {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: plugins.length,
          lastCheckedAt: '2026-10-27T00:00:00.000Z',
        },
        codex: {
          provider: 'codex',
          state: 'valid',
          accepted: true,
          pluginCount: plugins.length,
          lastCheckedAt: '2026-10-27T00:00:00.000Z',
        },
      };
      const marketplace: MarketplaceInfo = {
        id: repo,
        name: repo,
        sourceType: 'github',
        sourceUrl: `https://github.com/${repo}.git`,
        installLocation: `/marketplaces/${repo}`,
        pluginCount: plugins.length,
        plugins,
        providerStatus,
        validProviders: ['claude', 'codex'],
      };
      const result: Awaited<ReturnType<AddMarketplace>> = {
        success: true,
        data: {
          marketplace,
          providerOutcomes: providerStatus,
        },
      };
      return Promise.resolve(result);
    });
    const installPlugin = jest.fn<
      ReturnType<InstallPlugin>,
      Parameters<InstallPlugin>
    >(
      async (
        marketplaceId: string,
        name: string,
      ): Promise<Awaited<ReturnType<InstallPlugin>>> => {
        activeInstalls += 1;
        expect(activeInstalls).toBe(1);
        operations.push(`install:${name}`);
        await Promise.resolve();
        activeInstalls -= 1;
        return {
          success: true,
          data: buildMarketplacePlugin(name, marketplaceId),
        };
      },
    );
    const installSkills = jest.fn<
      ReturnType<InstallSkills>,
      Parameters<InstallSkills>
    >((): ReturnType<InstallSkills> => Promise.resolve({ success: true }));
    const dependencies = {
      addMarketplace,
      installPlugin,
      installSkills,
    };

    await prepareDesktopWorkspaceTemplateRefs(refs, dependencies);

    expect(addMarketplace).toHaveBeenCalledTimes(2);
    expect(addMarketplace).toHaveBeenNthCalledWith(1, 'Example/Course');
    expect(addMarketplace).toHaveBeenNthCalledWith(2, 'example/labs');
    expect(installSkills).toHaveBeenCalledTimes(1);
    expect(installSkills).toHaveBeenCalledWith('Example/Course', ['research']);
    expect(installPlugin).toHaveBeenCalledTimes(4);
    expect(operations).toEqual([
      'add:Example/Course',
      'install:teacher',
      'install:grader',
      'install:writing-coach',
      'add:example/labs',
      'install:lab-assistant',
    ]);
  });

  it('rejects a failed portable GitHub skill installation', async () => {
    const installSkills = jest.fn(() =>
      Promise.resolve({
        success: false as const,
        error: 'The requested skill was not found.',
      }),
    );

    await expect(
      prepareDesktopWorkspaceTemplateRefs(
        [
          {
            type: 'skill',
            source: { type: 'github', repo: 'example/course' },
            skill_name: 'research',
          },
        ],
        {
          installSkills,
          addMarketplace: jest.fn(),
          installPlugin: jest.fn(),
        },
      ),
    ).rejects.toThrow('The requested skill was not found.');
  });
});
