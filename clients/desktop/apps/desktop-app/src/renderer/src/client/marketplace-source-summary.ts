import {
  marketplaceDisplayName,
  pluginDisplayName,
  pluginDisplayAuthor,
} from '@canopy/ui-shared';
import { pluginHasContent } from '@canopy/ui-shared/lib/plugin-install-status';
import type {
  MarketplaceSource,
  MarketplaceSourceError,
  MarketplaceSourcePlugin,
  MarketplaceSourcePluginInstallState,
  MarketplaceSourceProviderInstallState,
  MarketplaceSourceProviderStatus,
  MarketplaceSourceStatus,
} from '@canopy/app-core/client';
import type {
  BuiltInProviderInstallStatus,
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginInfo,
  PluginProvider,
} from '@canopy/execution-engine/types/plugins';
import { brandText } from '@/lib/brand';
import { parseGitHubRepo } from '@/lib/format';

const PROVIDERS: readonly PluginProvider[] = ['claude', 'codex'];

export function marketplaceProviderLabel(provider: PluginProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

/** Built-in and curated rows are provisioned by the app and always usable. */
export function isManagedMarketplace(marketplace: MarketplaceInfo): boolean {
  return marketplace.builtIn === true || marketplace.curated === true;
}

/** External link for a GitHub-backed row; local sources have none. */
export function marketplaceSourceHref(
  marketplace: MarketplaceInfo,
): string | null {
  if (marketplace.sourceType !== 'github' || !marketplace.sourceUrl) {
    return null;
  }
  const repo = parseGitHubRepo(marketplace.sourceUrl);
  return repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    ? `https://github.com/${repo}`
    : null;
}

/** Confirmation copy shown before removal, keyed to the providers it affects. */
export function formatMarketplaceRemoveBodyCopy(
  validProviders: readonly PluginProvider[],
): string {
  const [onlyProvider] = validProviders;
  if (validProviders.length >= 2) {
    return `${brandText.appName} will remove this marketplace from Claude and Codex. Plugin selections that depend on it will be cleared.`;
  }
  if (onlyProvider) {
    return `${brandText.appName} will remove this marketplace from ${marketplaceProviderLabel(onlyProvider)}. Plugin selections that depend on it will be cleared.`;
  }
  return `${brandText.appName} will forget this marketplace. Plugin selections that depend on it will be cleared.`;
}

function toProviderInstallState(
  status: BuiltInProviderInstallStatus,
): MarketplaceSourceProviderInstallState {
  // `installPath` stays behind: DTOs carry no host paths.
  return {
    available: status.available,
    installed: status.installed,
    ...(status.enabled !== undefined ? { enabled: status.enabled } : {}),
    ...(status.version ? { version: status.version } : {}),
    ...(status.error ? { error: status.error } : {}),
    ...(status.installError ? { installError: status.installError } : {}),
  };
}

function toInstallState(
  plugin: PluginInfo,
): MarketplaceSourcePluginInstallState {
  const providers: Partial<
    Record<PluginProvider, MarketplaceSourceProviderInstallState>
  > = {};
  for (const provider of PROVIDERS) {
    const status = plugin.globalInstallStatus?.[provider];
    if (status) providers[provider] = toProviderInstallState(status);
  }
  return {
    externalSource: plugin.externalSource !== undefined,
    hasContent: pluginHasContent(plugin),
    providers,
    ...(plugin.globalInstallStatus?.checkedAt
      ? { checkedAt: plugin.globalInstallStatus.checkedAt }
      : {}),
    ...(plugin.codexCompatDisabled !== undefined
      ? { codexCompatDisabled: plugin.codexCompatDisabled }
      : {}),
  };
}

export function toMarketplaceSourcePlugin(
  plugin: PluginInfo,
): MarketplaceSourcePlugin {
  return {
    key: plugin.name,
    name: pluginDisplayName(plugin),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
    ...(plugin.category?.trim()
      ? { categories: [plugin.category.trim()] }
      : {}),
    ...(pluginDisplayAuthor(plugin.marketplaceId, plugin)?.trim()
      ? { author: pluginDisplayAuthor(plugin.marketplaceId, plugin)?.trim() }
      : {}),
    ...(plugin.recommended !== undefined
      ? { recommended: plugin.recommended }
      : {}),
    providerSupport: plugin.providerSupport,
    installState: toInstallState(plugin),
  };
}

function toProviderStatus(
  status: MarketplaceProviderStatus,
): MarketplaceSourceProviderStatus {
  // Provider manifest paths and install roots stay behind.
  return {
    state: status.state,
    accepted: status.accepted,
    pluginCount: status.pluginCount,
    lastCheckedAt: status.lastCheckedAt,
    ...(status.error ? { error: status.error } : {}),
  };
}

const CODEX_STRUCTURAL_NOTE =
  'Codex support is not rechecked automatically until this repository changes. Use Update to check again now.';

function toStatus(marketplace: MarketplaceInfo): MarketplaceSourceStatus {
  const managed = isManagedMarketplace(marketplace);
  const errors: MarketplaceSourceError[] = [];
  for (const provider of PROVIDERS) {
    const status = marketplace.providerStatus[provider];
    if (!managed && status.state === 'invalid' && status.error) {
      errors.push({
        label: marketplaceProviderLabel(provider),
        message: status.error,
        provider,
      });
    }
  }
  const note =
    !managed &&
    marketplace.providerStatus.codex.structurallyInvalidAtRevision !== undefined
      ? CODEX_STRUCTURAL_NOTE
      : undefined;
  const noteField = note ? { note } : {};
  if (managed || marketplace.validProviders.length > 0) {
    return { state: 'valid', errors, ...noteField };
  }
  const [first, ...rest] = errors;
  return {
    state: 'invalid',
    errors: first
      ? [first, ...rest]
      : [
          {
            label: 'Marketplace',
            message: 'Neither Claude nor Codex could load this marketplace.',
          },
        ],
    ...noteField,
  };
}

function toSourceLabel(marketplace: MarketplaceInfo): string {
  if (marketplace.builtIn === true) return `${brandText.appName} built-in`;
  if (marketplace.curated === true) return `${brandText.appName} curated`;
  if (marketplace.sourceType === 'github' && marketplace.sourceUrl) {
    return (
      marketplaceSourceHref(marketplace)?.replace('https://github.com/', '') ??
      'GitHub'
    );
  }
  // Local and unknown sources are host paths; show only their type.
  return marketplace.sourceType;
}

/** Path-free projection of a cached marketplace row. */
export function toMarketplaceSource(
  marketplace: MarketplaceInfo,
): MarketplaceSource {
  const managed = isManagedMarketplace(marketplace);
  const href = managed ? null : marketplaceSourceHref(marketplace);
  return {
    id: marketplace.id,
    name: marketplaceDisplayName(marketplace.name),
    ...(marketplace.description
      ? { description: marketplace.description }
      : {}),
    kind:
      marketplace.builtIn === true
        ? 'builtin'
        : marketplace.curated === true
          ? 'curated'
          : marketplace.sourceType,
    sourceLabel: toSourceLabel(marketplace),
    ...(href ? { sourceUrl: href } : {}),
    status: toStatus(marketplace),
    ...(marketplace.lastUpdated
      ? { lastUpdatedAt: marketplace.lastUpdated }
      : {}),
    pluginCount: marketplace.pluginCount,
    // Legacy rules: curated rows never update; managed rows never remove.
    actions: {
      update: marketplace.curated !== true,
      remove: !managed && marketplace.removable !== false,
    },
    plugins: marketplace.plugins.map(toMarketplaceSourcePlugin),
    providerStatus: {
      claude: toProviderStatus(marketplace.providerStatus.claude),
      codex: toProviderStatus(marketplace.providerStatus.codex),
    },
  };
}

/** Providers the removal confirmation names, from the projected status. */
export function marketplaceSourceValidProviders(
  source: MarketplaceSource,
): PluginProvider[] {
  return PROVIDERS.filter(
    (provider) => source.providerStatus?.[provider]?.state === 'valid',
  );
}
