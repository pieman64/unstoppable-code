import {
  BUILTIN_PLUGIN_MARKETPLACE_ID,
  BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL,
  CURATED_PLUGIN_MARKETPLACE_ID,
  CURATED_PLUGIN_MARKETPLACE_SOURCE_URL,
  isBuiltInPluginMarketplaceId,
  isCuratedPluginMarketplaceId,
  serializeShareableSource,
  type BuiltInPluginInstallStatus,
  type MarketplaceInfo,
  type MarketplacePluginExternalSource,
  type PluginDetails,
  type PluginInfo,
  type PluginProviderFacet,
  type PluginProviderSupport,
} from '../index';

describe('plugin catalog contract', () => {
  it('pins the built-in and curated marketplace identities', () => {
    expect(BUILTIN_PLUGIN_MARKETPLACE_ID).toBe('builtin/app');
    expect(BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL).toBe('builtin:app');
    expect(CURATED_PLUGIN_MARKETPLACE_ID).toBe('curated/cloud');
    expect(CURATED_PLUGIN_MARKETPLACE_SOURCE_URL).toBe('curated:cloud');
  });

  it('keeps the built-in source URL in sync with serializeShareableSource', () => {
    // BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL is a literal (not derived) to
    // avoid a module cycle between catalog.ts and index.ts; this pin keeps
    // the two from drifting.
    expect(serializeShareableSource({ type: 'builtin', id: 'app' })).toBe(
      BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL,
    );
  });

  it('recognizes only the canonical managed marketplace ids', () => {
    expect(isBuiltInPluginMarketplaceId('builtin/app')).toBe(true);
    expect(isBuiltInPluginMarketplaceId('curated/cloud')).toBe(false);
    expect(isBuiltInPluginMarketplaceId('builtin')).toBe(false);
    expect(isCuratedPluginMarketplaceId('curated/cloud')).toBe(true);
    expect(isCuratedPluginMarketplaceId('builtin/app')).toBe(false);
    expect(isCuratedPluginMarketplaceId('')).toBe(false);
  });

  it('keeps plugin detail shapes serializable through JSON round-trips', () => {
    const details: PluginDetails = {
      skills: [
        {
          name: 'commit-messages',
          description: 'Write commit messages',
          path: 'skills/commit-messages/SKILL.md',
          userInvocable: true,
        },
      ],
      agents: [
        { name: 'reviewer', description: 'Reviews', filePath: 'agents/r.md' },
      ],
      commands: [
        {
          name: 'review',
          description: 'Run review',
          filePath: 'commands/r.md',
        },
      ],
      apps: [{ name: 'panel', description: 'Panel', filePath: 'apps/p.md' }],
      hooks: [
        {
          event: 'PostToolUse',
          matcher: 'Edit',
          hookType: 'command',
          command: 'lint.sh',
        },
      ],
      mcpServers: [
        { name: 'search', type: 'http', url: 'https://mcp.example.com' },
        { name: 'local', type: 'command', command: 'node', args: ['mcp.js'] },
      ],
      lspServers: [
        { name: 'ts', command: 'tsserver', languages: ['typescript'] },
      ],
      hasReadme: true,
    };
    expect(JSON.parse(JSON.stringify(details))).toEqual(details);
  });

  it('constructs plugin rows with per-provider facets', () => {
    const externalSource: MarketplacePluginExternalSource = {
      source: 'github',
      url: 'https://github.com/acme/plugin',
      sha: 'abc123',
    };
    const facet: PluginProviderFacet = {
      provider: 'claude',
      mode: 'native',
      name: 'browser',
      displayName: 'Browser',
      version: '1.0.0',
      installLocation: '/tmp/marketplace',
      sourcePath: 'plugins/browser',
      externalSource,
      details: null,
    };
    const support: PluginProviderSupport = {
      claude: 'native',
      codex: 'compat',
    };
    const installStatus: BuiltInPluginInstallStatus = {
      claude: { available: true, installed: true, enabled: true },
      codex: { available: false, installed: false },
      checkedAt: '2026-08-27T00:00:00Z',
    };
    const plugin: PluginInfo = {
      name: 'browser',
      description: 'Browser automation',
      sourcePath: 'plugins/browser',
      marketplaceId: BUILTIN_PLUGIN_MARKETPLACE_ID,
      builtIn: true,
      globalInstallStatus: installStatus,
      externalSource,
      providerSupport: support,
      facets: { claude: facet },
      codexCompatDisabled: false,
    };
    expect(JSON.parse(JSON.stringify(plugin))).toEqual(plugin);
  });

  it('constructs marketplace rows with provider status', () => {
    const marketplace: MarketplaceInfo = {
      id: BUILTIN_PLUGIN_MARKETPLACE_ID,
      name: 'Built-in',
      sourceType: 'builtin',
      sourceUrl: BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL,
      builtIn: true,
      removable: false,
      installLocation: '/tmp/builtin',
      pluginCount: 0,
      plugins: [],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: 3,
          lastCheckedAt: '2026-08-27T00:00:00Z',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-08-27T00:00:00Z',
          error: 'not supported',
        },
      },
      validProviders: ['claude'],
    };
    expect(JSON.parse(JSON.stringify(marketplace))).toEqual(marketplace);
    // Open string union stays forward-compatible with unknown sources.
    const unknownSource: MarketplaceInfo['sourceType'] = 'gitlab';
    expect(unknownSource).toBe('gitlab');
  });
});
