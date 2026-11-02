/**
 * Coverage for the composer's shared decision logic.
 *
 * These helpers moved here from `apps/web`'s composer, where their tests still
 * live and reach them through re-exports. That indirection disappears when the
 * web fork is deleted, so the behaviour each one owns is pinned here too.
 */
import type { ModelCatalog, ModelCatalogOption } from '@canopy/ui-shared';
import type { PortalChatUsage } from '@canopy/protocol/portal';
import { defaultChatPlaceholder as sharedDefaultChatPlaceholder } from '@canopy/ui-shared/lib';
import {
  buildComposerOverflowMenuItems,
  defaultChatPlaceholder,
  resolveComposerThinking,
  resolveModelOptionProviderType,
  resolvePortalExecutionHarness,
  resolveUsageIndicatorIsCodex,
  toUsageIndicatorUsage,
} from '../composer-helpers';

function modelOption(
  overrides: Partial<ModelCatalogOption> & Pick<ModelCatalogOption, 'id'>,
): ModelCatalogOption {
  return {
    label: overrides.id,
    provider: 'claude',
    kind: 'model',
    available: true,
    ...overrides,
  };
}

describe('defaultChatPlaceholder', () => {
  // The wording is pinned in ui-shared, where the helper lives; this only
  // checks the historical export path still reaches that one implementation.
  it('re-exports the ui-shared helper', () => {
    expect(defaultChatPlaceholder).toBe(sharedDefaultChatPlaceholder);
  });
});

describe('resolveUsageIndicatorIsCodex', () => {
  const catalog: ModelCatalog = [
    modelOption({ id: 'gpt', harness: 'codex' }),
    modelOption({ id: 'sonnet', harness: 'claude' }),
  ];

  it('trusts a bound harness over the catalog', () => {
    expect(resolveUsageIndicatorIsCodex('codex', catalog, 'sonnet')).toBe(true);
    expect(resolveUsageIndicatorIsCodex('claude', catalog, 'gpt')).toBe(false);
  });

  it('falls back to the catalog before the first answer binds one', () => {
    expect(resolveUsageIndicatorIsCodex(undefined, catalog, 'gpt')).toBe(true);
    expect(resolveUsageIndicatorIsCodex(undefined, catalog, 'sonnet')).toBe(
      false,
    );
    expect(resolveUsageIndicatorIsCodex(undefined, undefined, 'gpt')).toBe(
      false,
    );
  });
});

describe('toUsageIndicatorUsage', () => {
  it('hides the context row until the harness reports a measurement', () => {
    const usage: PortalChatUsage = { contextWindow: 200_000 };
    expect(toUsageIndicatorUsage(usage, 111, 'm')?.contextWindow).toBe(0);
  });

  it('falls back to the supplied window once context is measured', () => {
    expect(
      toUsageIndicatorUsage({ contextTokens: 10 }, 999, 'm')?.contextWindow,
    ).toBe(999);
    expect(
      toUsageIndicatorUsage({ contextTokens: 10, contextWindow: 500 }, 999, 'm')
        ?.contextWindow,
    ).toBe(500);
  });

  it('omits rows the runtime never reported rather than reading them as zero', () => {
    const projected = toUsageIndicatorUsage({ contextTokens: 1 }, 10, 'm');
    expect(projected).not.toHaveProperty('totalCostUsd');
    expect(projected).not.toHaveProperty('durationMs');
    expect(projected).not.toHaveProperty('cacheCreationInputTokens');
    // Cumulative counters still default to zero.
    expect(projected?.inputTokens).toBe(0);
    expect(projected?.numTurns).toBe(0);
  });

  it('passes through with no usage at all', () => {
    expect(toUsageIndicatorUsage(undefined, 1, 'm')).toBeUndefined();
  });

  it('names the model from the fallback when usage carries none', () => {
    expect(toUsageIndicatorUsage({}, undefined, 'fallback')?.model).toBe(
      'fallback',
    );
    expect(toUsageIndicatorUsage({ model: 'own' }, undefined, 'f')?.model).toBe(
      'own',
    );
  });
});

