import { useCallback, useEffect, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import {
  isMobileAppPromoEligibleAccount,
  resolveMobileAppPromo,
  type MobileAppPromoState,
} from '@/lib/mobile-app-promo';
import { getBrandMobileApps } from '@/lib/brand';
import { useMobileActivation } from './useMobileActivation';

/** One day, matching the mobile-web interstitial's snooze. */
const SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Longest single `setTimeout` the snooze wake-up will schedule.
 *
 * `setTimeout` stores its delay in a signed 32-bit int, so anything past
 * ~24.9 days overflows and fires immediately. Capping each wait keeps a
 * far-future deadline (clock change, hand-edited preference) from collapsing
 * into "expire now".
 */
const MAX_SNOOZE_TIMER_MS = 2_147_483_647;

/** Synchronizes the card and cue, which mount as independent hook instances. */
const MOBILE_APP_PROMO_SNOOZED_EVENT = 'canopy:mobile-app-promo-snoozed';

export interface UseMobileAppPromoResult extends MobileAppPromoState {
  /**
   * Quiet the promotional surfaces for a day. The home card and the CTA banner
   * share this snooze, so one dismissal quiets both — otherwise the card would
   * be non-dismissible until activation, which reads as nagging.
   */
  snooze: () => void;
}

/**
 * Desktop host for {@link resolveMobileAppPromo}: loads the cloud account and
 * the snooze preference, subscribes to the live activation probe, and exposes
 * the resolved state plus a dismiss action.
 */
export function useMobileAppPromo(): UseMobileAppPromoResult {
  const [account, setAccount] = useState<CanopyCloudAccountPublicState | null>(
    null,
  );
  const [snoozedUntil, setSnoozedUntil] = useState<string | undefined>(
    undefined,
  );
  // `MobileAppCtaBanner` mounts unconditionally in the always-mounted shell,
  // so without this gate both effects below run at every app start under the
  // default `canopy` brand — where no listing is declared, `links` is empty,
  // and neither surface can ever render. Same argument as the gate inside
  // `useMobileActivation`, one level up: two IPC round trips on the startup
  // path buy nothing. The pure resolver already handles the empty-links case,
  // so leaving the state at its defaults is correct rather than merely cheap.
  const brandDeclaresMobileApps = getBrandMobileApps() !== null;
  // `resolved` is load-bearing, not decorative: `activated` starts `false` and
  // the account load (main-process memory cache) settles well before the
  // activation probe (an HTTPS round trip). Dropping `resolved` would render
  // the card and cue during that gap for an already-activated account, so the
  // promo would flash on and then vanish at every app start.
  const { activated, resolved: activationResolved } = useMobileActivation({
    enabled:
      brandDeclaresMobileApps && isMobileAppPromoEligibleAccount(account),
  });

  useEffect(() => {
    if (!brandDeclaresMobileApps) {
      return;
    }
    let cancelled = false;
    let readVersion = 0;
    const reload = (): void => {
      const version = ++readVersion;
      setAccount(null);
      const loadAccount = window.api?.loadCanopyCloudAccount;
      if (typeof loadAccount === 'function') {
        void loadAccount()
          .then((next) => {
            if (cancelled || version !== readVersion) return;
            setAccount(next);
          })
          .catch(() => {
            if (cancelled || version !== readVersion) return;
            setAccount(null);
          });
      }
    };
    reload();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    return (): void => {
      cancelled = true;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    };
  }, [brandDeclaresMobileApps]);

  useEffect(() => {
    if (!brandDeclaresMobileApps) {
      return;
    }
    let cancelled = false;
    const loadPreferences = window.api?.loadPreferences;
    if (typeof loadPreferences !== 'function') {
      return;
    }
    void loadPreferences()
      .then((prefs) => {
        if (cancelled) return;
        setSnoozedUntil(prefs.mobileInstallCueSnoozedUntil);
      })
      .catch(() => {
        // Absent-by-default optional string: a failed read means "not snoozed".
      });
    return (): void => {
      cancelled = true;
    };
  }, [brandDeclaresMobileApps]);

  useEffect(() => {
    const syncSnooze = (event: Event): void => {
      const until = (event as CustomEvent<unknown>).detail;
      if (typeof until === 'string') {
        setSnoozedUntil(until);
      }
    };
    window.addEventListener(MOBILE_APP_PROMO_SNOOZED_EVENT, syncSnooze);
    return (): void => {
      window.removeEventListener(MOBILE_APP_PROMO_SNOOZED_EVENT, syncSnooze);
    };
  }, []);

  // The snooze deadline is only ever compared against `Date.now()` during a
  // render, so nothing brings the surfaces back on its own when it lapses —
  // they stay hidden until some unrelated state change happens to re-render.
  // The desktop app is routinely left running for days, which is exactly the
  // session where a one-day snooze silently becomes permanent. Waking at the
  // deadline is what makes "quiet for a day" mean a day.
  useEffect(() => {
    if (snoozedUntil === undefined) {
      return;
    }
    const deadline = Date.parse(snoozedUntil);
    if (Number.isNaN(deadline)) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Self-rescheduling rather than one `setTimeout(remaining)`: `setTimeout`
    // overflows past ~24.9 days and fires immediately, which would drop a
    // far-future deadline the moment it was set. A deadline that far out can
    // only come from a clock change or a hand-edited preference, but the
    // failure mode is silent, so each pass waits at most MAX_SNOOZE_TIMER_MS
    // and then re-checks the real clock.
    const schedule = (): void => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setSnoozedUntil(undefined);
        return;
      }
      timer = setTimeout(schedule, Math.min(remaining, MAX_SNOOZE_TIMER_MS));
    };
    schedule();
    return (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [snoozedUntil]);

  const snooze = useCallback((): void => {
    const until = new Date(Date.now() + SNOOZE_MS).toISOString();
    setSnoozedUntil(until);
    window.dispatchEvent(
      new CustomEvent(MOBILE_APP_PROMO_SNOOZED_EVENT, { detail: until }),
    );
    const savePreferences = window.api?.savePreferences;
    if (typeof savePreferences === 'function') {
      void savePreferences({ mobileInstallCueSnoozedUntil: until }).catch(
        () => {
          // The in-memory one-day snooze still applies for this app session;
          // a failed persistence write may allow it to return after restart.
        },
      );
    }
  }, []);

  return {
    ...resolveMobileAppPromo({
      account,
      activated,
      activationResolved,
      snoozedUntil,
    }),
    snooze,
  };
}
