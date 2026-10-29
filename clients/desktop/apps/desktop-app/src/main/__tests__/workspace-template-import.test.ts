import type { ShareablePluginCatalog } from '../plugins/shareable-plugin-resolution';
import {
  installDesktopWorkspaceTemplateCapabilityPackages,
  prepareDesktopWorkspaceTemplateRefs,
  resolveDesktopWorkspaceTemplate,
} from '../plugins/workspace-template-import';

const document = {
  version: 1 as const,
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
            installedSkills: [{ name: 'Helper', localName: 'helper' }],
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
    const addMarketplace = jest.fn((repo: string) => {
      operations.push(`add:${repo}`);
      return Promise.resolve({
        success: true,
        data: {
          marketplace: {
            id: repo,
            sourceUrl: `https://github.com/${repo}.git`,
            plugins: [
              { name: 'teacher' },
              { name: 'grader' },
              { name: 'writing-coach' },
              { name: 'lab-assistant' },
            ],
          },
        },
      });
    });
    const installPlugin = jest.fn(async (_id: string, name: string) => {
      activeInstalls += 1;
      expect(activeInstalls).toBe(1);
      operations.push(`install:${name}`);
      await Promise.resolve();
      activeInstalls -= 1;
    });
    const installSkills = jest.fn(() =>
      Promise.resolve({ success: true as const }),
    );
    const dependencies = {
      addMarketplace,
      installPlugin,
      installSkills,
    };

    await prepareDesktopWorkspaceTemplateRefs(
      refs,
      dependencies as Parameters<typeof prepareDesktopWorkspaceTemplateRefs>[1],
    );

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
        } as Parameters<typeof prepareDesktopWorkspaceTemplateRefs>[1],
      ),
    ).rejects.toThrow('The requested skill was not found.');
  });
});
