import type { DetectedApp } from '@canopy/desktop-shared/types';

interface OpenInAppPreferences {
  lastOpenApp: string;
  disabledOpenApps: readonly string[];
}

/** Keep every direct "Open in" affordance aligned with the top-bar choice. */
export function selectPreferredOpenApp(
  apps: readonly DetectedApp[],
  preferences: OpenInAppPreferences,
): DetectedApp | undefined {
  const visibleApps = apps.filter(
    (app) => !preferences.disabledOpenApps.includes(app.id),
  );
  const lastApp = visibleApps.find((app) => app.id === preferences.lastOpenApp);
  return lastApp ?? visibleApps.find((app) => app.icon != null);
}
