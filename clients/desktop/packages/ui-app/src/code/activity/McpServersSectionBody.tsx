'use client';

import { useId, type JSX, type ReactNode } from 'react';
import {
  MCP_ROW_ACTION_CLASS_NAME,
  mcpAuthConnectLabel,
  mcpAuthStatusBadgeClass,
  mcpRowSecondaryText,
  type McpCardAuthStatus,
  type McpCardDisplayServer,
} from '@canopy/ui-shared/lib';
import {
  McpSignInPendingActions,
  McpSignInPendingStatus,
  COMPACT_ACTIVITY_ITEM_CLASS_NAME,
  useActivityItemDensity,
} from '@canopy/ui-shared/components';

export interface McpServersSectionItem extends McpCardDisplayServer {
  readonly key: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly authStatus: McpCardAuthStatus;
  readonly canRefresh?: boolean;
  readonly authStatusLabel: string;
  readonly canConnect: boolean;
  /** Keep the Connect action visible but inert, e.g. while a token is missing. */
  readonly connectDisabled?: boolean;
  /**
   * This row's own connection attempt is in flight. Hosts that can connect
   * several rows at once set it per row; `connectingKey` still marks a single
   * row for hosts that connect one at a time.
   */
  readonly connecting?: boolean;
  /** This row's own disconnect is in flight; `disconnectingKey` still marks a single row. */
  readonly disconnecting?: boolean;
  readonly connectLabel?: string;
  /**
   * Replaces the row's Sign in or Reconnect label, e.g. **Enable** for an
   * account server that needs no sign-in (web). It never adds an action to
   * a row that has none.
   */
  readonly connectActionLabel?: string;
  readonly canDisconnect?: boolean;
  readonly lastError?: string;
  readonly canToggleCanopyProxy?: boolean;
  readonly canopyProxyEnabled?: boolean;
  /**
   * The sign-in page of a sign-in that waits in another tab. The row reads
   * **Waiting…** and offers **Reopen** and a cancel control in place of its
   * Sign in or Reconnect.
   */
  readonly signInUrl?: string;
}

