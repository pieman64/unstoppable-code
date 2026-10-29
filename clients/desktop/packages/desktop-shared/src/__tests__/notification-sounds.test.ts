import {
  OS_NOTIFICATION_CATEGORY_SOUNDS,
  OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
} from '../types';
import {
  osNotificationSoundsForPlatform,
  resolveOsNotificationSoundForPlatform,
  windowsToastSoundEvent,
} from '../notification-sounds';

const MACOS_SOUNDS = [
  'Basso',
  'Blow',
  'Bottle',
  'Frog',
  'Funk',
  'Glass',
  'Hero',
  'Morse',
  'Ping',
  'Pop',
  'Purr',
  'Sosumi',
  'Submarine',
  'Tink',
];

describe('osNotificationSoundsForPlatform', () => {
  it('keeps the macOS list unchanged on darwin', () => {
    expect(osNotificationSoundsForPlatform('darwin')).toEqual([
      'System',
      'None',
      ...MACOS_SOUNDS,
    ]);
  });

  it('offers only Windows sounds, System and None on win32', () => {
    const sounds = osNotificationSoundsForPlatform('win32');
    expect(sounds).toEqual([
      'System',
      'None',
      'Mail',
      'Message',
      'Reminder',
      'SMS',
    ]);
    for (const name of MACOS_SOUNDS) {
      expect(sounds).not.toContain(name);
    }
  });

  it('keeps the macOS list on every platform other than Windows', () => {
    expect(osNotificationSoundsForPlatform('linux')).toEqual([
      'System',
      'None',
      ...MACOS_SOUNDS,
    ]);
  });

  it('only lists values the preference store accepts', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      for (const sound of osNotificationSoundsForPlatform(platform)) {
        expect(OS_NOTIFICATION_TOP_LEVEL_SOUNDS).toContain(sound);
        expect(OS_NOTIFICATION_CATEGORY_SOUNDS).toContain(sound);
      }
    }
  });
});

describe('resolveOsNotificationSoundForPlatform', () => {
  it('returns a sound that is available on the platform as is', () => {
    expect(resolveOsNotificationSoundForPlatform('Glass', 'darwin')).toBe(
      'Glass',
    );
    const [, , firstWindows] = osNotificationSoundsForPlatform('win32');
    expect(resolveOsNotificationSoundForPlatform(firstWindows, 'win32')).toBe(
      firstWindows,
    );
  });

  it('falls back to System for a macOS name saved on Windows', () => {
    expect(resolveOsNotificationSoundForPlatform('Bottle', 'win32')).toBe(
      'System',
    );
  });

  it('falls back to System for a Windows name saved on macOS', () => {
    const [, , firstWindows] = osNotificationSoundsForPlatform('win32');
    expect(resolveOsNotificationSoundForPlatform(firstWindows, 'darwin')).toBe(
      'System',
    );
  });

  it('never rewrites System, None or the category Default', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(resolveOsNotificationSoundForPlatform('System', platform)).toBe(
        'System',
      );
      expect(resolveOsNotificationSoundForPlatform('None', platform)).toBe(
        'None',
      );
      expect(resolveOsNotificationSoundForPlatform('Default', platform)).toBe(
        'Default',
      );
    }
  });

  it('keeps a macOS name on Linux and when the platform is unknown', () => {
    expect(resolveOsNotificationSoundForPlatform('Glass', 'linux')).toBe(
      'Glass',
    );
    expect(resolveOsNotificationSoundForPlatform('Glass', undefined)).toBe(
      'Glass',
    );
  });
});

describe('windowsToastSoundEvent', () => {
  it('maps every Windows sound to its own ms-winsoundevent', () => {
    const windowsSounds = osNotificationSoundsForPlatform('win32').slice(2);
    const events = windowsSounds.map((sound) => windowsToastSoundEvent(sound));
    for (const event of events) {
      expect(event).toMatch(/^Notification\.[A-Za-z]+$/);
    }
    expect(new Set(events).size).toBe(events.length);
  });

  it('maps the named notification sounds to the documented events', () => {
    expect(windowsToastSoundEvent('Mail')).toBe('Notification.Mail');
    expect(windowsToastSoundEvent('Message')).toBe('Notification.IM');
    expect(windowsToastSoundEvent('Reminder')).toBe('Notification.Reminder');
    expect(windowsToastSoundEvent('SMS')).toBe('Notification.SMS');
  });

  it('returns null for a macOS sound', () => {
    expect(windowsToastSoundEvent('Glass')).toBeNull();
  });
});