describe('execution harness resolution', () => {
  it('prefers the captured harness over the model source', () => {
    expect(resolvePortalExecutionHarness('claude', 'codex')).toBe('codex');
    expect(resolvePortalExecutionHarness('claude', undefined)).toBe('claude');
  });

  it('keeps an unknown harness unknown once an option is selected', () => {
    // A vendor the controls do not model must not fall back to a stale hint.
    expect(
      resolveModelOptionProviderType(
        modelOption({ id: 'x', provider: 'unknown' }),
        'claude',
      ),
    ).toBeUndefined();
    expect(resolveModelOptionProviderType(undefined, 'claude')).toBe('claude');
    expect(
      resolveModelOptionProviderType(
        modelOption({ id: 'x', provider: 'unknown' }),
        'claude',
        'codex',
      ),
    ).toBe('codex');
  });

  it('reads the harness ahead of the provider on a gateway row', () => {
    expect(
      resolveModelOptionProviderType(
        modelOption({ id: 'x', provider: 'claude', harness: 'codex' }),
        undefined,
      ),
    ).toBe('codex');
  });
});

describe('resolveComposerThinking', () => {
  it('walks the model’s own tiers when the host projects them', () => {
    expect(
      resolveComposerThinking({
        current: 'high',
        executionHarness: 'claude',
        supportedLevels: ['off', 'high', 'ultra'],
      }),
    ).toEqual({ display: 'high', next: 'ultra' });
  });

  it('clamps a stored tier the model does not support instead of hiding it', () => {
    expect(
      resolveComposerThinking({
        current: 'ultra',
        executionHarness: 'claude',
        supportedLevels: ['off', 'medium'],
      }).display,
    ).toBe('medium');
  });

  it('shows the weakest projected tier for a persisted off', () => {
    expect(
      resolveComposerThinking({
        current: 'off',
        executionHarness: 'codex',
        supportedLevels: ['high', 'medium'],
      }),
    ).toEqual({ display: 'medium', next: 'high' });
  });

  it('shows a Codex max as the xhigh tier that provider exposes', () => {
    expect(
      resolveComposerThinking({ current: 'max', executionHarness: 'codex' })
        .display,
    ).toBe('xhigh');
    expect(
      resolveComposerThinking({ current: 'max', executionHarness: 'claude' })
        .display,
    ).toBe('max');
  });
});

describe('buildComposerOverflowMenuItems', () => {
  const base = {
    canUsePlanMode: true,
    supportsFastMode: true,
    effectivePlanMode: false,
    effectiveFastMode: false,
    displayThinkingLevel: 'high' as const,
    thinkingLabel: 'High',
    onTogglePlan: (): void => {},
    onToggleFast: (): void => {},
    onCycleThinking: (): void => {},
  };

  it('gates each row on the same capability its chip does', () => {
    expect(buildComposerOverflowMenuItems(base).map((i) => i.key)).toEqual([
      'plan',
      'fast',
      'thinking',
    ]);
    expect(
      buildComposerOverflowMenuItems({
        ...base,
        canUsePlanMode: false,
        supportsFastMode: false,
        thinkingSupported: false,
      }),
    ).toEqual([]);
  });

  it('keeps the menu open for the cycler and closes it for the toggles', () => {
    const items = buildComposerOverflowMenuItems(base);
    const byKey = (key: string): (typeof items)[number] | undefined =>
      items.find((item) => item.key === key);
    expect(byKey('thinking')?.closeOnSelect).toBe(false);
    expect(byKey('thinking')?.role).toBe('menuitem');
    expect(byKey('plan')?.closeOnSelect).not.toBe(false);
  });

  it('reports each control’s current state in its row', () => {
    const items = buildComposerOverflowMenuItems({
      ...base,
      effectivePlanMode: true,
      effectiveFastMode: false,
    });
    expect(items.find((i) => i.key === 'plan')?.stateLabel).toBe('On');
    expect(items.find((i) => i.key === 'fast')?.stateLabel).toBe('Off');
    expect(items.find((i) => i.key === 'thinking')?.stateLabel).toBe('High');
  });
});
