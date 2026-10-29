import {
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
  MAX_SCRIPT_TIMEOUT_SECONDS,
  getScriptCommand,
  getScriptDefinition,
  getScriptDevServerPattern,
  getScriptShellDefinition,
  getScriptTimeoutSeconds,
  isScriptDefinition,
  isScriptInteractiveSupported,
  isScriptTimeoutConfigurable,
  listRunnableScripts,
  normalizeCommandShellDefinition,
  normalizeScriptDefinition,
  normalizeScriptDevServerPattern,
  normalizeScriptDevServerPatternsForRuntime,
  normalizeScriptInputMap,
  normalizeScriptTimeoutSeconds,
  resolveEffectiveScriptInteractive,
  resolveEffectiveScriptTimeoutSeconds,
} from '../scripts';
import type {
  ScriptDefinition,
  ScriptInputMap,
  ScriptOverrides,
  ScriptValue,
} from '../scripts';

describe('scripts transport contract', () => {
  describe('dev-server autoOpen', () => {
    it('keeps opt-in autoOpen through normalization and runnable descriptors', () => {
      const devServerPattern = { pattern: 'https?://\\S+', autoOpen: true };
      expect(normalizeScriptDevServerPattern(devServerPattern)).toEqual(
        devServerPattern,
      );
      const scripts = normalizeScriptInputMap({
        launch: { command: 'npm run dev', devServerPattern },
      });
      expect(listRunnableScripts(scripts)[0]?.devServerPattern).toEqual(
        devServerPattern,
      );
    });

    it.each([undefined, false, 'true', 1, null])(
      'omits default or invalid autoOpen %j',
      (autoOpen) => {
        expect(
          normalizeScriptDevServerPattern({
            pattern: 'https?://\\S+',
            autoOpen,
          }),
        ).toBe('https?://\\S+');
      },
    );
  });
  describe('constants', () => {
    it('exports the 5-minute default timeout in seconds', () => {
      expect(DEFAULT_SCRIPT_TIMEOUT_SECONDS).toBe(300);
    });

    it('exports the documented 2,000,000-second upper bound', () => {
      expect(MAX_SCRIPT_TIMEOUT_SECONDS).toBe(2_000_000);
      // Stays under Node setTimeout's silent clamp at 2 ** 31 - 1 ms even
      // after the * 1000 ms conversion.
      expect(MAX_SCRIPT_TIMEOUT_SECONDS * 1000).toBeLessThan(2 ** 31 - 1);
    });

    it('exports dev-server pattern bounds', () => {
      expect(MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH).toBe(1000);
      expect(MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH).toBe(80);
      expect(MAX_SCRIPT_DEV_SERVER_PATTERNS).toBe(8);
    });
  });

  describe('isScriptDefinition', () => {
    it('matches plain objects with a string command field', () => {
      expect(isScriptDefinition({ command: 'npm install' })).toBe(true);
      expect(
        isScriptDefinition({ command: 'npm install', timeoutSeconds: 600 }),
      ).toBe(true);
      expect(isScriptDefinition({ command: 'npm install', extra: 'ok' })).toBe(
        true,
      );
    });

    it('rejects null, primitives, arrays, and non-command objects', () => {
      expect(isScriptDefinition(null)).toBe(false);
      expect(isScriptDefinition(undefined)).toBe(false);
      expect(isScriptDefinition('npm install')).toBe(false);
      expect(isScriptDefinition(42)).toBe(false);
      expect(isScriptDefinition([])).toBe(false);
      expect(isScriptDefinition({})).toBe(false);
      expect(isScriptDefinition({ command: 42 })).toBe(false);
    });
  });

  describe('normalizeScriptTimeoutSeconds', () => {
    it('preserves null tombstones and undefined inputs', () => {
      expect(normalizeScriptTimeoutSeconds(null)).toBeNull();
      expect(normalizeScriptTimeoutSeconds(undefined)).toBeUndefined();
    });

    it('accepts positive integers within the documented range', () => {
      expect(normalizeScriptTimeoutSeconds(1)).toBe(1);
      expect(normalizeScriptTimeoutSeconds(600)).toBe(600);
      expect(normalizeScriptTimeoutSeconds(MAX_SCRIPT_TIMEOUT_SECONDS)).toBe(
        MAX_SCRIPT_TIMEOUT_SECONDS,
      );
    });

    it('drops zero, negative, non-integer, and out-of-range values', () => {
      expect(normalizeScriptTimeoutSeconds(0)).toBeUndefined();
      expect(normalizeScriptTimeoutSeconds(-1)).toBeUndefined();
      expect(normalizeScriptTimeoutSeconds(1.5)).toBeUndefined();
      expect(
        normalizeScriptTimeoutSeconds(MAX_SCRIPT_TIMEOUT_SECONDS + 1),
      ).toBeUndefined();
      expect(normalizeScriptTimeoutSeconds(Number.NaN)).toBeUndefined();
      expect(
        normalizeScriptTimeoutSeconds(Number.POSITIVE_INFINITY),
      ).toBeUndefined();
    });

    it('drops non-number inputs', () => {
      expect(normalizeScriptTimeoutSeconds('600')).toBeUndefined();
      expect(normalizeScriptTimeoutSeconds({})).toBeUndefined();
      expect(normalizeScriptTimeoutSeconds([])).toBeUndefined();
      expect(normalizeScriptTimeoutSeconds(true)).toBeUndefined();
    });
  });

  describe('normalizeScriptDefinition', () => {
    it('preserves interactive script metadata only when explicitly enabled', () => {
      expect(
        normalizeScriptDefinition({
          command: 'npm run wizard',
          interactive: true,
        }),
      ).toEqual({ command: 'npm run wizard', interactive: true });
      expect(
        normalizeScriptDefinition({
          command: 'npm test',
          interactive: false,
        }),
      ).toEqual({ command: 'npm test' });
    });

    it('passes through null and undefined inputs', () => {
      expect(normalizeScriptDefinition(null)).toBeNull();
      expect(normalizeScriptDefinition(undefined)).toBeUndefined();
    });

    it('normalizes plain string commands by trimming', () => {
      expect(normalizeScriptDefinition('  npm install  ')).toEqual({
        command: 'npm install',
      });
    });

    it('drops empty and whitespace-only string commands', () => {
      expect(normalizeScriptDefinition('')).toBeUndefined();
      expect(normalizeScriptDefinition('   ')).toBeUndefined();
    });

    it('preserves valid timeoutSeconds on object values', () => {
      expect(
        normalizeScriptDefinition({
          command: ' npm test ',
          timeoutSeconds: 900,
        }),
      ).toEqual({ command: 'npm test', timeoutSeconds: 900 });
      expect(
        normalizeScriptDefinition({
          command: 'npm start',
          timeoutSeconds: null,
        }),
      ).toEqual({ command: 'npm start', timeoutSeconds: null });
    });

    it('omits timeoutSeconds when undefined and drops out-of-range values', () => {
      expect(normalizeScriptDefinition({ command: 'npm test' })).toEqual({
        command: 'npm test',
      });
      expect(
        normalizeScriptDefinition({
          command: 'npm test',
          timeoutSeconds: undefined,
        }),
      ).toEqual({ command: 'npm test' });
      expect(
        normalizeScriptDefinition({
          command: 'npm test',
          timeoutSeconds: 0,
        }),
      ).toEqual({ command: 'npm test' });
      expect(
        normalizeScriptDefinition({
          command: 'npm test',
          timeoutSeconds: MAX_SCRIPT_TIMEOUT_SECONDS + 1,
        }),
      ).toEqual({ command: 'npm test' });
    });

    it('drops object values with empty commands', () => {
      expect(
        normalizeScriptDefinition({ command: '   ', timeoutSeconds: 600 }),
      ).toBeUndefined();
    });

    it('preserves supported per-platform shell values', () => {
      expect(
        normalizeScriptDefinition({
          command: 'npm test',
          shell: { windows: 'bash', mac: 'zsh' },
        }),
      ).toEqual({
        command: 'npm test',
        shell: { windows: 'bash', mac: 'zsh' },
      });
    });

    it('drops invalid shell draft values leniently', () => {
      expect(
        normalizeScriptDefinition({
          command: 'npm test',
          shell: { windows: 'zsh', mac: 'fish' },
        }),
      ).toEqual({ command: 'npm test' });
    });
  });

  describe('normalizeCommandShellDefinition', () => {
    it('returns only configured supported platform values', () => {
      expect(
        normalizeCommandShellDefinition({
          windows: 'powershell',
          mac: 'bash',
        }),
      ).toEqual({ windows: 'powershell', mac: 'bash' });
      expect(normalizeCommandShellDefinition({ windows: 'cmd' })).toEqual({
        windows: 'cmd',
      });
      expect(normalizeCommandShellDefinition({ mac: 'zsh' })).toEqual({
        mac: 'zsh',
      });
    });

    it('returns undefined for empty, invalid, and non-object inputs', () => {
      expect(normalizeCommandShellDefinition({})).toBeUndefined();
      expect(
        normalizeCommandShellDefinition({ windows: 'zsh', mac: 'fish' }),
      ).toBeUndefined();
      expect(normalizeCommandShellDefinition('bash')).toBeUndefined();
      expect(normalizeCommandShellDefinition(null)).toBeUndefined();
    });
  });

  describe('normalizeScriptInputMap', () => {
    it('returns undefined for empty inputs', () => {
      expect(normalizeScriptInputMap(undefined)).toBeUndefined();
      expect(normalizeScriptInputMap({})).toBeUndefined();
    });

    it('round-trips legacy string entries as strings', () => {
      const input: ScriptInputMap = {
        setup: '  npm install  ',
        teardown: 'npm run clean',
      };
      expect(normalizeScriptInputMap(input)).toEqual({
        setup: 'npm install',
        teardown: 'npm run clean',
      });
    });

    it('persists object entries with a timeout in object form', () => {
      const input: ScriptInputMap = {
        setup: { command: 'npm install', timeoutSeconds: 1800 },
      };
      expect(normalizeScriptInputMap(input)).toEqual({
        setup: { command: 'npm install', timeoutSeconds: 1800 },
      });
    });

    it('preserves null tombstones used to disable inherited scripts', () => {
      const input: ScriptInputMap = {
        setup: null,
        teardown: 'npm run clean',
      };
      expect(normalizeScriptInputMap(input)).toEqual({
        setup: null,
        teardown: 'npm run clean',
      });
    });

    it('compacts object entries without a timeout back to a string', () => {
      const input: ScriptInputMap = {
        setup: { command: 'npm install' },
      };
      expect(normalizeScriptInputMap(input)).toEqual({
        setup: 'npm install',
      });
    });

    it('keeps object form for interactive local overrides', () => {
      const input: ScriptInputMap = {
        setup: { command: 'npm run setup-wizard', interactive: true },
      };
      expect(normalizeScriptInputMap(input)).toEqual({
        setup: { command: 'npm run setup-wizard', interactive: true },
      });
    });

    it('drops entries whose normalized command is empty', () => {
      const input: ScriptInputMap = {
        setup: '   ',
        teardown: { command: '   ', timeoutSeconds: 600 },
        launch: 'echo run',
      };
      expect(normalizeScriptInputMap(input)).toEqual({ launch: 'echo run' });
    });

    it('drops entries whose script name is empty after trimming', () => {
      const input: ScriptInputMap = {
        '   ': 'noop',
        setup: 'npm install',
      };
      expect(normalizeScriptInputMap(input)).toEqual({ setup: 'npm install' });
    });

    it('sorts entries by canonical lifecycle order', () => {
      const input: ScriptInputMap = {
        teardown: 'echo teardown',
        setup: 'echo setup',
        'before-launch': 'echo prelaunch',
        custom: 'echo custom',
      };
      expect(Object.keys(normalizeScriptInputMap(input) ?? {})).toEqual([
        'setup',
        'before-launch',
        'teardown',
        'custom',
      ]);
    });
  });

  describe('getScriptDefinition / getScriptCommand / getScriptTimeoutSeconds', () => {
    const overrides: ScriptOverrides = {
      setup: 'npm install',
      teardown: { command: 'npm run clean', timeoutSeconds: 1800 },
      launch: { command: 'npm start', timeoutSeconds: null },
      test: { command: 'npm test', shell: { windows: 'cmd', mac: 'bash' } },
      disabled: null,
    };

    it('resolves string entries as a canonical definition', () => {
      expect(getScriptDefinition(overrides, 'setup')).toEqual({
        command: 'npm install',
      });
      expect(getScriptCommand(overrides, 'setup')).toBe('npm install');
      expect(getScriptTimeoutSeconds(overrides, 'setup')).toBeUndefined();
    });

    it('resolves object entries with custom timeouts', () => {
      expect(getScriptDefinition(overrides, 'teardown')).toEqual({
        command: 'npm run clean',
        timeoutSeconds: 1800,
      });
      expect(getScriptCommand(overrides, 'teardown')).toBe('npm run clean');
      expect(getScriptTimeoutSeconds(overrides, 'teardown')).toBe(1800);
    });

    it('preserves null tombstones on timeout lookups', () => {
      expect(getScriptTimeoutSeconds(overrides, 'launch')).toBeNull();
    });

    it('returns undefined for tombstoned and missing entries', () => {
      expect(getScriptDefinition(overrides, 'disabled')).toBeUndefined();
      expect(getScriptCommand(overrides, 'disabled')).toBeUndefined();
      expect(getScriptTimeoutSeconds(overrides, 'disabled')).toBeUndefined();
      expect(getScriptDefinition(overrides, 'missing')).toBeUndefined();
      expect(getScriptCommand(undefined, 'setup')).toBeUndefined();
    });

    it('returns shell metadata for object entries', () => {
      expect(getScriptShellDefinition(overrides, 'test')).toEqual({
        windows: 'cmd',
        mac: 'bash',
      });
      expect(getScriptShellDefinition(overrides, 'setup')).toBeUndefined();
      expect(getScriptShellDefinition(overrides, 'disabled')).toBeUndefined();
    });
  });

  describe('isScriptTimeoutConfigurable', () => {
    it('returns false only for launch scripts', () => {
      expect(isScriptTimeoutConfigurable('launch')).toBe(false);
      expect(isScriptTimeoutConfigurable('setup')).toBe(true);
      expect(isScriptTimeoutConfigurable('teardown')).toBe(true);
      expect(isScriptTimeoutConfigurable('before-launch')).toBe(true);
      expect(isScriptTimeoutConfigurable('custom-script')).toBe(true);
    });
  });

  describe('isScriptInteractiveSupported', () => {
    it('returns false only for teardown lifecycle phases', () => {
      expect(isScriptInteractiveSupported('teardown')).toBe(false);
      expect(isScriptInteractiveSupported('before-teardown')).toBe(false);
      expect(isScriptInteractiveSupported('after-teardown')).toBe(false);
      expect(isScriptInteractiveSupported('setup')).toBe(true);
      expect(isScriptInteractiveSupported('before-setup')).toBe(true);
      expect(isScriptInteractiveSupported('launch')).toBe(true);
      expect(isScriptInteractiveSupported('custom-script')).toBe(true);
    });
  });

  describe('resolveEffectiveScriptInteractive', () => {
    it('forces background for teardown phases regardless of configuration', () => {
      for (const scriptName of [
        'teardown',
        'before-teardown',
        'after-teardown',
      ]) {
        expect(
          resolveEffectiveScriptInteractive({
            scriptName,
            configuredInteractive: true,
          }),
        ).toBe(false);
      }
    });

    it('honors the configured flag everywhere else', () => {
      expect(
        resolveEffectiveScriptInteractive({
          scriptName: 'wizard',
          configuredInteractive: true,
        }),
      ).toBe(true);
      expect(
        resolveEffectiveScriptInteractive({
          scriptName: 'wizard',
          configuredInteractive: undefined,
        }),
      ).toBe(false);
      expect(
        resolveEffectiveScriptInteractive({
          scriptName: 'setup',
          configuredInteractive: false,
        }),
      ).toBe(false);
    });
  });

  describe('resolveEffectiveScriptTimeoutSeconds', () => {
    it('forces null for launch regardless of configured timeout', () => {
      expect(
        resolveEffectiveScriptTimeoutSeconds({
          scriptName: 'launch',
          configuredTimeoutSeconds: 600,
          defaultTimeoutSeconds: DEFAULT_SCRIPT_TIMEOUT_SECONDS,
        }),
      ).toBeNull();
      expect(
        resolveEffectiveScriptTimeoutSeconds({
          scriptName: 'launch',
          configuredTimeoutSeconds: null,
          defaultTimeoutSeconds: DEFAULT_SCRIPT_TIMEOUT_SECONDS,
        }),
      ).toBeNull();
    });

    it('falls back to the default when no configured timeout is present', () => {
      expect(
        resolveEffectiveScriptTimeoutSeconds({
          scriptName: 'setup',
          defaultTimeoutSeconds: DEFAULT_SCRIPT_TIMEOUT_SECONDS,
        }),
      ).toBe(DEFAULT_SCRIPT_TIMEOUT_SECONDS);
      expect(
        resolveEffectiveScriptTimeoutSeconds({
          scriptName: 'setup',
          configuredTimeoutSeconds: undefined,
          defaultTimeoutSeconds: DEFAULT_SCRIPT_TIMEOUT_SECONDS,
        }),
      ).toBe(DEFAULT_SCRIPT_TIMEOUT_SECONDS);
    });

    it('returns null when the configured timeout is explicitly disabled', () => {
      expect(
        resolveEffectiveScriptTimeoutSeconds({
          scriptName: 'setup',
          configuredTimeoutSeconds: null,
          defaultTimeoutSeconds: DEFAULT_SCRIPT_TIMEOUT_SECONDS,
        }),
      ).toBeNull();
    });

    it('returns the configured timeout when supplied', () => {
      expect(
        resolveEffectiveScriptTimeoutSeconds({
          scriptName: 'setup',
          configuredTimeoutSeconds: 900,
          defaultTimeoutSeconds: DEFAULT_SCRIPT_TIMEOUT_SECONDS,
        }),
      ).toBe(900);
    });
  });

  describe('listRunnableScripts', () => {
    it('marks interactive entries for activity and runtime consumers', () => {
      expect(
        listRunnableScripts({
          setup: { command: 'npm run setup-wizard', interactive: true },
        }),
      ).toEqual([
        {
          name: 'setup',
          command: 'npm run setup-wizard',
          lifecycle: 'setup',
          interactive: true,
        },
      ]);
    });

    it('returns an empty array when no scripts are configured', () => {
      expect(listRunnableScripts(undefined)).toEqual([]);
    });

    it('exposes command metadata for each runnable entry', () => {
      const overrides: ScriptOverrides = {
        setup: 'npm install',
        teardown: { command: 'npm run clean', timeoutSeconds: 1800 },
        launch: {
          command: 'npm start',
          timeoutSeconds: null,
          shell: { windows: 'powershell', mac: 'zsh' },
        },
        custom: { command: 'echo hi' },
      };
      expect(listRunnableScripts(overrides)).toEqual([
        { name: 'setup', command: 'npm install', lifecycle: 'setup' },
        {
          name: 'launch',
          command: 'npm start',
          lifecycle: 'launch',
          timeoutSeconds: null,
          shell: { windows: 'powershell', mac: 'zsh' },
        },
        {
          name: 'teardown',
          command: 'npm run clean',
          lifecycle: 'teardown',
          timeoutSeconds: 1800,
        },
        { name: 'custom', command: 'echo hi', lifecycle: 'custom' },
      ]);
    });

    it('skips null tombstones and unrecognised values', () => {
      const overrides = {
        setup: null,
        teardown: 'npm run clean',
        bogus: 42 as unknown as ScriptValue,
      } as ScriptOverrides;
      expect(listRunnableScripts(overrides)).toEqual([
        { name: 'teardown', command: 'npm run clean', lifecycle: 'teardown' },
      ]);
    });
  });

  describe('normalizeScriptDevServerPattern', () => {
    it('returns undefined for null/undefined inputs', () => {
      expect(normalizeScriptDevServerPattern(null)).toBeUndefined();
      expect(normalizeScriptDevServerPattern(undefined)).toBeUndefined();
    });

    it('normalizes a bare string by trimming and validating regex', () => {
      expect(
        normalizeScriptDevServerPattern('  https?://localhost:\\d+\\S*  '),
      ).toBe('https?://localhost:\\d+\\S*');
    });

    it('returns undefined for empty/whitespace-only strings', () => {
      expect(normalizeScriptDevServerPattern('')).toBeUndefined();
      expect(normalizeScriptDevServerPattern('   ')).toBeUndefined();
    });

    it('drops patterns that fail to compile as a regex', () => {
      expect(normalizeScriptDevServerPattern('(unclosed')).toBeUndefined();
      expect(
        normalizeScriptDevServerPattern({ pattern: '(unclosed' }),
      ).toBeUndefined();
    });

    it('drops patterns longer than the documented cap', () => {
      const tooLong = 'a'.repeat(MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH + 1);
      expect(normalizeScriptDevServerPattern(tooLong)).toBeUndefined();
      expect(
        normalizeScriptDevServerPattern({ pattern: tooLong }),
      ).toBeUndefined();
    });

    it('keeps a label when present and within the cap', () => {
      expect(
        normalizeScriptDevServerPattern({
          pattern: 'Local:\\s+(https?://\\S+)',
          label: '  Web App  ',
        }),
      ).toEqual({ pattern: 'Local:\\s+(https?://\\S+)', label: 'Web App' });
    });

    it('drops labels that are empty or too long, keeping the bare pattern', () => {
      expect(
        normalizeScriptDevServerPattern({
          pattern: 'https?://\\S+',
          label: '   ',
        }),
      ).toBe('https?://\\S+');
      expect(
        normalizeScriptDevServerPattern({
          pattern: 'https?://\\S+',
          label: 'x'.repeat(MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH + 1),
        }),
      ).toBe('https?://\\S+');
    });

    it('returns a single entry bare when only one valid entry survives', () => {
      expect(
        normalizeScriptDevServerPattern([
          { pattern: '(invalid' },
          'https?://\\S+',
          '',
        ]),
      ).toBe('https?://\\S+');
    });

    it('preserves array order and label/no-label mixing', () => {
      expect(
        normalizeScriptDevServerPattern([
          { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
          { pattern: 'App:\\s+(https?://\\S+)', label: 'App' },
          'https?://localhost:\\d+\\S*',
        ]),
      ).toEqual([
        { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
        { pattern: 'App:\\s+(https?://\\S+)', label: 'App' },
        'https?://localhost:\\d+\\S*',
      ]);
    });

    it('collapses an object entry without a label down to its bare pattern', () => {
      expect(
        normalizeScriptDevServerPattern({ pattern: 'https?://\\S+' }),
      ).toBe('https?://\\S+');
    });

    it('drops object entries without a string pattern', () => {
      expect(
        normalizeScriptDevServerPattern({ pattern: 42 } as unknown),
      ).toBeUndefined();
      expect(normalizeScriptDevServerPattern({} as unknown)).toBeUndefined();
    });

    it('caps arrays at MAX_SCRIPT_DEV_SERVER_PATTERNS, preserving leading order', () => {
      const inputs = Array.from(
        { length: MAX_SCRIPT_DEV_SERVER_PATTERNS + 3 },
        (_, index) => `https?://host${index}\\S*`,
      );
      const normalized = normalizeScriptDevServerPattern(inputs);
      expect(Array.isArray(normalized)).toBe(true);
      expect((normalized as string[]).length).toBe(
        MAX_SCRIPT_DEV_SERVER_PATTERNS,
      );
      expect((normalized as string[])[0]).toBe('https?://host0\\S*');
      expect((normalized as string[])[MAX_SCRIPT_DEV_SERVER_PATTERNS - 1]).toBe(
        `https?://host${MAX_SCRIPT_DEV_SERVER_PATTERNS - 1}\\S*`,
      );
    });

    it('returns undefined when no entries in an array survive', () => {
      expect(
        normalizeScriptDevServerPattern(['', '   ', { pattern: '(bad' }]),
      ).toBeUndefined();
    });
  });

  describe('normalizeScriptDevServerPatternsForRuntime', () => {
    it('returns an empty array for undefined input', () => {
      expect(normalizeScriptDevServerPatternsForRuntime(undefined)).toEqual([]);
    });

    it('expands a single string entry into one object entry defaulting openTarget to in-app', () => {
      expect(
        normalizeScriptDevServerPatternsForRuntime('https?://\\S+'),
      ).toEqual([{ pattern: 'https?://\\S+', openTarget: 'in-app' }]);
    });

    it('expands a single object entry preserving its label and defaulting openTarget', () => {
      expect(
        normalizeScriptDevServerPatternsForRuntime({
          pattern: 'Local:\\s+(https?://\\S+)',
          label: 'Web App',
        }),
      ).toEqual([
        {
          pattern: 'Local:\\s+(https?://\\S+)',
          label: 'Web App',
          openTarget: 'in-app',
        },
      ]);
    });

    it('preserves an explicit external openTarget in the runtime form', () => {
      expect(
        normalizeScriptDevServerPatternsForRuntime({
          pattern: 'Docs:\\s+(https?://\\S+)',
          label: 'Docs',
          openTarget: 'external',
        }),
      ).toEqual([
        {
          pattern: 'Docs:\\s+(https?://\\S+)',
          label: 'Docs',
          openTarget: 'external',
        },
      ]);
    });

    it('preserves priority order across mixed-array inputs', () => {
      expect(
        normalizeScriptDevServerPatternsForRuntime([
          {
            pattern: 'Admin:\\s+(https?://\\S+)',
            label: 'Admin',
            openTarget: 'external',
          },
          'https?://localhost:\\d+\\S*',
        ]),
      ).toEqual([
        {
          pattern: 'Admin:\\s+(https?://\\S+)',
          label: 'Admin',
          openTarget: 'external',
        },
        { pattern: 'https?://localhost:\\d+\\S*', openTarget: 'in-app' },
      ]);
    });

    it('drops invalid entries while preserving order of the survivors', () => {
      expect(
        normalizeScriptDevServerPatternsForRuntime([
          '',
          { pattern: '(bad' },
          'https?://a\\S*',
          { pattern: 'https?://b\\S*', label: 'B' },
        ]),
      ).toEqual([
        { pattern: 'https?://a\\S*', openTarget: 'in-app' },
        { pattern: 'https?://b\\S*', label: 'B', openTarget: 'in-app' },
      ]);
    });
  });

  describe('dev-server pattern openTarget contract', () => {
    it('defaults old string/object patterns to in-app in the runtime form', () => {
      // Legacy bare-string patterns carry no openTarget on disk and must
      // resolve to the in-app default at runtime.
      expect(
        normalizeScriptDevServerPatternsForRuntime('https?://\\S+'),
      ).toEqual([{ pattern: 'https?://\\S+', openTarget: 'in-app' }]);
      // Legacy object patterns without openTarget resolve the same way.
      expect(
        normalizeScriptDevServerPatternsForRuntime({
          pattern: 'https?://\\S+',
          label: 'Web',
        }),
      ).toEqual([
        { pattern: 'https?://\\S+', label: 'Web', openTarget: 'in-app' },
      ]);
    });

    it('drops the default in-app openTarget from the persisted form', () => {
      // An explicit in-app target carries no extra information, so a
      // label-less entry still collapses to a bare string on disk.
      expect(
        normalizeScriptDevServerPattern({
          pattern: 'https?://\\S+',
          openTarget: 'in-app',
        }),
      ).toBe('https?://\\S+');
      // With a label it stays an object but omits the default openTarget.
      expect(
        normalizeScriptDevServerPattern({
          pattern: 'https?://\\S+',
          label: 'Web',
          openTarget: 'in-app',
        }),
      ).toEqual({ pattern: 'https?://\\S+', label: 'Web' });
    });

    it('preserves an external openTarget in the persisted form, even without a label', () => {
      expect(
        normalizeScriptDevServerPattern({
          pattern: 'https?://\\S+',
          openTarget: 'external',
        }),
      ).toEqual({ pattern: 'https?://\\S+', openTarget: 'external' });
      expect(
        normalizeScriptDevServerPattern({
          pattern: 'Docs:\\s+(https?://\\S+)',
          label: 'Docs',
          openTarget: 'external',
        }),
      ).toEqual({
        pattern: 'Docs:\\s+(https?://\\S+)',
        label: 'Docs',
        openTarget: 'external',
      });
    });

    it('round-trips external deterministically through persist + runtime', () => {
      const persisted = normalizeScriptDevServerPattern({
        pattern: 'https?://\\S+',
        openTarget: 'external',
      });
      expect(persisted).toEqual({
        pattern: 'https?://\\S+',
        openTarget: 'external',
      });
      expect(normalizeScriptDevServerPatternsForRuntime(persisted)).toEqual([
        { pattern: 'https?://\\S+', openTarget: 'external' },
      ]);
    });

    it('normalizes an invalid openTarget away in permissive normalization', () => {
      // Unsupported values are treated as the in-app default and therefore
      // dropped: a label-less entry collapses to a bare string.
      expect(
        normalizeScriptDevServerPattern({
          pattern: 'https?://\\S+',
          openTarget: 'popup',
        } as unknown),
      ).toBe('https?://\\S+');
      // And the runtime form resolves the invalid value to in-app.
      expect(
        normalizeScriptDevServerPatternsForRuntime([
          {
            pattern: 'https?://\\S+',
            openTarget: 'popup',
          } as unknown as never,
        ]),
      ).toEqual([{ pattern: 'https?://\\S+', openTarget: 'in-app' }]);
    });
  });

  describe('normalizeScriptDefinition (devServerPattern)', () => {
    it('threads a valid devServerPattern through to the canonical form', () => {
      expect(
        normalizeScriptDefinition({
          command: 'npm run dev',
          devServerPattern: 'https?://localhost:\\d+\\S*',
        }),
      ).toEqual({
        command: 'npm run dev',
        devServerPattern: 'https?://localhost:\\d+\\S*',
      });
    });

    it('preserves array-form patterns with labels', () => {
      expect(
        normalizeScriptDefinition({
          command: 'npm run dev',
          devServerPattern: [
            { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
            'https?://localhost:\\d+\\S*',
          ],
        }),
      ).toEqual({
        command: 'npm run dev',
        devServerPattern: [
          { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
          'https?://localhost:\\d+\\S*',
        ],
      });
    });

    it('drops devServerPattern entirely when every entry is invalid', () => {
      expect(
        normalizeScriptDefinition({
          command: 'npm run dev',
          devServerPattern: ['', '   ', { pattern: '(bad' }],
        }),
      ).toEqual({ command: 'npm run dev' });
    });

    it('drops devServerPattern when undefined while preserving the command', () => {
      expect(
        normalizeScriptDefinition({
          command: 'npm run dev',
          devServerPattern: undefined,
        }),
      ).toEqual({ command: 'npm run dev' });
    });
  });

  describe('normalizeScriptInputMap (devServerPattern)', () => {
    it('persists devServerPattern in object form alongside the command', () => {
      const input: ScriptInputMap = {
        launch: {
          command: 'npm run dev',
          devServerPattern: 'https?://localhost:\\d+\\S*',
        },
      };
      expect(normalizeScriptInputMap(input)).toEqual({
        launch: {
          command: 'npm run dev',
          devServerPattern: 'https?://localhost:\\d+\\S*',
        },
      });
    });

    it('emits command metadata in a stable key order', () => {
      const input: ScriptInputMap = {
        launch: {
          command: 'npm run dev',
          devServerPattern: 'https?://localhost:\\d+\\S*',
          timeoutSeconds: 900,
          shell: { windows: 'bash', mac: 'zsh' },
        },
      };
      const normalized = normalizeScriptInputMap(input);
      const launchValue = normalized?.launch;
      expect(launchValue && typeof launchValue === 'object').toBe(true);
      expect(Object.keys(launchValue as ScriptDefinition)).toEqual([
        'command',
        'timeoutSeconds',
        'devServerPattern',
        'shell',
      ]);
    });

    it('compacts an object entry with only a devServerPattern to object form (not a string)', () => {
      const input: ScriptInputMap = {
        launch: {
          command: 'npm run dev',
          devServerPattern: 'https?://localhost:\\d+\\S*',
        },
      };
      const normalized = normalizeScriptInputMap(input);
      expect(typeof normalized?.launch).toBe('object');
    });

    it('compacts back to a string when the devServerPattern fully normalizes away', () => {
      const input: ScriptInputMap = {
        launch: {
          command: 'npm run dev',
          devServerPattern: '(invalid',
        },
      };
      expect(normalizeScriptInputMap(input)).toEqual({
        launch: 'npm run dev',
      });
    });
  });

  describe('getScriptDevServerPattern', () => {
    it('returns the devServerPattern attached to an object entry', () => {
      const overrides: ScriptOverrides = {
        launch: {
          command: 'npm run dev',
          devServerPattern: 'https?://localhost:\\d+\\S*',
        },
      };
      expect(getScriptDevServerPattern(overrides, 'launch')).toBe(
        'https?://localhost:\\d+\\S*',
      );
    });

    it('returns undefined for string entries and missing/tombstoned scripts', () => {
      const overrides: ScriptOverrides = {
        setup: 'npm install',
        disabled: null,
      };
      expect(getScriptDevServerPattern(overrides, 'setup')).toBeUndefined();
      expect(getScriptDevServerPattern(overrides, 'disabled')).toBeUndefined();
      expect(getScriptDevServerPattern(overrides, 'missing')).toBeUndefined();
      expect(getScriptDevServerPattern(undefined, 'setup')).toBeUndefined();
    });
  });

  describe('listRunnableScripts (devServerPattern)', () => {
    it('includes devServerPattern only when persisted on the object form', () => {
      const overrides: ScriptOverrides = {
        setup: 'npm install',
        launch: {
          command: 'npm run dev',
          devServerPattern: [
            { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
            'https?://localhost:\\d+\\S*',
          ],
        },
      };
      expect(listRunnableScripts(overrides)).toEqual([
        { name: 'setup', command: 'npm install', lifecycle: 'setup' },
        {
          name: 'launch',
          command: 'npm run dev',
          lifecycle: 'launch',
          devServerPattern: [
            { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
            'https?://localhost:\\d+\\S*',
          ],
        },
      ]);
    });
  });

  it('keeps the type aliases compatible with legacy string-only callers', () => {
    // Compile-time check: ergonomic literal types still satisfy the widened
    // aliases so existing fixtures/tests do not need to change.
    const overrides: ScriptOverrides = {
      setup: 'npm install',
      teardown: null,
    };
    const inputMap: ScriptInputMap = {
      setup: 'npm install',
      teardown: null,
      undefinedEntry: undefined,
    };
    const definition: ScriptDefinition = { command: 'npm test' };
    expect(overrides.setup).toBe('npm install');
    expect(inputMap.undefinedEntry).toBeUndefined();
    expect(definition.command).toBe('npm test');
  });
});
