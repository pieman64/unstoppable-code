import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useEffect, useState } from 'react';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';

/**
 * The last answer any mount read. A picker mounted later starts from it, so a
 * connected user does not see "Connect OpenCode" while the new read is pending.
 */
let lastKnownAvailable = false;

export function useOpenCodeChatAvailable(enabled: boolean): boolean {
  const opencodeHarnessEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  const [available, setAvailable] = useState(lastKnownAvailable);
  useEffect(() => {
    if (!enabled || !opencodeHarnessEnabled) return;
    let mounted = true;
    let revision = 0;
    const refresh = (): void => {
      const current = ++revision;
      // Read the preference first: most users never enable OpenCode, and the
      // runtime status probe touches the filesystem on the main thread.
      void window.api
        .loadPreferences()
        .then((preferences) =>
          preferences.opencodeEnabled
            ? window.api.opencodeConnection?.status()
            : undefined,
        )
        .then((managed) => {
          const next = Boolean(
            managed?.supported && managed.enabled && managed.installed,
          );
          if (current !== revision) return;
          lastKnownAvailable = next;
          if (mounted) setAvailable(next);
        })
        .catch(() => {
          if (current !== revision) return;
          lastKnownAvailable = false;
          if (mounted) setAvailable(false);
        });
    };
    refresh();
    const offLocal = subscribePreferencesUpdated(refresh);
    const offHost = window.api.onPreferencesChanged(refresh);
    return (): void => {
      mounted = false;
      offLocal();
      offHost();
    };
  }, [enabled, opencodeHarnessEnabled]);
  return enabled && opencodeHarnessEnabled && available;
}
