import { shouldProbeVoiceSupport } from '../voice-platform';

describe('shouldProbeVoiceSupport', () => {
  it('allows probing on macOS', () => {
    expect(shouldProbeVoiceSupport('darwin')).toBe(true);
  });

  it('skips probing on Windows so the mic button never renders', () => {
    expect(shouldProbeVoiceSupport('win32')).toBe(false);
  });

  it('skips probing on Linux', () => {
    expect(shouldProbeVoiceSupport('linux')).toBe(false);
  });

  it('skips probing when the platform is unknown', () => {
    expect(shouldProbeVoiceSupport(undefined)).toBe(false);
  });
});
