import type { MarketplaceInfo } from '@canopy/desktop-shared/types/plugins';
import type { ShareablePluginCatalog } from '../plugins/shareable-plugin-resolution';
const mockIsStartPageFeatureEnabled = jest.fn(() => true);
jest.mock('../lib/start-page-feature-flag', () => ({
  isStartPageFeatureEnabled: (): boolean => mockIsStartPageFeatureEnabled(),
}));
import {
  buildDesktopWorkspaceTemplateDocument,
  workspaceTemplateModelRequirements,
} from '../plugins/workspace-template-authoring';

const project = {
  id: 'course',
  name: 'Course',
  createdAt: '2026-09-09T00:00:00.000Z',
  description: 'Biology setup',
  color: '#22c55e',
  startPage: { kind: 'file' as const, path: 'README.md' },
  defaultPluginSelections: {
    collectionIds: ['collection-1'],
    skillRefs: [
      { sourceId: 'builtin:app', skillName: 'research' },
      { sourceId: 'custom:app', skillName: 'flashcards' },
    ],
    pluginRefs: [
      { marketplaceId: 'market-1', pluginName: 'teacher' },
      { marketplaceId: 'local-only', pluginName: 'private' },
    ],
    mcpServerRefs: [{ serverId: 'secret', configId: 'default' }],
  },
};

describe('buildDesktopWorkspaceTemplateDocument', () => {
  beforeEach(() => {
    mockIsStartPageFeatureEnabled.mockReturnValue(true);
  });

  it('projects the default model as a portable package requirement', () => {
    expect(workspaceTemplateModelRequirements('claude-sonnet-4-6')).toEqual([
      {
        id: 'model:claude-sonnet-4-6',
        kind: 'model',
        displayName: 'claude-sonnet-4-6',
        required: true,
        affectedSteps: [],
        setupHint:
          'Configure access to claude-sonnet-4-6 before using this project template.',
      },
    ]);
    expect(workspaceTemplateModelRequirements(undefined)).toEqual([]);
  });

  it('expands collections, inlines custom skill bytes, and reports local-only selections', async () => {
    const readRawSkill = jest.fn((id: string) => Promise.resolve(`raw:${id}`));
    const catalog = {
      skills: [
        {
          sourceId: 'builtin:app',
          name: 'research',
          shareableSource: { type: 'builtin', id: 'app' },
        },
        {
          sourceId: 'custom:app',
          name: 'flashcards',
          custom: true,
        },
        {
          sourceId: 'custom:app',
          name: 'labs',
          custom: true,
        },
      ],
      marketplaces: [
        {
          id: 'market-1',
          sourceUrl: 'https://github.com/example/course.git',
          plugins: [
            {
              name: 'teacher',
              facets: { claude: {}, codex: {} },
            },
          ],
        },
      ] as MarketplaceInfo[],
    } as ShareablePluginCatalog;

    const result = await buildDesktopWorkspaceTemplateDocument(
      project,
      'Tutor patiently.',
      {
        loadCatalog: () => Promise.resolve(catalog),
        loadCollection: () =>
          Promise.resolve({
            id: 'collection-1',
            name: 'Labs',
            description: '',
            skills: [{ sourceId: 'custom:app', skillName: 'labs' }],
            plugins: [],
            mcpServers: [
              { serverId: 'collection-secret', configId: 'default' },
            ],
            createdAt: '',
            updatedAt: '',
          }),
        readRawSkill,
        loadAccountConnections: () => Promise.resolve([]),
      },
    );

    expect(result.document).toMatchObject({
      name: 'Course',
      description: 'Biology setup',
      color: '#22c55e',
      instructions: 'Tutor patiently.',
      startPage: { kind: 'file', path: 'README.md' },
      customSkills: [
        {
          clientKey: 'custom:app/flashcards',
          name: 'flashcards',
          rawSkill: 'raw:custom:app/flashcards',
        },
        {
          clientKey: 'custom:app/labs',
          name: 'labs',
          rawSkill: 'raw:custom:app/labs',
        },
      ],
    });
    expect(result.document.plugins).toEqual(
      expect.arrayContaining([
        {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'research',
        },
        {
          type: 'plugin',
          marketplace: { type: 'github', repo: 'example/course' },
          plugin_name: 'teacher',
        },
      ]),
    );
    expect(result.omitted.mcpServers).toBe(true);
    expect(result.omitted.unresolvedRefs).toContain(
      'plugin:local-only/private',
    );
    expect(readRawSkill).toHaveBeenCalledWith('custom:app/labs');
  });

  it('omits a stored start page while the feature is disabled', async () => {
    mockIsStartPageFeatureEnabled.mockReturnValue(false);

    const result = await buildDesktopWorkspaceTemplateDocument(
      {
        ...project,
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
      '',
      {
        loadCatalog: () => Promise.resolve({ skills: [], marketplaces: [] }),
        loadCollection: () => Promise.resolve(null),
        readRawSkill: () => Promise.resolve(''),
        loadAccountConnections: () => Promise.resolve([]),
      },
    );

    expect(result.document.startPage).toBeUndefined();
  });

  it('carries account MCP servers by server key and omits device servers', async () => {
    const connection = {
      status: 'CONNECTED' as const,
      routeId: 'route',
      enabledTools: null,
      displayName: 'Server',
    };
    const result = await buildDesktopWorkspaceTemplateDocument(
      {
        ...project,
        defaultPluginSelections: {
          collectionIds: ['collection-1'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: 'account:connection-github', configId: 'default' },
            { serverId: 'github', configId: 'default' },
            { serverId: 'device-server', configId: 'default' },
          ],
        },
      },
      '',
      {
        loadCatalog: () => Promise.resolve({ skills: [], marketplaces: [] }),
        loadCollection: () =>
          Promise.resolve({
            id: 'collection-1',
            name: 'Tools',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [
              {
                serverId: 'custom:11111111-2222-4333-8444-555555555555',
                configId: 'default',
              },
            ],
            createdAt: '',
            updatedAt: '',
          }),
        readRawSkill: jest.fn(),
        loadAccountConnections: () =>
          Promise.resolve([
            {
              ...connection,
              id: 'connection-github',
              serverKey: 'github',
              configId: 'default',
              kind: 'CURATED' as const,
            },
            {
              ...connection,
              id: 'connection-custom',
              serverKey: 'custom:11111111-2222-4333-8444-555555555555',
              configId: 'default',
              kind: 'CUSTOM' as const,
            },
          ]),
      },
    );

    expect(result.document.mcpServerRefs).toEqual([
      { serverId: 'github', configId: 'default' },
      {
        serverId: 'custom:11111111-2222-4333-8444-555555555555',
        configId: 'default',
      },
    ]);
    expect(result.omitted.mcpServers).toBe(true);
  });
});
