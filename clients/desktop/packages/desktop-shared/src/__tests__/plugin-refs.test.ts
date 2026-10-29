import {
  computePluginShareableRef,
  parseShareableGitHubSource,
} from '../plugin-refs';
import type { MarketplaceInfo, PluginInfo } from '../types/plugins';

// Review finding on #3132 (critical): the shareable ref is published inside
// public plugin share references, so a marketplace source carrying userinfo,
// a query, a fragment, an extra path or a non-GitHub host must never become
// one. The previous parser let `?token=secret#frag` through as part of the
// repository segment.
describe('parseShareableGitHubSource', () => {
  it.each([
    ['https://github.com/acme/plugins', 'acme/plugins'],
    ['https://www.github.com/acme/plugins.git', 'acme/plugins'],
    ['acme/plugins', 'acme/plugins'],
    ['  acme/plugins  ', 'acme/plugins'],
  ])('accepts a plain GitHub repository source %s', (input, expected) => {
    expect(parseShareableGitHubSource(input)).toBe(expected);
  });

  it.each([
    'https://mp-user:mp-source-secret@github.com/acme/marketplace',
    'https://github.com/acme/marketplace?token=secret',
    'https://github.com/acme/marketplace#frag',
    'https://github.com/acme/marketplace?token=secret#frag',
    'https://gitlab.com/acme/marketplace',
    'https://github.com/acme/marketplace/tree/main',
    'https://github.com/acme',
    'git@github.com:acme/marketplace.git',
    'acme/marketplace?token=secret',
    'acme/market place',
    'builtin:app',
    'curated:cloud',
    '',
    null,
    undefined,
  ])('rejects %s', (input) => {
    expect(parseShareableGitHubSource(input)).toBeUndefined();
  });
});

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'My Plugin',
    sourcePath: 'plugins/my-plugin',
    marketplaceId: 'mkt-1',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    ...overrides,
  };
}

function makeMarketplace(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'mkt-1',
    name: 'Acme Plugins',
    sourceType: 'github',
    sourceUrl: 'https://github.com/acme/plugins',
    installLocation: '/tmp/mkt',
    pluginCount: 1,
    plugins: [],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
    },
    validProviders: ['claude', 'codex'],
    ...overrides,
  };
}

describe('computePluginShareableRef', () => {
  it('names the GitHub repository for a clean source', () => {
    expect(computePluginShareableRef(makePlugin(), makeMarketplace())).toEqual({
      type: 'claude_plugin',
      marketplace: { type: 'github', repo: 'acme/plugins' },
      plugin_name: 'My Plugin',
    });
  });

  it('refuses to build a ref from a credentialed or decorated source', () => {
    for (const sourceUrl of [
      'https://mp-user:secret@github.com/acme/plugins',
      'https://github.com/acme/plugins?token=secret#frag',
    ]) {
      expect(
        computePluginShareableRef(makePlugin(), makeMarketplace({ sourceUrl })),
      ).toBeUndefined();
    }
  });
});
