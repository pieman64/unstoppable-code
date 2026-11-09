import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { UnsavedChangesSaveResult } from '@canopy/ui-app/workflows';
import type { AutomationDraftSeed } from '@/lib/workflows/edit-target';
import { storedAutomationActivity } from '@/lib/workflows/stored-automation-activity';
import { useAutomationsStore } from '@/stores/automationsStore';
import type { ActivityFormChangeMeta } from '../../automations/form/ActivityFormBody';
import {
  activityToFormState,
  automationDraftFromSeed,
  automationFormSnapshot,
  buildAutomationMutationRequest,
  type AutomationFormSection,
  type FormState,
} from '../../automations/form/automationFormState';

const TOGGLE_FAILED = "Couldn't save that change. Try again.";
const LATEST_EDITS_UNSAVED =
  "Your latest edits aren't saved yet. Save again to keep them.";

/**
 * Why a schedule's last save or toggle failed. A blocking field names its
 * section and shows there; a refused request (`section: null`) shows above
 * the sections.
 */
export interface ScheduleDraftError {
  readonly message: string;
  readonly section: AutomationFormSection | null;
  /** Set by a failed menu toggle, so a later successful one clears it. */
  readonly fromToggle?: true;
}

/** One schedule the editor holds a draft for. */
export interface ScheduleDraftSource {
  /** Unique in the list: the record's id, or a new row's own key. */
  readonly key: string;
  /** The saved record; null for a new, unsaved row. */
  readonly activity: ScheduledActivity | null;
  /** How a new row starts. */
  readonly seed?: AutomationDraftSeed;
  /** A new row's whole form, such as a copy of another schedule's. */
  readonly initial?: FormState;
  /**
   * Edits a new row got while its create was in flight, carried to the
   * record it became, so they stay unsaved there instead of being lost.
   */
  readonly pending?: FormState;
  /**
   * Edit the action main stores (a converted record's
   * `ownedPipeline.storedAction`) instead of the chat action it shows as, so
   * a save sends that `worktree_pipeline` and never regenerates its
   * pipeline.
   */
  readonly stored?: boolean;
}

export interface ScheduleDraft {
  readonly key: string;
  readonly activity: ScheduledActivity | null;
  readonly state: FormState;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly error: ScheduleDraftError | null;
}

interface DraftEntry {
  /** The record this draft last followed. */
  readonly activity: ScheduledActivity | null;
  readonly state: FormState;
  /**
   * The clean form. Mount normalizations move it along with the form, so a
   * freshly opened schedule is never dirty.
   */
  readonly baseline: FormState;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly error: ScheduleDraftError | null;
}

type Drafts = ReadonlyMap<string, DraftEntry>;

export interface UseScheduleDraftsOptions {
  /** Memoize it: a new list reconciles the drafts. */
  readonly sources: readonly ScheduleDraftSource[];
  /**
   * Runs first in a save, inside its single flight. A result stops the save
   * with it, for checks only the caller can make.
   */
  readonly beforeSave?: (key: string) => UnsavedChangesSaveResult | null;
  /** A field in this section blocks the save: show it. */
  readonly onBlockedSection?: (section: AutomationFormSection) => void;
  /**
   * A new row saved as this record. `pending` is the row's form when it was
   * edited again while the create was in flight.
   */
  readonly onCreated?: (
    key: string,
    activity: ScheduledActivity,
    pending: FormState | undefined,
  ) => void;
}

export interface ScheduleDraftsApi {
  /** In `sources` order. */
  readonly drafts: readonly ScheduleDraft[];
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly change: (
    key: string,
    next: FormState,
    meta: ActivityFormChangeMeta,
  ) => void;
  readonly save: (key: string) => Promise<UnsavedChangesSaveResult>;
  /** Resets every draft to its saved form. */
  readonly discard: () => void;
  readonly toggle: (key: string, enabled: boolean) => void;
  /** Every draft as it is now, including edits not rendered yet. */
  readonly current: () => ScheduleDraft[];
  /** The draft's latest form, including edits not rendered yet. */
  readonly latest: (key: string) => FormState | undefined;
  /** Sets only the draft's name on its latest form. */
  readonly setName: (key: string, name: string) => void;
  /**
   * Deletes the record; throws with the refusal. `keepPipeline` keeps a
   * workflow page whose last schedule this is (CAN-5782).
   */
  readonly remove: (
    key: string,
    options?: { keepPipeline?: boolean },
  ) => Promise<void>;
  readonly setError: (
    key: string,
    update:
      | ScheduleDraftError
      | null
      | ((current: ScheduleDraftError | null) => ScheduleDraftError | null),
  ) => void;
}

