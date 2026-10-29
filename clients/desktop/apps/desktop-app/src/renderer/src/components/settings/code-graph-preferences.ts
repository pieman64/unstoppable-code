import type {
  CodeGraphPreferenceMode,
  CodeGraphPreferences,
} from '@canopy/desktop-shared/types';

/**
 * Renderer-side defaults + normalization for the Code Graph feature
 * preferences surfaced on Settings → Labs.
 *
 * The main-process preferences store owns the authoritative default and
 * load-time normalization (see {@link CodeGraphPreferences}). This module
 * mirrors that contract on the renderer so the Experiments UI always has a
 * complete, in-range value to render even when `PreferencesData.codeGraph` is
 * absent (migrated/older preferences) or the backend handlers are not yet
 * live — and so every `savePreferences({ codeGraph })` patch carries a
 * *complete* object, honoring the cross-boundary save invariant.
 */

export const MIN_GENERATION_TIMEOUT_MINUTES = 1;
export const MAX_GENERATION_TIMEOUT_MINUTES = 1440;
export const DEFAULT_GENERATION_TIMEOUT_MINUTES = 30;

const CODE_GRAPH_PREFERENCE_MODES: readonly CodeGraphPreferenceMode[] = [
  'enabled',
  'disabled',
  'selected-workspaces',
];

export const DEFAULT_CODE_GRAPH_PREFERENCES: CodeGraphPreferences = {
  mode: 'enabled',
  selectedWorkspaceIds: [],
  generationTimeoutMinutes: DEFAULT_GENERATION_TIMEOUT_MINUTES,
};

/**
 * Returns `true` when `value` is a whole number within the inclusive
 * `1`–`1440` generation-timeout range.
 */
export function isValidGenerationTimeoutMinutes(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_GENERATION_TIMEOUT_MINUTES &&
    value <= MAX_GENERATION_TIMEOUT_MINUTES
  );
}

/**
 * Coerce a possibly-absent/partial `codeGraph` preference into a complete,
 * in-range {@link CodeGraphPreferences}. Mirrors the backend normalization so
 * the renderer never renders (or saves) an out-of-range timeout, an unknown
 * mode, or a non-array selection.
 */
export function normalizeCodeGraphPreferences(
  value: CodeGraphPreferences | undefined | null,
): CodeGraphPreferences {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_CODE_GRAPH_PREFERENCES };
  }

  const mode = CODE_GRAPH_PREFERENCE_MODES.includes(value.mode)
    ? value.mode
    : DEFAULT_CODE_GRAPH_PREFERENCES.mode;

  const selectedWorkspaceIds = Array.isArray(value.selectedWorkspaceIds)
    ? value.selectedWorkspaceIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : [];

  const rawTimeout = value.generationTimeoutMinutes;
  const generationTimeoutMinutes = isValidGenerationTimeoutMinutes(rawTimeout)
    ? rawTimeout
    : DEFAULT_GENERATION_TIMEOUT_MINUTES;

  return { mode, selectedWorkspaceIds, generationTimeoutMinutes };
}
