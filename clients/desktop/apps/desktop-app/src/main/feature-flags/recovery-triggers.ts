import type { FeatureFlagRetryTrigger } from './service';

interface TriggerEventSource {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

export interface FeatureFlagRecoveryEventSources {
  /** Electron `app`: `browser-window-focus`. */
  app: TriggerEventSource;
  /** Electron `powerMonitor`: `resume` and `unlock-screen`. */
  powerMonitor: TriggerEventSource;
}

/**
 * Signals that the network is likely back after a failed LaunchDarkly start
 * (CAN-3511). The service ignores them unless a retry is pending and throttles
 * them, so they only shorten the backoff wait. The renderer's `online` event
 * reaches the service separately, through the feature-flag context refresh.
 */
export function installFeatureFlagRecoveryTriggers(
  service: { requestRetry(trigger: FeatureFlagRetryTrigger): void },
  sources: FeatureFlagRecoveryEventSources,
): () => void {
  const onWindowFocus = (): void => {
    service.requestRetry('window_focus');
  };
  const onPowerResume = (): void => {
    service.requestRetry('power_resume');
  };
  sources.app.on('browser-window-focus', onWindowFocus);
  sources.powerMonitor.on('resume', onPowerResume);
  sources.powerMonitor.on('unlock-screen', onPowerResume);
  return (): void => {
    sources.app.removeListener('browser-window-focus', onWindowFocus);
    sources.powerMonitor.removeListener('resume', onPowerResume);
    sources.powerMonitor.removeListener('unlock-screen', onPowerResume);
  };
}
