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
 *
 * A turn-on saved from this hook also keeps its server outcome (grant,
 * balance, blocked reason) for an inline confirmation. Only this hook's own
 * save sets it: a choice saved elsewhere never claims a grant here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CloudDailyCreditDripState } from '@canopy/desktop-shared/types';
import type {
  DailyCreditDripPreference,
  DailyCreditDripPreferenceSaveResult,
} from '@canopy/protocol/billing';
import {
  onDailyCreditDripChanged,
  saveDailyCreditDripChoice,
} from '@/lib/daily-credit-drip';
export interface DailyCreditDripInput {
  state: 'unavailable' | 'loading' | 'undecided' | 'decided';
  enabled: boolean;
  /** Plan cap offered by the card; null falls back to the default cap. */
  capCredits: number | null;
}

export const DAILY_CREDIT_DRIP_SAVE_ERROR = "Couldn't save. Try again.";

/** What the server reported for a turn-on saved from this hook. */
export type DailyCreditDripLocalSaveOutcome = Pick<
  DailyCreditDripPreferenceSaveResult,
  'granted' | 'balanceCredits' | 'blockedReason'
>;

export interface DailyCreditDripOptInState {
  /** The queue's view of the opt-in. */
  live: DailyCreditDripInput;
  /** True while a save is in flight; both buttons disable. */
  busy: boolean;
  /** Inline error after a failed save, or null. */
  error: string | null;
  /**
   * The outcome of the last successful turn-on saved here, for the current
   * account, or null. Cleared when a new save starts, on failure, when the
   * drip is turned off anywhere, and when the account changes.
   */
  outcome: DailyCreditDripLocalSaveOutcome | null;
  /** Save `enabled: true`. Resolves once the save settles. */
  turnOn: () => Promise<void>;
  /** Save `enabled: false`. Resolves once the save settles. */
  notNow: () => Promise<void>;
}

const LOADING: DailyCreditDripInput = {
  state: 'loading',
  enabled: false,
  capCredits: null,
};

const UNAVAILABLE: DailyCreditDripInput = {
  state: 'unavailable',
  enabled: false,
  capCredits: null,
};

/** Last settled answer, so a remounted Home draws the settled queue at once. */
let lastKnown: DailyCreditDripInput = LOADING;

/** Test seam: forget the remembered answer between tests. */
export function resetDailyCreditDripOptInCacheForTests(): void {
  lastKnown = LOADING;
}

function fromPreference(
  preference: DailyCreditDripPreference,
): DailyCreditDripInput {
  return {
    state: preference.decidedAt === null ? 'undecided' : 'decided',
    enabled: preference.enabled,
    capCredits: preference.capCredits,
  };
}

function fromState(state: CloudDailyCreditDripState): DailyCreditDripInput {
  if (!state.available || !state.resolved) return UNAVAILABLE;
  return fromPreference(state.preference);
}

export function useDailyCreditDripOptIn(): DailyCreditDripOptInState {
  const [live, setLive] = useState<DailyCreditDripInput>(lastKnown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] =
    useState<DailyCreditDripLocalSaveOutcome | null>(null);
  const busyRef = useRef(false);
  const activeSave = useRef(0);
  const readVersion = useRef(0);
  // Bumped by every save and account change, so a late save result cannot
  // restore a confirmation for an answer or account that has moved on.
  const outcomeVersion = useRef(0);

  const adopt = useCallback((next: DailyCreditDripInput): void => {
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
      outcomeVersion.current += 1;
      activeSave.current += 1;
      busyRef.current = false;
      setBusy(false);
      setError(null);
      setOutcome(null);
      adopt(LOADING);
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
      // Another surface's turn-on keeps this one's confirmation; a turn-off
      // anywhere withdraws it.
      if (!result.enabled) {
        outcomeVersion.current += 1;
        setOutcome(null);
      }
      adopt(fromPreference(result));
    });
    return (): void => {
      readVersion.current += 1;
      outcomeVersion.current += 1;
      activeSave.current += 1;
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
      const saveRequest = ++activeSave.current;
      const version = ++outcomeVersion.current;
      setBusy(true);
      setError(null);
      setOutcome(null);
      try {
        const { result, accountChanged } = await saveDailyCreditDripChoice(
          enabled,
          () => version === outcomeVersion.current,
        );
        // The account-change re-read owns the state for the new account.
        if (!accountChanged && version === outcomeVersion.current) {
          readVersion.current += 1;
          adopt(fromPreference(result));
          if (enabled && result.enabled) {
            setOutcome({
              granted: result.granted,
              balanceCredits: result.balanceCredits,
              ...(result.blockedReason !== undefined
                ? { blockedReason: result.blockedReason }
                : {}),
            });
          }
        }
      } catch {
        // Not decided locally: the server did not record an answer.
        if (version === outcomeVersion.current) {
          setOutcome(null);
          setError(DAILY_CREDIT_DRIP_SAVE_ERROR);
        }
      } finally {
        if (activeSave.current === saveRequest) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [adopt],
  );

  const turnOn = useCallback((): Promise<void> => save(true), [save]);
  const notNow = useCallback((): Promise<void> => save(false), [save]);

  return { live, busy, error, outcome, turnOn, notNow };
}