export interface McpServersSectionBodyProps {
  readonly servers: readonly McpServersSectionItem[];
  readonly warnings: readonly string[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly connectingKey: string | null;
  readonly disconnectingKey?: string | null;
  readonly proxyUpdatingKey?: string | null;
  readonly showProxyToggle?: boolean;
  readonly brandAppName: string;
  readonly proxyLogo: ReactNode;
  readonly onConnect?: (server: McpServersSectionItem) => void;
  readonly onDisconnect?: (server: McpServersSectionItem) => void;
  /** Stops waiting on a row's {@link McpServersSectionItem.signInUrl}. */
  readonly onCancelSignIn?: (server: McpServersSectionItem) => void;
  /** Host-owned content rendered under a row (token prompts, inline errors). */
  readonly renderRowExtra?: (server: McpServersSectionItem) => ReactNode;
  readonly onSetCanopyProxyEnabled?: (
    server: McpServersSectionItem,
    enabled: boolean,
  ) => void;
  readonly onOpenDetails?: (server: McpServersSectionItem) => void;
  readonly emptyLabel?: string;
}

export function McpServersSectionBody({
  servers,
  warnings,
  loading,
  error,
  connectingKey,
  disconnectingKey = null,
  proxyUpdatingKey = null,
  showProxyToggle = true,
  brandAppName,
  proxyLogo,
  onConnect,
  onDisconnect,
  onCancelSignIn,
  renderRowExtra,
  onSetCanopyProxyEnabled,
  onOpenDetails,
  emptyLabel,
}: McpServersSectionBodyProps): JSX.Element | null {
  const compact = useActivityItemDensity() === 'compact';
  const body =
    loading && servers.length === 0 ? (
      <p
        className="text-xs fg-secondary"
        data-testid="mcp-servers-card-loading"
      >
        Checking MCP servers…
      </p>
    ) : error !== null ? (
      <p
        className="text-xs fg-destructive"
        data-testid="mcp-servers-card-error"
      >
        {error}
      </p>
    ) : servers.length === 0 ? (
      emptyLabel === undefined ? null : (
        <p
          className="text-xs fg-secondary"
          data-testid="mcp-servers-card-empty"
        >
          {emptyLabel}
        </p>
      )
    ) : (
      <ul
        className={
          compact
            ? 'flex flex-col'
            : 'divide-y overflow-hidden rounded-md border bg-base/30'
        }
        data-testid="mcp-servers-card-list"
      >
        {servers.map((server) => {
          const authConnectLabel = mcpAuthConnectLabel(
            server.authStatus,
            server.canRefresh,
          );
          const connectLabel =
            authConnectLabel === undefined
              ? undefined
              : (server.connectActionLabel ??
                (authConnectLabel === 'Connect'
                  ? 'Sign in'
                  : authConnectLabel));
          const isConnecting =
            server.connecting === true || connectingKey === server.key;
          const isDisconnecting =
            server.disconnecting === true || disconnectingKey === server.key;
          const buttonDisabled =
            !server.canConnect ||
            isConnecting ||
            isDisconnecting ||
            server.connectDisabled === true;
          const showToggle =
            showProxyToggle &&
            server.canToggleCanopyProxy === true &&
            onSetCanopyProxyEnabled !== undefined;
          const signInUrl = server.signInUrl;
          const proxyActive = server.canopyProxyEnabled === true;
          const proxyUpdating = proxyUpdatingKey === server.key;
          const toggleTitle = proxyActive
            ? `${brandAppName} proxy enabled. Click to use agent provider auth.`
            : `Using agent provider auth. Click to use ${brandAppName} proxy.`;
          const toggleClass = compact
            ? // Borderless in the card; it shows on hover or focus unless it
              // is on (its state stays visible) or the pointer is touch.
              proxyActive
              ? 'bg-accent-subtle fg-accent'
              : 'fg-tertiary opacity-0 hover:bg-subtle hover:fg-primary focus-visible:opacity-100 group-hover/mcp-row:opacity-100 group-focus-within/mcp-row:opacity-100 pointer-coarse:opacity-100'
            : proxyActive
              ? 'border-line-accent bg-accent-subtle fg-accent'
              : 'fg-secondary hover:bg-fg-primary/[0.08] hover:fg-primary';
          // In the card, a status earns space only when it needs the user.
          const compactStatusInk =
            server.authStatus === 'error'
              ? 'fg-destructive'
              : server.authStatus === 'not_connected' ||
                  (server.authStatus === 'expired' && !server.canRefresh)
                ? 'fg-warning'
                : null;
          const toggleHeading = proxyActive
            ? `${brandAppName} proxy: on`
            : `${brandAppName} proxy: off`;
          const toggleAction = proxyActive
            ? 'Click to use agent provider auth.'
            : `Click to route this server through the ${brandAppName} proxy.`;
          return (
            <li
              key={server.key}
              className={
                compact
                  ? `group/mcp-row flex ${COMPACT_ACTIVITY_ITEM_CLASS_NAME}`
                  : 'flex items-start justify-between gap-2 px-2.5 py-2'
              }
              data-testid="mcp-servers-card-row"
              data-enabled={server.enabled ? 'true' : 'false'}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {onOpenDetails === undefined ? (
                    <span
                      data-testid="mcp-servers-card-name"
                      className={
                        compact
                          ? 'truncate fg-primary'
                          : 'truncate text-s font-medium fg-primary'
                      }
                    >
                      {server.displayName}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(): void => onOpenDetails(server)}
                      data-testid="mcp-servers-card-name"
                      className={
                        compact
                          ? 'focus-ring truncate rounded text-left fg-primary hover:underline'
                          : 'focus-ring truncate rounded text-left text-s font-medium fg-primary hover:underline'
                      }
                    >
                      {server.displayName}
                    </button>
                  )}
                  {compact && signInUrl === undefined ? (
                    compactStatusInk === null ? null : (
                      <span
                        className={`shrink-0 ${compactStatusInk}`}
                        data-testid="mcp-servers-card-badge"
                      >
                        {server.authStatusLabel}
                      </span>
                    )
                  ) : signInUrl === undefined ? (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-3xs font-medium ${mcpAuthStatusBadgeClass(server.authStatus, server.canRefresh)}`}
                      data-testid="mcp-servers-card-badge"
                    >
                      {server.authStatusLabel}
                    </span>
                  ) : (
                    <McpSignInPendingStatus
                      variant="pill"
                      dataTestId="mcp-servers-card-badge"
                    />
                  )}
                </div>
                {compact ? null : (
                  <p className="truncate text-2xs fg-secondary">
                    {mcpRowSecondaryText(server)}
                  </p>
                )}
                {server.authStatus === 'error' && server.lastError && (
                  <p className="mt-1 text-2xs fg-destructive">
                    {server.lastError}
                  </p>
                )}
                {renderRowExtra?.(server)}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {showToggle && (
                  <ProxyToggle
                    active={proxyActive}
                    updating={proxyUpdating}
                    ariaLabel={toggleTitle}
                    toggleClass={toggleClass}
                    bordered={!compact}
                    heading={toggleHeading}
                    action={toggleAction}
                    logo={proxyLogo}
                    onToggle={(): void =>
                      onSetCanopyProxyEnabled(server, !proxyActive)
                    }
                  />
                )}
                {signInUrl !== undefined && (
                  <McpSignInPendingActions
                    variant="compact"
                    authorizationUrl={signInUrl}
                    onCancel={
                      onCancelSignIn === undefined
                        ? undefined
                        : (): void => onCancelSignIn(server)
                    }
                    dataTestId="mcp-servers-card-sign-in"
                  />
                )}
                {signInUrl === undefined &&
                  server.canConnect &&
                  connectLabel &&
                  onConnect !== undefined && (
                    <button
                      type="button"
                      onClick={(): void => onConnect(server)}
                      disabled={buttonDisabled}
                      data-testid="mcp-servers-card-connect"
                      className={`${MCP_ROW_ACTION_CLASS_NAME} bg-accent fg-emphasis`}
                    >
                      {isConnecting ? 'Connecting…' : connectLabel}
                    </button>
                  )}
                {server.canDisconnect === true &&
                  onDisconnect !== undefined && (
                    <button
                      type="button"
                      onClick={(): void => onDisconnect(server)}
                      disabled={isDisconnecting || isConnecting}
                      data-testid="mcp-servers-card-disconnect"
                      className={`${MCP_ROW_ACTION_CLASS_NAME} fg-secondary ring-1 ring-inset ring-line-base hover:bg-fg-primary/[0.08] hover:fg-primary`}
                    >
                      {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  )}
              </div>
            </li>
          );
        })}
      </ul>
    );

  if (body === null && warnings.length === 0) {
    return null;
  }

  return (
    <>
      {body}
      {warnings.length > 0 && (
        <p
          className={`text-2xs fg-warning${body === null ? '' : ' mt-2'}`}
          data-testid="mcp-servers-card-warnings"
        >
          Some MCP servers could not be loaded.
        </p>
      )}
    </>
  );
}

interface ProxyToggleProps {
  readonly active: boolean;
  readonly updating: boolean;
  readonly ariaLabel: string;
  readonly toggleClass: string;
  /** Draws the outline; the card's compact rows go without. */
  readonly bordered: boolean;
  readonly heading: string;
  readonly action: string;
  readonly logo: ReactNode;
  readonly onToggle: () => void;
}

function ProxyToggle({
  active,
  updating,
  ariaLabel,
  toggleClass,
  bordered,
  heading,
  action,
  logo,
  onToggle,
}: ProxyToggleProps): JSX.Element {
  const tooltipId = useId();
  return (
    <span className="group/proxy relative inline-flex">
      <button
        type="button"
        onClick={onToggle}
        disabled={updating}
        aria-label={ariaLabel}
        aria-pressed={active}
        aria-describedby={tooltipId}
        data-testid="mcp-servers-card-proxy-toggle"
        className={`focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-md ${bordered ? 'border ' : ''}transition-colors before:absolute before:-inset-2 before:content-[''] disabled:opacity-60 ${toggleClass}`}
      >
        {logo}
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-tooltip mt-1.5 hidden w-max max-w-55 flex-col items-start rounded-md bg-popover px-2.5 py-1.5 font-normal shadow-tooltip fg-primary group-hover/proxy:flex group-focus-within/proxy:flex"
      >
        <span className="text-2xs font-normal leading-tight">{heading}</span>
        <span className="mt-0.5 text-3xs leading-snug fg-secondary">
          {action}
        </span>
      </span>
    </span>
  );
}
