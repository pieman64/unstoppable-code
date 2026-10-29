import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HomeOnboardingSuggestionsPreferences,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { navigationModeForRole } from '@canopy/desktop-shared/lib/navigation-mode';
import {
  PROFILE_ROLES,
  type ProfileRoleId,
} from '@canopy/protocol/plugin-catalog';
import { withEntryCompleted } from './queue';
import {
  mutateOnboardingSuggestionsDurably,
  onOnboardingSuggestionCompleted,
  onOnboardingSuggestionsRestored,
  seedOnboardingSuggestionsDurably,
} from './completionWriter';

/**
 * Show-gate and persistence owner for the dynamic Home onboarding
 * suggestions module (the merged successor of the CAN-2411 card and the Home
 * suggested prompts). Follows the `useHomeOnboardingCardState` split: the
 * runtime mounts the module only while `visible`, and sheds it for a cheap
 * watcher once the queue is genuinely empty, so the provider status probes
 * inside the module run only while there is something left to suggest.
 *
 * Every install starts the module exactly once — existing users included.
 * Unlike the old card, which never showed once a code workspace existed or
 * the first-run wizard had run, nothing about the install keeps the
 * checklist away: `startedAt` is written on the first launch that finds no
 * module state (by this hook from the app shell, or by `completionWriter.ts`
 * when a completion races that first seed), and the add-repo entry
 * *converts* after the first repository instead of disappearing. Dismissal
 * applies only to individual suggestions
 * (Settings → "Show setup checklist" restores them): the module as a whole
 * cannot be dismissed, so neither the legacy card's
 * `homeOnboardingDismissedAt` nor a `retiredAt` left by the removed
 * whole-module retirement callback is honored. Completed and dismissed
 * activities disappear immediately; finishing the current introductory queue
 * unlocks advanced examples.
 */
export interface HomeOnboardingSuggestionsState {
  /** Whether the host surface should render the module right now. */
  visible: boolean;
  /** Persisted module state; non-null whenever `visible`. */
  persisted: HomeOnboardingSuggestionsPreferences | null;
  /**
   * Multi-select roles picked as categories on the Connect your tools step
   * (or a pre-existing wizard answer projected to a one-element list); null
   * until answered.
   */
  selectedRoles: readonly ProfileRoleId[] | null;
  /** Applies an immutable update (the `queue.ts` reducers) and persists it. */
  update: (
    updater: (
      previous: HomeOnboardingSuggestionsPreferences,
    ) => HomeOnboardingSuggestionsPreferences,
  ) => void;
  /**
   * Saves the categories picked above the tool tiles: `profileRoles` (the
   * full selection, possibly empty) and `profileRole` (primary — first
   * selected in `PROFILE_ROLES` order, which feeds cloud profile sync and the
   * role-targeted curated-catalog refresh). The local selection updates at
   * once so the tool tiles re-rank as the user picks.
   */
  changeRoles: (roles: readonly ProfileRoleId[]) => void;
}

export const FORCE_HOME_ONBOARDING_STORAGE_KEY =
  'canopy.dev.forceHomeOnboarding';

/**
 * Dev-only replay switch (mirrors `header-states-page-flag.ts`): with
 *
 *   localStorage.setItem('canopy.dev.forceHomeOnboarding', '1')
 *
 * every launch treats the module as a fresh first boot — persisted entry
 * dismissals and completions are ignored (roles stay pre-selected from any
 * prior answer) and the seed is in-memory only, so in-session interactions
 * behave normally and the next launch starts fresh again. Whole-module
 * retirement is not listed here because it is ignored on every path, forced
 * or not. Packaged builds never honor the flag.
 */
