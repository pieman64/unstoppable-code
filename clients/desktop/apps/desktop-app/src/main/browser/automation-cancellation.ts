const browserAutomationControllers = new Map<string, Set<AbortController>>();
const browserAutomationCancellationTombstones = new Map<string, number>();
const CANCELLATION_TOMBSTONE_LIMIT = 256;
const CANCELLATION_TOMBSTONE_TTL_MS = 60_000;

function pruneCancellationTombstones(now: number): void {
  browserAutomationCancellationTombstones.forEach((cancelledAt, key): void => {
    if (now - cancelledAt >= CANCELLATION_TOMBSTONE_TTL_MS)
      browserAutomationCancellationTombstones.delete(key);
  });
}

function rememberCancellation(key: string): void {
  const now = Date.now();
  pruneCancellationTombstones(now);
  browserAutomationCancellationTombstones.delete(key);
  browserAutomationCancellationTombstones.set(key, now);
  while (
    browserAutomationCancellationTombstones.size > CANCELLATION_TOMBSTONE_LIMIT
  ) {
    const oldest = browserAutomationCancellationTombstones.keys().next().value;
    if (oldest === undefined) return;
    browserAutomationCancellationTombstones.delete(oldest);
  }
}

export function registerBrowserAutomationCancellation(
  key: string,
  controller: AbortController,
): () => void {
  pruneCancellationTombstones(Date.now());
  if (browserAutomationCancellationTombstones.has(key)) controller.abort();
  const controllers = browserAutomationControllers.get(key) ?? new Set();
  controllers.add(controller);
  browserAutomationControllers.set(key, controllers);
  return (): void => {
    const registered = browserAutomationControllers.get(key);
    if (!registered) return;
    registered.delete(controller);
    if (registered.size === 0) browserAutomationControllers.delete(key);
  };
}

export function cancelBrowserAutomation(key: string): boolean {
  rememberCancellation(key);
  const controllers = browserAutomationControllers.get(key);
  if (!controllers || controllers.size === 0) return false;
  browserAutomationControllers.delete(key);
  controllers.forEach((controller): void => controller.abort());
  return true;
}
