import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { getLabsFeatureEnabled } from '@/stores/labsExperimentsStore';

/**
 * The App Advisor home surface never had a per-worktree layout mode (main
 * skips seeding it), so it keeps its own behavior under early access too.
 */
const APP_ADVISOR_HOME_KEY = `${APP_ADVISOR_PROJECT_ID}/${APP_ADVISOR_WORKTREE_ID}`;

/**
 * Whether the early-access take on Minimal applies to layouts this worktree
 * builds from now on: a Side Panel that starts empty instead of seeded with
 * Activity and File explorer, and optional regions that start hidden. It
 * shapes new layouts and conversions the user starts; it never re-shapes a
 * layout the user already has.
 */
export function earlyAccessMinimalFor(worktreeKey: string): boolean {
  if (worktreeKey === APP_ADVISOR_HOME_KEY) return false;
  return getLabsFeatureEnabled('minimal-layout');
}
