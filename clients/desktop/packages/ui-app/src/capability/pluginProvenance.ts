/**
 * Plugin provenance helpers for the unified projection (CAN-3653): who
 * publishes a marketplace plugin, which package it is, and which MCP endpoint
 * a bundled server or installed row points at. Pure and deterministic.
 */
import type {
  UnifiedBundledMcpServerInput,
  UnifiedMarketplaceInput,
  UnifiedMarketplacePluginInput,
} from './unifiedPluginEntries';

/**
 * A GitHub handle: alphanumeric, single interior hyphens, no leading/trailing
 * hyphen. Owners are interpolated into URLs downstream, so anything that could
 * carry a path, query, or scheme out of that position is refused outright
 * rather than escaped.
 */
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** `git@github.com:<owner>/<repo>` SSH remotes. */
const GITHUB_SSH_PATTERN = /^git@github\.com:([^/]*)\//i;

/**
 * The GitHub owner of a repository URL, or nothing if it is not one. Accepts
 * `http(s)://(www.)github.com/<owner>/…` and `git@github.com:<owner>/…`.
 */
export function githubOwner(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  const ssh = GITHUB_SSH_PATTERN.exec(url);
  if (ssh) {
    const owner = ssh[1];
    return owner !== undefined && GITHUB_OWNER_PATTERN.test(owner)
      ? owner
      : undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return undefined;
  }
  // Compared exactly, never by prefix/suffix: `github.com.evil.example` and
  // `notgithub.com` must not match.
  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return undefined;
  }
  // Indexed rather than filtered for empties: on `github.com//repo` the owner
  // slot is genuinely empty, and skipping it would promote the NEXT segment
  // into the owner position.
  const owner = parsed.pathname.split('/')[1];
  if (owner === undefined || !GITHUB_OWNER_PATTERN.test(owner)) {
    return undefined;
  }
  return owner;
}

/** The plugin package's own source URL, from either host's input shape. */
function pluginExternalSourceUrl(
  plugin: UnifiedMarketplacePluginInput,
): string | undefined {
  return plugin.externalSourceUrl ?? plugin.externalSource?.url;
}

function nativeProvider(
  plugin: UnifiedMarketplacePluginInput,
): 'Claude' | 'Codex' | undefined {
  if (plugin.providerSupport?.claude === 'native') return 'Claude';
  if (plugin.providerSupport?.codex === 'native') return 'Codex';
  return undefined;
}

/**
 * Where a marketplace plugin comes from, as one line of row metadata: the
 * provider it runs natively on, then a GitHub owner or the catalog name
 * (`Claude · slackapi`, `Codex official`). The owner is the package's, else the
 * catalog repository's, so it is not a verified publisher.
 */
export function pluginSourceLabel(
  marketplace: UnifiedMarketplaceInput,
  plugin: UnifiedMarketplacePluginInput,
): string {
  const provider = nativeProvider(plugin);
  if (provider === undefined) return marketplace.name;
  const owner =
    githubOwner(pluginExternalSourceUrl(plugin)) ??
    githubOwner(marketplace.sourceUrl);
  if (owner !== undefined) return `${provider} · ${owner}`;
  // A catalog already named for its provider (`Codex official`) reads fine
  // alone; repeating the provider would say it twice.
  if (marketplace.name.toLowerCase().startsWith(provider.toLowerCase())) {
    return marketplace.name;
  }
  return `${provider} · ${marketplace.name}`;
}

/**
 * Identity of the package a plugin is built from: its external source URL
 * reduced to scheme, host and path (as the Portal row carries it, so the
 * desktop's raw source and the web's sanitized copy agree), case-folded and
 * without a trailing `/` or `.git`. A monorepo subdirectory is not part of it:
 * the Portal row does not carry one. Absent when it publishes none or the
 * source is not an http(s) URL, the only sources the Portal row carries; such
 * a package collapses by name like one that publishes no source.
 */
export function pluginPackageKey(
  plugin: UnifiedMarketplacePluginInput,
): string | undefined {
  const url = pluginExternalSourceUrl(plugin);
  if (url === undefined || url === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  return `${parsed.origin}${parsed.pathname}`
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

/** The MCP servers a plugin bundles, from either host's input shape. */
export function bundledMcpServersOf(
  plugin: UnifiedMarketplacePluginInput,
): readonly UnifiedBundledMcpServerInput[] {
  return plugin.bundledMcpServers ?? plugin.details?.mcpServers ?? [];
}

export { mcpEndpointKey } from '@canopy/ui-shared';
