const INVALIDATION_DELAY_MS = 50;

const staleListeners = new Set<() => void>();
let staleTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleDesktopSessionSnapshotInvalidation(): void {
  if (staleTimer !== null) {
    return;
  }
  staleTimer = setTimeout((): void => {
    staleTimer = null;
    staleListeners.forEach((listener): void => {
      listener();
    });
  }, INVALIDATION_DELAY_MS);
}

export function subscribeDesktopSessionSnapshotInvalidation(
  listener: () => void,
): () => void {
  staleListeners.add(listener);
  return (): void => {
    staleListeners.delete(listener);
  };
}

export function cancelDesktopSessionSnapshotInvalidation(): void {
  if (staleTimer !== null) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  staleListeners.clear();
}
