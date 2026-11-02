import { useEffect } from 'react';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';

const NO_ACTIVITIES: readonly ScheduledActivity[] = [];

/** The automations snapshot that decides which chats a resume already covers. */
export interface ScheduledResumeAutomations {
  readonly activities: readonly ScheduledActivity[];
  /**
   * The store holds an authoritative snapshot for the current context:
   * hydrated without an error. A background reload may still be `loading`.
   */
  readonly settled: boolean;
  readonly loading: boolean;
  /** The last load's failure, or null. A failure is never an empty list. */
  readonly error: string | null;
  /** Load the snapshot if it is missing or failed and no load is in flight. */
  readonly retry: () => void;
}

let bridgeConsumers = 0;
let releaseBridge: (() => void) | null = null;

/**
 * One store bridge subscription shared by every active consumer, so each
 * automations change or context switch reloads the snapshot once rather than
 * once per mounted surface.
 */
function acquireBridge(): () => void {
  bridgeConsumers += 1;
  if (bridgeConsumers === 1) {
    releaseBridge = useAutomationsStore.getState().subscribeBridge();
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    bridgeConsumers -= 1;
    if (bridgeConsumers === 0) {
      const release = releaseBridge;
      releaseBridge = null;
      release?.();
    }
  };
}

function retryScheduledResumeAutomations(): void {
  const store = useAutomationsStore.getState();
  if ((!store.hydrated || store.error !== null) && !store.loading) {
    void store.hydrate();
  }
}

/**
 * Subscribes to the automations store while `active`, for surfaces that
 * exclude chats with a pending usage-limit resume
 * ({@link excludeScheduledResumeSessions}). Activation loads the snapshot if
 * it is missing or failed and none is in flight; the store deduplicates
 * concurrent loads. A workspace context change clears `hydrated`, so the
 * previous context's schedules never read as settled while the next loads.
 *
 * While inactive nothing is subscribed or loaded, `activities` is a stable
 * empty list, and the snapshot never reads as settled.
 */
export function useScheduledResumeAutomations(
  active: boolean,
): ScheduledResumeAutomations {
  const activities = useAutomationsStore((s) =>
    active ? s.activities : NO_ACTIVITIES,
  );
  const settled = useAutomationsStore(
    (s) => active && s.hydrated && s.error === null,
  );
  const loading = useAutomationsStore((s) => active && s.loading);
  const error = useAutomationsStore((s) => (active ? s.error : null));

  useEffect(() => {
    if (!active) return;
    const release = acquireBridge();
    retryScheduledResumeAutomations();
    return release;
  }, [active]);

  return {
    activities,
    settled,
    loading,
    error,
    retry: retryScheduledResumeAutomations,
  };
}
