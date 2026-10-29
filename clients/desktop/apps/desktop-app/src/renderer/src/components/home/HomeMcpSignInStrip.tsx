import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  AccountMcpConnectionSummary,
  DetectedMcpServerInfo,
} from '@canopy/desktop-shared/types/mcp-servers';
import type { McpServersSectionItem } from '@canopy/ui-app';
import {
  McpSignInStrip,
  mcpServersNeedingSignIn,
} from '@canopy/ui-app/capability';
import {
  ErrorBanner,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import {
  mcpAuthConnectLabel,
  mcpConnectErrorCodeTitle,
} from '@canopy/ui-shared/lib';
import {
  useAccountMcpSignIn,
  type AccountMcpSignIn,
  type AccountMcpSignInTarget,
} from '@/components/mcp/useAccountMcpSignIn';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useDetectedMcpServers } from '@/hooks/useDetectedMcpServers';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';

/** A strip row with what Connect needs to sign it in. */
interface HomeSignInRow extends McpServersSectionItem {
  readonly server: DetectedMcpServerInfo;
  /** The account flow's key and target for this row; absent for a device server. */
  readonly accountKey?: string;
  readonly target?: AccountMcpSignInTarget;
  /** Connect waits for the catalog to load. */
  readonly waitsForCatalog?: boolean;
  /** Connect waits for the server's connection to load. */
  readonly waitsForConnection?: boolean;
  /** An account server no connection can serve here; MCP settings can. */
  readonly opensSettings?: boolean;
}

/** The account's connections, and whether the latest read of them landed. */
interface AccountConnections {
  readonly list: readonly AccountMcpConnectionSummary[];
  readonly status: 'loading' | 'loaded' | 'failed';
}

type HomeSignInStatus = 'signed_in' | 'not_signed_in' | 'needs_reconnecting';

function signInStatus(row: McpServersSectionItem): HomeSignInStatus {
  if (row.authStatus === 'connected') return 'signed_in';
  return mcpAuthConnectLabel(row.authStatus, row.canRefresh) === 'Reconnect'
    ? 'needs_reconnecting'
    : 'not_signed_in';
}

function isAccountServer(server: DetectedMcpServerInfo): boolean {
  return server.scope === 'account' || server.authHandler === 'account';
}

function selectsCapabilities(selections: ChatTabPluginSelections): boolean {
  return (
    (selections.mcpServerRefs?.length ?? 0) > 0 ||
    selections.pluginRefs.length > 0 ||
    selections.collectionIds.length > 0
  );
}

/**
 * An account server signs in through the cloud: a disconnected connection
 * reads Not signed in, a connection that needs the user again Needs
 * reconnecting. A server the inventory links to a connection waits for that
 * connection to load, so Connect reconnects it under its own configuration
 * instead of starting it as if it had none. One with neither a connection nor
 * a catalog key (a plugin's own HTTP server) has nothing a sign-in here could
 * create that the chat would use, since names and URLs never identify a
 * connection, so its row points at MCP settings instead. A device server
 * signs in through local OAuth, as the chat's MCP Servers card does it;
 * servers without a sign-in stay off the strip. Rows read by name, as on the
 * web.
 */
