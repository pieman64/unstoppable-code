/**
 * Code vs Work navigation mode (CAN-1817).
 *
 * The saved mode decides how much repository detail project and task setup
 * shows and, later, how the assistant explains its work (CAN-999). It is a
 * global user preference (`PreferencesData.navigationMode`), seeded from the
 * onboarding role and overridable in Settings → General. Internal data
 * models never change with the mode; only presentation does.
 */
export const NAVIGATION_MODES = ['code', 'work'] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

export function isNavigationMode(value: unknown): value is NavigationMode {
  return value === 'code' || value === 'work';
}
