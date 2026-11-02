import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';

/** Bounded lesson funnel; never includes prompt or account content. */
export function trackPlanModeHintAction(
  action: 'shown' | 'accepted' | 'dismissed',
  surface: 'home' | 'chat',
): void {
  const context = { action, entry: 'plan-mode-hint', surface };
  startClientOperation('canopy.home_onboarding_suggestions', { context });
  succeedClientOperation('canopy.home_onboarding_suggestions', { context });
}
