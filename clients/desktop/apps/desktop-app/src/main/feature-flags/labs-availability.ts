import { createHash } from 'node:crypto';
import type { LDContext } from 'launchdarkly-node-client-sdk';
import {
  isLabsExperimentAvailability,
  parseLabsExperimentAvailability,
  type LabsExperimentAvailability,
} from '@canopy/protocol/experiments';
import {
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagDefaultMode,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type { LabsExperiment } from '@canopy/desktop-shared/lib/labs-experiments';

// Includes every targeting attribute (organizations, teams, provider identity,
// version and OS). Object ordering cannot create aliases between contexts.
export function labsContextIdentity(context: LDContext): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, field]) => [key, stable(field)]),
      );
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(context)))
    .digest('hex');
}
export interface LabsAvailabilityState {
  snapshot: FeatureFlagSnapshot;
  contextIdentity: string | null;
  liveValues: Readonly<Record<string, unknown>>;
}
/** Pure per-experiment override; undefined retains the registered flag default. */
export type LabsAvailabilityFallbackPolicy = (
  entry: LabsExperiment,
  mode: FeatureFlagDefaultMode,
) => LabsExperimentAvailability | undefined;
export function resolveLabsAvailability(
  entry: LabsExperiment,
  state: LabsAvailabilityState,
  cached: Readonly<Record<string, LabsExperimentAvailability>>,
  fallbackPolicy?: LabsAvailabilityFallbackPolicy,
): LabsExperimentAvailability {
  if (entry.fixtureAvailability !== undefined) return entry.fixtureAvailability;
  if (state.snapshot.status === 'not_configured')
    return resolveFallback(entry, 'launchdarkly_disabled', fallbackPolicy);
  const live = state.liveValues[entry.flagKey];
  if (isLabsExperimentAvailability(live)) return live;
  const cachedValue = cached[entry.flagKey];
  if (isLabsExperimentAvailability(cachedValue)) return cachedValue;
  return resolveFallback(
    entry,
    'launchdarkly_enabled_unavailable',
    fallbackPolicy,
  );
}

function resolveFallback(
  entry: LabsExperiment,
  mode: FeatureFlagDefaultMode,
  policy: LabsAvailabilityFallbackPolicy | undefined,
): LabsExperimentAvailability {
  const flag = Object.values(CLIENT_FEATURE_FLAGS).find(
    (flag) => flag.key === entry.flagKey,
  );
  const registered = parseLabsExperimentAvailability(
    mode === 'launchdarkly_disabled'
      ? flag?.launchDarklyDisabledDefaultValue
      : flag?.launchDarklyEnabledUnavailableValue,
    mode === 'launchdarkly_disabled' ? 'on' : 'offered',
  );
  return parseLabsExperimentAvailability(policy?.(entry, mode), registered);
}
