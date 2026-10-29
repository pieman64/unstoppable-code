/**
 * Deduplicate concurrent invocations of an async operation. While one run is
 * in flight every caller receives that same promise; once it settles (either
 * way) the next call starts a fresh run. Use it for "ensure X exists" work
 * whose guard state only becomes observable after an await.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (): Promise<T> => {
    if (inFlight !== null) return inFlight;
    const promise = run().finally(() => {
      inFlight = null;
    });
    inFlight = promise;
    return promise;
  };
}
