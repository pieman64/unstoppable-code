/**
 * Durable completion for onboarding suggestion entries, decoupled from the
 * module's mount lifetime.
 *
 * Every successful Home send navigates away from Home, which unmounts the
 * page-variant `HomeSurface` (and the module inside it) in the same commit
 * the send notification fires. A component-owned subscriber therefore never
 * gets to persist the armed entry's completion — the exact bug this module
 * fixes. Arming state and the completion write live here at module scope:
 * the send subscription is registered once at import time, and completion
 * writes go straight through `window.api` (load → apply reducer → save)
 * instead of through React state owned by an unmounting component.
 *
 * The mounted gate hook subscribes to {@link onOnboardingSuggestionCompleted}
 * to refresh its in-memory copy for the non-navigating send paths; on
 * navigating sends the next Home mount re-reads preferences anyway.
 */

import type { HomeOnboardingSuggestionsPreferences } from '@canopy/desktop-shared/types';
import { withDismissalsCleared, withEntryCompleted } from './queue';
import { subscribeHomeTaskSends, type HomeTaskSendEvent } from './sendEvents';
import { trackOnboardingSuggestionCompleted } from './telemetry';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';

/** Plan-mode queue entry id — completed on a Plan-mode `task_ready` dispatch. */
const PLAN_MODE_ENTRY_ID = 'plan-mode';

/**
 * Where an armed prompt was injected: the Home composer (`chatId: null`) or
 * one chat tab's composer. A send completes the armed entry only when it
 * comes from that same surface (CAN-3032): a prompt tried in one project's
 * new chat must not be marked done by an unrelated send elsewhere.
 */
interface ArmedSuggestion {
  entryId: string;
  chatId: string | null;
}

let armed: ArmedSuggestion | null = null;

/**
 * Arms `entryId` to complete on the next successful chat-kind send from the
 * surface it was injected into — Home by default, or the chat tab named by
 * `target` — deliberately even if the user edits the injected prompt first.
 */
export function armOnboardingSuggestion(
  entryId: string,
  target?: { chatId: string },
): void {
  armed = { entryId, chatId: target?.chatId ?? null };
}

/**
 * Disarms `entryId`, and only `entryId` — dismissing an unrelated row must
 * never cancel another row's pending completion, so there is deliberately
 * no disarm-all form.
 */
export function disarmOnboardingSuggestion(entryId: string): void {
  if (armed?.entryId !== entryId) return;
  armed = null;
}

type CompletedListener = (entryId: string) => void;
const completedListeners = new Set<CompletedListener>();

/** Notifies mounted consumers that an entry was durably completed. */
export function onOnboardingSuggestionCompleted(
  listener: CompletedListener,
): () => void {
  completedListeners.add(listener);
  return (): void => {
    completedListeners.delete(listener);
  };
}

/**
 * Serialized read-modify-write chain for `homeOnboardingSuggestions`. Every
 * durable mutation — writer completions here AND the gate hook's
 * dismiss/latch/roles/retire deltas — must route through this chain:
 * `savePreferences` replaces the whole nested object on the main side, so
 * two independent load→save writers racing each other would silently drop
 * whichever delta lands first. Mutators receive the FRESH persisted state
 * and must be replayable deltas (the pure `queue.ts` reducers are), never
 * snapshots of a caller's in-memory copy. Returning `null` skips the save.
 *
 * With `allowStart`, a successful read that finds no module state hands the
 * mutator a fresh module (`startedAt` now, no entries) instead of skipping,
 * so a completion that races the first seed still lands; the seed then
 * no-ops. Without it, a module that never started is left alone.
 */
let writeChain: Promise<void> = Promise.resolve();

export interface MutateOnboardingSuggestionsOptions {
  allowStart?: boolean;
}

