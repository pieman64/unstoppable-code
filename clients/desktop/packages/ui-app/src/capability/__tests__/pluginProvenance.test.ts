import {
  githubOwner,
  mcpEndpointKey,
  pluginPackageKey,
  pluginSourceLabel,
} from '../pluginProvenance';
import type {
  UnifiedMarketplaceInput,
  UnifiedMarketplacePluginInput,
} from '../unifiedPluginEntries';

function plugin(
  overrides: Partial<UnifiedMarketplacePluginInput> = {},
): UnifiedMarketplacePluginInput {
  return {
    name: 'slack',
    marketplaceId: 'claude-plugins-official',
    providerSupport: { claude: 'native', codex: 'compat' },
    ...overrides,
  };
}

function marketplace(
  overrides: Partial<UnifiedMarketplaceInput> = {},
): UnifiedMarketplaceInput {
  return {
    id: 'claude-plugins-official',
    name: 'claude-plugins-official',
    sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
    plugins: [],
    ...overrides,
  };
}

describe('githubOwner', () => {
  it('reads the owner from https, www and ssh GitHub URLs', () => {
    expect(
      githubOwner('https://github.com/slackapi/slack-mcp-plugin.git'),
    ).toBe('slackapi');
    expect(githubOwner('git@github.com:slackapi/x.git')).toBe('slackapi');
    expect(githubOwner('https://www.github.com/anthropics/x')).toBe(
      'anthropics',
    );
  });

  it('refuses look-alike hosts, empty owners and missing URLs', () => {
    expect(githubOwner('https://github.com.evil/x/y')).toBeUndefined();
    expect(githubOwner('https://github.com//repo')).toBeUndefined();
    expect(githubOwner('git@github.com:/repo.git')).toBeUndefined();
    expect(githubOwner(undefined)).toBeUndefined();
  });
});

describe('pluginSourceLabel', () => {
  it('names the native provider and the package owner', () => {
    expect(
      pluginSourceLabel(
        marketplace(),
        plugin({
          externalSource: {
            source: 'url',
            url: 'https://github.com/slackapi/slack-mcp-plugin.git',
          },
        }),
      ),
    ).toBe('Claude · slackapi');
  });

  it('keeps a catalog name that already names its provider', () => {
    expect(
      pluginSourceLabel(
        marketplace({
          id: 'openai-curated',
          name: 'Codex official',
          sourceUrl: 'https://github.invalid/openai/curated',
        }),
        plugin({
          marketplaceId: 'openai-curated',
          providerSupport: { claude: 'none', codex: 'native' },
          externalSourceUrl: 'https://github.invalid/openai/slack.git',
        }),
      ),
    ).toBe('Codex official');
  });

  it('falls back to the marketplace repository owner for inline plugins', () => {
    expect(pluginSourceLabel(marketplace(), plugin())).toBe(
      'Claude · anthropics',
    );
  });

  it('joins the provider and a non-GitHub catalog name', () => {
    expect(
      pluginSourceLabel(
        marketplace({ id: 'demo', name: 'Demo Market', sourceUrl: undefined }),
        plugin({ providerSupport: { claude: 'none', codex: 'native' } }),
      ),
    ).toBe('Codex · Demo Market');
  });

  it('uses the catalog name alone without a native provider', () => {
    expect(
      pluginSourceLabel(
        marketplace({ id: 'demo', name: 'Demo Market' }),
        plugin({ providerSupport: { claude: 'none', codex: 'compat' } }),
      ),
    ).toBe('Demo Market');
  });

  it('prefers Claude when both providers are native', () => {
    expect(
      pluginSourceLabel(
        marketplace({ sourceUrl: 'https://github.com/owner/market' }),
        plugin({ providerSupport: { claude: 'native', codex: 'native' } }),
      ),
    ).toBe('Claude · owner');
  });
});

describe('pluginPackageKey', () => {
  it('folds case and a trailing .git', () => {
    expect(
      pluginPackageKey(
        plugin({
          externalSource: {
            source: 'url',
            url: 'https://GitHub.com/SlackAPI/slack-mcp-plugin.git',
          },
        }),
      ),
    ).toBe('https://github.com/slackapi/slack-mcp-plugin');
    expect(
      pluginPackageKey(
        plugin({
          externalSourceUrl: 'https://github.com/slackapi/slack-mcp-plugin',
        }),
      ),
    ).toBe('https://github.com/slackapi/slack-mcp-plugin');
  });

  it('folds a trailing slash, with or without .git', () => {
    for (const url of [
      'https://github.com/slackapi/slack-mcp-plugin/',
      'https://github.com/slackapi/slack-mcp-plugin.git/',
    ]) {
      expect(pluginPackageKey(plugin({ externalSourceUrl: url }))).toBe(
        'https://github.com/slackapi/slack-mcp-plugin',
      );
    }
  });

  it('is absent without a source', () => {
    expect(pluginPackageKey(plugin())).toBeUndefined();
  });

  // The desktop reads the raw source; the web reads the Portal row's
  // sanitized copy. Both must key one package the same way.
  it('keys the raw desktop source like the Portal-sanitized web copy', () => {
    const desktop = pluginPackageKey(
      plugin({
        externalSource: {
          source: 'url',
          url: 'https://user:token@github.com/slackapi/slack-mcp-plugin.git?ref=main#readme',
        },
      }),
    );
    const web = pluginPackageKey(
      plugin({
        externalSourceUrl: 'https://github.com/slackapi/slack-mcp-plugin.git',
      }),
    );
    expect(desktop).toBe('https://github.com/slackapi/slack-mcp-plugin');
    expect(web).toBe(desktop);
  });

  it('is absent for a source the Portal cannot carry', () => {
    // The Portal row carries http(s) sources only, so the web never receives
    // these; the desktop must not key them either.
    for (const url of [
      'git@github.com:slackapi/slack-mcp-plugin.git',
      'ssh://git@github.com/slackapi/slack-mcp-plugin.git',
      'file:///Users/someone/plugins/slack',
    ]) {
      expect(
        pluginPackageKey(plugin({ externalSource: { source: 'url', url } })),
      ).toBeUndefined();
    }
  });
});

describe('mcpEndpointKey', () => {
  it('keys http servers by host from a URL or a stored host', () => {
    expect(
      mcpEndpointKey({ type: 'http', url: 'https://MCP.slack.com/mcp' }),
    ).toBe('http:mcp.slack.com');
    expect(mcpEndpointKey({ type: 'http', urlHost: 'mcp.slack.com' })).toBe(
      'http:mcp.slack.com',
    );
  });

  it('keys command servers by the constant command', () => {
    expect(mcpEndpointKey({ type: 'command' })).toBe('command');
  });

  it('returns null for an http server without a parseable host', () => {
    expect(mcpEndpointKey({ type: 'http' })).toBeNull();
    expect(mcpEndpointKey({ type: 'http', url: 'not a url' })).toBeNull();
  });
});
