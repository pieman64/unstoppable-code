import type {
  PreferencesData,
  TerminalPreset,
  TerminalShellProfile,
  TerminalShellProfileId,
} from '@canopy/desktop-shared/types';

/**
 * Renderer-side cache for the terminal shell profiles shown in the add-panel
 * menu.
 *
 * The menu is created fresh on every open, so fetching profiles from its own
 * effect meant the first paint listed only the synthesized "Terminal" row and
 * the real profiles ("Terminal (bash)", …) appeared a moment later, shifting
 * every row beneath them while the user was already reading — and moving the
 * row under the cursor. Profiles are process-stable, so they are fetched once
 * and reused: a warm cache lets the menu render its full list on the FIRST
 * paint.
 */

let cached: TerminalShellProfile[] | null = null;
let inFlight: Promise<TerminalShellProfile[]> | null = null;
let cachedPanelPreferences: TerminalPanelPreferences | null = null;
let panelPreferencesInFlight: Promise<TerminalPanelPreferences> | null = null;

export interface TerminalPanelPreferences {
  disabledTerminalShellProfileIds: TerminalShellProfileId[];
  terminalPresets: TerminalPreset[];
}

const DEFAULT_PANEL_PREFERENCES: TerminalPanelPreferences = {
  disabledTerminalShellProfileIds: [],
  terminalPresets: [],
};

function terminalPanelPreferencesFrom(
  preferences: Pick<
    PreferencesData,
    'disabledTerminalShellProfileIds' | 'terminalPresets'
  >,
): TerminalPanelPreferences {
  return {
    disabledTerminalShellProfileIds: [
      ...preferences.disabledTerminalShellProfileIds,
    ],
    terminalPresets: preferences.terminalPresets.map((preset) => ({
      ...preset,
      ...(preset.icon ? { icon: { ...preset.icon } } : {}),
    })),
  };
}

/** Profiles if already resolved, else `null` — safe for render-time reads. */
export function getCachedTerminalShellProfiles():
  | TerminalShellProfile[]
  | null {
  return cached;
}

/**
 * Resolve the profiles, reusing the cached value or an in-flight request.
 * Failures resolve to an empty list and are NOT cached, so a later open can
 * retry rather than being stuck with nothing.
 */
export function loadTerminalShellProfiles(): Promise<TerminalShellProfile[]> {
  if (cached !== null) return Promise.resolve(cached);
  if (inFlight !== null) return inFlight;

  const terminalApi = window.api?.terminal;
  if (!terminalApi) return Promise.resolve([]);

  inFlight = terminalApi
    .listProfiles()
    .then((profiles) => {
      cached = profiles;
      return profiles;
    })
    .catch(() => [])
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Warm the cache ahead of the first menu open. Fire-and-forget: callers do
 * not await it, and a failure just leaves the cache cold.
 */
export function prefetchTerminalShellProfiles(): void {
  void loadTerminalShellProfiles();
  void loadTerminalPanelPreferences();
}

export function getCachedTerminalPanelPreferences(): TerminalPanelPreferences | null {
  return cachedPanelPreferences;
}

export function setCachedTerminalPanelPreferences(
  preferences: TerminalPanelPreferences,
): void {
  cachedPanelPreferences = terminalPanelPreferencesFrom(preferences);
}

export function loadTerminalPanelPreferences(): Promise<TerminalPanelPreferences> {
  if (cachedPanelPreferences !== null) {
    return Promise.resolve(cachedPanelPreferences);
  }
  if (panelPreferencesInFlight !== null) return panelPreferencesInFlight;
  if (!window.api?.loadPreferences) {
    return Promise.resolve(DEFAULT_PANEL_PREFERENCES);
  }

  panelPreferencesInFlight = window.api
    .loadPreferences()
    .then((preferences) => {
      cachedPanelPreferences = terminalPanelPreferencesFrom(preferences);
      return cachedPanelPreferences;
    })
    .catch(() => DEFAULT_PANEL_PREFERENCES)
    .finally(() => {
      panelPreferencesInFlight = null;
    });
  return panelPreferencesInFlight;
}

/** Test seam — drops the cache so each case starts cold. */
export function __resetTerminalShellProfilesForTests(): void {
  cached = null;
  inFlight = null;
  cachedPanelPreferences = null;
  panelPreferencesInFlight = null;
}