function isForcedFreshOnboarding(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.devInfo?.isDev !== true) return false;
  try {
    return (
      window.localStorage.getItem(FORCE_HOME_ONBOARDING_STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

/**
 * The writer notifies whether or not it wrote (`completionWriter.ts`), so a
 * completion can name an entry this copy already resolved; that entry keeps
 * its original time. Shared by the live listener and the pre-read buffer so
 * the two paths that apply the same notification agree.
 */
function withCompletionApplied(
  state: HomeOnboardingSuggestionsPreferences,
  entryId: string,
  at: string,
): HomeOnboardingSuggestionsPreferences {
  const entry = state.entries[entryId];
  if (entry?.completedAt !== undefined || entry?.dismissedAt !== undefined) {
    return state;
  }
  return withEntryCompleted(state, entryId, at);
}

/**
 * Persists a replayable delta through the module's serialized write chain
 * (`mutateOnboardingSuggestionsDurably`): the mutator re-applies against
 * the FRESH persisted state, so this hook's writes can never race the
 * send-completion writer into dropping each other's entries. Best-effort —
 * a failed save just means progress may replay on the next launch.
 */
function persistDelta(
  mutator: (
    state: HomeOnboardingSuggestionsPreferences,
  ) => HomeOnboardingSuggestionsPreferences | null,
): void {
  void mutateOnboardingSuggestionsDurably(mutator).catch(() => undefined);
}

/** First selected role in canonical `PROFILE_ROLES` order. */
export function primaryProfileRole(
  roles: readonly ProfileRoleId[],
): ProfileRoleId | null {
  for (const role of PROFILE_ROLES) {
    if (roles.includes(role)) return role;
  }
  return null;
}

export function useHomeOnboardingSuggestionsState(
  enabled: boolean,
): HomeOnboardingSuggestionsState {
  const [state, setState] =
    useState<HomeOnboardingSuggestionsPreferences | null>(null);
  // Mutations compute against this mirror so persistence stays OUTSIDE the
  // setState updater (React documents updaters as pure and double-invokes
  // them under StrictMode; a persist inside would double-write).
  const stateRef = useRef(state);
  stateRef.current = state;
  const [selectedRoles, setSelectedRoles] = useState<
    readonly ProfileRoleId[] | null
  >(null);
  const selectedRolesRef = useRef(selectedRoles);
  selectedRolesRef.current = selectedRoles;
  // Whether an answer has reached disk. The first persisted answer seeds the
  // navigation mode, so a failed first save leaves the next pick as the
  // first answer instead of silently skipping the seed.
  const answerPersistedRef = useRef(false);
  // Category picks save one at a time; a broadcast heard while one is in
  // flight would briefly restore an older selection, so syncs wait for the
  // count to drain.
  const pendingRoleSaves = useRef(0);
  // Re-reads the saved roles once the chain drains: a broadcast heard while
  // a save was in flight is ignored, so this is what picks its change up.
  const resyncRolesRef = useRef<() => void>(() => undefined);
  const startedRef = useRef(false);
  // Completions heard before the first preferences read lands. That read is
  // not on the writer's chain, so a completion written while it is in flight
  // is missing from its snapshot; applying the buffer when the read lands
  // keeps the mounted copy in step with what is on disk.
  const pendingCompletionsRef = useRef<string[]>([]);

  // One preferences read decides whether the module has already started for
  // this install; if not, this launch starts it.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let rolesSynced = false;
    let roleReadVersion = 0;
    let roleReadPending = false;
    const withPendingCompletions = (
      next: HomeOnboardingSuggestionsPreferences,
    ): HomeOnboardingSuggestionsPreferences => {
      const pending = pendingCompletionsRef.current;
      if (pending.length === 0) return next;
      pendingCompletionsRef.current = [];
      const at = new Date().toISOString();
      return pending.reduce(
        (state, entryId) => withCompletionApplied(state, entryId, at),
        next,
      );
    };
    // The first read's state, with the buffer applied, made visible to the
    // listeners at once: `setState` commits later, and a completion heard
    // in between would otherwise be buffered again with nothing left to
    // drain it.
    const mountState = (next: HomeOnboardingSuggestionsPreferences): void => {
      const mounted = withPendingCompletions(next);
      stateRef.current = mounted;
      setState(mounted);
    };
    let lastRolesKey: string | undefined;
    // `null` means the question was never answered; an explicit empty list
    // (every category cleared) is an answer, so a later pick is not a first
    // answer and does not reseed the navigation mode.
    const rolesFrom = (
      prefs: PreferencesData,
    ): readonly ProfileRoleId[] | null =>
      prefs.profileRoles?.length
        ? prefs.profileRoles
        : prefs.profileRole
          ? [prefs.profileRole]
          : Array.isArray(prefs.profileRoles)
            ? []
            : null;
    const syncRoles = (prefs: PreferencesData): void => {
      if (pendingRoleSaves.current > 0) return;
      const next = rolesFrom(prefs);
      if (next !== null) answerPersistedRef.current = true;
      lastRolesKey = next?.join(',') ?? '';
      setSelectedRoles((previous) =>
        previous === next ||
        (previous !== null &&
          next !== null &&
          previous.length === next.length &&
          previous.every((role, index) => role === next[index]))
          ? previous
          : next,
      );
    };
    // This owner survives navigation to Settings and the replayed wizard.
    // Subscribe before reading so a late initial snapshot cannot replace a
    // newer role. Broadcasts wait for cloud sync and can arrive out of order:
    // use role changes as an invalidation signal, then read canonical state.
    const unsubscribe = window.api.onPreferencesSynced((prefs) => {
      if (cancelled) return;
      rolesSynced = true;
      if (
        !roleReadPending &&
        (rolesFrom(prefs)?.join(',') ?? '') === lastRolesKey
      )
        return;
      const version = ++roleReadVersion;
      roleReadPending = true;
      void window.api
        .loadPreferences()
        .then((current) => {
          if (!cancelled && version === roleReadVersion) syncRoles(current);
        })
        .catch(() => {
          // Keep the last confirmed roles until another sync can be read.
        })
        .finally(() => {
          if (version === roleReadVersion) roleReadPending = false;
        });
    });
    resyncRolesRef.current = (): void => {
      void window.api
        .loadPreferences()
        .then((prefs) => {
          if (!cancelled) syncRoles(prefs);
        })
        .catch(() => {
          // Keep the local selection until another sync can be read.
        });
    };
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (cancelled) return;
        if (isForcedFreshOnboarding()) {
          // In-memory seed only: later interactions persist normally, and
          // the next forced launch ignores them again.
          startedRef.current = true;
          mountState({ startedAt: new Date().toISOString(), entries: {} });
        } else if (prefs.homeOnboardingSuggestions) {
          startedRef.current = true;
          mountState(prefs.homeOnboardingSuggestions);
        } else if (prefs.__error) {
          // A degraded read resolves with defaults rather than rejecting. It
          // is not an empty install: stay hidden for this session instead of
          // seeding over state that could not be read (which would also
          // rewrite the last-good preferences snapshot from defaults).
        } else {
          // First launch with no module state: start it, durably, for this
          // install. A repository on disk or the old first-run wizard having
          // run does not exempt anyone.
          startedRef.current = true;
          const fresh: HomeOnboardingSuggestionsPreferences = {
            startedAt: new Date().toISOString(),
            entries: {},
          };
          // A completion that raced this read already started the module on
          // disk; the seed no-ops there, and the mounted copy carries it.
          mountState(fresh);
          void seedOnboardingSuggestionsDurably(fresh).catch(() => undefined);
        }
        if (!rolesSynced) syncRoles(prefs);
      })
      .catch(() => {
        // A failed read leaves the module hidden for this session rather
        // than seeding over state that could not be read.
      });
    return (): void => {
      cancelled = true;
      resyncRolesRef.current = (): void => undefined;
      unsubscribe();
    };
  }, [enabled]);

  // Durable completions are written by `completionWriter.ts` (which
  // survives the unmount every navigating send performs); mirror them into
  // the in-memory copy WITHOUT re-persisting so non-navigating sends update
  // the visible queue immediately.
  useEffect(() => {
    if (!enabled) return;
    const unsubscribeRestored = onOnboardingSuggestionsRestored((next) => {
      startedRef.current = true;
      stateRef.current = next;
      setState(next);
    });
    const unsubscribeCompleted = onOnboardingSuggestionCompleted((entryId) => {
      const previous = stateRef.current;
      if (previous === null) {
        pendingCompletionsRef.current.push(entryId);
        return;
      }
      const next = withCompletionApplied(
        previous,
        entryId,
        new Date().toISOString(),
      );
      if (next === previous) return;
      stateRef.current = next;
      setState(next);
    });
    return (): void => {
      unsubscribeRestored();
      unsubscribeCompleted();
    };
  }, [enabled]);

  const update = useCallback(
    (
      updater: (
        previous: HomeOnboardingSuggestionsPreferences,
      ) => HomeOnboardingSuggestionsPreferences,
    ): void => {
      const previous = stateRef.current;
      if (previous === null) return;
      // Optimistic local apply; the same PURE delta replays against the
      // fresh persisted state inside the serialized chain.
      const next = updater(previous);
      stateRef.current = next;
      setState(next);
      persistDelta(updater);
    },
    [],
  );

  // Picks made while a save is in flight collapse into one save of the
  // newest selection once it settles, so a burst of toggles costs one cloud
  // sync and curated-catalog refresh per settled save, not one per tile.
  // The local selection updates at once either way.
  const unsavedRolesRef = useRef<readonly ProfileRoleId[] | null>(null);
  // The first answer seeds the Code/Work navigation mode (CAN-1817), as the
  // retired roles step did; later picks only re-rank tools, so toggling
  // categories never reshapes the app. Settings → General can override it.
  // The seed is fixed by the first pick and re-sent until an answer reaches
  // disk, so a failed first save does not skip it and a quick second pick
  // cannot flip it.
  const firstAnswerSeedRef = useRef<ReturnType<
    typeof navigationModeForRole
  > | null>(null);
  const saveRolesRef = useRef<() => void>(() => undefined);
  saveRolesRef.current = (): void => {
    const deduped = unsavedRolesRef.current;
    if (deduped === null) return;
    unsavedRolesRef.current = null;
    const primary = primaryProfileRole(deduped);
    const seed = answerPersistedRef.current ? null : firstAnswerSeedRef.current;
    pendingRoleSaves.current += 1;
    let failed = false;
    Promise.resolve()
      .then(() =>
        window.api.savePreferences({
          // An explicit empty list clears the answer (preferences-store).
          profileRoles: [...deduped],
          ...(primary !== null ? { profileRole: primary } : {}),
          ...(seed !== null ? { navigationMode: seed } : {}),
        }),
      )
      .then(() => {
        answerPersistedRef.current = true;
      })
      .catch(() => {
        // Best-effort — the local selection still drives this session, so
        // the drain below must not re-read a profile this save never wrote.
        failed = true;
      })
      .finally(() => {
        pendingRoleSaves.current -= 1;
        if (unsavedRolesRef.current !== null) {
          saveRolesRef.current();
        } else if (!failed) {
          resyncRolesRef.current();
        }
      });
  };

  const changeRoles = useCallback((roles: readonly ProfileRoleId[]): void => {
    const deduped = Array.from(new Set(roles));
    if (!answerPersistedRef.current && firstAnswerSeedRef.current === null) {
      firstAnswerSeedRef.current = navigationModeForRole(
        primaryProfileRole(deduped),
      );
    }
    selectedRolesRef.current = deduped;
    setSelectedRoles(deduped);
    unsavedRolesRef.current = deduped;
    if (pendingRoleSaves.current === 0) saveRolesRef.current();
  }, []);

  // `state.retiredAt` is intentionally ignored — see the module doc comment.
  const visible = enabled && state !== null;

  return {
    visible,
    persisted: state,
    selectedRoles,
    update,
    changeRoles,
  };
}
