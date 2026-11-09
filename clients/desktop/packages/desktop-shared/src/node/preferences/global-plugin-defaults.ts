import type { PreferencesData } from '../../types';

/** The preference key holding the global plugin defaults (CAN-5766). */
export const GLOBAL_PLUGIN_DEFAULTS_PREFERENCE_KEY = 'globalPluginSelections';

/**
 * Whether a generic save is the intent to change the global plugin defaults:
 * a patch whose only key is `globalPluginSelections`, as every writer sends it.
 */
export function isGlobalPluginDefaultsSave(
  preferences: Partial<PreferencesData>,
): boolean {
  const keys = Object.keys(preferences);
  return keys.length === 1 && keys[0] === GLOBAL_PLUGIN_DEFAULTS_PREFERENCE_KEY;
}

/**
 * Removes the global plugin defaults from a generic renderer save unless it
 * is the one-key intent: a wider patch may carry a stale copy read before the
 * core catalog or another window changed them. Mutates `patch`.
 */
export function applyGlobalPluginDefaultsSaveRule(
  preferences: Partial<PreferencesData>,
  patch: Partial<PreferencesData>,
): void {
  if (isGlobalPluginDefaultsSave(preferences)) return;
  delete patch[GLOBAL_PLUGIN_DEFAULTS_PREFERENCE_KEY];
}
