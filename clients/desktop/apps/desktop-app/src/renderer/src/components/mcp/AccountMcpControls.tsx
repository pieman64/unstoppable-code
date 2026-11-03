import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { InstalledEntryStatusSection } from '../plugins/InstalledEntryStatusSection';
import { useCallback, useState, type JSX } from 'react';
import type { AccountMcpClientSetup } from '@canopy/protocol/mcp-servers';
import { McpToolSelection } from '@canopy/ui-app/capability';
import {
  Button,
  McpClientSetupDetails,
  StatusBadge,
  DialogModal,
  Notice,
  MarketplaceShareButton,
  DetailActionBar,
  UNIFIED_ENTRY_SURFACE_LABELS,
} from '@canopy/ui-shared';
import type {
  AccountMcpConnection,
  McpServerIndexEntry,
  ProviderConnectorProvider,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  accountMcpRowKey,
  type AccountMcpActions,
} from '../../hooks/useAccountMcpActions';
import { FormField, TextInput } from '@canopy/ui-shared/components';

interface McpTierBadgeProps {
  row: McpServerIndexEntry;
  providers?: ProviderConnectorProvider[];
  /**
   * The catalog keeps this server off the cloud account (REG-3035), so even
   * an account row made before it was marked reads Desktop only.
   */
  desktopOnly?: boolean;
}

export function McpTierBadge({
  row,
  providers = [],
  desktopOnly = false,
}: McpTierBadgeProps): JSX.Element {
  const cloudRow = row.scope === 'account' || row.authHandler === 'account';
  const labels = cloudRow
    ? [UNIFIED_ENTRY_SURFACE_LABELS[desktopOnly ? 'desktop' : 'cloud']]
    : providers.length
      ? providers.map((provider): string =>
          provider === 'claude' ? 'Managed by Claude' : 'Managed by Codex',
        )
      : [UNIFIED_ENTRY_SURFACE_LABELS.desktop];
  return (
    <span className="inline-flex gap-1" data-testid="mcp-tier-badge">
      {labels.map(
        (label): JSX.Element => (
          <StatusBadge key={label} variant="muted" label={label} />
        ),
      )}
    </span>
  );
}

interface AccountMcpControlsProps {
  row: McpServerIndexEntry;
  actions: AccountMcpActions;
  onConnect?: () => void;
  /**
   * False for a server only the desktop can connect (REG-3035): the row keeps
   * only Disconnect, for a connection made before it was marked.
   */
  connectable?: boolean;
}

export function AccountMcpControls({
  row,
  actions,
  onConnect,
  connectable = true,
}: AccountMcpControlsProps): JSX.Element {
  const key = accountMcpRowKey(row);
  const connection = row.accountConnection;
  if (!key) return <></>;
  if (
    connectable &&
    (actions.pending.has(key) || connection?.status === 'PENDING')
  )
    return (
      <span
        className="inline-flex items-center gap-2"
        data-testid="mcp-account-pending"
      >
        {!connection && <span role="status">Waiting for browser</span>}
        <Button
          size="sm"
          variant="ghost"
          className="whitespace-nowrap"
          onClick={(): void =>
            void (actions.pending.has(key)
              ? actions.cancel(key)
              : connection
                ? actions.disconnect(connection.id)
                : Promise.resolve())
          }
        >
          Cancel
        </Button>
      </span>
    );
  return (
    // Each label stays on one line; a narrow mount wraps whole buttons.
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      {connectable && connection?.status !== 'CONNECTED' && (
        <Button
          size="sm"
          variant="secondary"
          className="whitespace-nowrap"
          data-testid="mcp-account-connect"
          onClick={
            onConnect ??
            ((): void => void actions.connect(key, connection?.configId))
          }
        >
          {!connection
            ? 'Make available in cloud'
            : connection.status === 'REAUTH_REQUIRED'
              ? 'Reconnect'
              : 'Connect'}
        </Button>
      )}
      {connection && connection.status !== 'DISCONNECTED' && (
        <Button
          size="sm"
          variant="ghost"
          className="whitespace-nowrap"
          data-testid="mcp-account-disconnect"
          onClick={(): void => void actions.disconnect(connection.id)}
        >
          Disconnect
        </Button>
      )}
    </span>
  );
}

