/** @jest-environment jsdom */
import type {
  MarketplacePluginExternalSource,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import { installRecommendedPlugin } from '../installRecommendedPlugin';
jest.mock('@/hooks/useMarketplaceList', () => ({
  applyPluginUpdateToMarketplaceCaches: jest.fn(),
}));

function plugin(name: string, marketplaceId = 'openai-curated'): PluginInfo {
  return {
    name,
    marketplaceId,
    sourcePath: name,
    facets: {},
    providerSupport: { claude: 'none', codex: 'native' },
  };
}
const api = {
  loadMarketplacesCacheOnly: jest.fn(),
  installPlugin: jest.fn(),
  installBuiltInPlugin: jest.fn(),
};
function catalog(plugins: PluginInfo[]): void {
  api.loadMarketplacesCacheOnly.mockResolvedValue({
    success: true,
    data: { marketplaces: [{ plugins }] },
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  Object.defineProperty(window, 'plugins', { configurable: true, value: api });
});

it.each([
  'Slack',
  'Vercel',
  'gmail',
  'google-calendar',
  'notion',
  'bigquery',
  'snowflake',
  'datadog',
])(
  'resolves the exact bundled %s identity rather than constructing a details URL',
  async (name) => {
    const original = plugin(name);
    catalog([original]);
    expect(
      await installRecommendedPlugin([`openai-curated/${name.toLowerCase()}`]),
    ).toEqual(original);
    expect(api.installBuiltInPlugin).not.toHaveBeenCalled();
  },
);
it('installs an external bundle before considering it usable', async () => {
  const externalSource: MarketplacePluginExternalSource = {
    source: 'github',
    url: 'https://example.com/vercel.git',
  };
  const original = {
    ...plugin('Vercel'),
    externalSource,
  };
  const installed: PluginInfo = {
    ...original,
    details: {
      skills: [],
      agents: [],
      commands: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
      hasReadme: true,
    },
  };
  catalog([original]);
  api.installPlugin.mockResolvedValue({ success: true, data: installed });
  expect(await installRecommendedPlugin(['openai-curated/vercel'])).toEqual(
    installed,
  );
  expect(api.installPlugin).toHaveBeenCalledWith(
    'openai-curated',
    'Vercel',
    externalSource.url,
  );
});
it('installs only supported missing providers and reports partial failures', async () => {
  const original = plugin('Slack', 'curated/cloud');
  catalog([original]);
  api.installBuiltInPlugin.mockResolvedValue({
    success: true,
    data: {
      plugin: original,
      providerOutcomes: { codex: { installed: false } },
    },
  });
  await expect(
    installRecommendedPlugin(['curated/cloud/slack']),
  ).rejects.toThrow('Could not install');
  expect(api.installBuiltInPlugin).toHaveBeenCalledWith({
    marketplaceId: 'curated/cloud',
    pluginName: 'Slack',
    providers: ['codex'],
  });
});
it('fails safely for an unavailable catalog entry', async () => {
  catalog([]);
  await expect(
    installRecommendedPlugin(['openai-curated/slack']),
  ).rejects.toThrow('unavailable');
  expect(api.installPlugin).not.toHaveBeenCalled();
});
