import type { JSX } from 'react';

import { CenteredLoadingSpinner } from './CenteredLoadingSpinner';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { ErrorBanner } from './StatusBlocks';
import { Fact, FactList } from './FactList';
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
 * "Plugin & Marketplace" section of the MCP server details view: the plugin's
 * facts, then the marketplace's under a rule.
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
      {loading && (
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner className="my-12" />
        </DelayedLoadingPlaceholder>
      )}
      <ErrorBanner className="" error={error} />
      {!loading && !error && context && (
        <div className="rounded-lg border bg-secondary/20 px-4 py-3">
          {/* One label width for both lists, so their values line up. */}
          <FactList labelWidth="6rem" rowGap="2" labelTone="secondary">
            <Fact label="Plugin">
              {context.plugin?.name ?? server.pluginName ?? '—'}
              {context.plugin?.version ? ` · v${context.plugin.version}` : ''}
            </Fact>
            {context.plugin?.description && (
              <Fact label="Description">{context.plugin.description}</Fact>
            )}
            {author && <Fact label="Author">{author}</Fact>}
            {context.plugin?.category && (
              <Fact label="Category">{context.plugin.category}</Fact>
            )}
            {context.plugin?.homepage && (
              <Fact label="Homepage" fit="break-all">
                <a
                  href={context.plugin.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="fg-accent hover:underline"
                >
                  {context.plugin.homepage}
                </a>
              </Fact>
            )}
            {context.plugin?.externalSource?.url && (
              <Fact label="Source" fit="break-all" mono>
                <a
                  href={context.plugin.externalSource.url}
                  target="_blank"
                  rel="noreferrer"
                  className="fg-accent hover:underline"
                >
                  {context.plugin.externalSource.url}
                </a>
                {context.plugin.externalSource.sha && (
                  <span className="ml-2 fg-secondary">
                    @{context.plugin.externalSource.sha.slice(0, 7)}
                  </span>
                )}
              </Fact>
            )}
          </FactList>
          <FactList
            labelWidth="6rem"
            rowGap="2"
            labelTone="secondary"
            divided
            placement="mt-2"
          >
            <Fact label="Marketplace">
              {context.marketplace?.name ?? server.marketplaceId ?? '—'}
            </Fact>
            {context.marketplace?.description && (
              <Fact label="About">{context.marketplace.description}</Fact>
            )}
            {context.marketplace?.sourceUrl && (
              <Fact label="Source" fit="break-all" mono>
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
              </Fact>
            )}
          </FactList>
        </div>
      )}
    </div>
  );
}

/** One configuration's settings: names only, never secret values. */
export function McpConfigFacts({
  config,
}: {
  config: McpStandaloneConfig;
}): JSX.Element {
  return (
    <FactList rowGap="2" labelTone="secondary">
      {Object.keys(config.envVars).length > 0 && (
        <Fact label="Env vars">{Object.keys(config.envVars).join(', ')}</Fact>
      )}
      {config.extraArgs.length > 0 && (
        <Fact label="Extra args" mono fit="break-all">
          {/* Args often carry API keys inline. */}
          <span className={REPLAY_BLOCK_CLASS}>
            {config.extraArgs.join(' ')}
          </span>
        </Fact>
      )}
      {Object.keys(config.extraHeaders).length > 0 && (
        <Fact label="Extra headers">
          {Object.keys(config.extraHeaders).join(', ')}
        </Fact>
      )}
      {config.authToken && <Fact label="Auth token">configured</Fact>}
    </FactList>
  );
}

/** A local MCP server's connection: how it runs and where it points. */
export interface McpConnectionFactsProps {
  /** Where the server comes from, for a detected server. */
  readonly source?: string | undefined;
  /** The server's name inside its plugin, for a plugin server. */
  readonly pluginServerName?: string | undefined;
  readonly type: 'command' | 'http';
  /** Shown for an HTTP server. */
  readonly url?: string | undefined;
  /** The full command line; rendered replay-blocked (args carry keys). */
  readonly commandLine?: string | undefined;
  /** Whether OAuth is configured; omitted hides the fact. */
  readonly oauth?: boolean | undefined;
}

/**
 * The connection facts of a local MCP server, in the fact list the web MCP
 * detail uses (design call 4A, 2026-10-31). The desktop MCP page and the MCP
 * details dialog both render it.
 */
export function McpConnectionFacts({
  source,
  pluginServerName,
  type,
  url,
  commandLine,
  oauth,
}: McpConnectionFactsProps): JSX.Element {
  return (
    <FactList
      rowGap="2"
      labelTone="secondary"
      dataTestId="mcp-server-connection-facts"
    >
      {source !== undefined && <Fact label="Source">{source}</Fact>}
      {pluginServerName && (
        <Fact label="Plugin server">{pluginServerName}</Fact>
      )}
      <Fact label="Type">
        {type === 'command' ? 'Command (stdio)' : 'HTTP'}
      </Fact>
      {type === 'http' && url && (
        <Fact label="URL" mono fit="break-all">
          {url}
        </Fact>
      )}
      {commandLine && (
        <Fact label="Command" mono fit="break-all">
          <span className={REPLAY_BLOCK_CLASS}>{commandLine}</span>
        </Fact>
      )}
      {oauth !== undefined && (
        <Fact label="OAuth">{oauth ? 'configured' : 'not configured'}</Fact>
      )}
    </FactList>
  );
}

/**
 * "Configurations" section of a standalone MCP server: one card per
 * configuration. The MCP details dialog and the desktop MCP page render it.
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
      {loading && (
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner className="my-12" />
        </DelayedLoadingPlaceholder>
      )}
      <ErrorBanner className="" error={error} />
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
                  <McpConfigFacts config={config} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
