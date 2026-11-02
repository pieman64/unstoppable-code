// Renderer-only privacy formatting stays at the presentation boundary.
export * from '@canopy/desktop-shared/lib/watcher-display';
import type { AppAdvisorWatcherTarget } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

export function watcherTitleReplayClass(
  target: AppAdvisorWatcherTarget,
): string {
  return target.kind === 'command_watch' ? POSTHOG_REPLAY_BLOCK_CLASS : '';
}
