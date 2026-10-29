'use client';

import { useState, type JSX } from 'react';
import { Github } from '@canopy/ui-shared/icons/AppIcons';
import { ErrorBanner } from '@canopy/ui-shared/components';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { canEditOrg } from '@canopy/protocol/settings/organization-permissions';
import {
  SettingsConfirmDialog,
  useSettingsBrand,
  useSettingsClient,
  useSettingsNavigation,
} from '../host';
import { useSettingsErrorCopy } from '../errors';
import { GITHUB_CONNECT_KNOWN_ERRORS } from '../github/github-organization-error-copy';
import { useOrganizationSettingsSubtabSlots } from './settings/organization-settings-subtab-slots';
import {
  disconnectGitHub,
  getOrganizationDetail,
  startGitHubConnect,
} from './team-api';

interface TeamGitHubConnectionSectionProps {
  detail: OrganizationDetail;
  onDetailChange: (detail: OrganizationDetail) => void;
}

/**
 * Owner/admin control for connecting the org-level GitHub App (CAN-405). When
 * connected, telemetry ingest fetches authoritative PR data from GitHub and
 * overrides the client-supplied merge/diff fields. Connecting follows GitHub's
 * install flow in this tab when the host supplies `followGitHubInstallUrl`;
 * otherwise the install opens in the browser and the card offers "Check
 * again" to re-read the connection. Disconnecting removes the connection row.
 * Returns `null` for members who cannot edit the org so the control never
 * renders for them.
 */
export function TeamGitHubConnectionSection({
  detail,
  onDetailChange,
}: TeamGitHubConnectionSectionProps): JSX.Element | null {
  const brand = useSettingsBrand();
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organization.github');
  const navigation = useSettingsNavigation();
  const { followGitHubInstallUrl } = useOrganizationSettingsSubtabSlots();
  const [busy, setBusy] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The install opened in the browser; the card waits for "Check again".
  const [continuingInBrowser, setContinuingInBrowser] = useState(false);
  const [checking, setChecking] = useState(false);

  if (!canEditOrg(detail.viewerRole)) {
    return null;
  }

  const { connected, accountLogin } = detail.githubConnection;

  const handleConnect = async (): Promise<void> => {
    try {
      setBusy(true);
      setError(null);
      const { installUrl } = await startGitHubConnect(client, detail.id);
      if (followGitHubInstallUrl !== undefined) {
        // Full-page navigation to GitHub's install flow; the Setup-URL
        // callback returns the user to the settings page with a `?github=`
        // status.
        followGitHubInstallUrl(installUrl);
        return;
      }
      // The install completes in the browser, where the callback lands.
      navigation.openExternal(installUrl);
      setContinuingInBrowser(true);
      setBusy(false);
    } catch (err) {
      setError(
        errorCopy.actionCopy(err, {
          action: 'connect GitHub',
          known: GITHUB_CONNECT_KNOWN_ERRORS,
        }),
      );
      setBusy(false);
    }
  };

  const handleCheckAgain = async (): Promise<void> => {
    try {
      setChecking(true);
      setError(null);
      const updated = await getOrganizationDetail(client, detail.id);
      onDetailChange(updated);
      if (updated.githubConnection.connected) setContinuingInBrowser(false);
    } catch (err) {
      setError(
        errorCopy.actionCopy(err, { action: 'check the GitHub connection' }),
      );
    } finally {
      setChecking(false);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    try {
      setBusy(true);
      setError(null);
      await disconnectGitHub(client, detail.id);
      onDetailChange({
        ...detail,
        githubConnection: { connected: false, accountLogin: null },
      });
      setConfirmingDisconnect(false);
    } catch (err) {
      setError(errorCopy.actionCopy(err, { action: 'disconnect GitHub' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-xl bg-card p-5 shadow-sm"
      data-testid="team-github-connection-section"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-subtle fg-accent">
          <Github size={18} />
        </span>
        <div className="flex-1">
          <h2 className="text-m font-semibold fg-primary">GitHub connection</h2>
          <p className="mt-1 text-s fg-secondary">
            Connect the {brand.displayName} GitHub App so pull request merge
            state and diff stats in the timeline are pulled straight from
            GitHub, keeping them accurate and up to date.
          </p>

          <ErrorBanner className="mt-3" error={error} />

          {connected ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span
                className="inline-flex items-center gap-2 rounded-md bg-success-subtle px-2.5 py-1 text-s font-medium fg-success"
                data-testid="team-github-connected"
              >
                Connected
                {accountLogin ? (
                  <span className="font-normal fg-success">
                    ({accountLogin})
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => setConfirmingDisconnect(true)}
                disabled={busy}
                data-testid="team-github-disconnect"
                className="rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          ) : continuingInBrowser ? (
            <div
              className="mt-3 flex flex-wrap items-center gap-3"
              data-testid="team-github-continue-in-browser"
            >
              <span className="text-s fg-secondary">
                Continue in your browser.
              </span>
              <button
                type="button"
                onClick={() => void handleCheckAgain()}
                disabled={checking}
                data-testid="team-github-check-again"
                className="rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {checking ? 'Checking…' : 'Check again'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void handleConnect()}
              disabled={busy}
              data-testid="team-github-connect"
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Github size={15} />
              {busy ? 'Connecting…' : 'Connect GitHub'}
            </button>
          )}
        </div>
      </div>

      {confirmingDisconnect ? (
        <SettingsConfirmDialog
          title="Disconnect GitHub?"
          message="The timeline will go back to trusting pull request data reported by the desktop client. You can reconnect at any time."
          confirmLabel="Disconnect"
          busyLabel="Disconnecting…"
          busy={busy}
          destructive
          onConfirm={() => void handleDisconnect()}
          onCancel={() => setConfirmingDisconnect(false)}
          dataTestId="team-github-disconnect-confirm"
        />
      ) : null}
    </section>
  );
}
