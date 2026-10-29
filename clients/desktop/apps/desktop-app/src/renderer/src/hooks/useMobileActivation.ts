import { useEffect, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { getBrandMobileApps } from '@/lib/brand';

export interface UseMobileActivationResult {
  /** True only once a probe has actually confirmed an iOS/Android token. */
  activated: boolean;
  /** False until the first probe resolves. */
  resolved: boolean;
}

export interface UseMobileActivationOptions {
  /**
   * Whether this account can render an activation-gated surface at all.
   *
   * Defaults to `true` so a caller that cannot observe the account is
   * unaffected. Pass `isMobileAppPromoEligibleAccount(account)` to skip the
   * probe for signed-out accounts and device-scoped guests: `showPromotional`
   * already requires a signed-in non-guest, so a probe for anyone else is a
   * request whose answer can never change a rendered surface. A guest holds
   * real credentials, so that request is a genuine authenticated round trip
   * rather than a cheap local short-circuit.
   */
  enabled?: boolean;
}

/**
 * Live "has this account activated the mobile app?" signal.
 *
 * Deliberately its own IPC path rather than a field on the account snapshot:
 * `loadCanopyCloudAccount` is a cached read of the secure store refreshed on a
 * 20-minute interval, and its on-demand refresh re-applies org policy and
 * rewrites `preferences.json` — the wrong contract and the wrong freshness.
 * `loadCanopyCloudEntitlements` *is* live but is the billing capability
 * surface; folding a device-token read into it would couple promo suppression
 * to billing failures.
 *
 * **The no-restart requirement is satisfied by the `focus`/`visibilitychange`
 * refresh.** The real flow is: the user looks at the cue, picks up their phone,
 * installs the app, puts the phone down, and alt-tabs back. That return is what
 * must clear the cue.
 *
 * Never throws. A transient probe failure resolves `{ resolved: false }` and
 * this hook keeps its last-known-good value, so a flaky network does not make
 * the promotion flicker back for an activated user.
 *
 * **Brand-gated.** `MobileAppCtaBanner` mounts in the always-mounted shell, so
 * an ungated probe would fire on mount and again — cache-bypassing — on every
 * `focus` and `visibilitychange`, forever. Under a brand that declares no
 * listings (the default `canopy` brand) no surface can ever render, so that
 * traffic buys nothing; the request is skipped entirely and the hook reports a
 * resolved, not-activated result. The same argument applies to accounts that
 * can never render a gated surface — see {@link UseMobileActivationOptions}.
 */
export function useMobileActivation({
  enabled = true,
}: UseMobileActivationOptions = {}): UseMobileActivationResult {
  const [activated, setActivated] = useState(false);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // No declared store listings means no surface can render, so there is
    // nothing for a probe result to change. Report resolved so consumers do not
    // wait on a request that will never be made.
    if (getBrandMobileApps() === null) {
      setResolved(true);
      return;
    }
    // Not a signed-in non-guest: `showPromotional` is false regardless of what
    // a probe would answer. Deliberately does NOT report resolved — an
    // ineligible account has no probe result, and claiming one would be a lie
    // the moment the account becomes eligible and this effect re-runs.
    if (!enabled) {
      return;
    }
    // Per-refresh sequence token, matching `useSubscriptionStatus`: focus and
    // the account-changed event can fire in quick succession, and without a
    // token an earlier slow probe could resolve after a newer one and clobber
    // it with stale data (last-completed wins). Each refresh bumps `latest` and
    // its resolutions no-op if a newer refresh has since started.
    let latest = 0;
    // Once a probe confirms activation there is nothing left for the ambient
    // focus/visibility refreshes to discover: every surface this signal gates is
    // already permanently suppressed for this account. An account change still
    // refreshes, because the next account may not be activated.
    let confirmedActivated = false;
    const refresh = (forceRefresh = false): void => {
      const seq = ++latest;
      const stale = (): boolean => cancelled || seq !== latest;
      // Guard the preload bridge so a partial preload degrades to *showing*
      // the promo rather than crashing.
      const load = window.api?.loadCanopyCloudMobileActivation;
      if (typeof load !== 'function') {
        setResolved(true);
        return;
      }
      const request = forceRefresh ? load({ forceRefresh: true }) : load();
      void request
        .then((state) => {
          if (stale()) return;
          // An unresolved probe means a transient failure: keep last-known-good.
          if (!state.resolved) {
            return;
          }
          confirmedActivated = state.hasMobileActivation;
          setActivated(state.hasMobileActivation);
          setResolved(true);
        })
        .catch(() => {
          if (stale()) return;
          setResolved(true);
        });
    };

    const refreshOnVisible = (): void => {
      if (confirmedActivated) return;
      if (document.visibilityState === 'visible') {
        refresh(true);
      }
    };
    const refreshOnFocus = (): void => {
      if (confirmedActivated) return;
      refresh(true);
    };
    const refreshOnAccountChange = (): void => {
      // A different account may not be activated, so this one always re-probes.
      confirmedActivated = false;
      // Dropping back to unresolved is what keeps the promotional surfaces
      // gated for the duration of that probe. `activated` still holds the
      // PREVIOUS account's answer, and the account load lands before the probe
      // does — so without this, switching from a non-activated account to an
      // already-activated one renders the card and cue during the gap and then
      // vanishes them. That is exactly the flash the `resolved` gate exists to
      // prevent, re-entering through the account-transition path.
      setResolved(false);
      refresh(true);
    };

    refresh();
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisible);
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      refreshOnAccountChange,
    );
    return (): void => {
      cancelled = true;
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisible);
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        refreshOnAccountChange,
      );
    };
  }, [enabled]);

  return { activated, resolved };
}
