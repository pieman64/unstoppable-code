import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';

const DEFAULT_WORKER_CONCURRENCY_LIMIT = 5;

type ClaudeWorkerModePreferences = Pick<
  PreferencesData,
  'canopyBackgroundProcessesMode' | 'pipelinesMode'
>;
type EffectiveClaudeWorkerModePreferences<
  T extends ClaudeWorkerModePreferences,
> = Omit<T, keyof ClaudeWorkerModePreferences> & ClaudeWorkerModePreferences;

export function isClaudeTuiWorkersEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
  );
}

export function getEffectiveClaudeWorkerModePreferences<
  T extends ClaudeWorkerModePreferences,
>(preferences: T): EffectiveClaudeWorkerModePreferences<T> {
  if (isClaudeTuiWorkersEnabled()) {
    return preferences;
  }
  return {
    ...preferences,
    canopyBackgroundProcessesMode: 'canopy',
    pipelinesMode: 'canopy',
  };
}

export function getEffectiveClaudeWorkerConcurrencyLimit(
  preferences: Pick<PreferencesData, 'workerConcurrencyLimit'> | null,
): number {
  if (!isClaudeTuiWorkersEnabled()) {
    return 0;
  }
  return (
    preferences?.workerConcurrencyLimit ?? DEFAULT_WORKER_CONCURRENCY_LIMIT
  );
}
