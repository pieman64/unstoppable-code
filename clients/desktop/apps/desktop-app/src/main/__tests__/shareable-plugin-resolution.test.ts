import {
  matchShareablePluginRef,
  type ShareablePluginCatalog,
} from '../plugins/shareable-plugin-resolution';

const catalog: ShareablePluginCatalog = {
  skills: [],
  marketplaces: [
    {
      id: 'acme-marketplace',
      name: 'Acme Marketplace',
      sourceType: 'github',
      sourceUrl: 'acme/plugins',
      installLocation: '/tmp/acme',
      pluginCount: 2,
      plugins: [
        {
          name: 'both-native',
          sourcePath: 'plugins/both-native',
          marketplaceId: 'acme-marketplace',
          providerSupport: { claude: 'native', codex: 'native' },
          facets: {
            claude: {
              provider: 'claude',
              mode: 'native',
              name: 'both-native',
              installLocation: '/tmp/acme/claude/both-native',
              sourcePath: '/tmp/acme/claude/both-native',
            },
            codex: {
              provider: 'codex',
              mode: 'native',
              name: 'both-native',
              installLocation: '/tmp/acme/codex/both-native',
              sourcePath: '/tmp/acme/codex/both-native',
            },
          },
        },
        {
          name: 'claude-only',
          sourcePath: 'plugins/claude-only',
          marketplaceId: 'acme-marketplace',
          providerSupport: { claude: 'native', codex: 'none' },
          facets: {
            claude: {
              provider: 'claude',
              mode: 'native',
              name: 'claude-only',
              installLocation: '/tmp/acme/claude/claude-only',
              sourcePath: '/tmp/acme/claude/claude-only',
            },
          },
        },
      ],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: 2,
          lastCheckedAt: '2026-06-24T00:00:00.000Z',
        },
        codex: {
          provider: 'codex',
          state: 'valid',
          accepted: true,
          pluginCount: 1,
          lastCheckedAt: '2026-06-24T00:00:00.000Z',
        },
      },
      validProviders: ['claude', 'codex'],
    },
  ],
};

describe('matchShareablePluginRef dynamic plugin refs', () => {
  it('uses native Codex resolution first for Codex sessions', () => {
    expect(
      matchShareablePluginRef(
        {
          type: 'plugin',
          marketplace: { type: 'github', repo: 'acme/plugins' },
          plugin_name: 'both-native',
        },
        catalog,
        { providerType: 'codex' },
      ),
    ).toMatchObject({
      matchState: 'matched',
      catalogKey: 'acme-marketplace/both-native',
      selection: {
        kind: 'plugin',
        marketplaceId: 'acme-marketplace',
        pluginName: 'both-native',
      },
    });
  });

  it('falls back to Claude plugin resolution when Codex-native resolution is unavailable', () => {
    expect(
      matchShareablePluginRef(
        {
          type: 'plugin',
          marketplace: { type: 'github', repo: 'acme/plugins' },
          plugin_name: 'claude-only',
        },
        catalog,
        { providerType: 'codex' },
      ),
    ).toMatchObject({
      matchState: 'matched',
      catalogKey: 'acme-marketplace/claude-only',
      selection: {
        kind: 'plugin',
        marketplaceId: 'acme-marketplace',
        pluginName: 'claude-only',
      },
    });
  });
});
