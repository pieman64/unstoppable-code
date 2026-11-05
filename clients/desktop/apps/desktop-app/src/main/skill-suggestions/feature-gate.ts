import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { isE2eBuild } from '../lib/e2e-gate';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * The single gate every repeat-task skill suggestion entry point checks
 * (CAN-385). The LaunchDarkly flag is the master switch; the
 * `skillSuggestionsEnabled` preference only opts out on top of it.
 *
 * - {@link isSkillSuggestionsEnabled}: recording, surfacing and IPC.
 * - {@link isSkillSuggestionScanEnabled}: additionally off in E2E builds, for
 *   the scheduler, backfill and model confirmation only, so Electron flows
 *   can still seed a suggestion and see its banner.
 */
export interface SkillSuggestionGateChange {
  enabled: boolean;
  /** What flipped: a flag change keeps data, a preference-off purges it. */
  cause: 'flag' | 'preference' | 'source';
}
type GateListener = (change: SkillSuggestionGateChange) => void;

const FLAG_KEY = CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key;

// No work may start until the profile has been authoritatively read.
let preferenceEnabled = false;
let preferenceKnown = false;
let sourceAllowed = true;
let lastFlagEnabled: boolean | null = null;
const listeners = new Set<GateListener>();
let unsubscribeFlag: (() => void) | null = null;

export function isSkillSuggestionsFlagEnabled(): boolean {
  try {
    return getFeatureFlagService().isEnabled(FLAG_KEY);
  } catch (error) {
    logMainProcessWarn('[skill-suggestions] flag read failed', error);
    return false;
  }
}

export function isSkillSuggestionsPreferenceEnabled(): boolean {
  return preferenceEnabled;
}

export function isSkillSuggestionsEnabled(): boolean {
  return sourceAllowed && preferenceEnabled && isSkillSuggestionsFlagEnabled();
}

export function isSkillSuggestionScanEnabled(): boolean {
  return isSkillSuggestionsEnabled() && !isE2eBuild();
}

function emit(change: SkillSuggestionGateChange): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(change);
    } catch (error) {
      logMainProcessWarn('[skill-suggestions] gate listener failed', error);
    }
  }
}

/**
 * Records the preference, from startup and from every committed save. A
 * change is announced only when it changes the effective gate or turns the
 * preference off (which purges data even while the flag is off).
 */
export function setSkillSuggestionsPreference(enabled: boolean): void {
  if (preferenceKnown && enabled === preferenceEnabled) return;
  preferenceKnown = true;
  const before = isSkillSuggestionsEnabled();
  preferenceEnabled = enabled;
  const after = isSkillSuggestionsEnabled();
  if (!enabled || before !== after) {
    emit({ enabled: after, cause: 'preference' });
  }
}

/** Master/category eligibility pauses production without authorizing a purge. */
export function setSkillSuggestionsSourceAllowed(allowed: boolean): void {
  const before = isSkillSuggestionsEnabled();
  sourceAllowed = allowed;
  const after = isSkillSuggestionsEnabled();
  if (before !== after) emit({ enabled: after, cause: 'source' });
}

export function onSkillSuggestionsGateChanged(
  listener: GateListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Follows live flag snapshots so the kill switch needs no restart. */
export function startSkillSuggestionsGate(): () => void {
  unsubscribeFlag?.();
  lastFlagEnabled = isSkillSuggestionsFlagEnabled();
  const unsubscribe = getFeatureFlagService().onSnapshotChanged(() => {
    const flag = isSkillSuggestionsFlagEnabled();
    if (flag === lastFlagEnabled) return;
    lastFlagEnabled = flag;
    if (!preferenceEnabled) return;
    emit({ enabled: isSkillSuggestionsEnabled(), cause: 'flag' });
  });
  unsubscribeFlag = unsubscribe;
  return () => {
    unsubscribe();
    if (unsubscribeFlag === unsubscribe) unsubscribeFlag = null;
  };
}

export function resetSkillSuggestionsGateForTests(): void {
  unsubscribeFlag?.();
  unsubscribeFlag = null;
  listeners.clear();
  preferenceEnabled = false;
  preferenceKnown = false;
  sourceAllowed = true;
  lastFlagEnabled = null;
}
