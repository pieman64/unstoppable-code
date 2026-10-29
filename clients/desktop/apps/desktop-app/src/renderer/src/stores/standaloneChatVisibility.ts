let archiveOverlayOpen = false;
const listeners = new Set<() => void>();

export function isStandaloneChatArchiveOverlayOpen(): boolean {
  return archiveOverlayOpen;
}

export function setStandaloneChatArchiveOverlayOpen(open: boolean): void {
  if (archiveOverlayOpen === open) return;
  archiveOverlayOpen = open;
  listeners.forEach((listener) => listener());
}

export function subscribeStandaloneChatArchiveOverlay(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
