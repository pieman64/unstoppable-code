import {
  claudeNativeMemoryOptions,
  codexNativeMemoryThreadConfig,
  harnessNativeMemoryAllowed,
  localMemoryEnabledFromEnv,
  nativeMemorySettingsOverride,
} from '../native-memory';

describe('native-memory suppression (CAN-1969)', () => {
  describe('local memory disabled (opt-in default)', () => {
    it('leaves harness-native memory on provider defaults', () => {
      expect(nativeMemorySettingsOverride(false, {})).toEqual({});
      expect(claudeNativeMemoryOptions(false, undefined, {})).toEqual({});
      expect(codexNativeMemoryThreadConfig(false, {})).toEqual({});
    });

    it('passes base settings through without a suppression key', () => {
      expect(claudeNativeMemoryOptions(false, { ultracode: true }, {})).toEqual(
        { settings: { ultracode: true } },
      );
    });

    it('stays on provider defaults regardless of the escape hatch', () => {
      const env = { CANOPY_HARNESS_NATIVE_MEMORY: '1' };
      expect(nativeMemorySettingsOverride(false, env)).toEqual({});
      expect(claudeNativeMemoryOptions(false, undefined, env)).toEqual({});
      expect(codexNativeMemoryThreadConfig(false, env)).toEqual({});
    });
  });

  describe('local memory enabled', () => {
    it('suppresses harness-native memory', () => {
      expect(nativeMemorySettingsOverride(true, {})).toEqual({
        autoMemoryEnabled: false,
      });
      expect(claudeNativeMemoryOptions(true, undefined, {})).toEqual({
        settings: { autoMemoryEnabled: false },
      });
      expect(codexNativeMemoryThreadConfig(true, {})).toEqual({
        'features.memories': false,
      });
    });

    it('merges thinking-derived settings with the suppression flag', () => {
      expect(claudeNativeMemoryOptions(true, { ultracode: true }, {})).toEqual({
        settings: { ultracode: true, autoMemoryEnabled: false },
      });
    });
  });

  describe('branded env escape hatch', () => {
    it('force-allows native memory for 1 and true only', () => {
      for (const value of ['1', 'true']) {
        const env = { CANOPY_HARNESS_NATIVE_MEMORY: value };
        expect(harnessNativeMemoryAllowed(env)).toBe(true);
        expect(nativeMemorySettingsOverride(true, env)).toEqual({});
        expect(claudeNativeMemoryOptions(true, undefined, env)).toEqual({});
        expect(codexNativeMemoryThreadConfig(true, env)).toEqual({});
      }
      for (const value of ['0', 'false', 'yes', '']) {
        const env = { CANOPY_HARNESS_NATIVE_MEMORY: value };
        expect(harnessNativeMemoryAllowed(env)).toBe(false);
        expect(nativeMemorySettingsOverride(true, env)).toEqual({
          autoMemoryEnabled: false,
        });
        expect(codexNativeMemoryThreadConfig(true, env)).toEqual({
          'features.memories': false,
        });
      }
    });

    it('passes base settings through unchanged when force-allowed', () => {
      expect(
        claudeNativeMemoryOptions(
          true,
          { ultracode: true },
          { CANOPY_HARNESS_NATIVE_MEMORY: '1' },
        ),
      ).toEqual({ settings: { ultracode: true } });
    });
  });

  describe('localMemoryEnabledFromEnv', () => {
    it('is off when the branded preference env var is absent', () => {
      expect(localMemoryEnabledFromEnv({})).toBe(false);
    });

    it('is on only for 1 and true', () => {
      for (const value of ['1', 'true']) {
        expect(
          localMemoryEnabledFromEnv({
            CANOPY_PREF_LOCAL_MEMORY_ENABLED: value,
          }),
        ).toBe(true);
      }
      for (const value of ['0', 'false', 'yes', '']) {
        expect(
          localMemoryEnabledFromEnv({
            CANOPY_PREF_LOCAL_MEMORY_ENABLED: value,
          }),
        ).toBe(false);
      }
    });
  });
});
