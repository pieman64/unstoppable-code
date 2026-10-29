import type {
  MarketplaceInfo,
  PluginInfo,
  PluginDetails,
} from '@canopy/desktop-shared/types/plugins';
import {
  countPluginsNeedingInstall,
  pluginNeedsInstall,
} from '../pluginInstallStatus';

const emptyDetails: PluginDetails = {
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
  hasReadme: false,
};

function makePlugin(overrides: Partial<PluginInfo>): PluginInfo {
  return {
    name: 'p',
    sourcePath: '',
    marketplaceId: 'm',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    ...overrides,
  };
}

describe('pluginNeedsInstall', () => {
  it('is false for a retained parked plugin without provider details', () => {
    expect(
      pluginNeedsInstall(
        makePlugin({
          parked: true,
          externalSource: { source: 'github', url: 'https://x/y' },
          details: null,
        }),
      ),
    ).toBe(false);
  });

  it('is true for an external plugin with no details anywhere', () => {
    expect(
      pluginNeedsInstall(
        makePlugin({
          externalSource: { source: 'github', url: 'https://x/y' },
          details: null,
        }),
      ),
    ).toBe(true);
  });

  it('is false once top-level details are present', () => {
    expect(
      pluginNeedsInstall(
        makePlugin({
          externalSource: { source: 'github', url: 'https://x/y' },
          details: emptyDetails,
        }),
      ),
    ).toBe(false);
  });

  it('is false when a facet carries details', () => {
    expect(
      pluginNeedsInstall(
        makePlugin({
          externalSource: { source: 'github', url: 'https://x/y' },
          details: null,
          facets: {
            claude: {
              provider: 'claude',
              mode: 'native',
              name: 'p',
              installLocation: '/i',
              sourcePath: '/s',
              details: emptyDetails,
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('is false for an inline plugin with no external source', () => {
    expect(pluginNeedsInstall(makePlugin({ details: emptyDetails }))).toBe(
      false,
    );
  });
});

describe('countPluginsNeedingInstall', () => {
  it('counts only external plugins missing details', () => {
    const marketplace: MarketplaceInfo = {
      id: 'm',
      name: 'M',
      sourceType: 'github',
      sourceUrl: 'https://x/y',
      installLocation: '/i',
      pluginCount: 3,
      plugins: [
        makePlugin({
          name: 'needs',
          externalSource: { source: 'github', url: 'u' },
          details: null,
        }),
        makePlugin({
          name: 'done',
          externalSource: { source: 'github', url: 'u' },
          details: emptyDetails,
        }),
        makePlugin({ name: 'inline', details: emptyDetails }),
      ],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: 3,
          lastCheckedAt: '2026-06-17T00:00:00.000Z',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-06-17T00:00:00.000Z',
        },
      },
      validProviders: ['claude'],
    };
    expect(countPluginsNeedingInstall(marketplace)).toBe(1);
  });
});
