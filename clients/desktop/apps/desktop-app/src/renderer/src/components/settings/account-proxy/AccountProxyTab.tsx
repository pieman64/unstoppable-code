import { type JSX, type ReactNode, useId, useState } from 'react';
import { Button, ToggleSwitch, ProviderStatusDot } from '@canopy/ui-shared';
import {
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  AccountProxyError,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { useOpenSettingsSection } from '../settings-section-navigation';
import {
  useAccountProxyLiveRefresh,
  useAccountProxyStatus,
  useAccountProxyStore,
} from '@/stores/accountProxyStore';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from '../SettingsLayout';
import { AccountProxyAccountList } from './AccountProxyAccountList';
import {
  AccountProxyAddAccount,
  AccountProxyLocalConnection,
  AccountProxyLocalSetup,
  type AccountProxyMode,
  AccountProxyModeRow,
} from './AccountProxyLocal';
import { AccountProxyErrorMessage } from './AccountProxyErrorMessage';
import { AccountProxyStrategyRow } from './AccountProxyStrategyRow';
import {
  ACCOUNT_PROXY_PAGE_DESCRIPTION,
  accountProxyErrorField,
  accountProxyHost,
} from './accountProxyCopy';
import { StatusLabel } from '@canopy/ui-shared/components';

function ErrorText({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId: string;
}): JSX.Element {
  return <StatusLabel data-testid={testId}>{children}</StatusLabel>;
}

interface ConnectFormProps {
  readonly initialUrl: string;
  /** Offered when the form replaces a working connection (Change key). */
  readonly onCancel?: () => void;
}

/**
 * Server URL and management key. A failed attempt keeps the previous
 * connection and puts the error under the field it belongs to.
 */
function ConnectForm({ initialUrl, onCancel }: ConnectFormProps): JSX.Element {
  const urlId = useId();
  const keyId = useId();
  const [url, setUrl] = useState(initialUrl);
  const [key, setKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<AccountProxyError | null>(null);

  const field = error ? accountProxyErrorField(error.code) : null;
  const message = error ? (
    <AccountProxyErrorMessage
      code={error.code}
      host={accountProxyHost(url.includes('://') ? url : `https://${url}`)}
      version={error.code === 'too-old' ? error.message : undefined}
    />
  ) : null;

  const connect = async (): Promise<void> => {
    const accountProxy = window.api.accountProxy;
    if (!accountProxy) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await accountProxy.connect({ url, managementKey: key });
      if (result.ok) {
        useAccountProxyStore.getState().setStatus(result.status);
        setKey('');
        onCancel?.();
      } else {
        setError(result.error);
      }
    } catch {
      setError({ code: 'unexpected', message: 'unexpected' });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <SettingsGroup dataTestId="account-proxy-connect-form">
      <SettingsRow
        label="Server URL"
        htmlFor={urlId}
        description={
          field === 'url' && message ? (
            <ErrorText testId="account-proxy-url-error">{message}</ErrorText>
          ) : (
            'The address your CLIProxyAPI server answers on.'
          )
        }
        control={
          <SettingsTextField
            id={urlId}
            width="md"
            mono
            value={url}
            onChange={(event): void => setUrl(event.target.value)}
            placeholder="https://proxy.example.com"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={field === 'url' || undefined}
            data-testid="account-proxy-url-input"
          />
        }
      />
      <SettingsRow
        label="Management key"
        htmlFor={keyId}
        description={
          field === 'key' && message ? (
            <ErrorText testId="account-proxy-key-error">{message}</ErrorText>
          ) : (
            'Lets this app list accounts and read their limits. Kept on this device.'
          )
        }
        control={
          <>
            <SettingsTextField
              id={keyId}
              width="md"
              type={keyVisible ? 'text' : 'password'}
              value={key}
              onChange={(event): void => setKey(event.target.value)}
              placeholder="Paste the key"
              autoComplete="off"
              aria-invalid={field === 'key' || undefined}
              data-testid="account-proxy-key-input"
            />
            <Button
              size="compact"
              variant="ghost"
              iconOnly
              aria-label={keyVisible ? 'Hide key' : 'Show key'}
              onClick={(): void => setKeyVisible((value) => !value)}
            >
              {keyVisible ? (
                <EyeOffIcon size="sm" aria-hidden />
              ) : (
                <EyeIcon size="sm" aria-hidden />
              )}
            </Button>
          </>
        }
      />
      <SettingsRow
        label="Connect"
        description={
          field === 'connection' && message ? (
            <ErrorText testId="account-proxy-connect-error">
              {message}
            </ErrorText>
          ) : (
            "Checks the server's version and lists its accounts."
          )
        }
        control={
          <>
            {onCancel ? (
              <Button size="compact" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
            <Button
              size="compact"
              variant="primary"
              disabled={connecting || !url.trim() || !key.trim()}
              onClick={(): void => {
                void connect();
              }}
              data-testid="account-proxy-connect"
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </>
        }
      />
    </SettingsGroup>
  );
}

function ConnectionSection({
  status,
}: {
  readonly status: AccountProxyStatus;
}): JSX.Element | null {
  const [changingKey, setChangingKey] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const connection = status.connection;
  if (!connection) return null;
  if (connection.kind === 'local') {
    return <AccountProxyLocalConnection status={status} />;
  }
  const host = accountProxyHost(connection.url);
  const keyRejected =
    status.error?.code === 'unauthorized' || status.error?.code === 'blocked';
  if (changingKey || status.state === 'needs-key') {
    return (
      <SettingsSection
        title="Connection"
        description={
          status.state === 'needs-key'
            ? 'Add the management key to use this server on this device.'
            : undefined
        }
      >
        <ConnectForm
          initialUrl={connection.url}
          onCancel={
            status.state === 'needs-key'
              ? undefined
              : (): void => setChangingKey(false)
          }
        />
      </SettingsSection>
    );
  }
  const statusLine = status.error ? (
    <ErrorText testId="account-proxy-connection-error">
      <AccountProxyErrorMessage
        code={status.error.code}
        host={host}
        version={
          status.error.code === 'too-old' ? status.error.message : undefined
        }
      />
    </ErrorText>
  ) : (
    <>
      {status.version
        ? `Connected · version ${status.version} · `
        : 'Connected · '}
      <span className={`font-mono ${POSTHOG_REPLAY_BLOCK_CLASS}`}>{host}</span>
    </>
  );
  return (
    <SettingsSection title="Connection">
      <SettingsGroup>
        <SettingsRow
          dataTestId="account-proxy-connection"
          label={
            <span className="inline-flex items-center gap-2">
              <GlobeIcon size="sm" aria-hidden />
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{host}</span>
              <ProviderStatusDot tone={status.error ? 'failed' : 'connected'} />
            </span>
          }
          description={statusLine}
          control={
            <Button
              size="compact"
              disabled={disconnecting}
              data-testid="account-proxy-disconnect"
              onClick={(): void => {
                setDisconnecting(true);
                void window.api.accountProxy
                  ?.disconnect()
                  .then((next) =>
                    useAccountProxyStore.getState().setStatus(next),
                  )
                  .finally(() => setDisconnecting(false));
              }}
            >
              Disconnect
            </Button>
          }
        />
        <SettingsRow
          label="Management key"
          description={
            keyRejected
              ? 'The server rejected the saved key. Enter the current key to reconnect.'
              : 'Saved on this device only.'
          }
          control={
            <Button
              size="compact"
              variant={keyRejected ? 'primary' : undefined}
              data-testid="account-proxy-change-key"
              onClick={(): void => setChangingKey(true)}
            >
              Change key
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

function RoutingSection({
  status,
}: {
  readonly status: AccountProxyStatus;
}): JSX.Element {
  const toggleId = useId();
  const claudeToggleId = useId();
  const codexToggleId = useId();
  const [saving, setSaving] = useState(false);
  const save = (preferences: Partial<PreferencesData>): void => {
    setSaving(true);
    void window.api
      .savePreferences(preferences)
      .finally(() => setSaving(false));
  };
  const serverAffinity = status.routing?.sessionAffinity;
  const local = status.connection?.kind === 'local';
  const whose = local ? "the proxy's" : "this server's";
  // The proxy keeps a session on one account only when its own
  // `routing.session-affinity` is on; this switch decides whether this
  // device sends the session ids it keys on. With affinity off there is
  // nothing to keep, so the switch is off and explains where to change it.
  const serverKeepsSessions = serverAffinity !== false;
  const keepDescription = serverKeepsSessions
    ? "Sends each chat's id so the server keeps the chat on one account until that account reaches a limit."
    : 'This server sends each request to the next account. Turn on session affinity in its config to keep a chat on one account.';
  return (
    <SettingsSection
      title="Routing"
      description={
        local
          ? 'What goes through the proxy on this device, and how it picks an account.'
          : 'What goes through this server, and how it picks an account.'
      }
    >
      <SettingsGroup>
        <SettingsRow
          label="Claude"
          htmlFor={claudeToggleId}
          description={`Claude chats, subagents, and workflow steps on this device use ${whose} Claude accounts.`}
          control={
            <ToggleSwitch
              id={claudeToggleId}
              checked={status.routeClaude}
              disabled={saving}
              label="Use for Claude"
              dataTestId="account-proxy-route-claude-toggle"
              onChange={(next): void => save({ accountProxyRouteClaude: next })}
            />
          }
        />
        <SettingsRow
          label="Codex"
          htmlFor={codexToggleId}
          description={`Codex chats, subagents, and workflow steps on this device use ${whose} Codex accounts.`}
          control={
            <ToggleSwitch
              id={codexToggleId}
              checked={status.routeCodex}
              disabled={saving}
              label="Use for Codex"
              dataTestId="account-proxy-route-codex-toggle"
              onChange={(next): void => save({ accountProxyRouteCodex: next })}
            />
          }
        />
        <SettingsRow
          label="Keep a chat on one account"
          htmlFor={toggleId}
          description={keepDescription}
          control={
            <ToggleSwitch
              id={toggleId}
              checked={serverKeepsSessions && status.keepChatOnOneAccount}
              disabled={saving || !serverKeepsSessions}
              label="Keep a chat on one account"
              dataTestId="account-proxy-keep-chat-toggle"
              onChange={(next): void =>
                save({ accountProxyKeepChatOnOneAccount: next })
              }
            />
          }
        />
        <AccountProxyStrategyRow status={status} />
      </SettingsGroup>
    </SettingsSection>
  );
}

/** Settings > Multi-account proxy (CAN-4019). */
export function AccountProxyTab(): JSX.Element {
  const status = useAccountProxyStatus();
  const openSettings = useOpenSettingsSection();
  const [mode, setMode] = useState<AccountProxyMode>('server');
  const local = status?.connection?.kind === 'local';
  const connected =
    status?.available === true &&
    (local || status.state === 'connected' || status.state === 'error');
  useAccountProxyLiveRefresh(connected);

  if (!status) {
    return (
      <SettingsPage
        title="Multi-account proxy"
        description={ACCOUNT_PROXY_PAGE_DESCRIPTION}
        dataTestId="settings-tab-account-proxy"
      >
        <SettingsLoading variant="spinner" />
      </SettingsPage>
    );
  }

  if (!status.available) {
    return (
      <SettingsPage
        title="Multi-account proxy"
        description={ACCOUNT_PROXY_PAGE_DESCRIPTION}
        dataTestId="settings-tab-account-proxy"
      >
        <SettingsSection>
          <SettingsGroup>
            <SettingsRow
              label="Turn on the account proxy"
              description="Turn on Use an account proxy in Labs to set it up."
              control={
                <Button
                  size="compact"
                  onClick={(): void => openSettings('experiments')}
                >
                  Open Labs
                </Button>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Multi-account proxy"
      description={ACCOUNT_PROXY_PAGE_DESCRIPTION}
      dataTestId="settings-tab-account-proxy"
    >
      {status.state === 'not-configured' ? (
        <SettingsSection title="Connection">
          {status.local.phase === 'unsupported' ? (
            <ConnectForm initialUrl="" />
          ) : (
            <>
              <SettingsGroup>
                <AccountProxyModeRow mode={mode} onChange={setMode} />
                {mode === 'local' ? (
                  <AccountProxyLocalSetup local={status.local} />
                ) : null}
              </SettingsGroup>
              {mode === 'server' ? <ConnectForm initialUrl="" /> : null}
            </>
          )}
        </SettingsSection>
      ) : (
        <ConnectionSection status={status} />
      )}
      {connected ? (
        <SettingsSection
          title="Accounts"
          description="Accounts the proxy shares. Limits refresh every minute."
          dataTestId="account-proxy-accounts"
        >
          <SettingsGroup>
            {status.accounts.length > 0 ? (
              <AccountProxyAccountList
                accounts={status.accounts}
                variant="row"
                actionsDisabled={
                  status.error?.code === 'unauthorized' ||
                  status.error?.code === 'blocked'
                }
              />
            ) : local ? null : (
              <SettingsRow
                label="No accounts yet"
                description="Sign accounts in on the server. They appear here within a minute."
              />
            )}
            {local ? <AccountProxyAddAccount status={status} /> : null}
          </SettingsGroup>
        </SettingsSection>
      ) : null}
      {connected ? <RoutingSection status={status} /> : null}
    </SettingsPage>
  );
}
