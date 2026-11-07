'use client';

import type { JSX, ReactNode } from 'react';
import {
  curatedMcpProviderOnly,
  type CuratedMcpConnectorProvider,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import {
  Badge,
  ErrorBanner,
  Button,
  ExternalTextLink,
  DelayedLoadingPlaceholder,
  McpServerLogo,
  Notice,
  PluginConfigurationButton,
  PluginConnectionRouteSection,
  EmptyStateRow,
  Heading,
  Skeleton,
} from '@canopy/ui-shared/components';
import { Divider } from '@canopy/ui-shared/components';
import {
  MCP_PROVIDER_CONNECTOR_LABELS,
  mcpProviderOnlyGuidance,
} from './mcpConnectionCopy';

/**
 * How a provider-only service connects, for a detail with no provider route
 * on screen to do it from (REG-3034). Hosts that render their own route area
 * place it there; `CuratedMcpDetail` shows it when no route is passed.
 */
export function McpProviderOnlyGuidance({
  entry,
}: {
  entry: Pick<McpDetailEntry, 'name' | 'providerConnector'>;
}): JSX.Element {
  return (
    <div data-testid="mcp-browse-detail-provider-guidance">
      <Notice intent="neutral">
        {mcpProviderOnlyGuidance(
          entry.name,
          (entry.providerConnector?.providers ?? []).map(
            (provider: CuratedMcpConnectorProvider): string =>
              MCP_PROVIDER_CONNECTOR_LABELS[provider],
          ),
        )}
      </Notice>
    </div>
  );
}

/** Display-only metadata; local servers need no fabricated catalog entry. */
export type McpDetailEntry = Pick<
  CuratedMcpServerEntry,
  'name' | 'shortDescription'
> &
  Partial<
    Pick<
      CuratedMcpServerEntry,
      | 'key'
      | 'longDescription'
      | 'logoUrl'
      | 'authorName'
      | 'authorUrl'
      | 'docsUrl'
      | 'supportUrl'
      | 'privacyPolicyUrl'
      | 'categories'
      | 'providerConnector'
      | 'oauthHints'
      | 'requiredConfigFields'
    >
  >;

/**
 * The routes a service offers when this entry is not the only one, such as a
 * provider connector folded into an integration card (REG-3033).
 */
export interface CuratedMcpDetailRoutes {
  /** Names the app connection when one exists; omitted for provider-only entries. */
  own?: { title: string; description: string };
  /** The other routes, each its own section, after this entry's tools. */
  others: ReactNode;
}

export interface CuratedMcpDetailProps<
  T extends McpDetailEntry = CuratedMcpServerEntry,
> {
  entry: T;
  installedServerId: string | null;
  toolNames: string[] | null;
  toolsLoading: boolean;
  toolsError: string;
  onAdd?: (entry: T) => void;
  onConfigure?: () => void;
  renderLogo?: (entry: T) => ReactNode;
  actions?: ReactNode;
  connectionContent?: ReactNode;
  /**
   * Set when the service can also be reached another way. This entry's
   * connection and tools then read as one titled route, followed by the
   * others, so nothing on the page reads as belonging to both.
   */
  routes?: CuratedMcpDetailRoutes;
  /** The installed item's Status, under the name and description. */
  statusContent?: ReactNode;
  /**
   * The installed server's management card, which takes the tools in as one of
   * its rows. Omitted, the tools keep their own section.
   */
  renderManagement?: (tools: ReactNode) => ReactNode;
}

export function CuratedMcpDetail<T extends McpDetailEntry>({
  entry,
  installedServerId,
  toolNames,
  toolsLoading,
  toolsError,
  onAdd,
  onConfigure,
  renderLogo,
  actions,
  connectionContent,
  routes,
  statusContent,
  renderManagement,
}: CuratedMcpDetailProps<T>): JSX.Element {
  const providerOnly = curatedMcpProviderOnly(entry);
  // With no provider route on screen (the MCP tab's Browse dialog), say how
  // this service connects rather than ending on its description.
  const showProviderGuidance = providerOnly && !routes?.others;
  const links: Array<{ href: string; label: string }> = [];
  if (entry.docsUrl)
    links.push({ href: entry.docsUrl, label: 'Documentation' });
  if (entry.supportUrl)
    links.push({ href: entry.supportUrl, label: 'Support' });
  if (entry.privacyPolicyUrl)
    links.push({ href: entry.privacyPolicyUrl, label: 'Privacy policy' });

  const toolsBody = (
    <McpToolsBody
      installed={installedServerId !== null}
      toolNames={toolNames}
      toolsLoading={toolsLoading}
      toolsError={toolsError}
    />
  );
  const tools = renderManagement ? (
    renderManagement(<div data-testid="mcp-browse-tools">{toolsBody}</div>)
  ) : (
    <div>
      {routes === undefined ? <Divider /> : null}
      <div
        className={routes === undefined ? 'pt-3' : undefined}
        data-testid="mcp-browse-tools"
      >
        <Heading level={4} variant="label" className="mb-2">
          Tools
        </Heading>
        {toolsBody}
      </div>
    </div>
  );

  return (
    <div
      className="flex flex-1 min-h-0 flex-col gap-4 px-5 pb-5 overflow-y-auto"
      data-testid="mcp-browse-detail"
    >
      <div className="flex items-start gap-3">
        {renderLogo?.(entry) ?? (
          <McpServerLogo
            curatedKey={entry.key}
            logoUrl={entry.logoUrl}
            name={entry.name}
            size={40}
            fallback="monogram"
            imgTestId="mcp-curated-logo"
            fallbackTestId="mcp-curated-logo-fallback"
          />
        )}
        <div className="min-w-0 flex-1">
          <Heading level={3} variant="section">
            {entry.name}
          </Heading>
          {entry.authorName && (
            <p className="mt-0.5 text-xs fg-secondary">
              By{' '}
              {entry.authorUrl ? (
                <ExternalTextLink
                  href={entry.authorUrl}
                  label={entry.authorName}
                />
              ) : (
                <span>{entry.authorName}</span>
              )}
            </p>
          )}
        </div>
        {actions ??
          (providerOnly ? null : installedServerId !== null && onConfigure ? (
            <PluginConfigurationButton onConfigure={onConfigure} />
          ) : onAdd ? (
            <Button
              type="button"
              variant="primary"
              size="compact"
              onClick={() => onAdd(entry)}
              data-testid="mcp-browse-detail-add"
            >
              Add
            </Button>
          ) : null)}
      </div>

      <p className="text-s fg-secondary">
        {entry.longDescription ?? entry.shortDescription}
      </p>
      {links.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {links.map((link) => (
            <ExternalTextLink key={link.label} {...link} />
          ))}
        </div>
      )}
      {Boolean(entry.categories?.length) && (
        <div className="flex flex-wrap gap-1.5">
          {entry.categories?.map((category) => (
            <Badge key={category}>{category}</Badge>
          ))}
        </div>
      )}

      {statusContent}
      {showProviderGuidance && <McpProviderOnlyGuidance entry={entry} />}
      {routes ? (
        <>
          {!providerOnly && routes.own && (
            <PluginConnectionRouteSection
              title={routes.own.title}
              description={routes.own.description}
              dataTestId="mcp-browse-detail-app-route"
            >
              {connectionContent}
              {tools}
            </PluginConnectionRouteSection>
          )}
          {routes.others}
        </>
      ) : (
        <>
          {!providerOnly && connectionContent}
          {!providerOnly && tools}
        </>
      )}
    </div>
  );
}

