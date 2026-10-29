import { AuthLoginModal } from './AuthLoginModal';
import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, Notice } from '@canopy/ui-shared/components';
import type { OpenCodeConnectionStatus } from '@canopy/desktop-shared/types/opencode-connection';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { extractIpcErrorMessage } from '@/lib/errors';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

export function OpenCodeConnection(): JSX.Element | null {
  const [status, setStatus] = useState<OpenCodeConnectionStatus>();
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const operation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const api = window.api.opencodeConnection;
    if (!api) return;
    const off = api.onProgress((value) => {
      if (mounted.current) setStatus(value);
    });
    void api
      .status()
      .then((value) => {
        if (mounted.current && !operation.current) setStatus(value);
      })
      .catch(() => {
        if (mounted.current)
          setError(
            'Could not check OpenCode setup. Reopen this page to retry.',
          );
      });
    return (): void => {
      mounted.current = false;
      off();
      if (operation.current) void api.cancel().catch(() => undefined);
    };
  }, []);
  const act = async (kind: 'connect' | 'disconnect'): Promise<void> => {
    const api = window.api.opencodeConnection;
    if (!api || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await api[kind]();
      const next = await api.status();
      emitPreferencesUpdated(await window.api.loadPreferences());
      if (mounted.current) setStatus(next);
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? extractIpcErrorMessage(reason)
            : 'OpenCode setup failed. Try again.',
        );
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (status && !status.supported) return null;
  const connected = status?.enabled && status.installed;
  const label = !status
    ? 'Checking setup…'
    : !busy
      ? connected
        ? 'OpenCode connected'
        : 'Ready to connect'
      : status.phase === 'downloading'
        ? `Downloading OpenCode${status.percent === undefined ? '…' : `… ${status.percent}%`}`
        : status.phase === 'discovering'
          ? 'Loading your OpenCode models…'
          : status.phase === 'verifying'
            ? 'Verifying download…'
            : 'Preparing OpenCode…';
  return (
    <SettingsSection title="OpenCode">
      <SettingsGroup>
        <SettingsRow
          dataTestId="opencode-connection"
          label="Use OpenCode"
          description="Connect your configured OpenCode providers. Their billing and usage limits apply."
          control={
            <>
              <Button
                size="compact"
                variant={connected ? 'secondary' : 'primary'}
                disabled={busy || !status}
                data-testid="opencode-connect"
                onClick={() => {
                  void act(connected ? 'disconnect' : 'connect');
                }}
              >
                {connected ? 'Disconnect' : 'Connect OpenCode'}
              </Button>
              {busy && (
                <Button
                  size="compact"
                  variant="secondary"
                  data-testid="opencode-cancel"
                  onClick={() => {
                    void window.api.opencodeConnection
                      ?.cancel()
                      .catch(() => undefined);
                  }}
                >
                  Cancel
                </Button>
              )}
            </>
          }
        >
          <p
            role="status"
            className="text-xs fg-secondary"
            data-testid="opencode-connection-status"
          >
            {label}
          </p>
          {!connected && (
            <p className="text-xs fg-secondary">
              Connect to download OpenCode, then sign in to a provider. Existing
              OpenCode accounts and provider settings are reused. Download size
              {status?.archiveBytes
                ? ` (${Math.round(status.archiveBytes / 1_000_000)} MB)`
                : ''}
              .
            </p>
          )}
          {status?.installed && (
            <Button
              size="compact"
              variant="secondary"
              disabled={busy}
              data-testid="opencode-provider-login"
              onClick={() => setLogin(true)}
            >
              Sign in to a provider
            </Button>
          )}
          {error && (
            <Notice
              intent="destructive"
              data-testid="opencode-connection-error"
            >
              {error}
            </Notice>
          )}
        </SettingsRow>
      </SettingsGroup>
      {login && (
        <AuthLoginModal
          provider="opencode"
          onClose={() => {
            setLogin(false);
            void window.api.opencodeConnection
              ?.listModels()
              .catch(() => undefined);
          }}
        />
      )}
    </SettingsSection>
  );
}
