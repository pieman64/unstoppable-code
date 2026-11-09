import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Whether cloud cowork chats show in the sidebar and chat view. Presentation
 * only: main refuses the web-core authority while the flag is off.
 */
export function useCanopyDesktopCloudChatsEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key),
  );
}