/**
 * The form a stored-action draft opens with. It leaves
 * `pipelineDependencies` undefined, so a save never sends `dependencies`:
 * the stored action is not a prompt, and an edit that loaded the list would
 * otherwise send `dependencies: null` and delete the converted prompt's
 * pipeline dependencies, which sharing, duplication and the dispatcher read.
 */
function storedActionFormState(activity: ScheduledActivity): FormState {
  return {
    ...activityToFormState(storedAutomationActivity(activity)),
    pipelineDependencies: undefined,
  };
}

function sourceFormState(source: ScheduleDraftSource): FormState {
  if (source.activity === null)
    return source.initial ?? automationDraftFromSeed(source.seed);
  return source.stored
    ? storedActionFormState(source.activity)
    : activityToFormState(source.activity);
}

/** Edits carried to a record: its identity, and the rest as typed. */
function carriedState(pending: FormState, baseline: FormState): FormState {
  return {
    ...pending,
    mode: baseline.mode,
    id: baseline.id,
    installed: baseline.installed,
    executionContext: baseline.executionContext,
  };
}

function newEntry(source: ScheduleDraftSource): DraftEntry {
  const baseline = sourceFormState(source);
  const state = source.pending
    ? carriedState(source.pending, baseline)
    : baseline;
  return {
    activity: source.activity,
    state,
    baseline,
    saving: false,
    deleting: false,
    error: null,
  };
}

function toDraft(source: ScheduleDraftSource, entries: Drafts): ScheduleDraft {
  const entry = entries.get(source.key) ?? newEntry(source);
  return {
    key: source.key,
    activity: entry.activity,
    state: entry.state,
    dirty: isDirty(entry),
    saving: entry.saving,
    deleting: entry.deleting,
    error: entry.error,
  };
}

function isDirty(entry: DraftEntry): boolean {
  return (
    automationFormSnapshot(entry.state) !==
    automationFormSnapshot(entry.baseline)
  );
}

/**
 * Drafts for the new and changed sources, without the removed ones. Another
 * surface changed a saved record (the side panel's toggle, another window,
 * sync): a clean draft follows it; local edits win.
 */
function reconcile(
  current: Drafts,
  sources: readonly ScheduleDraftSource[],
): Drafts {
  let changed = current.size !== sources.length;
  const next = new Map<string, DraftEntry>();
  for (const source of sources) {
    const entry = current.get(source.key);
    if (entry === undefined) {
      next.set(source.key, newEntry(source));
      changed = true;
    } else if (source.activity === null || entry.activity === source.activity) {
      next.set(source.key, entry);
    } else {
      changed = true;
      if (isDirty(entry)) {
        next.set(source.key, { ...entry, activity: source.activity });
      } else {
        const state = sourceFormState(source);
        next.set(source.key, {
          ...entry,
          activity: source.activity,
          state,
          baseline: state,
        });
      }
    }
  }
  return changed ? next : current;
}

/**
 * The schedule drafts an automation or workflow editor holds: one per record,
 * plus new unsaved rows. Each has its own single-flight save, header toggle
 * and error; the editor decides which sections show them.
 */
