const EVENT_NAME = 'canopy:voice-dictation-enabled-changed';

export function notifyVoiceDictationEnabledChanged(enabled: boolean): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: enabled }));
}

export function onVoiceDictationEnabledChanged(
  callback: (enabled: boolean) => void,
): () => void {
  const handler = (event: Event): void => {
    if (event instanceof CustomEvent && typeof event.detail === 'boolean') {
      callback(event.detail);
    }
  };
  window.addEventListener(EVENT_NAME, handler);
  return (): void => {
    window.removeEventListener(EVENT_NAME, handler);
  };
}
