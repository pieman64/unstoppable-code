/** Tracks whether this renderer has a mounted audit or usage-detail consumer. */
import { useEffect } from 'react';

export interface ObservabilityEntriesInterestRegistry {
  /** Register one consumer and return its idempotent release. */
  readonly register: () => () => void;
  /** Whether at least one consumer is currently registered. */
  readonly active: () => boolean;
  /** Subscribe to zero/nonzero consumer transitions. */
  readonly subscribe: (listener: (active: boolean) => void) => () => void;
}

export function createObservabilityEntriesInterestRegistry(): ObservabilityEntriesInterestRegistry {
  let count = 0;
  const listeners = new Set<(active: boolean) => void>();

  const notify = (active: boolean): void => {
    listeners.forEach((listener) => listener(active));
  };

  return {
    register: (): (() => void) => {
      count += 1;
      if (count === 1) notify(true);

      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        count = Math.max(0, count - 1);
        if (count === 0) notify(false);
      };
    },
    active: (): boolean => count > 0,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}

/** Shared by every audit and usage-detail consumer in this renderer. */
export const observabilityEntriesInterestRegistry: ObservabilityEntriesInterestRegistry =
  createObservabilityEntriesInterestRegistry();

/** Register an observability entries consumer until its component unmounts. */
export function useObservabilityEntriesInterest(): void {
  useEffect(() => observabilityEntriesInterestRegistry.register(), []);
}
