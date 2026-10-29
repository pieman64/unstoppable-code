import type { JSX } from 'react';

import { LoadingPlaceholder } from './StatusBlocks';
import { pluginDisplayAuthor } from '../lib/official-marketplace-products';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

// ---------------------------------------------------------------------------
// Narrow structural prop types
//
// These are deliberately minimal shapes covering only the fields the sections
// render. Desktop passes its richer `@canopy/desktop-shared` types
// (`DetectedMcpServerInfo`, `MarketplaceInfo`, `PluginInfo`,
// `McpServerData`) via structural compatibility — do NOT import
// `@canopy/desktop-shared` here; ui-shared must stay pure.
// ---------------------------------------------------------------------------

/** Fallback display fields read off the detected server row. */
export interface McpPluginSectionServer {
  readonly pluginName?: string;
  readonly marketplaceId?: string;
}

/** Plugin display fields rendered by {@link PluginSection}. */
export interface McpPluginSectionPlugin {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
  readonly category?: string;
  readonly homepage?: string;
  readonly externalSource?: {
    readonly url?: string;
    readonly sha?: string;
  };
}

/** Marketplace display fields rendered by {@link PluginSection}. */
export interface McpPluginSectionMarketplace {
  readonly name: string;
  readonly description?: string;
  readonly sourceType?: string;
  readonly sourceUrl?: string;
}

/** Resolved plugin + marketplace context for a plugin-sourced MCP server. */
export interface McpPluginSectionContext {
  readonly marketplace: McpPluginSectionMarketplace | null;
  readonly plugin: McpPluginSectionPlugin | null;
}

/** One configuration variant rendered by {@link StandaloneConfigsSection}. */
export interface McpStandaloneConfig {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly envVars: Readonly<Record<string, string>>;
  readonly extraArgs: readonly string[];
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly authToken?: string;
}

/** Standalone server payload rendered by {@link StandaloneConfigsSection}. */
export interface McpStandaloneConfigsData {
  readonly configs: readonly McpStandaloneConfig[];
}

/**
 * The author the section credits: the product's vendor for an official listing
 * OpenAI maintains on another vendor's behalf, as every plugin surface credits
 * it, and otherwise the plugin's own declared author.
 */
function pluginSectionAuthor(
  server: McpPluginSectionServer,
  plugin: McpPluginSectionPlugin | null | undefined,
): string | undefined {
  return plugin ? pluginDisplayAuthor(server.marketplaceId, plugin) : undefined;
}

/**
 * "Plugin & Marketplace" section of the MCP server details view. Ported from
 * the desktop `McpServerDetailsModal` internal — class names, copy, and
 * testids match it exactly so tests/selectors and visual diffs are unchanged.
 */
