import { type JSX, useEffect, useRef, useState } from 'react';
import { Stack, Button } from '@canopy/ui-shared/components';
import { CloseMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { brandText } from '@/lib/brand';
import { GUEST_UPGRADE_NUDGE_BODY } from '@/lib/guest-cta-copy';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { isGuestAccount } from '@/hooks/useIsGuestCredential';

/**
 * In-code session threshold that gates the soft upgrade nudge (CAN-936, WS3).
 * Intentionally a constant, not a feature flag: the nudge should fire after a
 * guest has gotten enough value from the app to be worth prompting. It also
 * doubles as the snooze interval — the nudge re-shows only after this many more
 * guest sessions elapse.
 */
export const GUEST_UPGRADE_NUDGE_SESSION_THRESHOLD = 5;

const CLOUD_NAME = `${brandText.appName} Cloud`;

/**
 * Motivated-moment nudge inviting a consented guest to sign in / upgrade after
 * they've gotten value from the app (CAN-936, WS3). It is a dismissible banner
 * mounted beside the other in-app notifications and never blocks the shell.
 *
 * Show gate: guest credential AND `guestSessionCount >= THRESHOLD` AND at least
 * THRESHOLD sessions have elapsed since it was last shown (snooze). The snooze
 * counter is persisted the moment the nudge renders, so ignoring it still
 * silences it until another threshold of sessions passes. Dismiss hides it for
 * the current launch (the snooze is already recorded on show).
 *
 * Sign-in routes through the shared cloud connect gate — the same
 * `CloudSyncModal` every other WS3 prompt uses — not a bespoke OAuth call.
 */
export function GuestUpgradeNudge(): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const persistedRef = useRef(false);
  const sessionCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const [account, prefs] = await Promise.all([
          window.api.loadCanopyCloudAccount(),
          window.api.loadPreferences(),
        ]);
        if (cancelled) return;
        const isGuest = isGuestAccount(account);
        const count = prefs.guestSessionCount ?? 0;
        const lastShown = prefs.guestUpgradeNudgeLastShownSessionCount ?? 0;
        const shouldShow =
          isGuest &&
          count >= GUEST_UPGRADE_NUDGE_SESSION_THRESHOLD &&
          count - lastShown >= GUEST_UPGRADE_NUDGE_SESSION_THRESHOLD;
        if (shouldShow) {
          sessionCountRef.current = count;
          setVisible(true);
        }
      } catch {
        // On any load failure the nudge simply does not show.
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Record the snooze as soon as the nudge is shown so it won't reappear until
  // another threshold of guest sessions elapses, even if the user ignores it.
  useEffect(() => {
    if (!visible || persistedRef.current) return;
    persistedRef.current = true;
    void window.api
      .savePreferences({
        guestUpgradeNudgeLastShownSessionCount: sessionCountRef.current,
      })
      .catch(() => {
        // Best-effort — a failed save just means the nudge may re-show sooner.
      });
  }, [visible]);

  const show = visible && !dismissed;
  useCurrentUiStateReporter(
    'guestUpgradeNudge.banner',
    show ? { open: true } : null,
  );

  if (!show) return null;

  const handleSignIn = (): void => {
    useCloudConnectGateStore.getState().requestConnect(
      {
        title: `Sign in to ${CLOUD_NAME}`,
        // No subheading: its first half repeated the panel's benefit rows and
        // its second half ("already available") told a guest the headline perk
        // needs no account. See `guest-cta-copy.ts` for the tone rules.
        subtitle: null,
        toastMessage: `You're all set. Your guest work is now synced to your account.`,
        guestBenefits: true,
      },
      () => setDismissed(true),
    );
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="guest-upgrade-nudge"
      className="flex flex-col pointer-events-auto animate-slide-up rounded-xl bg-card/95 p-4 fg-primary shadow-lg backdrop-blur-sm gap-3"
    >
      <div className="flex items-start gap-3">
        <Stack gap="tight" className="min-w-0 flex-1">
          <p className="text-s font-medium fg-primary">
            Enjoying {brandText.appName}?
          </p>
          <p className="text-s fg-secondary">{GUEST_UPGRADE_NUDGE_BODY}</p>
        </Stack>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={() => setDismissed(true)}
          data-testid="guest-upgrade-nudge-dismiss"
          aria-label="Dismiss sign-in reminder"
        >
          <CloseMediumIcon size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={handleSignIn}
          data-testid="guest-upgrade-nudge-sign-in"
        >
          Sign in
        </Button>
      </div>
    </div>
  );
}