export function useScheduleDrafts(
  options: UseScheduleDraftsOptions,
): ScheduleDraftsApi {
  const { sources } = options;
  const createActivity = useAutomationsStore((s) => s.createActivity);
  const updateActivity = useAutomationsStore((s) => s.updateActivity);
  const deleteActivity = useAutomationsStore((s) => s.deleteActivity);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const [entries, setEntries] = useState<Drafts>(() =>
    reconcile(new Map(), sources),
  );
  // Every write moves the ref first, so a save, toggle or second
  // normalization in the same commit reads the latest drafts.
  const entriesRef = useRef(entries);
  const commit = useCallback((update: (current: Drafts) => Drafts): void => {
    const next = update(entriesRef.current);
    if (next === entriesRef.current) return;
    entriesRef.current = next;
    setEntries(next);
  }, []);

  // New rows already created: until their source goes, they read as
  // gone, so a save pass that runs before the list re-renders never
  // creates them again.
  const createdKeysRef = useRef(new Set<string>());
  useEffect(() => {
    commit((current) => reconcile(current, sources));
    for (const key of createdKeysRef.current)
      if (!sources.some((source) => source.key === key))
        createdKeysRef.current.delete(key);
  }, [commit, sources]);

  const read = useCallback((key: string): DraftEntry | undefined => {
    const entry = entriesRef.current.get(key);
    if (entry !== undefined) return entry;
    const source = sourcesRef.current.find((item) => item.key === key);
    return source ? newEntry(source) : undefined;
  }, []);

  const patch = useCallback(
    (key: string, update: (entry: DraftEntry) => DraftEntry): void => {
      commit((current) => {
        const entry = current.get(key) ?? read(key);
        if (entry === undefined) return current;
        return new Map(current).set(key, update(entry));
      });
    },
    [commit, read],
  );

  const setError = useCallback<ScheduleDraftsApi['setError']>(
    (key, update) => {
      patch(key, (entry) => {
        const error =
          typeof update === 'function' ? update(entry.error) : update;
        return error === entry.error ? entry : { ...entry, error };
      });
    },
    [patch],
  );

  const change = useCallback(
    (key: string, next: FormState, meta: ActivityFormChangeMeta): void => {
      patch(key, (entry) => ({
        ...entry,
        state: next,
        ...(meta.origin === 'mount' && !isDirty(entry)
          ? { baseline: next }
          : {}),
      }));
    },
    [patch],
  );

  // The header toggle's write per record while it is in flight, resolving
  // to its error if it failed (it never rejects); a Save waits for it.
  const togglesRef = useRef(new Map<string, Promise<string | null>>());

  const runSave = useCallback(
    async (key: string): Promise<UnsavedChangesSaveResult> => {
      const blocked = optionsRef.current.beforeSave?.(key) ?? null;
      if (blocked !== null) return blocked;
      // A Save started while the toggle is writing `enabled` sends the
      // toggled value instead of reverting it.
      const toggling = togglesRef.current.get(key);
      const toggleError = toggling === undefined ? null : await toggling;
      const entry = read(key);
      if (entry === undefined) return { ok: false };
      const current = entry.state;
      const built = buildAutomationMutationRequest(current);
      if (!built.ok) {
        setError(key, { message: built.error, section: built.section });
        optionsRef.current.onBlockedSection?.(built.section);
        return { ok: false, message: built.error };
      }
      // A toggle that failed while this save waited keeps its error.
      patch(key, (latest) => ({
        ...latest,
        error:
          toggleError === null
            ? null
            : { message: toggleError, section: null, fromToggle: true },
        saving: true,
      }));
      const response =
        built.mode === 'create'
          ? await createActivity(built.request)
          : await updateActivity(built.request);
      patch(key, (latest) => ({ ...latest, saving: false }));
      if (!response.ok) {
        setError(key, { message: response.error, section: null });
        return { ok: false, message: response.error };
      }
      patch(key, (latest) => ({ ...latest, baseline: current }));
      const saved = response.activity;
      if (built.mode === 'create' && saved) {
        createdKeysRef.current.add(key);
        const after = read(key);
        const pending =
          after !== undefined && isDirty(after) ? after.state : undefined;
        // The record may already be listed (its broadcast can land before
        // the reply): it takes the edits now, unsaved. Otherwise its source
        // carries them when it arrives.
        const listed = entriesRef.current.get(saved.id);
        if (pending !== undefined && listed !== undefined)
          patch(saved.id, (entry) => ({
            ...entry,
            state: carriedState(pending, entry.baseline),
          }));
        optionsRef.current.onCreated?.(key, saved, pending);
      }
      return { ok: true };
    },
    [createActivity, patch, read, setError, updateActivity],
  );

  // One save at a time per schedule. A second request while one is in
  // flight (the unsaved-changes prompt's Save, ⌘S) joins it, so a new row is
  // never created twice.
  const pendingSavesRef = useRef(
    new Map<string, Promise<UnsavedChangesSaveResult>>(),
  );
  const save = useCallback(
    (key: string): Promise<UnsavedChangesSaveResult> => {
      const inFlight = pendingSavesRef.current.get(key);
      if (inFlight !== undefined) {
        // The joined save wrote the form as it was when it started. On a
        // saved record, edits made since are still unsaved, so a caller
        // about to leave must not. (A new row remounts as its saved record
        // instead.)
        return inFlight.then((result) => {
          const entry = read(key);
          return result.ok && entry !== undefined && isDirty(entry)
            ? { ok: false, message: LATEST_EDITS_UNSAVED }
            : result;
        });
      }
      if (createdKeysRef.current.has(key)) return Promise.resolve({ ok: true });
      const pending = runSave(key).finally(() => {
        pendingSavesRef.current.delete(key);
      });
      pendingSavesRef.current.set(key, pending);
      return pending;
    },
    [read, runSave],
  );

  const latest = useCallback(
    (key: string): FormState | undefined => read(key)?.state,
    [read],
  );
  const setName = useCallback(
    (key: string, name: string): void => {
      patch(key, (entry) =>
        entry.state.name === name
          ? entry
          : { ...entry, state: { ...entry.state, name } },
      );
    },
    [patch],
  );

  const discard = useCallback((): void => {
    commit((current) => {
      const next = new Map<string, DraftEntry>();
      for (const [key, entry] of current)
        next.set(key, { ...entry, state: entry.baseline });
      return next;
    });
  }, [commit]);

  const toggle = useCallback(
    (key: string, next: boolean): void => {
      const entry = read(key);
      if (entry === undefined) return;
      const { activity } = entry;
      if (activity === null) {
        patch(key, (latest) => ({
          ...latest,
          state: { ...latest.state, enabled: next },
        }));
        return;
      }
      // Only `enabled` is written: other unsaved edits stay unsaved, and the
      // next Save keeps this toggle because the baseline moves with it.
      if (togglesRef.current.has(key)) return;
      const pending = updateActivity({ id: activity.id, enabled: next })
        .then((response): string | null => {
          if (!response.ok) {
            setError(key, {
              message: response.error,
              section: null,
              fromToggle: true,
            });
            return response.error;
          }
          // The ref moves now, so a Save waiting on this write reads it.
          patch(key, (latest) => ({
            ...latest,
            error: latest.error?.fromToggle ? null : latest.error,
            state: { ...latest.state, enabled: next },
            baseline: { ...latest.baseline, enabled: next },
          }));
          return null;
        })
        .catch((error: unknown): string => {
          // A write that never answered fails like a refused one.
          reportClientAppError(error);
          setError(key, {
            message: TOGGLE_FAILED,
            section: null,
            fromToggle: true,
          });
          return TOGGLE_FAILED;
        })
        .finally(() => {
          togglesRef.current.delete(key);
        });
      togglesRef.current.set(key, pending);
    },
    [patch, read, setError, updateActivity],
  );

  const remove = useCallback(
    async (
      key: string,
      options?: { keepPipeline?: boolean },
    ): Promise<void> => {
      const activity = read(key)?.activity;
      if (!activity) return;
      patch(key, (latest) => ({ ...latest, deleting: true }));
      try {
        const response = await deleteActivity(activity.id, options);
        if (!response.ok) throw new Error(response.error);
        // Nothing is left to save, so leaving never asks.
        patch(key, (latest) => ({ ...latest, baseline: latest.state }));
      } finally {
        patch(key, (latest) => ({ ...latest, deleting: false }));
      }
    },
    [deleteActivity, patch, read],
  );

  const drafts = useMemo(
    () => sources.map((source) => toDraft(source, entries)),
    [entries, sources],
  );
  const current = useCallback(
    (): ScheduleDraft[] =>
      sourcesRef.current
        .filter((source) => !createdKeysRef.current.has(source.key))
        .map((source) => toDraft(source, entriesRef.current)),
    [],
  );

  return {
    drafts,
    dirty: drafts.some((draft) => draft.dirty),
    saving: drafts.some((draft) => draft.saving),
    deleting: drafts.some((draft) => draft.deleting),
    change,
    save,
    discard,
    toggle,
    current,
    latest,
    setName,
    remove,
    setError,
  };
}
