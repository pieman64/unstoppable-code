import { W5FileWriteRefusedError } from '../commit-log-file-store';

/*
 * A18′ for decision-only hosted units (W5d1, CAN-5522). A hosted metadata
 * command's one decision is its only effect, and a stale read refuses it
 * before any decision, so the one-decision runner may admit and decide again
 * from a fresh read. A keyed run retries under its one reservation, so a
 * concurrent same-key request stays in progress between attempts and never
 * redeems a one-time selection again. Only a returned stale-file refusal is
 * retried: a revision conflict is the caller's to resolve, and a
 * recovery-required, unapplied-change or transport failure may describe a
 * decision that was made.
 */

/** Three attempts, as W6g's Electron bound. */
export const W5_DECISION_ONLY_ATTEMPTS = 3;

export type W5DecisionOnlyRetryOutcome = 'retried' | 'exhausted';

export interface W5DecisionOnlyRetry {
  run<T>(label: string, attempt: () => Promise<T>): Promise<T>;
  /** `<label> fingerprint retried|exhausted` counts, for diagnostics and tests. */
  counts(): ReadonlyMap<string, number>;
}

export function createW5DecisionOnlyRetry(
  attempts: number = W5_DECISION_ONLY_ATTEMPTS,
): W5DecisionOnlyRetry {
  const counts = new Map<string, number>();
  const count = (label: string, outcome: W5DecisionOnlyRetryOutcome): void => {
    const key = `${label} fingerprint ${outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  return {
    async run<T>(label: string, attempt: () => Promise<T>): Promise<T> {
      for (let tried = 1; ; tried += 1) {
        try {
          return await attempt();
        } catch (error) {
          if (!(error instanceof W5FileWriteRefusedError)) throw error;
          if (tried >= attempts) {
            count(label, 'exhausted');
            throw error;
          }
          count(label, 'retried');
        }
      }
    },
    counts: () => new Map(counts),
  };
}
