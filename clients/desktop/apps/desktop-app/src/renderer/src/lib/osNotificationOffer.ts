/**
 * One-time offer to turn on OS notifications (CAN-4005).
 *
 * The first qualifying agent completion delivered while the main window is in
 * the background arms a pending offer. The desktop banner shows it once the
 * window is focused again; either answer is saved to preferences
 * (`osNotificationOfferAnsweredAt`) so the offer never returns for this local
 * preference profile.
 *
 * Pending state is session-only: a reload or quit before answering discards
 * it, and nothing is replayed at startup. Until preferences have been read the
 * eligibility is `unknown` and completions never arm the offer.
 *
 * This module is a leaf: `osNotifications.ts` calls into it from the delivery
 * gate, so it must not import that module or any store that does.
 */

import { create } from 'zustand';
import type {
  OsNotificationOptInResponse,
  PreferencesData,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';

export type OsNotificationOfferEligibility =
  | 'unknown'
  | 'eligible'
  | 'answered';

export type OsNotificationOfferChoice = 'enable' | 'dismiss';

export interface OsNotificationOfferState {
  eligibility: OsNotificationOfferEligibility;
  /** A qualifying background completion arrived and the offer awaits an answer. */
  pending: boolean;
  /** The choice being saved, or `null` when idle. */
  answering: OsNotificationOfferChoice | null;
  /** The first chosen action, retained when its save needs retrying. */
  answerChoice: OsNotificationOfferChoice | null;
  /** The last answer save failed; the card offers a retry. */
  saveFailed: boolean;
  /**
   * Stamp chosen for the first answer attempt, reused on retry so a failed
   * save and its retry record the same answer time.
   */
  answerTimestamp: string | null;
}

const INITIAL_STATE: OsNotificationOfferState = {
  eligibility: 'unknown',
  pending: false,
  answering: null,
  answerChoice: null,
  saveFailed: false,
  answerTimestamp: null,
};

export const useOsNotificationOfferStore = create<OsNotificationOfferState>(
  () => ({ ...INITIAL_STATE }),
);

let answerGeneration = 0;
let savingAnswerTimestamp: string | null = null;

// `osNotifications` is optional here although main always broadcasts the
// whole normalized object: a payload without it must never throw out of the
// `preferencesSynced` handler and skip the work that follows this module.
type OfferPreferences = Partial<
  Pick<PreferencesData, 'osNotifications' | 'osNotificationOfferAnsweredAt'>
> &
  Pick<PreferencesLoadResult, '__error'>;

function isAnswered(preferences: OfferPreferences): boolean {
  return (
    preferences.osNotificationOfferAnsweredAt !== undefined ||
    preferences.osNotifications?.enabled === true
  );
}

function markAnswered(): void {
  useOsNotificationOfferStore.setState({
    eligibility: 'answered',
    pending: false,
    answering: null,
    answerChoice: null,
    saveFailed: false,
    answerTimestamp: null,
  });
}

/**
 * Apply an authoritative preference snapshot: the startup load or a
 * `preferencesSynced` broadcast. An answer, or notifications already on,
 * suppresses the offer for good. Once answered, a stale snapshot without the
 * stamp never makes this session eligible again. A fallback snapshot from a
 * failed load cannot prove the offer is unanswered (main also skips its
 * enabled-profile migration then), so it leaves eligibility unknown. A
 * payload without `osNotifications` cannot prove it either, so it keeps the
 * previous eligibility.
 */
export function applyOsNotificationOfferPreferences(
  preferences: OfferPreferences,
): void {
  const state = useOsNotificationOfferStore.getState();
  if (isAnswered(preferences)) {
    // The answer's own sync can precede its IPC reply. Only a different
    // answer or an enabled preference supersedes that pending continuation.
    if (
      savingAnswerTimestamp !== null &&
      (preferences.osNotifications?.enabled === true ||
        preferences.osNotificationOfferAnsweredAt !== savingAnswerTimestamp)
    ) {
      cancelOsNotificationOfferOptIn();
    }
    markAnswered();
    return;
  }
  if (state.eligibility === 'answered') return;
  if (preferences.__error !== undefined) return;
  if (preferences.osNotifications === undefined) return;
  if (state.eligibility === 'unknown') {
    useOsNotificationOfferStore.setState({ eligibility: 'eligible' });
  }
}

/**
 * Called from the OS-notification delivery gate for an agent completion that
 * was withheld only because notifications are off. `windowFocused` is read at
 * delivery time by the caller. Performs no I/O.
 */
export function noteOsNotificationOfferCompletion(
  windowFocused: boolean,
): void {
  if (windowFocused) return;
  const state = useOsNotificationOfferStore.getState();
  if (state.eligibility !== 'eligible' || state.pending) return;
  useOsNotificationOfferStore.setState({ pending: true });
}

/** Record that the user made an explicit choice elsewhere (Settings). */
export function markOsNotificationOfferAnswered(): void {
  cancelOsNotificationOfferOptIn();
  markAnswered();
}

/** A newer Settings choice takes precedence over an in-flight offer answer. */
export function cancelOsNotificationOfferOptIn(): void {
  answerGeneration += 1;
}

export type OsNotificationOfferAnswerResult =
  | { kind: 'ignored' }
  | { kind: 'save-failed' }
  | { kind: 'dismissed' }
  | { kind: 'enabled'; optIn: OsNotificationOptInResponse }
  | { kind: 'opt-in-failed' };

/**
 * Save the user's answer, then (for `enable` only) run the existing opt-in.
 *
 * The answer is durable before opt-in starts, so a denied, unsupported, or
 * failed opt-in never brings the offer back. A failed save keeps the card up
 * with a retry and never enables notifications. Single-flight: a second call
 * while one is in progress is ignored.
 */
export async function answerOsNotificationOffer(
  choice: OsNotificationOfferChoice,
): Promise<OsNotificationOfferAnswerResult> {
  const state = useOsNotificationOfferStore.getState();
  if (
    state.answering !== null ||
    state.eligibility !== 'eligible' ||
    !state.pending
  ) {
    return { kind: 'ignored' };
  }
  const answerTimestamp = state.answerTimestamp ?? new Date().toISOString();
  const answerChoice = state.answerChoice ?? choice;
  const generation = answerGeneration;
  savingAnswerTimestamp = answerTimestamp;
  useOsNotificationOfferStore.setState({
    answering: answerChoice,
    answerChoice,
    saveFailed: false,
    answerTimestamp,
  });

  try {
    await window.api.savePreferences({
      osNotificationOfferAnsweredAt: answerTimestamp,
    });
  } catch {
    if (useOsNotificationOfferStore.getState().eligibility !== 'answered') {
      useOsNotificationOfferStore.setState({
        answering: null,
        saveFailed: true,
      });
    }
    return { kind: 'save-failed' };
  } finally {
    savingAnswerTimestamp = null;
  }

  markAnswered();
  if (generation !== answerGeneration) return { kind: 'ignored' };
  if (answerChoice === 'dismiss') return { kind: 'dismissed' };

  try {
    const optIn = await window.api.optInToOsNotifications();
    return { kind: 'enabled', optIn };
  } catch {
    return { kind: 'opt-in-failed' };
  }
}

// Test-only reset. Not part of the public surface.
export function __resetOsNotificationOfferForTests(): void {
  answerGeneration += 1;
  savingAnswerTimestamp = null;
  useOsNotificationOfferStore.setState({ ...INITIAL_STATE });
}
