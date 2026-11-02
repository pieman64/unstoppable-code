import {
  UNSUPPORTED_VOICE_DICTATION_MESSAGE,
  UNSUPPORTED_VOICE_DICTATION_RESPONSE,
  isCliPathManagementPlatform,
  isVoiceDictationPlatform,
  isWakeLockSupportedPlatform,
  usesNativeWindowFrame,
} from '../platform-capabilities';

describe('isVoiceDictationPlatform', () => {
  it('exposes a shared unsupported response', () => {
    expect(UNSUPPORTED_VOICE_DICTATION_RESPONSE).toEqual({
      supported: false,
      reason: UNSUPPORTED_VOICE_DICTATION_MESSAGE,
    });
  });

  it('returns true on darwin', () => {
    expect(isVoiceDictationPlatform('darwin')).toBe(true);
  });

  it('returns false on win32', () => {
    expect(isVoiceDictationPlatform('win32')).toBe(false);
  });

  it('returns false on linux', () => {
    expect(isVoiceDictationPlatform('linux')).toBe(false);
  });
});

describe('isCliPathManagementPlatform', () => {
  it('returns true on darwin', () => {
    expect(isCliPathManagementPlatform('darwin')).toBe(true);
  });

  it('returns true on win32', () => {
    expect(isCliPathManagementPlatform('win32')).toBe(true);
  });

  it('supports the per-user Linux launcher', () => {
    expect(isCliPathManagementPlatform('linux')).toBe(true);
  });
});

describe('isWakeLockSupportedPlatform', () => {
  it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])(
    'supports %s',
    (platform) => {
      expect(isWakeLockSupportedPlatform(platform)).toBe(true);
    },
  );

  it('does not claim support for other platforms', () => {
    expect(isWakeLockSupportedPlatform('freebsd')).toBe(false);
  });
});

describe('usesNativeWindowFrame', () => {
  it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])(
    'selects native chrome only on Linux (%s)',
    (platform) => {
      expect(usesNativeWindowFrame(platform)).toBe(platform === 'linux');
    },
  );
});
