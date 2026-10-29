import { McpServersTab } from '../pages/McpServersTab';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { type JSX, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_MCP_HTTP_AUTH_HANDLER,
  DEFAULT_MCP_PROXY_PORT,
  type McpHttpAuthHandler,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type {
  McpProxyState,
  McpProxyStatus,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  MCP_HTTP_AUTH_CANOPY_DESCRIPTION,
  MCP_HTTP_AUTH_CANOPY_LABEL,
  MCP_HTTP_AUTH_HEADING,
  mcpHttpAuthHelper,
  MCP_HTTP_AUTH_PROVIDER_DESCRIPTION,
  MCP_HTTP_AUTH_PROVIDER_LABEL,
  MCP_PORT_VALIDATION_ERROR,
  MCP_SAVE_ERROR_FALLBACK,
  MCP_SAVED_TEXT,
  parseMcpProxyPort,
} from './mcp-tab-helpers';
import { Tooltip } from '@canopy/ui-shared';
import {
  Button,
  StatusBadge,
  type StatusBadgeVariant,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRadioGroup,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
  type SettingsRadioOption,
} from './SettingsLayout';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

function statusLabel(status: McpProxyStatus): string {
  switch (status) {
    case 'stopped':
      return 'Stopped';
    case 'running':
      return 'Running';
    case 'error':
      return 'Error';
  }
}

function statusBadgeVariant(status: McpProxyStatus): StatusBadgeVariant {
  switch (status) {
    case 'stopped':
      return 'muted';
    case 'running':
      return 'success';
    case 'error':
      return 'destructive';
  }
}

type LoadStatus = 'loading' | 'ready' | 'error';

type McpAuthOption = SettingsRadioOption<McpHttpAuthHandler>;

const MCP_AUTH_OPTIONS: readonly McpAuthOption[] = [
  {
    value: 'canopy',
    label: MCP_HTTP_AUTH_CANOPY_LABEL,
    dataTestId: 'settings-mcp-auth-canopy',
  },
  {
    value: 'provider',
    label: MCP_HTTP_AUTH_PROVIDER_LABEL,
    dataTestId: 'settings-mcp-auth-provider',
  },
];

/** Offered only while account connections are enabled. */
const MCP_ACCOUNT_AUTH_OPTION: McpAuthOption = {
  value: 'account',
  label: 'Account (via cloud)',
  dataTestId: 'settings-mcp-auth-account',
};

function isValidHandler(value: unknown): value is McpHttpAuthHandler {
  return value === 'canopy' || value === 'provider' || value === 'account';
}

export function McpTab(): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const mcpSectionTitle = useEarlyAccessTitle('MCP Servers');
  const accountConnectionsEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [portInput, setPortInput] = useState<string>(
    String(DEFAULT_MCP_PROXY_PORT),
  );
  const [appliedPort, setAppliedPort] = useState<number>(
    DEFAULT_MCP_PROXY_PORT,
  );
  const [authHandler, setAuthHandler] = useState<McpHttpAuthHandler>(
    DEFAULT_MCP_HTTP_AUTH_HANDLER,
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [proxyState, setProxyState] = useState<McpProxyState | null>(null);
  const unsubscribeProxyStatusRef = useRef<(() => void) | null>(null);
  const portLocked = proxyState?.portLocked === true;

  function applyProxyState(state: McpProxyState): void {
    setProxyState(state);
    if (
      state.portLocked &&
      typeof state.port === 'number' &&
      Number.isFinite(state.port)
    ) {
      setPortInput(String(state.port));
    }
  }

  useEffect((): (() => void) => {
    let cancelled = false;
    setStatus('loading');
    void window.api
      .loadPreferences()
      .then((prefs: PreferencesData): void => {
        if (cancelled) return;
        const port =
          typeof prefs.mcpProxyPort === 'number' &&
          Number.isFinite(prefs.mcpProxyPort)
            ? prefs.mcpProxyPort
            : DEFAULT_MCP_PROXY_PORT;
        setPortInput(String(port));
        setAppliedPort(port);
        const handler = isValidHandler(prefs.mcpHttpAuthDefaultHandler)
          ? prefs.mcpHttpAuthDefaultHandler
          : DEFAULT_MCP_HTTP_AUTH_HANDLER;
        setAuthHandler(handler);
        setStatus('ready');
      })
      .catch((): void => {
        if (cancelled) return;
        setPortInput(String(DEFAULT_MCP_PROXY_PORT));
        setAppliedPort(DEFAULT_MCP_PROXY_PORT);
        setAuthHandler(DEFAULT_MCP_HTTP_AUTH_HANDLER);
        setStatus('error');
      });

    void window.mcpServers
      .getProxyState()
      .then((state: McpProxyState): void => {
        if (cancelled) return;
        applyProxyState(state);
      })
      .catch((): void => {
        // Non-fatal — UI falls back to "no state" placeholder.
      });

    unsubscribeProxyStatusRef.current = window.mcpServers.onProxyStatus(
      (state: McpProxyState): void => {
        applyProxyState(state);
      },
    );

    return (): void => {
      cancelled = true;
      unsubscribeProxyStatusRef.current?.();
      unsubscribeProxyStatusRef.current = null;
    };
  }, []);

  async function applySettings(port: number): Promise<void> {
    setSuccessMessage(null);
    setErrorMessage(null);
    setSaving(true);
    try {
      const state = await window.mcpServers.applyProxyPort(port);
      await window.api.savePreferences({
        mcpHttpAuthDefaultHandler: authHandler,
      });
      applyProxyState(state);
      setAppliedPort(port);
      setSuccessMessage(MCP_SAVED_TEXT);
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : MCP_SAVE_ERROR_FALLBACK;
      setErrorMessage(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleApply(): Promise<void> {
    const parsed = parseMcpProxyPort(portInput);
    if (parsed === null) {
      setSuccessMessage(null);
      setErrorMessage(MCP_PORT_VALIDATION_ERROR);
      return;
    }
    await applySettings(parsed);
  }

  async function handleReset(): Promise<void> {
    setPortInput(String(DEFAULT_MCP_PROXY_PORT));
    await applySettings(DEFAULT_MCP_PROXY_PORT);
  }

  function handleAuthHandlerChange(next: McpHttpAuthHandler): void {
    setAuthHandler(next);
    setSuccessMessage(null);
    setErrorMessage(null);
  }

  if (status === 'loading') {
    return (
      <SettingsPage title="MCP servers" dataTestId="settings-tab-mcp">
        <SettingsLoading />
      </SettingsPage>
    );
  }

  const authOptions = accountConnectionsEnabled
    ? [...MCP_AUTH_OPTIONS, MCP_ACCOUNT_AUTH_OPTION]
    : MCP_AUTH_OPTIONS;
  const inputPort = parseMcpProxyPort(portInput);
  const showReset =
    !portLocked &&
    (appliedPort !== DEFAULT_MCP_PROXY_PORT ||
      inputPort !== DEFAULT_MCP_PROXY_PORT);
  const proxyError =
    errorMessage ??
    (proxyState?.status === 'error' && proxyState.error
      ? proxyState.error
      : null);

  return (
    <SettingsPage
      title="MCP servers"
      // The account connections panel is a server table; without it the page
      // is two short forms that read best at the default measure.
      dataTestId="settings-tab-mcp"
    >
      {accountConnectionsEnabled && (
        <SettingsSection
          title="Account connections"
          headingId="settings-mcp-account-connections-heading"
          dataTestId="settings-mcp-account-connections"
        >
          <McpServersTab accountPanel />
        </SettingsSection>
      )}

      <SettingsSection
        title={MCP_HTTP_AUTH_HEADING}
        description={mcpHttpAuthHelper(mcpSectionTitle)}
      >
        <SettingsGroup>
          <SettingsRow
            label="Default auth path"
            description={
              <span data-testid="settings-mcp-auth-description">
                {authHandler === 'account'
                  ? 'Uses your connected cloud account through the local proxy.'
                  : authHandler === 'canopy'
                    ? MCP_HTTP_AUTH_CANOPY_DESCRIPTION
                    : MCP_HTTP_AUTH_PROVIDER_DESCRIPTION}
              </span>
            }
          >
            <SettingsRadioGroup
              name="settings-mcp-auth-handler"
              label="Default auth path"
              value={authHandler}
              options={authOptions}
              onChange={handleAuthHandlerChange}
              dataTestId="settings-mcp-auth-pill"
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Local HTTP proxy"
        description={`Used for HTTP MCP servers when the auth path is ${MCP_HTTP_AUTH_CANOPY_LABEL}. It only listens on 127.0.0.1.`}
      >
        <SettingsGroup>
          <SettingsRow
            label="Proxy port"
            htmlFor="settings-mcp-port-input"
            description={
              portLocked ? (
                <span data-testid="settings-mcp-port-locked">
                  The proxy port has been locked by app setup.
                </span>
              ) : undefined
            }
            control={
              <>
                <SettingsTextField
                  id="settings-mcp-port-input"
                  type="number"
                  width="xs"
                  min={1}
                  max={65535}
                  value={portInput}
                  disabled={portLocked}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
                    setPortInput(e.target.value);
                    setSuccessMessage(null);
                    setErrorMessage(null);
                  }}
                  data-testid="settings-mcp-port-input"
                />
                {showReset && (
                  <Tooltip label="Reset proxy port to default">
                    <Button
                      size={settingsButtonSize}
                      variant="ghost"
                      onClick={(): void => {
                        void handleReset();
                      }}
                      disabled={saving}
                      data-testid="settings-mcp-reset"
                    >
                      Reset
                    </Button>
                  </Tooltip>
                )}
                <Button
                  size={settingsButtonSize}
                  variant="secondary"
                  onClick={(): void => {
                    void handleApply();
                  }}
                  disabled={saving}
                  data-testid="settings-mcp-save"
                >
                  {saving ? 'Applying…' : 'Apply'}
                </Button>
              </>
            }
          >
            {/* Inline under the port, like the Display tab's save error, so
                an Apply result never moves the Apply button. */}
            {successMessage !== null && (
              <p
                className="text-xs fg-success"
                data-testid="settings-mcp-saved"
              >
                {successMessage}
              </p>
            )}
            {proxyError !== null && (
              <p
                role="alert"
                className="text-xs fg-destructive"
                data-testid="settings-mcp-error"
              >
                {proxyError}
              </p>
            )}
          </SettingsRow>

          {proxyState && (
            <SettingsRow
              label="Status"
              dataTestId="settings-mcp-proxy-status"
              description={
                proxyState.refreshedAt
                  ? `Last refreshed ${new Date(
                      proxyState.refreshedAt,
                    ).toLocaleTimeString()}`
                  : undefined
              }
              control={
                <StatusBadge
                  variant={statusBadgeVariant(proxyState.status)}
                  label={statusLabel(proxyState.status)}
                />
              }
            />
          )}
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
