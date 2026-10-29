// Main-process mirror of the Labs service effective Early access state.
// Only the authoritative service writes it; old preferences have no effect.

let experimentalFeaturesEnabled = false;
const listeners = new Set<(enabled: boolean) => void>();

export function isExperimentalFeaturesEnabled(): boolean {
  return experimentalFeaturesEnabled;
}

export function setExperimentalFeaturesEnabled(enabled: boolean): void {
  if (enabled === experimentalFeaturesEnabled) return;
  experimentalFeaturesEnabled = enabled;
  listeners.forEach((listener) => {
    listener(enabled);
  });
}

/** Calls `listener` whenever the switch changes; returns an unsubscribe. */
export function onExperimentalFeaturesChanged(
  listener: (enabled: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
