/**
 * Daily free AI Credits opt-in state for the Home "Getting started" queue and
 * the first-run "Let's get started" page.
 *
 * The drip is off until the user answers. The cloud preference is read through
 * main (`loadCloudDailyCreditDrip`), which answers `available: false` when no
 * cloud credential (guest or signed in) is connected, so a brand-new user sees
 * the card only once the guest credential exists; the account-changed event
 * re-reads it then. A transient failure (`resolved: false`) also hides the
 * card: the queue must never ask on fabricated data.
 *
 * Either answer marks the user decided on every device. A failed save keeps
 * the card undecided with an inline error so the user is not stranded.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CloudDailyCreditDripState } from '@canopy/desktop-shared/types';
import type { DailyCreditDripPreference } from '@canopy/protocol/billing';
import {
  onDailyCreditDripChanged,
  saveDailyCreditDripChoice,
} from '@/lib/daily-credit-drip';
import type { OnboardingDailyCreditDripInput } from '@/components/home/onboarding-suggestions/queue';

export const DAILY_CREDIT_DRIP_SAVE_ERROR = "Couldn't save. Try again.";

export interface DailyCreditDripOptInState {
  /** The queue's view of the opt-in. */
  live: OnboardingDailyCreditDripInput;
  /** True while a save is in flight; both buttons disable. */
  busy: boolean;
  /** Inline error after a failed save, or null. */
  error: string | null;
  /** Save `enabled: true`. Resolves once the save settles. */
  turnOn: () => Promise<void>;
  /** Save `enabled: false`. Resolves once the save settles. */
  notNow: () => Promise<void>;
}

const LOADING: OnboardingDailyCreditDripInput = {
  state: 'loading',
  enabled: false,
  capCredits: null,
};

const UNAVAILABLE: OnboardingDailyCreditDripInput = {
  state: 'unavailable',
  enabled: false,
  capCredits: null,
};

/** Last settled answer, so a remounted Home draws the settled queue at once. */
let lastKnown: OnboardingDailyCreditDripInput = LOADING;

/** Test seam: forget the remembered answer between tests. */
export function resetDailyCreditDripOptInCacheForTests(): void {
  lastKnown = LOADING;
}

function fromPreference(
  preference: DailyCreditDripPreference,
): OnboardingDailyCreditDripInput {
  return {
    state: preference.decidedAt === null ? 'undecided' : 'decided',
    enabled: preference.enabled,
    capCredits: preference.capCredits,
  };
}

function fromState(
  state: CloudDailyCreditDripState,
): OnboardingDailyCreditDripInput {
  if (!state.available || !state.resolved) return UNAVAILABLE;
  return fromPreference(state.preference);
}

export function useDailyCreditDripOptIn(): DailyCreditDripOptInState {
  const [live, setLive] = useState<OnboardingDailyCreditDripInput>(lastKnown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const readVersion = useRef(0);

  const adopt = useCallback((next: OnboardingDailyCreditDripInput): void => {
    lastKnown = next;
    setLive(next);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const version = ++readVersion.current;
    try {
      const state = await window.api.loadCloudDailyCreditDrip();
      if (version === readVersion.current) adopt(fromState(state));
    } catch {
      // The IPC never throws by contract; a broken bridge hides the card
      // rather than asking on data we could not read.
      if (version === readVersion.current) adopt(UNAVAILABLE);
    }
  }, [adopt]);

  useEffect(() => {
    void reload();
    const onAccountChanged = (): void => {
      setError(null);
      void reload();
    };
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    // A save from Settings, the model recovery, or App Advisor answers the
    // card too.
    const unsubscribe = onDailyCreditDripChanged((result) => {
      // Supersede any read still in flight: it predates this save.
      readVersion.current += 1;
      setError(null);
      adopt(fromPreference(result));
    });
    return (): void => {
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        onAccountChanged,
      );
      unsubscribe();
    };
  }, [adopt, reload]);

  const save = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const { result, accountChanged } =
          await saveDailyCreditDripChoice(enabled);
        // The account-change re-read owns the state for the new account.
        if (!accountChanged) {
          readVersion.current += 1;
          adopt(fromPreference(result));
        }
      } catch {
        // Not decided locally: the server did not record an answer.
        setError(DAILY_CREDIT_DRIP_SAVE_ERROR);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [adopt],
  );

  const turnOn = useCallback((): Promise<void> => save(true), [save]);
  const notNow = useCallback((): Promise<void> => save(false), [save]);

  return { live, busy, error, turnOn, notNow };
}
