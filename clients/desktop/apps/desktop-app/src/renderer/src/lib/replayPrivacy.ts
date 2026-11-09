import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { Toast, ToastCategory } from '@/stores/toastStore';

/**
 * Session-replay class for a toast or notification message. Chat messages
 * quote the agent's reply, and hook and error messages can quote command
 * output, so those are blocked, as is a message whose toast opts in with
 * `blockMessageFromReplay` because it names a person. Other messages carry
 * app copy, names, and paths, and are recorded.
 */
export function toastMessageReplayClass(
  type: Toast['type'],
  category?: ToastCategory,
  blockMessageFromReplay = false,
): string {
  return blockMessageFromReplay ||
    type === 'error' ||
    category === 'Chat' ||
    category === 'Hook'
    ? POSTHOG_REPLAY_BLOCK_CLASS
    : '';
}
