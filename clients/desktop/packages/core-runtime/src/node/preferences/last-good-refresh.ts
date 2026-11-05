import type { PreferencesDocument, PreferencesLog } from './document';

export interface LastGoodRefresher {
  /** Queues confirmed (bytes main has made durable) for the document's last-good; at most one install runs per document, always of the newest pending bytes. */
  schedule(document: PreferencesDocument, confirmed: string): void;
  /** Resolves when the document's pending refresh has landed or failed. */
  wait(document: PreferencesDocument): Promise<void>;
  /** Every refresh now running, for flush. */
  running(): Promise<void>[];
}

export function createLastGoodRefresher(
  log: PreferencesLog,
): LastGoodRefresher {
  interface LastGoodRefresh {
    /** The newest bytes main confirmed durable that are not written yet. */
    pending: string | null;
    running: Promise<void>;
  }

  /** Per primary file: at most one refresh running. */
  const lastGoodRefreshes = new Map<string, LastGoodRefresh>();

  /**
   * Refreshes last-good outside the write queue, so a save's acknowledgement
   * waits only for main. Call only with bytes main has confirmed durable, in
   * commit order: one write per file at a time, each of the newest pending
   * bytes, so an older state never lands after a newer one. Bytes, not the
   * state object: readers share that object. Best-effort: a failure is logged,
   * and a lost refresh leaves the previous confirmed copy. Never waits on the
   * queue: recovery inside it waits for this refresh.
   */
  function schedule(document: PreferencesDocument, confirmed: string): void {
    const existing = lastGoodRefreshes.get(document.key);
    if (existing) {
      existing.pending = confirmed;
      return;
    }
    const refresh: LastGoodRefresh = {
      pending: confirmed,
      running: Promise.resolve(),
    };
    lastGoodRefreshes.set(document.key, refresh);
    refresh.running = (async (): Promise<void> => {
      for (;;) {
        const next = refresh.pending;
        if (next === null) break;
        refresh.pending = null;
        try {
          await document.install('lastGood', next);
        } catch (error) {
          log.error(
            'Failed to refresh the last-good preferences backup:',
            error,
          );
        }
      }
      lastGoodRefreshes.delete(document.key);
    })();
  }

  /**
   * Readers of last-good wait for its pending refresh, so recovery in this
   * process never restores a state older than the newest one main confirmed,
   * such as rules a confirmed save revoked. A crash before the refresh lands
   * leaves the older copy behind the generation record, so recovery refuses it.
   */
  async function wait(document: PreferencesDocument): Promise<void> {
    await lastGoodRefreshes.get(document.key)?.running;
  }
  return {
    schedule,
    wait,
    running: (): Promise<void>[] =>
      Array.from(lastGoodRefreshes.values(), (refresh) => refresh.running),
  };
}
