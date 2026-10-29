/**
 * Pure helpers for the OS notification sound choices that a platform offers.
 *
 * The sound a notification plays is decided by the OS, and the two desktop
 * platforms expose different sets: macOS names a file under
 * `/System/Library/Sounds/`, Windows names a toast sound event. Platforms
 * other than Windows keep the macOS list. A saved
 * preference can hold either (a profile moved between machines, or a build
 * that offered the wrong list), so callers resolve it against the platform
 * that is actually running.
 *
 * Each helper takes a `NodeJS.Platform` so the renderer (`window.platform`)
 * and main (`process.platform`) share one answer. This module MUST stay
 * browser-safe: no Node-only imports and no reference to `process`.
 */

import {
  OS_NOTIFICATION_MACOS_SOUNDS,
  OS_NOTIFICATION_WINDOWS_SOUNDS,
  type OsNotificationCategorySound,
  type OsNotificationNamedSound,
  type OsNotificationTopLevelSound,
} from './types';

/**
 * The Windows toast sound event behind each Windows sound choice. Toast XML
 * selects it as `<audio src="ms-winsoundevent:<event>"/>`.
 */
const WINDOWS_TOAST_SOUND_EVENTS: Record<
  (typeof OS_NOTIFICATION_WINDOWS_SOUNDS)[number],
  string
> = {
  Mail: 'Notification.Mail',
  Message: 'Notification.IM',
  Reminder: 'Notification.Reminder',
  SMS: 'Notification.SMS',
};

function isWindowsSound(
  sound: string,
): sound is (typeof OS_NOTIFICATION_WINDOWS_SOUNDS)[number] {
  return OS_NOTIFICATION_WINDOWS_SOUNDS.some((name) => name === sound);
}

function platformNamedSounds(
  platform: NodeJS.Platform | undefined,
): readonly OsNotificationNamedSound[] {
  // Only Windows has its own list. Every other platform keeps the macOS list
  // it has always been offered.
  return platform === 'win32'
    ? OS_NOTIFICATION_WINDOWS_SOUNDS
    : OS_NOTIFICATION_MACOS_SOUNDS;
}

/**
 * The choices Settings offers for the default sound on `platform`: `System`
 * and `None` everywhere, plus the platform's named sounds (the Windows list
 * on Windows, the macOS list elsewhere).
 */
export function osNotificationSoundsForPlatform(
  platform: NodeJS.Platform | undefined,
): readonly OsNotificationTopLevelSound[] {
  return ['System', 'None', ...platformNamedSounds(platform)];
}

/**
 * Resolves a saved sound against what `platform` offers. A named sound the
 * platform cannot play (a macOS name on Windows, say) becomes `System`, so
 * the control shows and plays what actually happens. `System`, `None` and the
 * category `Default` pass through untouched.
 */
export function resolveOsNotificationSoundForPlatform<
  T extends OsNotificationCategorySound,
>(sound: T, platform: NodeJS.Platform | undefined): T | 'System' {
  if (sound === 'System' || sound === 'None' || sound === 'Default') {
    return sound;
  }
  return platformNamedSounds(platform).some((name) => name === sound)
    ? sound
    : 'System';
}

/**
 * The `ms-winsoundevent:` event for a Windows sound choice, or `null` for any
 * other name.
 */
export function windowsToastSoundEvent(sound: string): string | null {
  return isWindowsSound(sound) ? WINDOWS_TOAST_SOUND_EVENTS[sound] : null;
}
