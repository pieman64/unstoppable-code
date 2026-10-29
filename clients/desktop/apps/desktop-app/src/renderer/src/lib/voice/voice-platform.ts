import { isVoiceDictationPlatform } from '@canopy/desktop-shared/platform-capabilities';

/**
 * Whether the current renderer host should attempt to probe voice support.
 *
 * Voice dictation is only available on macOS today; on Windows and Linux the
 * preload bridge returns unsupported responses, but we skip the IPC call
 * entirely so the renderer never displays a microphone affordance.
 *
 * Callers pass `localPlatform()`: dictation runs on this computer, also in a
 * window that shows another one.
 */
export function shouldProbeVoiceSupport(
  platform: NodeJS.Platform | undefined,
): boolean {
  if (platform === undefined) {
    return false;
  }
  return isVoiceDictationPlatform(platform);
}
