/** Account changes invalidate cached quotas before old requests can finish. */
const listeners = new Set<(ready: boolean) => void>();

export function onCopilotUsageChanged(
  listener: (ready: boolean) => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function notifyCopilotUsageChanged(ready: boolean): void {
  for (const listener of Array.from(listeners)) listener(ready);
}
