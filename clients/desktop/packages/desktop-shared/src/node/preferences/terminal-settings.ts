import type { PreferencesData } from '../../types';

/** The preference keys `core.terminal.settings.*` owns (CAN-4148). */
export const TERMINAL_SETTINGS_PREFERENCE_KEYS = [
  'disabledTerminalShellProfileIds',
  'terminalPresets',
] as const;

/** A stored revision, or 0 when it is missing or not a non-negative safe integer. */
export function normalizeTerminalSettingsRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** The revision `next` commits: one more than `existing`'s when shells or presets changed. */
export function nextTerminalSettingsRevision(
  existing: PreferencesData,
  next: PreferencesData,
): number {
  const changed = TERMINAL_SETTINGS_PREFERENCE_KEYS.some(
    (key) => JSON.stringify(existing[key]) !== JSON.stringify(next[key]),
  );
  return changed
    ? existing.terminalSettingsRevision + 1
    : existing.terminalSettingsRevision;
}

/**
 * Whether a generic save is the legacy terminal settings intent: exactly the
 * two settings keys, as Settings > Terminal sent them before CAN-4148.
 */
export function isLegacyTerminalSettingsSave(
  preferences: Partial<PreferencesData>,
): boolean {
  const keys = Object.keys(preferences);
  return (
    keys.length === TERMINAL_SETTINGS_PREFERENCE_KEYS.length &&
    TERMINAL_SETTINGS_PREFERENCE_KEYS.every((key) =>
      Object.prototype.hasOwnProperty.call(preferences, key),
    )
  );
}

/**
 * Removes terminal settings from a generic renderer save unless it is the
 * legacy intent, and always removes the revision. Mutates `patch`.
 */
export function applyTerminalSettingsSaveRule(
  preferences: Partial<PreferencesData>,
  patch: Partial<PreferencesData>,
): void {
  delete patch.terminalSettingsRevision;
  if (isLegacyTerminalSettingsSave(preferences)) return;
  for (const key of TERMINAL_SETTINGS_PREFERENCE_KEYS) delete patch[key];
}
