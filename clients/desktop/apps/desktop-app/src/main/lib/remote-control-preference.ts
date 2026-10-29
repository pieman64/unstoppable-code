// Main-process mirror of `PreferencesData.remoteControlEnabled`, the
// Settings → Labs → Remote access switch. Remote control availability
// is read synchronously, so startup seeds this value and every preferences
// save refreshes it. Defaults to off until the saved value is read.

let remoteControlEnabled = false;
const listeners = new Set<(enabled: boolean) => void>();

export function isRemoteControlEnabled(): boolean {
  return remoteControlEnabled;
}

export function setRemoteControlEnabled(enabled: boolean): void {
  if (enabled === remoteControlEnabled) return;
  remoteControlEnabled = enabled;
  listeners.forEach((listener) => {
    listener(enabled);
  });
}

/** Calls `listener` whenever the switch changes; returns an unsubscribe. */
export function onRemoteControlEnabledChanged(
  listener: (enabled: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