export function mutateOnboardingSuggestionsDurably(
  mutator: (
    state: HomeOnboardingSuggestionsPreferences,
  ) => HomeOnboardingSuggestionsPreferences | null,
  options: MutateOnboardingSuggestionsOptions = {},
): Promise<void> {
  const run = async (): Promise<void> => {
    const prefs = await window.api.loadPreferences();
    // Never mutate over a degraded read: the save would merge into defaults
    // and replace the last-good snapshot with them.
    if (prefs.__error) return;
    const saved = prefs.homeOnboardingSuggestions;
    const state =
      saved ??
      (options.allowStart
        ? { startedAt: new Date().toISOString(), entries: {} }
        : null);
    if (!state) return;
    const next = mutator(state);
    if (next === null) return;
    await window.api.savePreferences({ homeOnboardingSuggestions: next });
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/**
 * Seeds the cohort latch exactly once: a no-op when any persisted state
 * already exists (serialized with every other mutation above).
 */
export function seedOnboardingSuggestionsDurably(
  fresh: HomeOnboardingSuggestionsPreferences,
): Promise<void> {
  const run = async (): Promise<void> => {
    const prefs = await window.api.loadPreferences();
    // Never seed over a read that came back degraded: the save would merge
    // into defaults and replace the last-good snapshot with them.
    if (prefs.__error || prefs.homeOnboardingSuggestions) return;
    await window.api.savePreferences({ homeOnboardingSuggestions: fresh });
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

type RestoredListener = (state: HomeOnboardingSuggestionsPreferences) => void;
const restoredListeners = new Set<RestoredListener>();

export function onOnboardingSuggestionsRestored(
  listener: RestoredListener,
): () => void {
  restoredListeners.add(listener);
  return () => {
    restoredListeners.delete(listener);
  };
}

/** Restore the shared module from Settings without erasing activity history. */
export function restoreOnboardingSuggestionsDurably(): Promise<void> {
  const run = async (): Promise<void> => {
    const prefs = await window.api.loadPreferences();
    if (prefs.__error) return;
    const saved = prefs.homeOnboardingSuggestions;
    // Dismissed rows come back; finished work stays finished. The reducer
    // is also what drops the legacy whole-module `retiredAt`.
    const next: HomeOnboardingSuggestionsPreferences = withDismissalsCleared(
      saved ?? { startedAt: new Date().toISOString(), entries: {} },
    );
    await window.api.savePreferences({ homeOnboardingSuggestions: next });
    for (const listener of Array.from(restoredListeners)) listener(next);
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/** Restart checklist lessons without changing roles, projects, or connections. */
export function resetOnboardingSuggestionsDurably(): Promise<void> {
  const run = async (): Promise<void> => {
    const prefs = await window.api.loadPreferences();
    if (prefs.__error) throw new Error('Unable to load checklist progress.');
    const next: HomeOnboardingSuggestionsPreferences = {
      startedAt:
        prefs.homeOnboardingSuggestions?.startedAt ?? new Date().toISOString(),
      entries: {},
    };
    await window.api.savePreferences({ homeOnboardingSuggestions: next });
    armed = null;
    useOnboardingSuggestionSurfaces.setState({ planModeHighlight: false });
    for (const listener of Array.from(restoredListeners)) listener(next);
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/**
 * Clear the saved answer and reopen only its lesson in one serialized save.
 * The roles question is the category row on the tools step (`github`), so
 * that is the step that comes back.
 */
export function clearOnboardingProfileRolesDurably(): Promise<void> {
  const run = async (): Promise<void> => {
    const prefs = await window.api.loadPreferences();
    if (prefs.__error) throw new Error('Unable to load checklist progress.');
    const saved = prefs.homeOnboardingSuggestions ?? {
      startedAt: new Date().toISOString(),
      entries: {},
    };
    const entries = { ...saved.entries };
    delete entries.github;
    const next = { ...saved, entries };
    await window.api.savePreferences({
      profileRole: undefined,
      profileRoles: [],
      profileRoleDetail: '',
      homeOnboardingSuggestions: next,
    });
    for (const listener of Array.from(restoredListeners)) listener(next);
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/**
 * The E2E harness hides the module so unrelated automation sees a settled
 * Home and sidebar; everything that starts or shows it keys on this switch.
 */
export function isOnboardingSuggestionsModuleEnabled(): boolean {
  return window.devInfo?.hideOnboardingSuggestions !== true;
}

/** Why an entry completed, kept low-cardinality for telemetry. */
export type OnboardingSuggestionCompletionReason =
  | 'imported'
  | 'skipped'
  | 'finished';

/**
 * Applies the completion through the serialized chain: a no-op when the
 * entry is already resolved. The module is seeded from the app shell at
 * startup, but that seed and a completion can race (each is one preferences
 * round trip), and the E2E harness may hold the module back entirely; when a
 * successful read finds no module state and the module is enabled, the chain
 * starts it here with the entry already completed rather than dropping the
 * completion. Never over a degraded read.
 */
async function completeEntryDurably(
  entryId: string,
  reason?: OnboardingSuggestionCompletionReason,
): Promise<void> {
  let applied = false;
  await mutateOnboardingSuggestionsDurably(
    (state) => {
      const entry = state.entries[entryId];
      if (
        entry?.completedAt !== undefined ||
        entry?.dismissedAt !== undefined
      ) {
        return null;
      }
      applied = true;
      return withEntryCompleted(state, entryId, new Date().toISOString());
    },
    { allowStart: isOnboardingSuggestionsModuleEnabled() },
  );
  if (applied) trackOnboardingSuggestionCompleted(entryId, reason);
  // The mounted copy hears every completion, written or not. Disk and the
  // mounted copy can disagree: the dev-only forced replay runs the module
  // from an in-memory seed in which an entry is still pending while the
  // persisted one was resolved long ago, and a degraded read leaves nothing
  // to patch at all. The hook applies the completion idempotently and
  // ignores it when no module is running.
  for (const listener of Array.from(completedListeners)) {
    listener(entryId);
  }
}

/**
 * Completes an entry from a surface other than a Home send — the bulk
 * project import (CAN-2439) resolves `import-projects` when a project lands
 * or when the scan finds nothing to bring in. Best-effort: an unresolved
 * entry simply resurfaces next visit.
 */
export function completeOnboardingSuggestionDurably(
  entryId: string,
  reason?: OnboardingSuggestionCompletionReason,
): void {
  void completeEntryDurably(entryId, reason).catch(() => {
    // Best-effort — see above.
  });
}

function handleHomeTaskSent(event: HomeTaskSendEvent): void {
  const chatId = event.chatId ?? null;
  // Home's Plan-mode lesson and its highlight belong to the Home composer;
  // a chat tab's send says nothing about either.
  if (chatId === null) {
    useOnboardingSuggestionSurfaces.setState({ planModeHighlight: false });
  }
  if (event.kind === 'pipeline') return;
  // The lesson is complete only after a real Plan-mode query is submitted.
  // Clicking or toggling Plan mode alone deliberately leaves the row visible.
  if (chatId === null && event.planMode === true) {
    void completeEntryDurably(PLAN_MODE_ENTRY_ID).catch(() => {
      // Best-effort — an unresolved entry simply resurfaces next visit.
    });
  }
  const current = armed;
  if (current === null) return;
  // Only the surface the prompt was injected into completes it: a Home send
  // for a Home-armed entry, the same chat tab for a chat-armed one. Anything
  // else leaves it armed, so it still completes when sent from there.
  if (current.chatId !== chatId) return;
  armed = null;
  void completeEntryDurably(current.entryId).catch(() => {
    // Best-effort — an unresolved entry simply resurfaces next visit.
  });
}

subscribeHomeTaskSends(handleHomeTaskSent);

/** Test-only: clears the armed entry between cases. */
export function __resetOnboardingSuggestionArmingForTests(): void {
  armed = null;
}
