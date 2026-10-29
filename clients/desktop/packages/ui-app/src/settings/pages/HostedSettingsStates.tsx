'use client';

import type { JSX, ReactNode } from 'react';
import type { SettingsErrorCode } from '@canopy/protocol/settings';
import { Button } from '@canopy/ui-shared/components/Button';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';

/**
 * Host states around hosted settings content: signed out, expired, offline,
 * access lost and unsupported server. Pages keep their own, more precise
 * errors; these cover the frame a host draws before a page renders. While a
 * route loads, hosts show its page skeleton (`HostedSettingsRouteLoading`).
 *
 * Each state sits in the shared settings column, so its text starts where the
 * page's header will. Inside the account frame (or a page) the column adds no
 * second inset.
 */

export const HOSTED_SETTINGS_COPY = {
  signedOut: 'Sign in to manage your account and organizations.',
  expired: 'Your session ended. Sign in again to continue.',
  offline: "Couldn't load these settings. Check your connection and try again.",
  accessLost: 'You no longer have access to this organization.',
  unsupported: 'These settings need a newer server.',
  uncertain: "Couldn't confirm the change. Check again before trying again.",
  signIn: 'Sign in',
  retry: 'Retry',
  organizations: 'Organizations',
  openOnWeb: 'Open on web',
} as const;

function StateFrame({
  testId,
  message,
  children,
}: {
  testId: string;
  message: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <SettingsPageColumn>
      <div
        className="flex flex-col items-start gap-3"
        data-testid={testId}
        role="status"
      >
        <p className="text-s fg-secondary">{message}</p>
        {children}
      </div>
    </SettingsPageColumn>
  );
}

export interface HostedSettingsErrorStateProps {
  readonly code: SettingsErrorCode | 'signed_out';
  readonly onRetry?: () => void;
  readonly onSignIn?: () => void;
  readonly onOpenOrganizations?: () => void;
  readonly onOpenOnWeb?: () => void;
}

/** The recovery state for a failure code, with its single recovery action. */
export function HostedSettingsErrorState({
  code,
  onRetry,
  onSignIn,
  onOpenOrganizations,
  onOpenOnWeb,
}: HostedSettingsErrorStateProps): JSX.Element {
  switch (code) {
    case 'signed_out':
    case 'unauthenticated':
      return (
        <StateFrame
          testId="hosted-settings-signed-out"
          message={HOSTED_SETTINGS_COPY.signedOut}
        >
          {onSignIn ? (
            <Button variant="primary" size="compact" onClick={onSignIn}>
              {HOSTED_SETTINGS_COPY.signIn}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'expired':
      return (
        <StateFrame
          testId="hosted-settings-expired"
          message={HOSTED_SETTINGS_COPY.expired}
        >
          {onSignIn ? (
            <Button variant="primary" size="compact" onClick={onSignIn}>
              {HOSTED_SETTINGS_COPY.signIn}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'forbidden':
    case 'not_found':
      return (
        <StateFrame
          testId="hosted-settings-access-lost"
          message={HOSTED_SETTINGS_COPY.accessLost}
        >
          {onOpenOrganizations ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={onOpenOrganizations}
            >
              {HOSTED_SETTINGS_COPY.organizations}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'unsupported_server':
      return (
        <StateFrame
          testId="hosted-settings-unsupported"
          message={HOSTED_SETTINGS_COPY.unsupported}
        >
          {onOpenOnWeb ? (
            <Button variant="secondary" size="compact" onClick={onOpenOnWeb}>
              {HOSTED_SETTINGS_COPY.openOnWeb}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'uncertain':
      return (
        <StateFrame
          testId="hosted-settings-uncertain"
          message={HOSTED_SETTINGS_COPY.uncertain}
        >
          {onRetry ? (
            <Button variant="secondary" size="compact" onClick={onRetry}>
              {HOSTED_SETTINGS_COPY.retry}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'offline':
    case 'invalid_response':
    case 'failed':
      return (
        <StateFrame
          testId="hosted-settings-failed"
          message={HOSTED_SETTINGS_COPY.offline}
        >
          {onRetry ? (
            <Button variant="secondary" size="compact" onClick={onRetry}>
              {HOSTED_SETTINGS_COPY.retry}
            </Button>
          ) : null}
        </StateFrame>
      );
  }
}