/** The tool chips, one per tool the server reports. */
function ToolChips({
  toolNames,
}: {
  toolNames: readonly string[];
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1">
      {toolNames.map((tool) => (
        <span
          key={tool}
          data-testid="mcp-browse-tool-chip"
          className="inline-block rounded bg-secondary px-1.5 py-0.5 text-3xs fg-primary"
        >
          {tool}
        </span>
      ))}
    </div>
  );
}

/** Plain tool names the loading skeleton measures. */
const SAMPLE_TOOL_NAMES: readonly string[] = [
  'search_issues',
  'create_issue',
  'list_projects',
  'add_comment',
];

/** What the installed server's tools show, in a section or a card's row. */
function McpToolsBody({
  installed,
  toolNames,
  toolsLoading,
  toolsError,
}: {
  installed: boolean;
  toolNames: string[] | null;
  toolsLoading: boolean;
  toolsError: string;
}): JSX.Element {
  if (!installed)
    return (
      <p className="text-xs fg-secondary">
        Tools appear after you add this server.
      </p>
    );
  if (toolsLoading)
    return (
      <DelayedLoadingPlaceholder slowNote="Still loading tools…">
        <Skeleton
          loading
          label="Loading tools"
          testId="mcp-browse-tools-loading"
        >
          <ToolChips toolNames={SAMPLE_TOOL_NAMES} />
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  if (toolsError)
    return (
      <ErrorBanner
        className=""
        error={toolsError}
        testId="mcp-browse-tools-error"
      />
    );
  if (toolNames === null || toolNames.length === 0)
    return <EmptyStateRow title="No tools discovered yet" />;
  return <ToolChips toolNames={toolNames} />;
}