export function PluginSection({
  server,
  loading,
  error,
  context,
}: {
  server: McpPluginSectionServer;
  loading: boolean;
  error: string | null;
  context: McpPluginSectionContext | null;
}): JSX.Element {
  const author = pluginSectionAuthor(server, context?.plugin);
  return (
    <div data-testid="mcp-server-details-plugin-section">
      <h3 className="mb-2 text-s font-medium fg-primary">
        Plugin & marketplace
      </h3>
      {loading && <LoadingPlaceholder />}
      {error && (
        <div className="rounded-lg border border-line-destructive/20 bg-destructive-subtle px-3 py-2 text-s fg-destructive">
          {error}
        </div>
      )}
      {!loading && !error && context && (
        <div className="rounded-lg border bg-secondary/20 px-4 py-3">
          <dl className="space-y-1.5 text-s">
            <div className="flex gap-2">
              <dt className="whitespace-nowrap font-medium fg-primary">
                Plugin:
              </dt>
              <dd className="fg-secondary">
                {context.plugin?.name ?? server.pluginName ?? '—'}
                {context.plugin?.version ? ` · v${context.plugin.version}` : ''}
              </dd>
            </div>
            {context.plugin?.description && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  Description:
                </dt>
                <dd className="fg-secondary">{context.plugin.description}</dd>
              </div>
            )}
            {author && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  Author:
                </dt>
                <dd className="fg-secondary">{author}</dd>
              </div>
            )}
            {context.plugin?.category && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  Category:
                </dt>
                <dd className="fg-secondary">{context.plugin.category}</dd>
              </div>
            )}
            {context.plugin?.homepage && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  Homepage:
                </dt>
                <dd className="break-all">
                  <a
                    href={context.plugin.homepage}
                    target="_blank"
                    rel="noreferrer"
                    className="fg-accent hover:underline"
                  >
                    {context.plugin.homepage}
                  </a>
                </dd>
              </div>
            )}
            {context.plugin?.externalSource?.url && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  Source:
                </dt>
                <dd className="break-all">
                  <a
                    href={context.plugin.externalSource.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs fg-accent hover:underline"
                  >
                    {context.plugin.externalSource.url}
                  </a>
                  {context.plugin.externalSource.sha && (
                    <span className="ml-2 font-mono text-xs fg-secondary">
                      @{context.plugin.externalSource.sha.slice(0, 7)}
                    </span>
                  )}
                </dd>
              </div>
            )}
            <div className="flex gap-2 border-t pt-1.5">
              <dt className="whitespace-nowrap font-medium fg-primary">
                Marketplace:
              </dt>
              <dd className="fg-secondary">
                {context.marketplace?.name ?? server.marketplaceId ?? '—'}
              </dd>
            </div>
            {context.marketplace?.description && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  About:
                </dt>
                <dd className="fg-secondary">
                  {context.marketplace.description}
                </dd>
              </div>
            )}
            {context.marketplace?.sourceUrl && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  Source:
                </dt>
                <dd className="break-all font-mono text-xs fg-secondary">
                  {context.marketplace.sourceType === 'github' ? (
                    <a
                      href={`https://github.com/${context.marketplace.sourceUrl}`}
                      target="_blank"
                      rel="noreferrer"
                      className="fg-accent hover:underline"
                    >
                      {context.marketplace.sourceUrl}
                    </a>
                  ) : (
                    context.marketplace.sourceUrl
                  )}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * "Configurations" section of the MCP server details view for standalone
 * servers. Ported from the desktop `McpServerDetailsModal` internal — class
 * names and copy match it exactly so tests/selectors and visual diffs are
 * unchanged.
 */
export function StandaloneConfigsSection({
  loading,
  error,
  serverData,
}: {
  loading: boolean;
  error: string | null;
  serverData: McpStandaloneConfigsData | null;
}): JSX.Element {
  return (
    <div>
      <h3 className="mb-2 text-s font-medium fg-primary">
        Configurations
        {serverData ? ` (${serverData.configs.length})` : ''}
      </h3>
      {loading && <LoadingPlaceholder />}
      {error && (
        <div className="rounded-lg border border-line-destructive/20 bg-destructive-subtle px-3 py-2 text-s fg-destructive">
          {error}
        </div>
      )}
      {!loading && !error && serverData && (
        <>
          {serverData.configs.length === 0 ? (
            <p className="text-xs italic fg-secondary">No configurations.</p>
          ) : (
            <div className="space-y-2">
              {serverData.configs.map((config) => (
                <div
                  key={config.id}
                  className="rounded-lg border bg-secondary/20 px-3 py-2"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-s font-medium fg-primary">
                      {config.name}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-3xs font-medium ${
                        config.enabled
                          ? 'bg-success-subtle fg-success'
                          : 'bg-secondary fg-secondary'
                      }`}
                    >
                      {config.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  {config.description && (
                    <p className="mb-1 text-xs fg-secondary">
                      {config.description}
                    </p>
                  )}
                  <dl className="space-y-1 text-xs">
                    {Object.keys(config.envVars).length > 0 && (
                      <div className="flex gap-2">
                        <dt className="whitespace-nowrap font-medium fg-primary">
                          Env vars:
                        </dt>
                        <dd className="fg-secondary">
                          {Object.keys(config.envVars).join(', ')}
                        </dd>
                      </div>
                    )}
                    {config.extraArgs.length > 0 && (
                      <div className="flex gap-2">
                        <dt className="whitespace-nowrap font-medium fg-primary">
                          Extra args:
                        </dt>
                        <dd
                          className={`${REPLAY_BLOCK_CLASS} font-mono fg-secondary`}
                        >
                          {config.extraArgs.join(' ')}
                        </dd>
                      </div>
                    )}
                    {Object.keys(config.extraHeaders).length > 0 && (
                      <div className="flex gap-2">
                        <dt className="whitespace-nowrap font-medium fg-primary">
                          Extra headers:
                        </dt>
                        <dd className="fg-secondary">
                          {Object.keys(config.extraHeaders).join(', ')}
                        </dd>
                      </div>
                    )}
                    {config.authToken && (
                      <div className="flex gap-2">
                        <dt className="whitespace-nowrap font-medium fg-primary">
                          Auth token:
                        </dt>
                        <dd className="fg-secondary">configured</dd>
                      </div>
                    )}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
