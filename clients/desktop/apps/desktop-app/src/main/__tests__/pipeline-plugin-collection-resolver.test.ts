import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePipelinePluginCollections } from '../pipelines/plugin-collection-resolver';
import { getPipelinePluginDefaultKey } from '@canopy/desktop-shared/pipelines/plugin-collections';
import type { ShareablePluginCatalog } from '../plugins/shareable-plugin-resolution';
import type {
  PipelinePluginCollection,
  PipelinePluginCollectionPreference,
} from '@canopy/desktop-shared/types/pipeline';

const catalog: ShareablePluginCatalog = {
  skills: [
    {
      name: 'ud-git:commit-messages',
      sourceId: 'builtin:app',
      description: 'Commit helper',
      source: 'Built-in',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updateAvailable: false,
      builtIn: true,
      shareableSource: { type: 'builtin', id: 'canopy' },
    },
    {
      name: 'reviewer',
      sourceId: 'github:owner/skills',
      description: 'Reviewer',
      source: 'owner/skills',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updateAvailable: false,
      shareableSource: { type: 'github', repo: 'owner/skills' },
    },
  ],
  marketplaces: [
    {
      id: 'owner-marketplace',
      name: 'Owner Marketplace',
      description: '',
      sourceType: 'github',
      sourceUrl: 'https://github.com/owner/marketplace',
      installLocation: '/tmp/marketplace',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      pluginCount: 1,
      plugins: [
        {
          name: 'browser',
          description: 'Browser helper',
          version: '',
          author: '',
          category: '',
          homepage: '',
          sourcePath: 'plugins/browser',
          marketplaceId: 'owner-marketplace',
          details: null,
          externalSource: null,
          cachePath: '/tmp/browser',
          cachedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  ],
};

describe('pipeline plugin collection resolver', () => {
  it('matches installed defaults and reports unmatched defaults in previews and snapshots', async () => {
    const optionalGithubSkill = {
      type: 'skill',
      source: { type: 'github', repo: 'OWNER/SKILLS' },
      skill_name: 'reviewer',
    } as const;
    const collections: PipelinePluginCollection[] = [
      {
        id: 'implementer_plugins',
        name: 'Implementer plugins',
        defaults: [
          {
            type: 'skill',
            source: { type: 'builtin', id: 'canopy' },
            skill_name: 'ud-git:commit-messages',
            required: true,
          },
          optionalGithubSkill,
          {
            type: 'claude_plugin',
            marketplace: { type: 'github', repo: 'owner/marketplace' },
            plugin_name: 'browser',
          },
          {
            type: 'skill',
            source: { type: 'github', repo: 'missing/skills' },
            skill_name: 'missing-skill',
            required: true,
          },
        ],
      },
    ];
    const preferences: Record<string, PipelinePluginCollectionPreference> = {
      implementer_plugins: {
        disabledDefaultKeys: [getPipelinePluginDefaultKey(optionalGithubSkill)],
        extraSelections: {
          collectionIds: [],
          skillRefs: [
            { sourceId: 'github:extras/skills', skillName: 'extra-skill' },
          ],
          pluginRefs: [
            {
              marketplaceId: 'extra-marketplace',
              pluginName: 'extra-plugin',
            },
          ],
          mcpServerRefs: [{ serverId: 'ignored', configId: 'ignored' }],
        },
      },
    };

    const resolution = await resolvePipelinePluginCollections(
      collections,
      preferences,
      catalog,
    );

    expect(resolution.previewItems).toHaveLength(4);
    expect(resolution.previewItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: 'ud-git:commit-messages',
          matchState: 'matched',
          required: true,
        }),
        expect.objectContaining({
          displayName: 'reviewer',
          enabledByDefault: false,
          matchState: 'matched',
        }),
        expect.objectContaining({
          displayName: 'browser',
          matchState: 'matched',
        }),
        expect.objectContaining({
          displayName: 'missing-skill',
          matchState: 'unmatched',
          required: true,
        }),
      ]),
    );
    expect(resolution.snapshots.implementer_plugins.selections).toMatchObject({
      skillRefs: [
        {
          sourceId: 'builtin:app',
          skillName: 'ud-git:commit-messages',
        },
        { sourceId: 'github:extras/skills', skillName: 'extra-skill' },
      ],
      pluginRefs: [
        { marketplaceId: 'owner-marketplace', pluginName: 'browser' },
        { marketplaceId: 'extra-marketplace', pluginName: 'extra-plugin' },
      ],
      mcpServerRefs: [],
    });
    expect(
      resolution.snapshots.implementer_plugins.unresolvedRequiredDefaults,
    ).toEqual([
      expect.objectContaining({
        defaultKey: 'skill:github:missing/skills:missing-skill',
      }),
    ]);
  });

  it('does not match external Claude plugins until they are installed locally', async () => {
    const collections: PipelinePluginCollection[] = [
      {
        id: 'plugins',
        name: 'Plugins',
        defaults: [
          {
            type: 'claude_plugin',
            marketplace: { type: 'github', repo: 'owner/marketplace' },
            plugin_name: 'external-browser',
          },
        ],
      },
    ];
    const externalCatalog: ShareablePluginCatalog = {
      skills: [],
      marketplaces: [
        {
          id: 'owner-marketplace',
          name: 'Owner Marketplace',
          description: '',
          sourceType: 'github',
          sourceUrl: 'https://github.com/owner/marketplace',
          installLocation: '/tmp/marketplace',
          lastUpdated: '2026-01-01T00:00:00.000Z',
          pluginCount: 1,
          plugins: [
            {
              name: 'external-browser',
              description: 'External browser helper',
              version: '',
              author: '',
              category: '',
              homepage: '',
              sourcePath: '',
              marketplaceId: 'owner-marketplace',
              details: null,
              externalSource: { url: 'https://github.com/owner/browser' },
              cachePath: null,
              cachedAt: null,
            },
          ],
        },
      ],
    };

    const resolution = await resolvePipelinePluginCollections(
      collections,
      {},
      externalCatalog,
    );

    expect(resolution.previewItems).toEqual([
      expect.objectContaining({
        displayName: 'external-browser',
        matchState: 'unmatched',
      }),
    ]);
    expect(resolution.snapshots.plugins.selections.pluginRefs).toEqual([]);
  });

  it('matches external Claude plugins when their cache exists locally', async () => {
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-plugin-'));
    try {
      const collections: PipelinePluginCollection[] = [
        {
          id: 'plugins',
          name: 'Plugins',
          defaults: [
            {
              type: 'claude_plugin',
              marketplace: { type: 'github', repo: 'owner/marketplace' },
              plugin_name: 'external-browser',
            },
          ],
        },
      ];
      const externalCatalog: ShareablePluginCatalog = {
        skills: [],
        marketplaces: [
          {
            id: 'owner-marketplace',
            name: 'Owner Marketplace',
            description: '',
            sourceType: 'github',
            sourceUrl: 'https://github.com/owner/marketplace',
            installLocation: '/tmp/marketplace',
            lastUpdated: '2026-01-01T00:00:00.000Z',
            pluginCount: 1,
            plugins: [
              {
                name: 'external-browser',
                description: 'External browser helper',
                version: '',
                author: '',
                category: '',
                homepage: '',
                sourcePath: cachePath,
                marketplaceId: 'owner-marketplace',
                details: null,
                externalSource: { url: 'https://github.com/owner/browser' },
                cachePath,
                cachedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        ],
      };

      const resolution = await resolvePipelinePluginCollections(
        collections,
        {},
        externalCatalog,
      );

      expect(resolution.previewItems).toEqual([
        expect.objectContaining({
          displayName: 'external-browser',
          matchState: 'matched',
          matchedCatalogKey: 'owner-marketplace/external-browser',
        }),
      ]);
      expect(resolution.snapshots.plugins.selections.pluginRefs).toEqual([
        {
          marketplaceId: 'owner-marketplace',
          pluginName: 'external-browser',
        },
      ]);
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  });

  it('matches Codex-native plugin defaults from Codex-only marketplaces', async () => {
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-codex-'));
    try {
      const collections: PipelinePluginCollection[] = [
        {
          id: 'plugins',
          name: 'Plugins',
          defaults: [
            {
              type: 'codex_plugin',
              marketplace: { type: 'codex-builtin', id: 'openai-curated' },
              plugin_name: 'codex-security',
              required: true,
            },
          ],
        },
      ];
      const codexCatalog: ShareablePluginCatalog = {
        skills: [],
        marketplaces: [
          {
            id: 'openai-curated',
            name: 'OpenAI Curated',
            description: '',
            sourceType: 'codex',
            sourceUrl: 'OpenAI Curated',
            installLocation: cachePath,
            lastUpdated: '2026-01-01T00:00:00.000Z',
            pluginCount: 1,
            plugins: [
              {
                name: 'codex-security',
                description: 'Security review helper',
                version: '',
                author: '',
                category: '',
                homepage: '',
                sourcePath: cachePath,
                marketplaceId: 'openai-curated',
                details: null,
                providerSupport: { claude: 'none', codex: 'native' },
                facets: {
                  codex: {
                    provider: 'codex',
                    mode: 'native',
                    name: 'codex-security',
                    installLocation: cachePath,
                    sourcePath: cachePath,
                  },
                },
              },
            ],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
            },
            validProviders: ['codex'],
          },
        ],
      };

      const resolution = await resolvePipelinePluginCollections(
        collections,
        {},
        codexCatalog,
      );

      expect(resolution.previewItems).toEqual([
        expect.objectContaining({
          displayName: 'codex-security',
          matchState: 'matched',
          required: true,
          matchedCatalogKey: 'openai-curated/codex-security',
        }),
      ]);
      expect(resolution.snapshots.plugins.selections.pluginRefs).toEqual([
        { marketplaceId: 'openai-curated', pluginName: 'codex-security' },
      ]);
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  });

  it('matches claude_plugin defaults through a paired Codex-native facet when the Claude cache is missing', async () => {
    const codexPath = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-codex-'));
    try {
      const collections: PipelinePluginCollection[] = [
        {
          id: 'plugins',
          name: 'Plugins',
          defaults: [
            {
              type: 'claude_plugin',
              marketplace: { type: 'github', repo: 'owner/marketplace' },
              plugin_name: 'paired-plugin',
              required: true,
            },
          ],
        },
      ];
      const pairedCatalog: ShareablePluginCatalog = {
        skills: [],
        marketplaces: [
          {
            id: 'owner-marketplace',
            name: 'Owner Marketplace',
            description: '',
            sourceType: 'github',
            sourceUrl: 'https://github.com/owner/marketplace',
            installLocation: '/tmp/marketplace',
            lastUpdated: '2026-01-01T00:00:00.000Z',
            pluginCount: 1,
            plugins: [
              {
                name: 'paired-plugin',
                description: 'Paired helper',
                version: '',
                author: '',
                category: '',
                homepage: '',
                sourcePath: '',
                marketplaceId: 'owner-marketplace',
                details: null,
                externalSource: { url: 'https://github.com/owner/paired' },
                cachePath: null,
                cachedAt: null,
                providerSupport: { claude: 'native', codex: 'native' },
                facets: {
                  claude: {
                    provider: 'claude',
                    mode: 'native',
                    name: 'paired-plugin',
                    installLocation: '/missing/claude',
                    sourcePath: '',
                    externalSource: {
                      source: 'github',
                      url: 'https://github.com/owner/paired',
                    },
                  },
                  codex: {
                    provider: 'codex',
                    mode: 'native',
                    name: 'paired-plugin',
                    installLocation: codexPath,
                    sourcePath: codexPath,
                  },
                },
              },
            ],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
            },
            validProviders: ['claude', 'codex'],
          },
        ],
      };

      const resolution = await resolvePipelinePluginCollections(
        collections,
        {},
        pairedCatalog,
      );

      expect(resolution.previewItems).toEqual([
        expect.objectContaining({
          displayName: 'paired-plugin',
          matchState: 'matched',
          required: true,
        }),
      ]);
      expect(resolution.snapshots.plugins.selections.pluginRefs).toEqual([
        { marketplaceId: 'owner-marketplace', pluginName: 'paired-plugin' },
      ]);
    } finally {
      fs.rmSync(codexPath, { recursive: true, force: true });
    }
  });
});
