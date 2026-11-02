import { useEffect, useRef, useState, type JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  Button,
  CopyButton,
  ProviderStatusDot,
} from '@canopy/ui-shared/components';
import type { CopilotConnectionStatus } from '@canopy/desktop-shared/types';
import { extractIpcErrorMessage } from '@/lib/errors';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { GitHubIcon } from '@canopy/ui-shared/icons/AppIcons';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

interface CopilotConnectionProps {
  /**
   * `row`: one provider row inside the caller's group, as on Accounts beside
   * Claude and Codex. `section` (default): its own untitled section and box,
   * as on Labs.
   */
  readonly placement?: 'row' | 'section';
}

export function CopilotConnection({
  placement = 'section',
}: CopilotConnectionProps = {}): JSX.Element | null {
  const [status, setStatus] = useState<CopilotConnectionStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const operation = useRef(false);
  // A cancelled setup rejects with an abort; that is the user's choice, not a
  // failure to report.
  const cancelRequested = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const api = window.api.copilotConnection;
    if (!api) return;
    const off = api.onProgress((value) => {
      if (mounted.current) setStatus(value);
    });
    void api
      .status()
      .then(async (value) => {
        if (mounted.current) setStatus(value);
        if (value.enabled && value.installed) {
          const account = await api.account();
          if (
            mounted.current &&
            !operation.current &&
            (!account ||
              account.host !== value.account?.host ||
              account.login !== value.account?.login)
          ) {
            setStatus({
              ...value,
              enabled: false,
              account: null,
              phase: 'idle',
            });
            setError(
              'Copilot sign-in changed. Reconnect the account you want to use.',
            );
          }
        }
      })
      .catch(() => {
        if (mounted.current && !operation.current)
          setError('Could not check Copilot setup. Reopen this page to retry.');
      });
    return (): void => {
      mounted.current = false;
      off();
      if (operation.current) void api.cancel().catch(() => undefined);
    };
  }, []);

  const act = async (
    kind: 'connect' | 'disconnect' | 'changeAccount',
  ): Promise<void> => {
    const api = window.api.copilotConnection;
    if (!api || operation.current) return;
    operation.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setError(undefined);
    try {
      await api[kind]();
      const next = await api.status();
      const preferences = await window.api.loadPreferences();
      emitPreferencesUpdated(preferences);
      if (mounted.current) setStatus(next);
    } catch (reason) {
      if (mounted.current && !cancelRequested.current)
        setError(
          reason instanceof Error
            ? extractIpcErrorMessage(reason)
            : 'Copilot setup failed. Try again.',
        );
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (status && !status.supported) return null;
  const connected = status?.enabled && status.installed;
  const progress =
    busy && status?.phase !== 'connected' && status?.phase !== 'idle';
  const label = !status
    ? 'Checking setup…'
    : !busy
      ? connected
        ? 'Copilot connected'
        : 'Ready to connect'
      : status.phase === 'downloading'
        ? `Downloading Copilot${status.percent === undefined ? '…' : `… ${status.percent}%`}`
        : status.phase === 'authorizing'
          ? 'Enter this code on GitHub to connect Copilot'
          : status.phase === 'checking'
            ? 'Checking Copilot access…'
            : status.phase === 'verifying'
              ? 'Verifying download…'
              : 'Preparing Copilot…';
  // Mark, name and status dot as the label, as on the Claude, Codex and
  // Cursor rows; the account actions sit on the row's trailing edge.
  const row = (
    <SettingsRow
      dataTestId="copilot-connection"
      label={
        <span className="inline-flex items-center gap-2">
          <GitHubIcon size={16} className="shrink-0 fg-primary" aria-hidden />
          GitHub Copilot
          {/* No dot until the first status read answers: "Checking setup…"
              is neither connected nor disconnected. */}
          {status && (
            <ProviderStatusDot
              data-testid="copilot-connection-status-dot"
              tone={connected ? 'connected' : 'failed'}
            />
          )}
        </span>
      }
      description={
        <>
          <span
            role="status"
            data-testid="copilot-connection-status"
            className="block"
          >
            {label}
          </span>
          {connected && status?.account && !busy && (
            <span data-testid="copilot-connection-account" className="block">
              Signed in as{' '}
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                {status.account.login}
              </span>
            </span>
          )}
        </>
      }
      control={
        <>
          {busy && (
            <Button
              size="compact"
              variant="secondary"
              data-testid="copilot-cancel"
              onClick={() => {
                cancelRequested.current = true;
                void window.api.copilotConnection?.cancel();
              }}
            >
              Cancel
            </Button>
          )}
          {connected && !busy && (
            <Button
              size="compact"
              variant="secondary"
              data-testid="copilot-change-account"
              onClick={() => {
                void act('changeAccount');
              }}
            >
              Change account
            </Button>
          )}
          <Button
            size="compact"
            variant={connected ? 'secondary' : 'primary'}
            disabled={busy || !status}
            data-testid="copilot-connect"
            onClick={() => {
              void act(connected ? 'disconnect' : 'connect');
            }}
          >
            {connected ? 'Disconnect Copilot' : 'Connect Copilot'}
          </Button>
        </>
      }
    >
      {/* The pitch answers what Connect does, so it is spent once Copilot is
          connected and stays through setup. */}
      {!connected && (
        <div className="space-y-1 text-xs text-pretty fg-secondary">
          <p>
            Connect your GitHub account to use Copilot models, tools, and
            skills.
          </p>
          <p>
            {status?.archiveBytes
              ? `${Math.round(status.archiveBytes / 1_000_000)}MB download · `
              : ''}
            Your Copilot plan and usage limits apply
          </p>
        </div>
      )}
      {busy && status?.phase === 'authorizing' && status.userCode && (
        <div className="flex flex-wrap items-center gap-2">
          {/* The device code is a live sign-in secret. */}
          <span
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} rounded-md px-3 py-1 font-mono text-m fg-primary ring-[length:var(--border-hairline)] ring-inset ring-line-base`}
            data-testid="copilot-device-code"
            aria-label={`Device code ${status.userCode}`}
          >
            {status.userCode}
          </span>
          <CopyButton
            variant="secondary"
            size="compact"
            label="Copy code"
            value={status.userCode}
            dataTestId="copilot-copy-code"
          />
          <Button
            size="compact"
            variant="secondary"
            data-testid="copilot-open-github"
            onClick={() => {
              if (status.verificationUri)
                void window.api.browser.openExternal({
                  url: status.verificationUri,
                });
            }}
          >
            Open GitHub
          </Button>
        </div>
      )}
      {connected && !progress && (
        <p className="text-xs fg-secondary">
          Disconnect signs out of Copilot on this device. Change account signs
          out first.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-xs fg-destructive"
          data-testid="copilot-connection-error"
        >
          {error}
        </p>
      )}
    </SettingsRow>
  );
  if (placement === 'row') return row;
  return (
    // Untitled: the row itself names Copilot, so a heading would repeat it.
    <SettingsSection>
      <SettingsGroup>{row}</SettingsGroup>
    </SettingsSection>
  );
}
