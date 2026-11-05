// Renderer mirror of main's Labs experiments snapshot (Settings → Labs).
//
// Main is the only evaluator: it resolves availability, the stored choice,
// and the Early access prerequisite, then pushes one snapshot to every
// window. This store keeps the newest snapshot by revision and never
// recomputes effective state. The only local overlay is the switch value a
// pending save requested, so a toggle answers immediately without granting
// any page before main confirms it.

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import {
  hiddenLabsSidebarKeys,
  LABS_EXPERIMENTS,
  labsOwnedSidebarKeys,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';

export const LABS_EXPERIMENT_SAVE_ERROR =
  'Could not save this setting. Try again.';

interface LabsExperimentsState {
  /** Newest authoritative snapshot; null until the first one arrives. */
  snapshot: LabsExperimentsSnapshot | null;
  /** True once a snapshot arrived or the bridge could not supply one. */
  hydrated: boolean;
  /** Switch values requested by saves still in flight, by experiment id. */
  pending: Readonly<Record<string, boolean>>;
  /** Save errors shown under the section, by experiment id. */
  errors: Readonly<Record<string, string>>;
}

export const useLabsExperimentsStore = create<LabsExperimentsState>(() => ({
  snapshot: null,
  hydrated: false,
  pending: {},
  errors: {},
}));

let unsubscribeSnapshot: (() => void) | null = null;
let subscriptionGeneration = 0;
// Each save gets a token; a completion whose token was cleared (account
// change or reset) no longer belongs to the visible scope and is ignored.
let nextSaveToken = 0;
const saveTokens = new Map<string, number>();

function isNewer(
  next: LabsExperimentsSnapshot,
  current: LabsExperimentsSnapshot | null,
): boolean {
  if (current === null) return true;
  if (next.generation !== current.generation)
    return next.generation > current.generation;
  return next.revision > current.revision;
}

/**
 * Applies a snapshot from a push, the hydrating read, or a save result. Older
 * revisions are dropped. A new generation or scope means the account changed:
 * pending saves and errors from the previous one are discarded.
 */
export function applyLabsExperimentsSnapshot(
  snapshot: LabsExperimentsSnapshot,
): void {
  const current = useLabsExperimentsStore.getState();
  if (!isNewer(snapshot, current.snapshot)) {
    if (!current.hydrated) useLabsExperimentsStore.setState({ hydrated: true });
    return;
  }
  const scopeChanged =
    current.snapshot !== null &&
    (current.snapshot.generation !== snapshot.generation ||
      current.snapshot.scope !== snapshot.scope);
  if (scopeChanged) saveTokens.clear();
  useLabsExperimentsStore.setState({
    snapshot,
    hydrated: true,
    ...(scopeChanged ? { pending: {}, errors: {} } : {}),
  });
}

function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Subscribes to main's pushes, then reads the current snapshot, for the
 * lifetime of the window. Idempotent. A missing or partial bridge settles
 * hydration with no snapshot, which keeps every experiment off.
 */
export function ensureLabsExperimentsSubscription(): void {
  if (unsubscribeSnapshot !== null) return;
  const generation = ++subscriptionGeneration;
  const accept = (snapshot: LabsExperimentsSnapshot): void => {
    if (generation === subscriptionGeneration)
      applyLabsExperimentsSnapshot(snapshot);
  };
  // Isolated renderer/test hosts may expose a partial preload bridge.
  const api = typeof window !== 'undefined' ? window.api : undefined;
  const experiments = api?.experiments;
  if (typeof experiments?.getSnapshot !== 'function') {
    unsubscribeSnapshot = (): void => undefined;
    useLabsExperimentsStore.setState({ hydrated: true });
    return;
  }
  unsubscribeSnapshot = (): void => undefined;
  try {
    if (typeof experiments.onSnapshotChanged === 'function')
      unsubscribeSnapshot = experiments.onSnapshotChanged(accept);
  } catch {
    useLabsExperimentsStore.setState({ hydrated: true });
    return;
  }
  // Deferred so a bridge that throws or returns a non-promise still settles
  // through the catch below instead of escaping from a caller's effect.
  void Promise.resolve()
    .then(() => experiments.getSnapshot())
    .then(accept)
    .catch(() => {
      if (generation === subscriptionGeneration)
        useLabsExperimentsStore.setState({ hydrated: true });
    });
}

/**
 * Saves the person's choice for one experiment through main. Ignored while a
 * save for the same experiment is in flight or before a ready snapshot.
 */
export async function setLabsExperimentChoice(
  experimentId: string,
  enabled: boolean,
): Promise<void> {
  const state = useLabsExperimentsStore.getState();
  if (
    !state.snapshot?.ready ||
    Object.prototype.hasOwnProperty.call(state.pending, experimentId)
  )
    return;
  const experiments = window.api?.experiments;
  const token = ++nextSaveToken;
  saveTokens.set(experimentId, token);
  useLabsExperimentsStore.setState({
    pending: { ...state.pending, [experimentId]: enabled },
    errors: withoutKey(state.errors, experimentId),
  });
  const current = (): boolean => saveTokens.get(experimentId) === token;
  try {
    if (typeof experiments?.setChoice !== 'function')
      throw new Error('Experiments are unavailable.');
    const snapshot = await experiments.setChoice({ experimentId, enabled });
    if (!current()) return;
    saveTokens.delete(experimentId);
    // Main's result lands before the overlay goes, so the switch never shows
    // the previous value in between.
    applyLabsExperimentsSnapshot(snapshot);
    useLabsExperimentsStore.setState((latest) => ({
      pending: withoutKey(latest.pending, experimentId),
    }));
  } catch {
    if (!current()) return;
    saveTokens.delete(experimentId);
    // Only the overlay goes; a newer pushed snapshot stays in place.
    useLabsExperimentsStore.setState((latest) => ({
      pending: withoutKey(latest.pending, experimentId),
      errors: { ...latest.errors, [experimentId]: LABS_EXPERIMENT_SAVE_ERROR },
    }));
  }
}

/** Whether main reports this experiment on. False until a ready snapshot. */
export function isLabsExperimentEnabled(
  snapshot: LabsExperimentsSnapshot | null,
  experimentId: string,
): boolean {
  if (!snapshot?.ready) return false;
  return (
    snapshot.experiments.find((entry) => entry.id === experimentId)?.enabled ===
    true
  );
}

/** Reads only main's effective verdict, including rollout and hydration. */
export function useLabsExperimentEnabled(experimentId: string): boolean {
  const enabled = useLabsExperimentsStore((state) =>
    isLabsExperimentEnabled(state.snapshot, experimentId),
  );
  useEffect(() => {
    ensureLabsExperimentsSubscription();
  }, []);
  return enabled;
}

/**
 * Sidebar nav keys owned by experiments that are off, including E2E fixture
 * entries only main's snapshot carries. Every registered key is hidden until
 * a ready snapshot arrives. Stable between changes.
 */
export function useLabsHiddenSidebarKeys(): readonly string[] {
  useEffect(() => {
    ensureLabsExperimentsSubscription();
  }, []);
  const key = useLabsExperimentsStore((state) =>
    hiddenLabsSidebarKeys(
      state.snapshot,
      state.snapshot?.experiments ?? LABS_EXPERIMENTS,
    ).join('|'),
  );
  return useMemo(() => (key ? key.split('|') : []), [key]);
}

/**
 * Sidebar nav keys any experiment in the snapshot's registry owns, on or off,
 * including E2E fixture entries. The sidebar marks these rows with the Labs
 * marker; off keys are hidden, so only pages whose experiment is on show it.
 * Stable between changes.
 */
export function useLabsOwnedSidebarKeys(): readonly string[] {
  useEffect(() => {
    ensureLabsExperimentsSubscription();
  }, []);
  const key = useLabsExperimentsStore((state) =>
    labsOwnedSidebarKeys(state.snapshot?.experiments ?? LABS_EXPERIMENTS).join(
      '|',
    ),
  );
  return useMemo(() => (key ? key.split('|') : []), [key]);
}

/** Current effective state for non-React consumers; main remains the evaluator. */
export function getLabsFeatureEnabled(id: string): boolean {
  return isLabsExperimentEnabled(
    useLabsExperimentsStore.getState().snapshot,
    id,
  );
}

/** Follow one feature without reacting to unrelated choice or pending-save changes. */
export function subscribeLabsFeature(
  id: string,
  listener: (enabled: boolean, previous: boolean) => void,
): () => void {
  ensureLabsExperimentsSubscription();
  return useLabsExperimentsStore.subscribe((state, previous) => {
    const enabled = isLabsExperimentEnabled(state.snapshot, id);
    const wasEnabled = isLabsExperimentEnabled(previous.snapshot, id);
    if (enabled !== wasEnabled) listener(enabled, wasEnabled);
  });
}
