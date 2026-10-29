import { createContext } from 'react';
import type { ReplaySurfacePrivacy } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';

/**
 * The session-replay classification of the Settings section on screen
 * (`SETTINGS_SECTION_REPLAY_PRIVACY`). `SettingsOverlay` provides it, keyed to
 * the section actually displayed, and every section's `SettingsPage` puts the
 * matching class on its own root, an element that mounts with the section's
 * content. A page rendered without a provider is blocked, so a missing
 * provider fails closed.
 */
export const SettingsReplayPrivacyContext =
  createContext<ReplaySurfacePrivacy>('blocked');
