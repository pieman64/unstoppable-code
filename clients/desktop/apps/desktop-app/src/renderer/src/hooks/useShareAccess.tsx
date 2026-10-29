import { type JSX, useCallback, useState } from 'react';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { CloudSyncModal } from '@/components/shared/CloudSyncModal';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';

/**
 * A device-scoped guest holds a real cloud credential (api key + resolved
 * account), so `isCanopyCloudConnected` is true for it — but a guest cannot
 * publish to the shared Cloud registry and must sign in / create a real account
 * first. Treat a guest as not-yet-connected here so the share gate shows the
 * `CloudSyncModal` sign-in prompt instead of proceeding straight into the share
 * modal (mirrors `isConnectedNonGuest` in `cloudConnectGateStore`).
 */
function isConnectedForSharing(
  account: Parameters<typeof isCanopyCloudConnected>[0],
): boolean {
  return isCanopyCloudConnected(account) && !isGuestAccount(account);
}

/**
 * Per-source personalization for the Cloud sign-in prompt shown when an
 * unauthenticated user clicks a Share button.
 */
export interface ShareGateContext {
  title?: string;
  subtitle?: string;
  description?: string;
}

interface PendingShare {
  context: ShareGateContext;
  proceed: () => void;
  guestBenefits: boolean;
  onCancelled?: () => void;
}

export interface ShareAccess {
  /**
   * Request a share action. If the Cloud account is already connected, `proceed`
   * runs immediately (opening the real share modal). Otherwise the
   * `CloudSyncModal` is shown in its connect state; once the user connects we
   * auto-resume by invoking `proceed`.
   */
  requestShare: (
    context: ShareGateContext,
    proceed: () => void,
    onCancelled?: () => void,
  ) => void;
  /** Render this once in the host component to back `requestShare`. */
  shareGateModal: JSX.Element | null;
}

/**
 * Backs the "share to Cloud" entry points: prompts an unauthenticated user to
 * sign in before sharing. On successful connect we reopen the original share
 * modal (auto-resume).
 */
export function useShareAccess(): ShareAccess {
  const [pending, setPending] = useState<PendingShare | null>(null);

  const requestShare = useCallback(
    (
      context: ShareGateContext,
      proceed: () => void,
      onCancelled?: () => void,
    ): void => {
      void (async (): Promise<void> => {
        let guestBenefits = false;
        try {
          const account = await window.api.loadCanopyCloudAccount();
          if (isConnectedForSharing(account)) {
            proceed();
            return;
          }
          guestBenefits = isGuestAccount(account);
        } catch {
          // Fall through to the connect prompt on load failure.
        }
        setPending({
          context,
          proceed,
          guestBenefits,
          ...(onCancelled ? { onCancelled } : {}),
        });
      })();
    },
    [],
  );

  const handleClose = useCallback((): void => {
    const current = pending;
    setPending(null);
    if (!current) return;
    // Auto-resume: if the user connected while the modal was open, reopen the
    // original share modal.
    void (async (): Promise<void> => {
      try {
        const account = await window.api.loadCanopyCloudAccount();
        if (isConnectedForSharing(account)) {
          current.proceed();
          return;
        }
      } catch {
        // Still not connected — silently drop the pending share.
      }
      current.onCancelled?.();
    })();
  }, [pending]);

  const shareGateModal = pending ? (
    <CloudSyncModal
      onClose={handleClose}
      title={pending.context.title}
      subtitle={pending.context.subtitle}
      description={pending.context.description}
      guestBenefits={pending.guestBenefits}
    />
  ) : null;

  return { requestShare, shareGateModal };
}
