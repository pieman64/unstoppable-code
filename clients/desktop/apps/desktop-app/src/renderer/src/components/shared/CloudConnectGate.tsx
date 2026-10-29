import { type JSX, useCallback } from 'react';
import { CloudSyncModal } from '@/components/shared/CloudSyncModal';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  isConnectedNonGuest,
  useCloudConnectGateStore,
} from '@/stores/cloudConnectGateStore';

/**
 * App-level singleton for the shared cloud connect gate (CAN-936, WS3). Mounted
 * once in `App.tsx`, it renders the shared `CloudSyncModal` whenever a surface
 * calls `useCloudConnectGateStore.getState().requestConnect(...)` and no real
 * account is connected yet. On close it re-checks the account and, if the user
 * connected (or upgraded from guest) while the modal was open, auto-resumes the
 * pending action — the same auto-resume pattern proven in `useShareAccess`, but
 * lifted to an app-wide singleton so contextual prompts never stack modals.
 */
export function CloudConnectGate(): JSX.Element | null {
  const pending = useCloudConnectGateStore((s) => s.pending);
  const resolve = useCloudConnectGateStore((s) => s.resolve);

  // Surface the gate to the App Advisor so it knows a sign-in prompt is open.
  useCurrentUiStateReporter(
    'cloudConnectGate.modal',
    pending ? { open: true } : null,
  );

  const handleClose = useCallback((): void => {
    const current = pending;
    // `resolve()` also opens a new AI-credits availability episode, so no
    // answer read while the user was still a guest can be reused for anything
    // decided after they signed in. That lives in the store rather than here
    // because the store is the chokepoint every close passes through — see
    // `cloudConnectGateStore.resolve`.
    resolve();
    if (!current) return;
    // Auto-resume: if the user connected a real account while the modal was
    // open, run the pending action now. A guest who did not upgrade is treated
    // as still-not-connected, so the action is silently dropped.
    void (async (): Promise<void> => {
      try {
        const account = await window.api.loadCanopyCloudAccount();
        if (isConnectedNonGuest(account)) {
          current.proceed();
        }
      } catch {
        // Still not connected — drop the pending action.
      }
    })();
  }, [pending, resolve]);

  if (!pending) return null;

  return (
    <CloudSyncModal
      onClose={handleClose}
      title={pending.context.title}
      subtitle={pending.context.subtitle}
      description={pending.context.description}
      toastMessage={pending.context.toastMessage}
      guestBenefits={pending.context.guestBenefits}
    />
  );
}
