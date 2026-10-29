// Legacy Early access projection retained for compatibility and hydration.
// Product features read their independent Labs experiment instead.

import { useEffect } from 'react';
import { create } from 'zustand';
import { EARLY_ACCESS_EXPERIMENT_ID } from '@canopy/protocol/experiments';
import {
  ensureLabsExperimentsSubscription,
  isLabsExperimentEnabled,
  resetLabsExperimentsStoreForTest,
  useLabsExperimentsStore,
} from './labsExperimentsStore';

interface ExperimentalFeaturesState {
  /** True while main reports Early access on. Off until hydrated. */
  enabled: boolean;
  /** True once the Labs snapshot loaded (or could not load). */
  hydrated: boolean;
}

export const useExperimentalFeaturesStore = create<ExperimentalFeaturesState>(
  () => ({
    enabled: false,
    hydrated: false,
  }),
);

let unsubscribeLabs: (() => void) | null = null;

function project(): void {
  const labs = useLabsExperimentsStore.getState();
  const current = useExperimentalFeaturesStore.getState();
  // Without a snapshot only hydration moves: `enabled` keeps its default
  // (off), which is also the seam isolated renderer tests set directly.
  const enabled =
    labs.snapshot === null
      ? current.enabled
      : isLabsExperimentEnabled(labs.snapshot, EARLY_ACCESS_EXPERIMENT_ID);
  const hydrated = current.hydrated || labs.hydrated;
  if (current.enabled === enabled && current.hydrated === hydrated) return;
  useExperimentalFeaturesStore.setState({ enabled, hydrated });
}

/**
 * Hydrates the Labs snapshot and follows it for the lifetime of the window.
 * Idempotent; safe to call from every consumer.
 */
export function ensureExperimentalFeaturesSubscription(): void {
  if (unsubscribeLabs !== null) return;
  unsubscribeLabs = useLabsExperimentsStore.subscribe(project);
  ensureLabsExperimentsSubscription();
  project();
}

/** Resolves once the Labs snapshot has loaded (or failed to load). */
export function whenExperimentalFeaturesHydrated(): Promise<void> {
  ensureExperimentalFeaturesSubscription();
  if (useExperimentalFeaturesStore.getState().hydrated)
    return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useExperimentalFeaturesStore.subscribe((state) => {
      if (!state.hydrated) return;
      unsubscribe();
      resolve();
    });
  });
}

/**
 * Whether early access is on. Unfinished features render only when this is
 * true; it reads false until the snapshot loads, so they never flash in.
 */
export function useExperimentalFeaturesEnabled(): boolean {
  const enabled = useExperimentalFeaturesStore((state) => state.enabled);
  useEffect(() => {
    ensureExperimentalFeaturesSubscription();
  }, []);
  return enabled;
}

/** Test-only: drop the subscription and return the store to its defaults. */
export function resetExperimentalFeaturesStoreForTest(): void {
  unsubscribeLabs?.();
  unsubscribeLabs = null;
  resetLabsExperimentsStoreForTest();
  useExperimentalFeaturesStore.setState({
    enabled: false,
    hydrated: false,
  });
}