interface AccountMcpDetailsProps {
  shareAction?: MarketplaceShareAction;
  connection: AccountMcpConnection;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export type AccountMcpCredentialKind = 'bearer' | 'oauth-client';
export type AccountMcpCredential =
  | { bearerToken: string }
  | { oauthClient: { clientId: string; clientSecret?: string } };

interface AccountMcpCredentialDialogProps {
  displayName: string;
  kind: AccountMcpCredentialKind;
  /** Replaces the default explanation, e.g. when a first connect needs one. */
  intro?: string;
  /**
   * For `oauth-client`: what the cloud said the user's own app needs. The
   * dialog then explains it with the redirect URI to register, and collects
   * a secret when the account can store one.
   */
  clientSetup?: AccountMcpClientSetup;
  onSubmit: (credential: AccountMcpCredential) => void;
  onClose: () => void;
}

const CREDENTIAL_COPY: Record<
  AccountMcpCredentialKind,
  { intro: string; label: string; empty: string; testId: string }
> = {
  bearer: {
    intro:
      'This server uses an access token. Enter a new token to connect it again.',
    label: 'Access token',
    empty: 'Enter the access token to connect.',
    testId: 'mcp-account-bearer-token',
  },
  'oauth-client': {
    intro:
      'This server uses its own OAuth app. Enter its client ID to connect it again.',
    label: 'OAuth client ID',
    empty: 'Enter the OAuth client ID to connect.',
    testId: 'mcp-account-oauth-client-id',
  },
};

/** Collects the credential a custom connection needs before it connects. */
export function AccountMcpCredentialDialog({
  displayName,
  kind,
  intro,
  clientSetup,
  onSubmit,
  onClose,
}: AccountMcpCredentialDialogProps): JSX.Element {
  const copy = CREDENTIAL_COPY[kind];
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const setup = kind === 'oauth-client' ? clientSetup : undefined;
  const collectsSecret = setup?.clientSecretAccepted === true;
  const secretRequired = collectsSecret && setup?.clientSecretRequired === true;
  const submit = (): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(copy.empty);
      return;
    }
    if (secretRequired && !secret.trim()) {
      setError('Enter the OAuth client secret to connect.');
      return;
    }
    onSubmit(
      kind === 'bearer'
        ? { bearerToken: value }
        : {
            oauthClient: {
              clientId: trimmed,
              ...(collectsSecret && secret.trim()
                ? { clientSecret: secret }
                : {}),
            },
          },
    );
  };
  return (
    <DialogModal title={`Connect ${displayName}`} onClose={onClose}>
      <div className="space-y-4" data-testid="mcp-account-credential-setup">
        {setup ? (
          <McpClientSetupDetails
            serverName={displayName}
            redirectUri={setup.redirectUri}
            {...(setup.docsUrl ? { docsUrl: setup.docsUrl } : {})}
            clientSecretRequired={setup.clientSecretRequired}
            clientSecretAccepted={setup.clientSecretAccepted}
            registrationRefused={setup.registrationRefused === true}
          />
        ) : (
          <p className="text-s fg-secondary">{intro ?? copy.intro}</p>
        )}
        <FormField label={copy.label}>
          {(control) => (
            <TextInput
              {...control}
              type={kind === 'bearer' ? 'password' : 'text'}
              autoComplete="off"
              data-testid={copy.testId}
              value={value}
              onChange={(event): void => setValue(event.target.value)}
            />
          )}
        </FormField>
        {collectsSecret && (
          <FormField
            label={
              secretRequired
                ? 'OAuth client secret'
                : 'OAuth client secret (optional)'
            }
          >
            {(control) => (
              <TextInput
                {...control}
                type="password"
                autoComplete="off"
                data-testid="mcp-account-oauth-client-secret"
                value={secret}
                onChange={(event): void => setSecret(event.target.value)}
              />
            )}
          </FormField>
        )}
        {error && <Notice intent="destructive">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Connect
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}

export function AccountMcpDetails({
  shareAction,
  connection,
  onClose,
  onSaved,
}: AccountMcpDetailsProps): JSX.Element {
  const loadTools = useCallback(
    () => window.mcpServers.listAccountConnectionUpstreamTools(connection.id),
    [connection.id],
  );
  const saveTools = useCallback(
    async (tools: string[] | null): Promise<void> => {
      await window.mcpServers.setAccountConnectionTools(connection.id, tools);
    },
    [connection.id],
  );
  return (
    <DialogModal
      title={connection.displayName}
      onClose={onClose}
      // Share sits in the title bar's top right, where every Marketplace
      // detail puts it.
      topRightActions={
        <DetailActionBar
          share={
            shareAction ? (
              <MarketplaceShareButton
                action={shareAction}
                name={connection.displayName}
                placement="detail"
                dataTestId="mcp-account-details-share"
              />
            ) : undefined
          }
        />
      }
    >
      <div className="" data-testid="mcp-account-details">
        <InstalledEntryStatusSection
          entry={{
            state: 'installed',
            name: connection.displayName,
            ref: {
              type: 'local-mcp',
              serverId: connection.serverKey,
              configId: connection.configId,
            },
          }}
          onUninstalled={onClose}
        />
        <McpToolSelection
          enabledTools={connection.enabledTools}
          loadTools={loadTools}
          saveTools={saveTools}
          onSaved={async (): Promise<void> => {
            await onSaved();
            onClose();
          }}
          onReauthRequired={onSaved}
          dataTestId="mcp-account-tools"
        />
      </div>
    </DialogModal>
  );
}
