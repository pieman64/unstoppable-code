import type { JSX } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { Button } from '@/components/shared/Button';
import { GUEST_WORK_PRESERVED } from '@/lib/guest-cta-copy';
import { Surface } from '@canopy/ui-shared/components';

interface RemoteControlGuestCtaProps {
  /**
   * Start the free-trial sign-in flow via the shared cloud-connect gate (the
   * same `CloudSyncModal` the bottom-left "Start free trial" CTA uses). Wired by
   * the modal to a wrapper around `useSubscriptionStatus().startFreeTrial` that
   * supplies Remote Control framing — the shared handler's default title names
   * a different offer, which would read as a non sequitur here.
   */
  onCreateAccount: () => void;
  /**
   * Server-reported free app access. There is no trial to start then, so the
   * button names the step itself: "Sign in". False keeps the trial label.
   */
  freeAccess?: boolean;
  /** Extra classes applied to the CTA container. */
  className?: string;
}

/**
 * Create-account CTA shown inside the Remote Control modal when the current
 * credential is a device-scoped guest (billing on). A guest resolves as a real
 * cloud account (has an API key), so the modal would otherwise show a dead-end
 * Enable button that the server rejects — the guest has no way to sign in and
 * finish pairing. This points the guest at the shortest path to a real account
 * via the shared free-trial gate. Mirrors {@link RemoteControlUpgradeCta}.
 * Presentational — the gate + handler come from the modal (via
 * `useSubscriptionStatus`).
 */
export function RemoteControlGuestCta({
  onCreateAccount,
  freeAccess = false,
  className = '',
}: RemoteControlGuestCtaProps): JSX.Element {
  return (
    <Surface
      variant="group"
      padding="compact"
      data-testid="canopy-portal-guest-cta"
    >
      <div
        className={`flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${className}`}
      >
        <p className="text-s fg-secondary">
          Create a free account to unlock {REMOTE_CONTROL_LABEL}.{' '}
          {GUEST_WORK_PRESERVED}
        </p>
        <Button
          variant="primary"
          size="compact"
          onClick={onCreateAccount}
          data-testid="canopy-portal-guest-cta-button"
        >
          {freeAccess ? 'Sign in' : 'Start free trial'}
        </Button>
      </div>
    </Surface>
  );
}
