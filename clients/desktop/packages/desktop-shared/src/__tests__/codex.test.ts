import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModelPackageConfig } from '../model-config';
import {
  applyCodexMultiAgentConfig,
  normalizeCodexMaxConcurrentSubagents,
} from '../lib/codex-multi-agent';
import { THINKING_LEVELS, type ThinkingLevel } from '@canopy/protocol/thinking';
import {
  codexServiceTierForModelConfig,
  codexServiceTierForSpeed,
  type CodexReasoningEffort,
  isCodexConfig,
  mapThinkingToReasoningEffort,
} from '../lib/codex-model-config';
import {
  applyAgentSessionCodexSpeed,
  canonicalizeAgentModelConfig,
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  CodexSpeedUnsupportedError,
  mergeAgentModelConfig,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '../lib/codex-speed';
import {
  initCodexModels,
  normalizeAgentModelConfig,
  resolveProviderModelConfig,
} from '../types';

const EXHAUSTIVE_REASONING_EFFORT: Record<ThinkingLevel, CodexReasoningEffort> =
  {
    off: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
    ultra: 'xhigh',
  };

describe('Codex model config', () => {
  afterEach(() => initCodexModels([]));

  it.each(['gpt-6.1-sol', 'gpt-6-astra'])(
    'maps persisted off to low and keeps low for configured model %s',
    (model) => {
      const pkg: unknown = JSON.parse(
        readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
      );
      initCodexModels(parseModelPackageConfig(pkg).codexModels);
      expect(mapThinkingToReasoningEffort('off', model)).toBe('low');
      expect(mapThinkingToReasoningEffort('low', model)).toBe('low');
      expect(mapThinkingToReasoningEffort('off', 'gpt-6-luna')).toBe('none');
    },
  );

  it.each([
    ['low', ['high', 'medium', 'low']],
    ['medium', ['high', 'medium']],
    ['high', ['high']],
  ] satisfies [CodexReasoningEffort, ThinkingLevel[]][])(
    'maps unsupported off to the weakest declared effort %s regardless of order',
    (expected, supportedThinkingLevels) => {
      initCodexModels([
        { id: 'no-off', label: 'No off', supportedThinkingLevels },
      ]);
      expect(mapThinkingToReasoningEffort('off', 'no-off')).toBe(expected);
    },
  );

  it('keeps the ThinkingLevel to CodexReasoningEffort mapping exhaustive', () => {
    initCodexModels([
      {
        id: 'all-thinking-levels',
        label: 'All thinking levels',
        supportedThinkingLevels: [...THINKING_LEVELS],
      },
    ]);

    for (const level of THINKING_LEVELS) {
      expect(mapThinkingToReasoningEffort(level, 'all-thinking-levels')).toBe(
        EXHAUSTIVE_REASONING_EFFORT[level],
      );
    }
  });

  it('recognizes JSON-object config values', () => {
    expect(isCodexConfig({ features: { multi_agent: true } })).toBe(true);
    expect(isCodexConfig(null)).toBe(false);
    expect(isCodexConfig([])).toBe(false);
  });

  it('maps thinking levels to app-server reasoning effort', () => {
    expect(mapThinkingToReasoningEffort('off')).toBe('none');
    expect(mapThinkingToReasoningEffort('low')).toBe('low');
    expect(mapThinkingToReasoningEffort('medium')).toBe('medium');
    expect(mapThinkingToReasoningEffort('high')).toBe('high');
    expect(mapThinkingToReasoningEffort('xhigh')).toBe('xhigh');
    expect(mapThinkingToReasoningEffort('max')).toBe('xhigh');
    initCodexModels([
      {
        id: 'gpt-5.6-sol',
        label: 'GPT 5.6 Sol',
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT 5.6 Luna',
        supportedThinkingLevels: [
          'off',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
      },
    ]);
    expect(mapThinkingToReasoningEffort('off', 'gpt-5.6-luna')).toBe('none');
    expect(mapThinkingToReasoningEffort('max', 'gpt-5.6-sol')).toBe('max');
    expect(mapThinkingToReasoningEffort('ultra')).toBe('xhigh');
  });

  it('selects the service tier from Fast mode', () => {
    expect(codexServiceTierForModelConfig()).toBe('default');
    expect(codexServiceTierForModelConfig({ fastMode: false })).toBe('default');
    expect(codexServiceTierForModelConfig({ fastMode: true })).toBe('priority');
  });

  it('maps every Codex speed to an explicit service tier, preferring speed over the legacy boolean', () => {
    expect(codexServiceTierForModelConfig({ speed: 'standard' })).toBe(
      'default',
    );
    expect(codexServiceTierForModelConfig({ speed: 'fast' })).toBe('priority');
    expect(codexServiceTierForModelConfig({ speed: 'ultrafast' })).toBe(
      'ultrafast',
    );
    expect(
      codexServiceTierForModelConfig({ speed: 'ultrafast', fastMode: false }),
    ).toBe('ultrafast');
    expect(
      codexServiceTierForModelConfig({ speed: 'standard', fastMode: true }),
    ).toBe('default');
    expect(codexServiceTierForSpeed('standard')).toBe('default');
  });
});

describe('Codex speed', () => {
  it('reads each record by speed, then fastMode, then legacy aliases', () => {
    expect(readCodexSpeedRecord(undefined)).toBeUndefined();
    expect(readCodexSpeedRecord({})).toBeUndefined();
    expect(readCodexSpeedRecord({ speed: 'ultrafast', fastMode: true })).toBe(
      'ultrafast',
    );
    expect(readCodexSpeedRecord({ fastMode: true })).toBe('fast');
    expect(readCodexSpeedRecord({ fastMode: false }, true)).toBe('standard');
    expect(readCodexSpeedRecord({ speed: 'priority' }, true)).toBe('fast');
    expect(readCodexSpeedRecord({ speed: 'bogus', fastMode: false })).toBe(
      'standard',
    );
    expect(readCodexSpeedRecord(null, undefined, false)).toBe('standard');
  });

  it('projects the legacy boolean only for Fast', () => {
    expect(codexSpeedFastMode('standard')).toBe(false);
    expect(codexSpeedFastMode('fast')).toBe(true);
    expect(codexSpeedFastMode('ultrafast')).toBe(false);
    expect(codexSpeedFromFastMode(true)).toBe('fast');
    expect(codexSpeedFromFastMode(false)).toBe('standard');
  });

  it('merges an explicit speed patch with its derived boolean', () => {
    expect(
      mergeAgentModelConfig(
        { thinkingLevel: 'low', fastMode: true },
        { speed: 'ultrafast' },
      ),
    ).toEqual({ thinkingLevel: 'low', speed: 'ultrafast', fastMode: false });
  });

  it('lets an explicit boolean patch without speed replace the speed', () => {
    const ultra = { speed: 'ultrafast', fastMode: false } as const;
    expect(mergeAgentModelConfig(ultra, { fastMode: true })).toEqual({
      speed: 'fast',
      fastMode: true,
    });
    // `false` equals Ultra's derived boolean, but is still an explicit Regular
    // command: there is no equality no-op heuristic.
    expect(mergeAgentModelConfig(ultra, { fastMode: false })).toEqual({
      speed: 'standard',
      fastMode: false,
    });
  });

  it('preserves the speed across unrelated thinking patches', () => {
    expect(
      mergeAgentModelConfig(
        { thinkingLevel: 'high', speed: 'ultrafast', fastMode: false },
        { thinkingLevel: 'xhigh' },
      ),
    ).toEqual({ thinkingLevel: 'xhigh', speed: 'ultrafast', fastMode: false });
    expect(
      mergeAgentModelConfig({ fastMode: true }, { thinkingLevel: 'low' }),
    ).toEqual({ thinkingLevel: 'low', speed: 'fast', fastMode: true });
    expect(mergeAgentModelConfig(undefined, { thinkingLevel: 'low' })).toEqual({
      thinkingLevel: 'low',
    });
  });

  it('canonicalizes a config atomically', () => {
    expect(withCodexSpeed({ thinkingLevel: 'high' }, 'ultrafast')).toEqual({
      thinkingLevel: 'high',
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(canonicalizeAgentModelConfig({ fastMode: true })).toEqual({
      speed: 'fast',
      fastMode: true,
    });
    expect(canonicalizeAgentModelConfig({ thinkingLevel: 'low' })).toEqual({
      thinkingLevel: 'low',
    });
  });

  it('normalizes persisted configs safely, never projecting Ultra as fastMode', () => {
    expect(normalizeAgentModelConfig({ speed: 'ultrafast' })).toEqual({
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(
      normalizeAgentModelConfig({ speed: 'ultrafast', fastMode: true }),
    ).toEqual({ speed: 'ultrafast', fastMode: false });
    expect(
      normalizeAgentModelConfig({ speed: 'nope', fastMode: true }),
    ).toEqual({ fastMode: true });
    expect(normalizeAgentModelConfig({ speed: 'nope' })).toBeUndefined();
  });

  it('resolves the selected record before provider defaults', () => {
    const ultraDefault = { codex: { speed: 'ultrafast' as const } };
    expect(resolveProviderModelConfig('codex', {}, ultraDefault)).toMatchObject(
      { speed: 'ultrafast', fastMode: false },
    );
    // An explicit legacy false on the selection beats a newer Ultra default.
    expect(
      resolveProviderModelConfig(
        'codex',
        { modelConfig: { fastMode: false } },
        ultraDefault,
      ),
    ).toMatchObject({ speed: 'standard', fastMode: false });
    expect(
      resolveProviderModelConfig(
        'codex',
        { codexFastModeEnabled: false },
        ultraDefault,
      ),
    ).toMatchObject({ speed: 'standard', fastMode: false });
    expect(
      resolveProviderModelConfig(
        'codex',
        { modelConfig: { speed: 'fast', fastMode: true } },
        ultraDefault,
      ),
    ).toMatchObject({ speed: 'fast', fastMode: true });
    expect(
      resolveProviderModelConfig('codex', {}, { codex: { fastMode: true } }),
    ).toMatchObject({ speed: 'fast', fastMode: true });
    expect(resolveProviderModelConfig('codex', {}, undefined)).toMatchObject({
      speed: 'standard',
      fastMode: false,
    });
  });

  it('never requests a Codex speed for another provider', () => {
    expect(
      resolveProviderModelConfig(
        'claude',
        { modelConfig: { speed: 'ultrafast' } },
        { claude: { speed: 'fast' } },
      ),
    ).toMatchObject({ speed: 'standard', fastMode: false });
  });

  it('applies an exact speed to a session, falling back to the boolean setter only for Regular and Fast', async () => {
    const calls: string[] = [];
    const record =
      (prefix: string) =>
      (value: string | boolean): Promise<void> => {
        calls.push(`${prefix}:${String(value)}`);
        return Promise.resolve();
      };
    await applyAgentSessionCodexSpeed(
      { setSpeed: record('speed'), setFastMode: record('fast') },
      'ultrafast',
    );
    const legacy = { setFastMode: record('fast') };
    await applyAgentSessionCodexSpeed(legacy, 'fast');
    await applyAgentSessionCodexSpeed(legacy, 'standard');
    await applyAgentSessionCodexSpeed(
      { setCodexFastMode: record('codex') },
      'fast',
    );
    await applyAgentSessionCodexSpeed({}, 'standard');
    expect(calls).toEqual([
      'speed:ultrafast',
      'fast:true',
      'fast:false',
      'codex:true',
    ]);
    await expect(
      applyAgentSessionCodexSpeed(legacy, 'ultrafast'),
    ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
    await expect(
      applyAgentSessionCodexSpeed({}, 'ultrafast'),
    ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
  });
});

describe('Codex multi-agent policy', () => {
  it('overrides mixed dotted/nested provider config while retaining unrelated settings', () => {
    const base = {
      'features.multi_agent': true,
      'features.multi_agent_v2': true,
      'agents.enabled': true,
      'agents.max_threads': 10,
      features: { code_mode: true },
      agents: {
        enabled: true,
        max_threads: 8,
        explorer: { description: 'Read code' },
      },
    };
    expect(
      applyCodexMultiAgentConfig(base, {
        enabled: false,
        maxConcurrentSubagents: 2,
      }),
    ).toEqual({
      features: { code_mode: true, multi_agent: false, multi_agent_v2: false },
      agents: {
        enabled: false,
        max_concurrent_threads_per_session: 2,
        explorer: { description: 'Read code' },
      },
    });
    expect(base.agents.max_threads).toBe(8);
  });
  it('omits an explicit limit for Codex default without removing custom roles', () => {
    expect(
      applyCodexMultiAgentConfig(
        {
          'agents.max_threads': 7,
          agents: {
            max_concurrent_threads_per_session: 3,
            default_subagent_model: 'gpt-5.5',
          },
        },
        { maxConcurrentSubagents: null },
      ),
    ).toEqual({ agents: { default_subagent_model: 'gpt-5.5' } });
  });
  it('leaves independent CLI config unchanged when preferences are absent', () => {
    const base = { agents: { enabled: false, max_threads: 4 } };
    expect(applyCodexMultiAgentConfig(base, {})).toEqual(base);
  });
  it.each([0, -3, 1.2, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid concurrency %s',
    (value) => {
      expect(normalizeCodexMaxConcurrentSubagents(value)).toBeNull();
    },
  );
});
