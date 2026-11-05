import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';

/**
 * Bounded GitHub star prompt funnel (CAN-5604). `fallback` marks a browser
 * open after an in-app star failed. Never includes the GitHub login or any
 * prompt content.
 */
export function trackGitHubStarPromptAction(
  action: 'shown' | 'starred' | 'opened' | 'dismissed',
  extra?: { fallback: boolean },
): void {
  const context = {
    action,
    entry: 'github-star-prompt',
    surface: 'chat',
    ...extra,
  };
  startClientOperation('canopy.home_onboarding_suggestions', { context });
  succeedClientOperation('canopy.home_onboarding_suggestions', { context });
}
