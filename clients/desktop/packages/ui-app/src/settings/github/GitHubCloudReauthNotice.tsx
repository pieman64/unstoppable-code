'use client';

import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';

// ---------------------------------------------------------------------------
// The "GitHub needs you to sign in again" notice (REG-3020).
//
// A pure view: the shared `Notice` with one primary action. It requests
// nothing, navigates nowhere and reads no controller, so it can never stop or
// change a running worktree (those keep the installation-token transport Core
// already holds); the consumer's `onReconnect` decides what Reconnect does,
// normally `() => void controller.connect()` on the page's ONE controller. Not
// mounted in any product flow yet: REG-3022 (repo-backed cloud composer) and
// REG-3025 (pull request actions) mount it when the connection needs reauth
// (`controller.connection?.state === 'NEEDS_REAUTH'`, or the typed
// `github-cloud-needs-reauth` error); see "Cloud Git Connect UI handoff" in
// docs/github-auth.md.
//
// Geometry follows the surroundings: inside a `NoticeShapeProvider` (the
// composer banner stack) it takes the composer corners. It has no dismiss
// control: the state ends only when GitHub is reconnected.
//
// Busy: the button keeps `aria-disabled` rather than `disabled`, so a focused
// button stays focused while Connect runs. `NoticeButton` keeps its resting
// width and shows a loader, with `Connecting…` as the accessible busy label.
// When the notice unmounts after a successful reconnect, focus is the
// consumer's to place (the consumer owns what sits around it).
// ---------------------------------------------------------------------------

export interface GitHubCloudReauthNoticeProps {
  /** Reconnect GitHub: start the controller's Connect. */
  readonly onReconnect: () => void;
  /** Connect is running or GitHub is opening: the press is ignored. */
  readonly busy?: boolean;
}

export function GitHubCloudReauthNotice({
  onReconnect,
  busy = false,
}: GitHubCloudReauthNoticeProps): JSX.Element {
  return (
    <Notice
      intent="attention"
      title="GitHub needs you to sign in again"
      data-testid="github-cloud-reauth-notice"
      actions={
        <NoticeButton
          variant="secondary"
          data-testid="github-cloud-reauth-reconnect"
          aria-disabled={busy ? true : undefined}
          busy={busy}
          busyLabel="Connecting…"
          onClick={() => {
            if (!busy) onReconnect();
          }}
        >
          Reconnect GitHub
        </NoticeButton>
      }
    >
      Reconnect GitHub to keep using your repositories in cloud projects.
      Worktrees that are already running keep working.
    </Notice>
  );
}