function signInRows(
  servers: readonly DetectedMcpServerInfo[],
  connections: AccountConnections,
  accountEnabled: boolean,
  signIn: Pick<AccountMcpSignIn, 'pending' | 'waitsForCatalog'>,
): HomeSignInRow[] {
  const rows = servers.flatMap((server): HomeSignInRow[] => {
    if (!isAccountServer(server)) {
      if (!server.canConnect && server.authStatus !== 'connected') return [];
      return [{ ...server, server }];
    }
    if (!accountEnabled) return [];
    const connection = connections.list.find(
      (candidate) => candidate.id === server.accountConnectionId,
    );
    const accountRow = {
      ...server,
      source: server.source === 'standalone' ? 'account' : server.source,
      authStatus:
        server.authStatus === 'connected'
          ? 'connected'
          : server.authStatus === 'error'
            ? 'expired'
            : 'not_connected',
      canRefresh: false,
      server,
    } satisfies HomeSignInRow;
    if (
      connection === undefined &&
      server.accountConnectionId !== undefined &&
      connections.status !== 'loaded'
    )
      return [
        {
          ...accountRow,
          canConnect: true,
          connectDisabled: true,
          waitsForConnection: true,
        },
      ];
    const accountKey = connection?.serverKey ?? server.curatedKey;
    if (accountKey === undefined)
      return [{ ...accountRow, canConnect: false, opensSettings: true }];
    const target: AccountMcpSignInTarget = {
      ...(connection ? { connection } : {}),
      ...(server.curatedKey ? { curatedKey: server.curatedKey } : {}),
      ...(server.configId ? { configId: server.configId } : {}),
    };
    const waiting = signIn.pending.has(accountKey);
    const waitsForCatalog = signIn.waitsForCatalog(target);
    return [
      {
        ...accountRow,
        canConnect: true,
        ...(waiting ? { connecting: true } : {}),
        ...(waiting || waitsForCatalog ? { connectDisabled: true } : {}),
        accountKey,
        target,
        waitsForCatalog,
      },
    ];
  });
  return rows.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

export interface HomeMcpSignInStripProps {
  /** The Home draft's plugin selections. */
  readonly selections: ChatTabPluginSelections | null;
  /** Report to App Advisor; only one mounted Home surface should. */
  readonly reportUiState?: boolean;
}

/**
 * The Home composer's MCP sign-in strip: the draft's servers that still need
 * sign-in, signed in right there. Account servers connect through the cloud
 * exactly as the MCP servers settings connect them, device servers through
 * local OAuth as the chat's MCP Servers card does. Rows come from the same
 * inventory that card reads, so servers a selected plugin brings are
 * included.
 */
export function HomeMcpSignInStrip({
  selections,
  reportUiState = false,
}: HomeMcpSignInStripProps): JSX.Element | null {
  const accountEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const detected = useDetectedMcpServers(
    selections !== null && selectsCapabilities(selections) ? selections : null,
  );
  const [connections, setConnections] = useState<AccountConnections>({
    list: [],
    status: 'loading',
  });
  const connectionsRequest = useRef(0);
  const loadConnections = useCallback(async (): Promise<void> => {
    if (!accountEnabled) return;
    const request = ++connectionsRequest.current;
    setConnections((current) =>
      current.status === 'loading'
        ? current
        : { ...current, status: 'loading' },
    );
    try {
      const list = await window.mcpServers.listAccountConnections();
      if (request === connectionsRequest.current)
        setConnections({ list, status: 'loaded' });
    } catch {
      if (request === connectionsRequest.current)
        setConnections((current) => ({ ...current, status: 'failed' }));
    }
  }, [accountEnabled]);
  const refreshDetected = detected.refresh;
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([refreshDetected(), loadConnections()]);
  }, [loadConnections, refreshDetected]);
  const accountRowsKey = accountEnabled
    ? detected.servers
        .filter(isAccountServer)
        .map((server) => `${server.key}:${server.authStatus}`)
        .join('\n')
    : '';
  const signIn = useAccountMcpSignIn(refresh, {
    enabled: accountRowsKey !== '',
  });

  useEffect((): void => {
    if (accountRowsKey !== '') void loadConnections();
  }, [accountRowsKey, loadConnections]);

  const { pending: signInPending, waitsForCatalog } = signIn;
  const rows = useMemo(
    () =>
      signInRows(detected.servers, connections, accountEnabled, {
        pending: signInPending,
        waitsForCatalog,
      }),
    [
      accountEnabled,
      connections,
      detected.servers,
      signInPending,
      waitsForCatalog,
    ],
  );
  const rowsByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  const pending = mcpServersNeedingSignIn(rows);

  useCurrentUiStateReporter(
    'home.mcpSignIn',
    reportUiState
      ? {
          visible: pending.length > 0,
          setupOpen: signIn.setupOpen,
          servers: pending.slice(0, 20).map((row) => ({
            name: row.displayName,
            status: signInStatus(row),
            pending: row.connecting === true,
          })),
        }
      : null,
  );

  const onConnect = (item: McpServersSectionItem): void => {
    const row = rowsByKey.get(item.key);
    if (row === undefined || row.waitsForConnection === true) return;
    if (row.target === undefined) {
      void detected.connect(row.server);
      return;
    }
    signIn.connect(row.target);
  };

  const renderRowExtra = (item: McpServersSectionItem): JSX.Element | null => {
    const row = rowsByKey.get(item.key);
    if (row?.opensSettings === true && item.authStatus !== 'connected')
      return (
        <span className="mt-1.5 flex items-center gap-2 text-2xs">
          <button
            type="button"
            className="focus-ring fg-accent"
            data-testid="mcp-sign-in-strip-open-settings"
            onClick={(): void =>
              useNavigationStore.getState().openSettings('mcp')
            }
          >
            Open MCP settings
          </button>
        </span>
      );
    const accountKey = row?.accountKey;
    if (accountKey === undefined || !signIn.pending.has(accountKey))
      return null;
    return (
      <span
        className="mt-1.5 flex items-center gap-2 text-2xs"
        data-testid="mcp-sign-in-strip-waiting"
      >
        <span role="status" className="fg-secondary">
          Waiting for browser
        </span>
        <button
          type="button"
          className="focus-ring fg-accent"
          onClick={(): void => signIn.cancel(accountKey)}
        >
          Cancel
        </button>
      </span>
    );
  };

  const error = signIn.error ?? detected.error;
  const errorCode = signIn.error === null ? null : signIn.errorCode;
  const catalogBlocksConnect =
    signIn.catalogFailed && pending.some((row) => row.waitsForCatalog === true);
  const connectionsBlockConnect =
    connections.status === 'failed' &&
    pending.some((row) => row.waitsForConnection === true);
  const retryLoad = (): void => {
    if (catalogBlocksConnect) signIn.retryCatalog();
    if (connectionsBlockConnect) void loadConnections();
  };
  return (
    <>
      <McpSignInStrip
        servers={rows}
        connectingKey={detected.connectingKey}
        onConnect={onConnect}
        renderRowExtra={renderRowExtra}
        notice={
          catalogBlocksConnect || connectionsBlockConnect ? (
            <Notice
              intent="destructive"
              role="status"
              className="mb-1"
              data-testid="mcp-sign-in-strip-load-error"
              actions={
                <NoticeButton
                  variant="primary"
                  data-testid="mcp-sign-in-strip-load-retry"
                  onClick={retryLoad}
                >
                  Try again
                </NoticeButton>
              }
            >
              Couldn’t load sign-in details.
            </Notice>
          ) : error === null ? undefined : (
            <div
              title={mcpConnectErrorCodeTitle(errorCode)}
              data-mcp-error-code={errorCode ?? undefined}
              data-testid="mcp-sign-in-strip-error"
            >
              <ErrorBanner error={error} className="mb-1" />
            </div>
          )
        }
      />
      {signIn.dialogs}
    </>
  );
}
