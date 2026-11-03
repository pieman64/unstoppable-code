import { DesktopMcpManagementSections } from '../mcp/DesktopMcpManagementSections';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  curatedMcpDesktopOnly,
  curatedMcpProviderOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { AccountMcpClientSetup } from '@canopy/protocol/mcp-servers';
import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import type {
  AccountMcpConnection,
  McpServerData,
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  Button,
  MCP_SIGN_IN_WAITING_LABEL,
  PluginAccountConnection,
  PluginConnectionNotice,
  type UnifiedEntryFoldedPlugin,
} from '@canopy/ui-shared';
import {
  DetailPageActions,
  PluginConfigurationButton,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { McpWorkspaceDefaultsSection } from '@canopy/ui-app';
import {
  MCP_CONNECT_ONCE_FOR_HARNESSES,
  MCP_SHARED_ACROSS_HARNESSES,
  MCP_WORKSPACE_SETTINGS_HINT,
  McpConnectActionButton,
  McpProviderOnlyGuidance,
  curatedMcpAddTarget,
  mcpAppRouteDescription,
  mcpAppRouteTitle,
  mcpConnectionStatusLabel,
  mcpConnectToAccountDescription,
  mcpCustomSetupStaysDescription,
  mcpFoldedPluginSkillsNote,
  type CuratedMcpDeviceServer,
  type CuratedMcpReplacedDeviceServer,
  type McpConnectionCopyState,
} from '@canopy/ui-app/capability';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { AccountMcpDetails } from '../mcp/AccountMcpControls';
import { useAccountMcpActions } from '@/hooks/useAccountMcpActions';
import { accountMcpCatalogConnectStep } from '../mcp/accountMcpConnectSteps';
import { CuratedDetail } from '../mcp/McpBrowseDialog';
import {
  McpServerDialog,
  curatedInitialUrl,
  curatedRequiresProviderAuth,
  oauthFromCuratedHints,
  validateCuratedSetup,
} from '../pages/McpServersTab';
import { useMarketplaceOAuth } from '@/hooks/useMarketplaceOAuth';
import { pointRefsAt } from '@/lib/mcpServerRefs';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import {
  matchesStockCuratedServer,
  stockCuratedServerData,
} from './curatedStockServer';
import {
  addMcpServerToWorkspaceDefaults,
  removeMcpServerFromWorkspaceDefaults,
  useMcpWorkspaceDefaultChoices,
} from '@/lib/workspaceDefaultMcp';
import { PluginHarnessStatus } from './PluginHarnessStatus';
import {
  useFoldedPluginInstall,
  type FoldedPluginInstallState,
} from './useFoldedPluginInstall';
import { McpOAuthBrowser } from './McpOAuthBrowser';
import { brandText } from '@/lib/brand';

type McpConnectionSource =
  | { entry: CuratedMcpServerEntry; localServer?: McpServerIndexEntry }
  | { entry?: undefined; localServer: McpServerIndexEntry };

type CuratedMcpConnectionDetailProps = McpConnectionSource & {
  installedServerId: string | null;
  autoConnect?: boolean;
  /**
   * Whether the account connection list was read, as the MCP index reports
   * it. Together with the shared-account flag this decides where Add puts
   * the server (REG-3033); unknown reads as unavailable.
   */
  accountConnectionsAvailable?: boolean;
  /** The curated plugin folded into this integration card, when one is. */
  foldedPlugin?: UnifiedEntryFoldedPlugin;
  /**
   * Counts the host's requests to install the folded plugin, for a binding
   * the host owns (a provider connector route taken from Add). Each increment
   * installs once; `0` requests nothing.
   */
  installFoldedPluginRequest?: number;
  /**
   * The account connection already backing this card. The card then reads
   * the connection's own state, reconnects through the account, and opens
   * the connection's details instead of a device editor. For a desktop-only
   * entry (REG-3035) it backs nothing: the card stays on its device server
   * and offers only this connection's Disconnect.
   */
  accountConnection?: AccountMcpConnection;
  /**
   * The account connection for this key while a device server backs the
   * card. Connecting the device server to the account switches to it
   * instead of signing in again.
   */
  accountConnectionBehindDevice?: AccountMcpConnection;
  /**
   * The provider connections folded into this card (REG-3033), rendered as
   * their own section. The app connection and tools precede them only when
   * the catalog provides an app connection path.
   */
  providerConnections?: ReactNode;
  /**
   * Host-owned primary, such as the shared Try it / Install CTA (CAN-4359).
   * When present it replaces the internal Add/Connect primary; the move to
   * the account joins the secondary actions so nothing is lost.
   */
  renderPrimaryAction?: (input: CuratedMcpPrimaryActionInput) => ReactNode;
  onServersChanged: () => Promise<void>;
  onEditorOpenChange?: (open: boolean) => void;
  /** Leaves the detail after a confirmed deletion of its device server. */
  onDeleted?: () => void;
};

export interface CuratedMcpPrimaryActionInput {
  /** Connected (or auth-free) counts as installed; sign-in in flight is pending. */
  installation: 'pending' | 'installed' | 'not-installed';
  /** The detail's own Add/Connect/Reconnect flow. */
  onInstall: () => void;
  installLabel: 'Install' | 'Connect' | 'Reconnect';
  installBusy: boolean;
  /** The detail's own connect action, styled as a secondary. */
  secondaryInstallAction: ReactNode;
  /** The installed server reference, when one exists. */
  mcpServerRef: { serverId: string; configId: string } | null;
}

/** Account setup the catalog entry needs before it can connect. */
interface AccountSetupRequest {
  entry: CuratedMcpServerEntry;
  configId: string;
  clientSetup?: AccountMcpClientSetup;
  endpointUrl?: string;
  /** The device server the connection replaces once it connects. */
  replaces?: DeviceReplacement;
  /**
   * The account signed in when the dialog opened. Credentials typed into the
   * dialog are bound to it: a sign-in change closes the dialog, and the start
   * carries it as `expectedAccountId`, so a secret entered under one account
   * is never submitted under another (the same rule as the MCP tab).
   */
  accountId: string;
}

const SIGN_IN_TO_CONNECT = 'Sign in to connect account servers.';
const REPLACE_DEVICE_FAILED =
  "Connected to your account, but couldn't remove the copy on this desktop. Try again.";

function deviceSetupChangedMessage(name: string): string {
  return `${name} is connected to your account. Its setup on this desktop changed while you signed in, so it wasn't removed.`;
}

function connectionCopyState(input: {
  accountConnection: AccountMcpConnection | undefined;
  connected: boolean;
  installed: boolean;
  accountReady: boolean;
  replacesDevice: boolean;
  accountBehindConnected: boolean;
}): McpConnectionCopyState {
  if (input.accountConnection) {
    if (input.connected) return 'account-connected';
    return input.accountConnection.status === 'REAUTH_REQUIRED'
      ? 'account-reauth'
      : 'account-not-connected';
  }
  if (!input.installed)
    return input.accountReady
      ? 'account-not-connected'
      : 'device-not-connected';
  if (input.accountBehindConnected) return 'account-connected';
  if (input.connected)
    return input.replacesDevice ? 'device-connected-only' : 'device-connected';
  return input.replacesDevice
    ? 'account-not-connected'
    : 'device-not-connected';
}

/** The device server to replace, as it was when the move started. */
interface DeviceReplacement extends CuratedMcpReplacedDeviceServer {
  readonly fingerprint: string;
}

function deviceServerOf(
  entry: CuratedMcpServerEntry,
  server: McpServerData,
): CuratedMcpDeviceServer {
  return {
    id: server.definition.id,
    type: server.definition.type,
    configIds: server.configs.map((config): string => config.id),
    ...(server.definition.httpAuthHandler
      ? { httpAuthHandler: server.definition.httpAuthHandler }
      : {}),
    matchesCatalogDefaults: matchesStockCuratedServer(entry, server),
  };
}

export function CuratedMcpConnectionDetail(
  props: CuratedMcpConnectionDetailProps,
): JSX.Element {
  if (props.entry && curatedMcpProviderOnly(props.entry)) {
    // Provider-only entries have no app-owned connection. Do not mount the
    // device/account lifecycle, even when an old device server still exists.
    return (
      <ProviderOnlyConnectionDetail
        entry={props.entry}
        foldedPlugin={props.foldedPlugin}
        installFoldedPluginRequest={props.installFoldedPluginRequest ?? 0}
        providerConnections={props.providerConnections}
        renderPrimaryAction={props.renderPrimaryAction}
      />
    );
  }
  return <AppMcpConnectionDetail {...props} />;
}

/**
 * A provider-only card (Gmail, Calendar, Drive): only its provider route,
 * plus the plugin folded into it, which still installs on its own or as the
 * provider route starts (REG-3033).
 */
function ProviderOnlyConnectionDetail({
  entry,
  foldedPlugin,
  installFoldedPluginRequest,
  providerConnections,
  renderPrimaryAction,
}: {
  entry: CuratedMcpServerEntry;
  foldedPlugin: UnifiedEntryFoldedPlugin | undefined;
  installFoldedPluginRequest: number;
  providerConnections: ReactNode;
  renderPrimaryAction?: (input: CuratedMcpPrimaryActionInput) => ReactNode;
}): JSX.Element {
  const { pluginInstall, installFoldedPlugin } = useFoldedPluginInstall(
    foldedPlugin,
    installFoldedPluginRequest,
  );
  const secondary =
    foldedPlugin && pluginInstall.status !== 'installed' ? (
      <InstallSkillsButton
        pluginInstall={pluginInstall}
        onInstall={installFoldedPlugin}
      />
    ) : undefined;
  // Provider routes connect in their own section below, so the primary has
  // no install step of its own: Try it carries the catalog identity.
  const primary = renderPrimaryAction?.({
    installation: 'installed',
    onInstall: (): void => {},
    installLabel: 'Install',
    installBusy: false,
    secondaryInstallAction: undefined,
    mcpServerRef: null,
  });
  return (
    <>
      {(secondary || primary) && (
        <DetailPageActions secondary={secondary} primary={primary} />
      )}
      <CuratedDetail
        entry={entry}
        installedServerId={null}
        routes={{
          others: (
            <>
              <FoldedPluginStatus
                foldedPlugin={foldedPlugin}
                pluginInstall={pluginInstall}
              />
              {/* No connector folded in (no provider could be read), so no
                  provider route renders: say how this service connects. */}
              {providerConnections ?? <McpProviderOnlyGuidance entry={entry} />}
            </>
          ),
        }}
      />
    </>
  );
}

function InstallSkillsButton({
  pluginInstall,
  onInstall,
}: {
  pluginInstall: FoldedPluginInstallState;
  onInstall: () => Promise<void>;
}): JSX.Element {
  return (
    <Button
      variant="secondary"
      size="compact"
      data-testid="mcp-browse-detail-install-skills"
      disabled={pluginInstall.status === 'installing'}
      onClick={() => void onInstall()}
    >
      {pluginInstall.status === 'installing'
        ? 'Installing skills…'
        : 'Install skills only'}
    </Button>
  );
}

function FoldedPluginStatus({
  foldedPlugin,
  pluginInstall,
}: {
  foldedPlugin: UnifiedEntryFoldedPlugin | undefined;
  pluginInstall: FoldedPluginInstallState;
}): JSX.Element | null {
  if (foldedPlugin && pluginInstall.status === 'installed')
    return (
      <p
        className="text-xs fg-secondary"
        data-testid="mcp-browse-detail-skills-installed"
      >
        {`${foldedPlugin.name} skills are installed.`}
      </p>
    );
  if (pluginInstall.status === 'error' && pluginInstall.message)
    return (
      <ErrorBanner
        className=""
        error={pluginInstall.message}
        testId="mcp-browse-detail-skills-error"
      />
    );
  return null;
}

function AppMcpConnectionDetail({
  entry,
  localServer,
  installedServerId,
  autoConnect = false,
  accountConnectionsAvailable,
  foldedPlugin,
  installFoldedPluginRequest = 0,
  accountConnection: givenAccountConnection,
  accountConnectionBehindDevice,
  providerConnections,
  renderPrimaryAction,
  onServersChanged,
  onEditorOpenChange,
  onDeleted,
}: CuratedMcpConnectionDetailProps): JSX.Element {
  // The cloud account never connects a desktop-only server (REG-3035), so an
  // account connection made before it was marked never backs this card: no
  // status, cloud reconnect, or account details come from it, and Add creates
  // the device server. While it still holds a credential, the card offers its
  // Disconnect and nothing else.
  const desktopOnly = entry !== undefined && curatedMcpDesktopOnly(entry);
  const accountConnection = desktopOnly ? undefined : givenAccountConnection;
  const cloudLeftover =
    desktopOnly && givenAccountConnection?.status !== 'DISCONNECTED'
      ? givenAccountConnection
      : undefined;
  const accountConnectionsEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const accountActions = useAccountMcpActions(onServersChanged);
  const [accountSetup, setAccountSetup] = useState<AccountSetupRequest | null>(
    null,
  );
  const accountSetupRef = useRef(accountSetup);
  accountSetupRef.current = accountSetup;
  const { pluginInstall, installFoldedPlugin } = useFoldedPluginInstall(
    foldedPlugin,
    installFoldedPluginRequest,
  );
  const [server, setServer] = useState<McpServerData | null>(null);
  const [status, setStatus] = useState<McpServerStatusEntry | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [moveConnection, setMoveConnection] = useState<AccountMcpConnection>();
  const [moveEditorOpen, setMoveEditorOpen] = useState(false);
  const [managementBusy, setManagementBusy] = useState(false);
  useEffect(() => {
    onEditorOpenChange?.(editorOpen || moveEditorOpen);
    return (): void => onEditorOpenChange?.(false);
  }, [editorOpen, moveEditorOpen, onEditorOpenChange]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [guidance, setGuidance] = useState<string>();
  const [moveNotice, setMoveNotice] = useState<string>();
  const startingErrorRevision = useRef<string | undefined>(undefined);
  const statusGeneration = useRef(0);
  const [toolsRevision, setToolsRevision] = useState(0);
  const oauth = useMarketplaceOAuth();
  const { pending, finish, start, url: authorizationUrl } = oauth;
  const serverRef = useRef(server);
  serverRef.current = server;
  const inFlight = useRef(false);
  const replacedServerIds = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const id = serverRef.current?.definition.id ?? installedServerId;
    if (accountConnection) {
      const run = ++statusGeneration.current;
      try {
        const statuses = await window.mcpServers.listStatus();
        if (mounted.current && run === statusGeneration.current) {
          setStatus(
            statuses.find(
              (item) =>
                item.serverId === accountConnection.serverKey &&
                item.handler === 'account' &&
                item.configs.some(
                  (config) => config.configId === accountConnection.configId,
                ),
            ),
          );
          setRefreshError('');
        }
      } catch {
        if (mounted.current && run === statusGeneration.current)
          setRefreshError(
            'Could not refresh connection health. Reopen the detail to try again.',
          );
      }
      return;
    }
    if (!id || replacedServerIds.current.has(id)) return;
    const run = ++statusGeneration.current;
    try {
      const [file, statuses] = await Promise.all([
        window.mcpServers.loadServer(id),
        window.mcpServers.listStatus(),
      ]);
      if (
        !mounted.current ||
        run !== statusGeneration.current ||
        replacedServerIds.current.has(id)
      )
        return;
      setServer(file.server);
      setStatus(statuses.find((item) => item.serverId === id));
      setRefreshError('');
      setToolsRevision((value) => value + 1);
    } catch (cause) {
      if (mounted.current && run === statusGeneration.current)
        setRefreshError(String(cause));
    }
  }, [accountConnection, installedServerId]);
  // One subscription: the bridge fires this for every account operation, so
  // the open setup dialog only closes when the signed-in account really
  // differs from the one its credentials were captured under; an unreadable
  // account closes it too.
  const closeSetupIfAccountChanged = useCallback((): void => {
    const open = accountSetupRef.current;
    if (!open) return;
    void window.api
      ?.loadCanopyCloudAccount?.()
      .then((state): void => {
        if (!mounted.current || !accountSetupRef.current) return;
        if (state.account?.id === open.accountId) return;
        setAccountSetup(null);
      })
      .catch((): void => {
        if (mounted.current) setAccountSetup(null);
      });
  }, []);
  useEffect(() => {
    void refresh();
    return window.mcpServers.onAuthChanged?.(() => {
      void refresh();
      closeSetupIfAccountChanged();
    });
  }, [closeSetupIfAccountChanged, refresh]);
  const activeConfig = server?.configs.find((config) => config.enabled);
  const auth = status?.configs.find(
    (config) => config.configId === activeConfig?.id,
  );
  const connected = accountConnection
    ? accountConnection.status === 'CONNECTED'
    : auth?.authStatus === 'connected';
  useEffect(() => {
    if (pending && connected) finish();
  }, [connected, pending, finish]);
  useEffect(() => {
    if (
      pending &&
      authorizationUrl &&
      auth?.authStatus === 'error' &&
      // Only a matching revision proves this is the previous attempt's error.
      (auth.authErrorRevision === undefined ||
        auth.authErrorRevision !== startingErrorRevision.current)
    ) {
      finish(auth.lastError ?? 'Sign-in failed. Connect again to retry.');
    }
  }, [
    pending,
    authorizationUrl,
    auth?.authStatus,
    auth?.lastError,
    auth?.authErrorRevision,
    finish,
  ]);
  useEffect(() => {
    const expiresAt = auth?.expiresAt ? Date.parse(auth.expiresAt) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        void refresh();
        return;
      }
      timer = setTimeout(schedule, Math.min(2_147_483_647, remaining));
    };
    schedule();
    return (): void => clearTimeout(timer);
  }, [auth?.expiresAt, refresh]);

  /**
   * Opens the account setup dialog under the account signed in right now,
   * so the credentials it collects are bound to that account.
   */
  const openAccountSetup = useCallback(
    async (request: Omit<AccountSetupRequest, 'accountId'>): Promise<void> => {
      let accountId: string | undefined;
      try {
        accountId = (await window.api?.loadCanopyCloudAccount?.())?.account?.id;
      } catch {
        accountId = undefined;
      }
      if (!mounted.current) return;
      if (!accountId) {
        setError(SIGN_IN_TO_CONNECT);
        return;
      }
      setAccountSetup({ ...request, accountId });
    },
    [],
  );

  /**
   * Hands a device server over to the account connection that now holds its
   * sign-in: saved defaults and chats follow the connection, then the device
   * server and its own sign-in go (REG-3052).
   */
  const replaceDeviceServer = useCallback(
    async (
      replaced: DeviceReplacement,
      connection: Pick<AccountMcpConnection, 'serverKey' | 'configId'>,
    ): Promise<void> => {
      const unchanged = async (): Promise<boolean | undefined> => {
        try {
          const reloaded = (
            await window.mcpServers.loadServer(replaced.serverId)
          ).server;
          if (stableStringify(reloaded) === replaced.fingerprint) return true;
          if (mounted.current)
            setMoveNotice(deviceSetupChangedMessage(reloaded.definition.name));
          await onServersChanged();
          return false;
        } catch {
          if (mounted.current) setError(REPLACE_DEVICE_FAILED);
          return undefined;
        }
      };
      if ((await unchanged()) !== true) return;
      // Main checks the fingerprint, moves the references and removes the
      // device server as one step, so a save that lands meanwhile wins.
      replacedServerIds.current.add(replaced.serverId);
      statusGeneration.current += 1;
      let retired: 'removed' | 'changed' | undefined;
      try {
        ({ retired } = await pointRefsAt(
          [{ serverId: replaced.serverId, configId: replaced.configId }],
          { serverId: connection.serverKey, configId: connection.configId },
          { serverId: replaced.serverId, fingerprint: replaced.fingerprint },
        ));
      } catch {
        replacedServerIds.current.delete(replaced.serverId);
        if (mounted.current) setError(REPLACE_DEVICE_FAILED);
        return;
      }
      if (retired !== 'removed') {
        replacedServerIds.current.delete(replaced.serverId);
        await unchanged();
        return;
      }
      if (mounted.current) {
        serverRef.current = null;
        setServer(null);
        setStatus(undefined);
      }
      await onServersChanged();
    },
    [onServersChanged],
  );
  /**
   * The account half of the shared Add rule: the catalog's setup dialog when
   * the entry needs fields or an endpoint choice, otherwise a start by server
   * key. The connection is the plugin's binding, so the folded plugin installs
   * as soon as the connection exists (`onStarted`), while the browser sign-in
   * is still settling; the installer reports its own failures and never
   * throws, so it cannot make `onStarted` drop the new connection.
   */
  const connectAccount = useCallback(
    async (
      catalogEntry: CuratedMcpServerEntry,
      configId: string,
      replaces?: DeviceReplacement,
    ): Promise<void> => {
      const step = accountMcpCatalogConnectStep(catalogEntry, configId);
      if (step.kind === 'setup') {
        await openAccountSetup({
          entry: step.entry,
          configId: step.configId,
          ...(replaces ? { replaces } : {}),
        });
        return;
      }
      await accountActions.connect(step.serverKey, step.configId, {
        onStarted: installFoldedPlugin,
        onOAuthClientRequired: (clientSetup): void =>
          void openAccountSetup({
            entry: catalogEntry,
            configId,
            clientSetup,
            ...(replaces ? { replaces } : {}),
          }),
        ...(replaces
          ? {
              onConnected: (connection): Promise<void> =>
                replaceDeviceServer(replaces, connection),
            }
          : {}),
      });
      if (mounted.current) await onServersChanged();
    },
    [
      accountActions,
      installFoldedPlugin,
      onServersChanged,
      openAccountSetup,
      replaceDeviceServer,
    ],
  );
  /**
   * Where a device server signs in next, under the shared Add rule. True
   * when the account took it: the account signs in (or an existing account
   * connection is reused) and the device server is replaced once connected.
   */
  const signInThroughAccount = useCallback(
    async (current: McpServerData): Promise<boolean> => {
      if (!entry) return false;
      const target = curatedMcpAddTarget(entry, {
        accountConnectionsEnabled,
        accountConnectionsAvailable,
        deviceServer: deviceServerOf(entry, current),
        ...(accountConnectionBehindDevice
          ? { configId: accountConnectionBehindDevice.configId }
          : {}),
      });
      if (target.kind !== 'account' || !target.replacesDeviceServer)
        return false;
      const replaces: DeviceReplacement = {
        ...target.replacesDeviceServer,
        fingerprint: stableStringify(current),
      };
      if (accountConnectionBehindDevice?.status === 'CONNECTED')
        await replaceDeviceServer(replaces, accountConnectionBehindDevice);
      else await connectAccount(entry, target.configId, replaces);
      return true;
    },
    [
      accountConnectionBehindDevice,
      accountConnectionsAvailable,
      accountConnectionsEnabled,
      connectAccount,
      entry,
      replaceDeviceServer,
    ],
  );

  const connect = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    setGuidance(undefined);
    setMoveNotice(undefined);
    try {
      let current = serverRef.current;
      // An account connection backs this card: Connect reconnects it through
      // the account rather than creating anything.
      if (!current && entry && accountConnection) {
        if (accountConnection.status !== 'CONNECTED')
          await connectAccount(entry, accountConnection.configId);
        return;
      }
      if (!current && installedServerId)
        current = (await window.mcpServers.loadServer(installedServerId))
          .server;
      if (!current && entry) {
        // Re-read before creating so retrying or reopening a pending login
        // never creates a second account/configuration for the same entry.
        const index = await window.mcpServers.loadIndex();
        const rows = flattenMcpServerRows(index.servers).filter(
          (item) => item.curatedKey === entry.key,
        );
        // An account connection already binds this key: nothing to create.
        // A desktop-only key's account row binds nothing (REG-3035).
        if (!desktopOnly && rows.some((item) => item.scope === 'account')) {
          await onServersChanged();
          return;
        }
        const existing = rows.find((item) => item.scope !== 'account');
        if (existing)
          current = (await window.mcpServers.loadServer(existing.id)).server;
      }
      if (current && (await signInThroughAccount(current))) return;
      if (!current) {
        if (!entry)
          throw new Error(
            'Unable to load this server. Reopen its details to retry.',
          );
        // One Add rule for the Plugins page and the MCP tab (REG-3033).
        const target = curatedMcpAddTarget(entry, {
          accountConnectionsEnabled,
          accountConnectionsAvailable,
        });
        if (target.kind === 'account') {
          await connectAccount(entry, target.configId);
          return;
        }
        const form = oauthFromCuratedHints(entry);
        const setupError = validateCuratedSetup(
          entry,
          curatedInitialUrl(entry),
          form,
        );
        if (curatedRequiresProviderAuth(entry) || setupError) {
          setGuidance(
            'Choose Advanced configuration to complete this service’s connection setup.',
          );
          setError(
            setupError ??
              'This service requires a provider-managed connection. Choose Advanced configuration to set it up.',
          );
          return;
        }
        const stock = stockCuratedServerData(entry);
        if ('error' in stock) throw new Error(stock.error);
        current = (await window.mcpServers.saveServer(stock.server)).server;
        // The device file is the plugin's binding; install its skills now.
        await installFoldedPlugin();
      }
      if (current.definition.type === 'command') {
        serverRef.current = current;
        setServer(current);
        return;
      }
      if (
        current.definition.httpAuthHandler === 'provider' ||
        current.definition.httpAuthHandler === 'account'
      ) {
        setError(
          'This connection is managed by another account. Choose Advanced configuration to change it.',
        );
        return;
      }
      const config = current.configs.find((item) => item.enabled);
      if (!config)
        throw new Error(
          'Enable a configuration in Advanced configuration to connect.',
        );
      serverRef.current = current;
      setServer(current);
      await onServersChanged();
      if (!mounted.current) return;
      // Read persisted status before starting. The initial render may still be
      // loading an old error when Add automatically begins a retry.
      const fresh = (await window.mcpServers.listStatus())
        .find((item) => item.serverId === current.definition.id)
        ?.configs.find((item) => item.configId === config.id);
      if (!mounted.current) return;
      startingErrorRevision.current = fresh?.authErrorRevision;
      statusGeneration.current += 1;
      setStatus(undefined);
      if (!current.definition.oauth && fresh?.authStatus === 'not_configured') {
        await refresh();
        return;
      }
      if (!current.definition.oauth && !fresh) {
        await refresh();
        return;
      }
      await start({
        serverId: current.definition.id,
        configId: config.id,
        force:
          fresh?.authStatus === 'error' ||
          (fresh?.authStatus === 'expired' && fresh.canRefresh !== true),
      });
      await refresh();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }, [
    accountConnection,
    accountConnectionsAvailable,
    accountConnectionsEnabled,
    connectAccount,
    desktopOnly,
    entry,
    installFoldedPlugin,
    installedServerId,
    onServersChanged,
    signInThroughAccount,
    start,
    refresh,
  ]);
  const moveToAccount = useCallback(async (): Promise<void> => {
    const current = serverRef.current;
    if (inFlight.current || !current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    setGuidance(undefined);
    setMoveNotice(undefined);
    try {
      await signInThroughAccount(current);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }, [signInThroughAccount]);
  const started = useRef(false);
  useEffect(() => {
    if (autoConnect && !started.current) {
      started.current = true;
      void connect();
    }
  }, [autoConnect, connect]);
  const connectionError =
    error ||
    oauth.error ||
    accountActions.error ||
    refreshError ||
    (!pending && auth?.authStatus === 'error' ? auth.lastError : undefined);
  const accountPending = entry ? accountActions.pending.has(entry.key) : false;
  const noAuth =
    accountConnection === undefined &&
    ((server?.definition.type ?? localServer?.type) === 'command' ||
      Boolean(
        server &&
        !server.definition.oauth &&
        (!auth || auth.authStatus === 'not_configured'),
      ));
  const installed =
    server !== null ||
    installedServerId !== null ||
    accountConnection !== undefined;
  const serviceName =
    entry?.name ?? server?.definition.name ?? localServer?.name ?? '';
  const accountReady =
    entry !== undefined &&
    !desktopOnly &&
    accountConnectionsEnabled &&
    accountConnectionsAvailable === true;
  const deviceTarget =
    entry && server && !accountConnection
      ? curatedMcpAddTarget(entry, {
          accountConnectionsEnabled,
          accountConnectionsAvailable,
          deviceServer: deviceServerOf(entry, server),
        })
      : undefined;
  const replacesDevice =
    deviceTarget?.kind === 'account'
      ? deviceTarget.replacesDeviceServer
      : undefined;
  const keepsDeviceSetup =
    deviceTarget?.kind === 'device' && deviceTarget.keepsDeviceSetup === true;
  const accountBehindConnected =
    replacesDevice !== undefined &&
    accountConnectionBehindDevice?.status === 'CONNECTED';
  const copyState = connectionCopyState({
    accountConnection,
    connected,
    installed,
    accountReady,
    replacesDevice: replacesDevice !== undefined,
    accountBehindConnected,
  });
  const signInPending =
    oauth.pending || accountPending || accountConnection?.status === 'PENDING';
  const connection = signInPending
    ? MCP_SIGN_IN_WAITING_LABEL
    : noAuth
      ? 'Not required'
      : mcpConnectionStatusLabel(serviceName, copyState);
  const usableHere = connected || accountBehindConnected;
  const statusConnected = !signInPending && !noAuth && usableHere;
  const offersMove =
    !noAuth && usableHere && replacesDevice !== undefined && !oauth.pending;
  const serverId = accountConnection?.serverKey ?? server?.definition.id;
  const configId =
    accountConnection?.configId ?? activeConfig?.id ?? server?.configs[0]?.id;
  const selectionRef = useMemo(
    () =>
      serverId !== undefined && configId !== undefined
        ? { serverId, configId }
        : null,
    [configId, serverId],
  );
  const workspaceChoices = useMcpWorkspaceDefaultChoices(selectionRef);
  const usable = !oauth.pending && (connected || noAuth);
  const showWorkspaces =
    selectionRef !== null &&
    (usable || workspaceChoices.some((choice) => choice.enabled === true));
  // Beside the provider route, the route heading already says this server
  // works with every supported harness, so the card keeps only what it adds.
  const skillsNote =
    foldedPlugin && !installed
      ? mcpFoldedPluginSkillsNote(foldedPlugin.name)
      : undefined;
  const connectedDescription = providerConnections
    ? undefined
    : MCP_SHARED_ACROSS_HARNESSES;
  const notConnectedDescription = providerConnections
    ? skillsNote
    : skillsNote
      ? `${MCP_CONNECT_ONCE_FOR_HARNESSES} ${skillsNote}`
      : MCP_CONNECT_ONCE_FOR_HARNESSES;
  const connectAction = (variant: 'primary' | 'secondary'): JSX.Element => (
    <McpConnectActionButton
      size="compact"
      variant={variant}
      data-testid="mcp-browse-detail-add"
      serviceName={serviceName}
      action={
        !installed
          ? 'add'
          : copyState === 'account-reauth'
            ? 'reconnect'
            : 'connect'
      }
      phase={
        oauth.pending || accountPending
          ? 'waiting'
          : saving
            ? 'connecting'
            : 'idle'
      }
      disabled={managementBusy}
      onClick={() => void connect()}
    />
  );
  const moveAction = (variant: 'primary' | 'secondary'): JSX.Element => (
    <McpConnectActionButton
      size="compact"
      variant={variant}
      data-testid="mcp-browse-detail-connect-account"
      serviceName={serviceName}
      action={accountBehindConnected ? 'use-account' : 'connect-to-account'}
      phase={accountPending ? 'waiting' : saving ? 'connecting' : 'idle'}
      disabled={managementBusy}
      onClick={() => void moveToAccount()}
    />
  );
  const primaryAction = renderPrimaryAction
    ? renderPrimaryAction({
        installation: signInPending
          ? 'pending'
          : usableHere || noAuth
            ? 'installed'
            : 'not-installed',
        onInstall: (): void => void connect(),
        installLabel: !installed
          ? 'Install'
          : copyState === 'account-reauth'
            ? 'Reconnect'
            : 'Connect',
        installBusy: saving || managementBusy,
        secondaryInstallAction: connectAction('secondary'),
        mcpServerRef: selectionRef,
      })
    : !usableHere &&
        !noAuth &&
        (entry !== undefined || accountConnection === undefined)
      ? connectAction('primary')
      : offersMove
        ? moveAction('primary')
        : undefined;
  useCurrentUiStateReporter('plugins.connection', {
    pending: oauth.pending,
    browserOpen: Boolean(oauth.url),
    connected: statusConnected,
    authRequired: connection !== 'Not required',
    errorVisible: Boolean(connectionError),
  });
  return (
    <>
      {/* Page actions join the detail's action bar at the top right:
          [Advanced configuration] [Install skills only] [Share] [Add]. */}
      <DetailPageActions
        secondary={
          <>
            <PluginConfigurationButton
              size="compact"
              onConfigure={() => setEditorOpen(true)}
              disabled={saving || accountPending || managementBusy}
            />
            {foldedPlugin && pluginInstall.status !== 'installed' && (
              <InstallSkillsButton
                pluginInstall={pluginInstall}
                onInstall={installFoldedPlugin}
              />
            )}
            {renderPrimaryAction && offersMove && moveAction('secondary')}
          </>
        }
        primary={primaryAction}
      />
      <div
        className={
          oauth.url ? 'grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2' : ''
        }
      >
        <CuratedDetail
          entry={
            entry ?? {
              name: server?.definition.name ?? localServer.name,
              shortDescription:
                server?.definition.description ?? localServer.description ?? '',
              key: localServer.curatedKey,
              logoUrl: localServer.logoUrl,
            }
          }
          installedServerId={server?.definition.id ?? installedServerId}
          toolsRevision={toolsRevision}
          routes={
            providerConnections
              ? {
                  own: {
                    title: mcpAppRouteTitle(brandText.appName),
                    description: mcpAppRouteDescription(brandText.appName),
                  },
                  others: providerConnections,
                }
              : undefined
          }
          connectionContent={
            <div className="max-w-2xl space-y-5">
              <PluginAccountConnection
                headingLevel={providerConnections ? 4 : 3}
                status={connection}
                connected={statusConnected}
                description={
                  noAuth
                    ? 'No account connection is needed.'
                    : offersMove
                      ? mcpConnectToAccountDescription(
                          serviceName,
                          accountBehindConnected,
                        )
                      : keepsDeviceSetup
                        ? mcpCustomSetupStaysDescription(serviceName)
                        : connected
                          ? connectedDescription
                          : notConnectedDescription
                }
                availability={<PluginHarnessStatus installed={installed} />}
              >
                <FoldedPluginStatus
                  foldedPlugin={foldedPlugin}
                  pluginInstall={pluginInstall}
                />
                {showWorkspaces &&
                  selectionRef &&
                  (workspaceChoices.length > 0 ? (
                    <McpWorkspaceDefaultsSection
                      workspaces={workspaceChoices}
                      onAdd={(workspaceId) =>
                        addMcpServerToWorkspaceDefaults(
                          workspaceId,
                          selectionRef,
                        )
                      }
                      onRemove={(workspaceId) =>
                        removeMcpServerFromWorkspaceDefaults(
                          workspaceId,
                          selectionRef,
                        )
                      }
                      testId="mcp-browse-detail-projects"
                    />
                  ) : (
                    <p
                      className="text-xs fg-secondary"
                      data-testid="mcp-browse-detail-projects-hint"
                    >
                      {MCP_WORKSPACE_SETTINGS_HINT}
                    </p>
                  ))}
                {moveNotice && (
                  <p
                    className="text-xs fg-secondary"
                    role="status"
                    data-testid="mcp-browse-detail-move-notice"
                  >
                    {moveNotice}
                  </p>
                )}
                {cloudLeftover && (
                  <div
                    className="flex flex-wrap items-center gap-2"
                    data-testid="mcp-browse-detail-cloud-connection"
                  >
                    <p className="text-xs fg-secondary">
                      Cloud chats can’t use this server anymore. You can
                      disconnect its cloud connection.
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="mcp-browse-detail-cloud-disconnect"
                      onClick={() =>
                        void accountActions.disconnect(cloudLeftover.id)
                      }
                    >
                      Disconnect
                    </Button>
                  </div>
                )}
                {connectionError && (
                  <PluginConnectionNotice
                    error={connectionError}
                    checkingStatus={
                      Boolean(refreshError) && !error && !oauth.error
                    }
                    guidance={
                      guidance ??
                      (error.includes('Advanced configuration')
                        ? error
                        : undefined)
                    }
                  />
                )}
              </PluginAccountConnection>
              {(server || accountConnection) && (
                <DesktopMcpManagementSections
                  key={accountConnection?.id ?? server?.definition.id}
                  server={accountConnection ? null : server}
                  status={status}
                  connection={accountConnection}
                  row={localServer}
                  actions={accountActions}
                  accountEnabled={accountConnectionsEnabled}
                  busy={
                    saving ||
                    accountPending ||
                    oauth.pending ||
                    editorOpen ||
                    moveEditorOpen
                  }
                  onChanged={async (): Promise<void> => {
                    await onServersChanged();
                    await refresh();
                  }}
                  onDeleted={onDeleted}
                  onMoveToDevice={(connection): void => {
                    setMoveConnection(connection);
                    setMoveEditorOpen(true);
                  }}
                  onBusyChange={setManagementBusy}
                />
              )}
            </div>
          }
        />
        {oauth.url && (
          <McpOAuthBrowser
            key={oauth.url}
            url={oauth.url}
            onClose={oauth.closeBrowser}
          />
        )}
      </div>
      {editorOpen && accountConnection && (
        <AccountMcpDetails
          key={accountConnection.id}
          connection={accountConnection}
          onClose={() => setEditorOpen(false)}
          onSaved={onServersChanged}
        />
      )}
      {editorOpen && !accountConnection && (
        <McpServerDialog
          serverId={server?.definition.id ?? installedServerId}
          initialCurated={installed ? undefined : entry}
          curatedEntries={entry ? [entry] : []}
          onClose={() => setEditorOpen(false)}
          onSaved={async () => {
            setEditorOpen(false);
            await onServersChanged();
            await refresh();
          }}
        />
      )}
      {moveEditorOpen && moveConnection && (
        <McpServerDialog
          serverId={server?.definition.id ?? null}
          accountConnection={moveConnection}
          entryAction="move-to-device"
          onClose={() => setMoveEditorOpen(false)}
          onSaved={async (): Promise<void> => {
            setMoveEditorOpen(false);
            await onServersChanged();
            await refresh();
          }}
        />
      )}
      {accountSetup && (
        <McpServerDialog
          key={`account:${accountSetup.entry.key}:${accountSetup.configId}`}
          serverId={null}
          mode="account"
          initialCurated={accountSetup.entry}
          curatedEntries={[accountSetup.entry]}
          {...(accountSetup.clientSetup
            ? {
                requiresOAuthClient: true,
                clientSetup: accountSetup.clientSetup,
              }
            : {})}
          {...(accountSetup.endpointUrl
            ? { initialEndpointUrl: accountSetup.endpointUrl }
            : {})}
          onAccountConnect={(options): void => {
            const {
              entry: catalogEntry,
              configId,
              accountId,
              replaces,
            } = accountSetup;
            setAccountSetup(null);
            void (async (): Promise<void> => {
              await accountActions.connect(catalogEntry.key, configId, {
                ...options,
                // Bound to the account the dialog opened under; a change in
                // between is refused before any secret leaves the renderer.
                expectedAccountId: accountId,
                onStarted: installFoldedPlugin,
                // Setup reopens for the user's own app, or the secret it
                // lacked, on the endpoint this attempt chose.
                onOAuthClientRequired: (clientSetup): void =>
                  void openAccountSetup({
                    entry: catalogEntry,
                    configId,
                    ...(clientSetup ? { clientSetup } : {}),
                    ...(options.endpointUrl
                      ? { endpointUrl: options.endpointUrl }
                      : {}),
                    ...(replaces ? { replaces } : {}),
                  }),
                ...(replaces
                  ? {
                      onConnected: (connection): Promise<void> =>
                        replaceDeviceServer(replaces, connection),
                    }
                  : {}),
              });
              if (mounted.current) await onServersChanged();
            })();
          }}
          onClose={() => setAccountSetup(null)}
          onSaved={async () => {
            setAccountSetup(null);
            await onServersChanged();
          }}
        />
      )}
    </>
  );
}
