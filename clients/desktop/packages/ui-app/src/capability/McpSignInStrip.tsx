'use client';

import { useId, useState, type JSX, type ReactNode } from 'react';
import { mcpAuthConnectLabel } from '@canopy/ui-shared/lib';
import {
  McpServersSectionBody,
  type McpServersSectionItem,
} from '../code/activity/McpServersSectionBody';

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Selected servers still waiting on Sign in or Reconnect. */
export function mcpServersNeedingSignIn<T extends McpServersSectionItem>(
  servers: readonly T[],
): T[] {
  return servers.filter(
    (server) =>
      mcpAuthConnectLabel(server.authStatus, server.canRefresh) !== undefined,
  );
}

/** "Linear and Slack", "Linear, Slack, and 2 more": server names in strip copy. */
export function mcpServerNameList(names: readonly string[]): string {
  return names.length <= 2
    ? names.join(' and ')
    : names.length === 3
      ? `${names[0]}, ${names[1]}, and ${names[2]}`
      : `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/** "Linear and Slack need sign-in": the strip's one line of copy. */
export function mcpSignInSummary(names: readonly string[]): string {
  const verb = names.length === 1 ? 'needs' : 'need';
  return `${mcpServerNameList(names)} ${verb} sign-in`;
}

/**
 * The row badge, in the sign-in words the picker and Marketplace use. A row
 * whose host relabels its action (a server that needs no sign-in) keeps the
 * host's own badge.
 */
export function mcpSignInStatusLabel(server: McpServersSectionItem): string {
  if (server.connectActionLabel !== undefined) return server.authStatusLabel;
  if (server.authStatus === 'connected') return 'Signed in';
  const action = mcpAuthConnectLabel(server.authStatus, server.canRefresh);
  if (action === 'Reconnect') return 'Needs reconnecting';
  if (action === 'Connect') return 'Not signed in';
  return server.authStatusLabel;
}

function sameKeys(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export interface McpSignInStripRows<T extends McpServersSectionItem> {
  /** The strip's rows, in the host's order. */
  readonly rows: T[];
  /** Rows still waiting on sign-in; the strip hides when this is empty. */
  readonly pending: T[];
}

/**
 * A row joins the strip while it needs sign-in and stays, reading Signed in,
 * once it connects, so the user sees each sign-in land. Rows leave with the
 * selection, and the whole set clears once nothing is left to sign in.
 */
export function useMcpSignInStripRows<T extends McpServersSectionItem>(
  servers: readonly T[],
): McpSignInStripRows<T> {
  const pending = mcpServersNeedingSignIn(servers);
  const [shown, setShown] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  let next: ReadonlySet<string> = EMPTY_KEYS;
  if (pending.length > 0) {
    const selected = new Set(servers.map((server) => server.key));
    const keys = new Set<string>();
    for (const key of shown) if (selected.has(key)) keys.add(key);
    for (const server of pending) keys.add(server.key);
    next = keys;
  }
  if (!sameKeys(next, shown)) setShown(next);
  return {
    rows: servers.filter((server) => next.has(server.key)),
    pending,
  };
}

function stripRow(server: McpServersSectionItem): McpServersSectionItem {
  const signedIn = server.authStatus === 'connected';
  return {
    ...server,
    authStatusLabel: mcpSignInStatusLabel(server),
    canConnect: !signedIn && server.canConnect,
    canDisconnect: false,
    canToggleCanopyProxy: false,
  };
}

export interface McpSignInStripProps {
  /**
   * The selected servers that sign in, in display order, whatever their
   * state. The strip shows while any of them needs sign-in.
   */
  readonly servers: readonly McpServersSectionItem[];
  readonly connectingKey?: string | null;
  readonly onConnect: (server: McpServersSectionItem) => void;
  /** Stops waiting on a row's pending sign-in. */
  readonly onCancelSignIn?: (server: McpServersSectionItem) => void;
  /** Host-owned content under a row: token or OAuth app prompts, errors. */
  readonly renderRowExtra?: (server: McpServersSectionItem) => ReactNode;
  /** A failure with no row to sit on, shown under the summary. */
  readonly notice?: ReactNode;
  /**
   * The summary line for the rows still waiting, in display order. Defaults
   * to {@link mcpSignInSummary} of their names.
   */
  readonly summary?: (pending: readonly McpServersSectionItem[]) => string;
  readonly dataTestId?: string;
}

/**
 * Hangs from a new task's composer, the way the desktop project selector sits
 * on top of it: the attached MCP servers that still need sign-in, each with
 * the MCP Servers card's row and its Sign in or Reconnect. The 16px inset
 * meets the composer's flat bottom edge, past its corner radius. It only
 * prompts. Send stays available, and a server left signed out behaves as it
 * does in a chat.
 */
export function McpSignInStrip({
  servers,
  connectingKey = null,
  onConnect,
  onCancelSignIn,
  renderRowExtra,
  notice,
  summary,
  dataTestId = 'mcp-sign-in-strip',
}: McpSignInStripProps): JSX.Element | null {
  const summaryId = useId();
  const { rows, pending } = useMcpSignInStripRows(servers);
  if (pending.length === 0) return null;
  return (
    <section
      aria-labelledby={summaryId}
      data-testid={dataTestId}
      className="relative mx-4 rounded-b-2xl bg-depth p-1 shadow-2xs"
    >
      <p
        id={summaryId}
        aria-live="polite"
        data-testid={`${dataTestId}-summary`}
        className="px-2 py-1.5 text-xs fg-secondary"
      >
        {summary === undefined
          ? mcpSignInSummary(pending.map((server) => server.displayName))
          : summary(pending)}
      </p>
      {notice}
      <McpServersSectionBody
        servers={rows.map(stripRow)}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey={connectingKey}
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        onConnect={onConnect}
        onCancelSignIn={onCancelSignIn}
        renderRowExtra={renderRowExtra}
      />
    </section>
  );
}
