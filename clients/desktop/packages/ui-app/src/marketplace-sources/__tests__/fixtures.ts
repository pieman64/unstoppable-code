import type {
  MarketplaceSource,
  MarketplaceSourcePlugin,
} from '@canopy/app-core/client';

export function sourcePlugin(
  key: string,
  overrides: Partial<MarketplaceSourcePlugin> = {},
): MarketplaceSourcePlugin {
  return { key, name: key, ...overrides };
}

export function missingInstallState(): MarketplaceSourcePlugin['installState'] {
  return { externalSource: true, hasContent: false, providers: {} };
}

export function installedState(): MarketplaceSourcePlugin['installState'] {
  return { externalSource: true, hasContent: true, providers: {} };
}

export function marketplaceSource(
  id: string,
  overrides: Partial<MarketplaceSource> = {},
): MarketplaceSource {
  const plugins = overrides.plugins ?? [];
  return {
    id,
    name: `Source ${id}`,
    kind: 'github',
    sourceLabel: `acme/${id}`,
    status: { state: 'valid', errors: [] },
    pluginCount: plugins.length,
    actions: { update: true, remove: true },
    plugins,
    ...overrides,
  };
}
