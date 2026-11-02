import type { DeepLinkResolveShareResponse } from '@canopy/desktop-shared/types';
import {
  shareLandingErrorCopy as sharedShareLandingErrorCopy,
  shareLandingRecoveryAction,
  shareLandingRecoveryActionLabel,
  type ShareInstallEntity,
  type ShareLandingRecoveryAction,
} from '@canopy/ui-app/sharing/share-install-copy';
import { brandText } from '@/lib/brand';
import type { PublicShareLanding } from './usePublicShareLanding';

/** Every reason the resolve contract can fail with (CAN-5222). */
export type ShareLandingFailure = Extract<
  DeepLinkResolveShareResponse,
  { ok: false }
>['reason'];

/**
 * Why a shared resource could not be resolved, as one line for the reader.
 * The shared copy must accept every reason the contract returns.
 */
export function shareLandingErrorCopy(
  reason: ShareLandingFailure,
  entity: ShareInstallEntity,
): string {
  return sharedShareLandingErrorCopy(reason, entity, {
    appName: brandText.appName,
    serverName: brandText.serverName,
  });
}

/** The landing's one recovery action, as both hosts render it. */
export interface ShareLandingRecovery {
  action: ShareLandingRecoveryAction;
  label: string;
  testId: string;
  onClick: () => void;
}

const RECOVERY_TEST_IDS: Readonly<Record<ShareLandingRecoveryAction, string>> =
  {
    'sign-in': 'deep-link-share-sign-in',
    'switch-account': 'deep-link-share-switch-account',
    retry: 'deep-link-share-retry',
    'check-for-updates': 'deep-link-share-update-app',
  };

/**
 * The recovery for a failed landing, or `undefined` when there is none.
 * `onOpenAccountSurface` runs before Sign in or Switch account opens the
 * sign-in or account surface, so a modal host can step aside for it.
 */
export function shareLandingRecovery(
  reason: ShareLandingFailure,
  landing: Pick<
    PublicShareLanding,
    'retryResolve' | 'signIn' | 'switchAccount'
  >,
  options?: { onOpenAccountSurface?: () => void },
): ShareLandingRecovery | undefined {
  const action = shareLandingRecoveryAction(reason);
  if (action === null) return undefined;
  const onClick = ((): (() => void) => {
    switch (action) {
      case 'sign-in':
        return (): void => {
          options?.onOpenAccountSurface?.();
          landing.signIn();
        };
      case 'switch-account':
        return (): void => {
          options?.onOpenAccountSurface?.();
          landing.switchAccount();
        };
      case 'retry':
        return landing.retryResolve;
      case 'check-for-updates':
        return (): void => {
          void window.api.update.checkForUpdates().catch(() => {
            // Best effort: the update surface reports its own errors.
          });
        };
    }
  })();
  return {
    action,
    label: shareLandingRecoveryActionLabel(action),
    testId: RECOVERY_TEST_IDS[action],
    onClick,
  };
}
