import {
  BUILTIN_PLAN_DETECTION_RULE_IDS,
  getBuiltinPlanDetectionRule,
  normalizePlanDetectionRule,
  resolvePlanDetectionRules,
} from '../plan-detection';
import type {
  PlanDetectionPreferences,
  WorkspacePlanDetectionConfig,
  CanopyJsonPlanDetection,
} from '../types';

function global(
  over: Partial<PlanDetectionPreferences> = {},
): PlanDetectionPreferences {
  return { disabledBuiltinRuleIds: [], customRules: [], ...over };
}

describe('BUILTIN_PLAN_DETECTION_RULES', () => {
  it('ships the Superpowers and plan file built-ins', () => {
    expect(getBuiltinPlanDetectionRule('superpowers-specs')).toEqual({
      id: 'superpowers-specs',
      label: 'Superpowers Specs',
      kind: 'include',
      pattern: 'docs/superpowers/specs/*.md',
      enabled: true,
    });
    expect(getBuiltinPlanDetectionRule('superpowers-designs')?.kind).toBe(
      'exclude',
    );
    expect(getBuiltinPlanDetectionRule('plan-md')).toEqual({
      id: 'plan-md',
      label: 'Plan Files',
      kind: 'include',
      pattern: '**/plan.md',
      enabled: true,
    });
    expect(BUILTIN_PLAN_DETECTION_RULE_IDS.has('superpowers-specs')).toBe(true);
    expect(BUILTIN_PLAN_DETECTION_RULE_IDS.has('plan-md')).toBe(true);
  });
});

describe('resolvePlanDetectionRules', () => {
  it('returns enabled built-ins split by kind by default', () => {
    const { includes, excludes } = resolvePlanDetectionRules({
      global: global(),
    });
    expect(includes.map((r) => r.id)).toEqual(['superpowers-specs', 'plan-md']);
    expect(excludes.map((r) => r.id)).toEqual(['superpowers-designs']);
  });

  it('drops built-ins disabled at the global tier', () => {
    const { includes } = resolvePlanDetectionRules({
      global: global({
        disabledBuiltinRuleIds: ['superpowers-specs', 'plan-md'],
      }),
    });
    expect(includes).toHaveLength(0);
  });

  it('unions custom rules from every tier', () => {
    const workspaceLocal: WorkspacePlanDetectionConfig = {
      customRules: [
        {
          id: 'ws-1',
          label: 'WS plans',
          kind: 'include',
          pattern: 'plans/*.md',
          enabled: true,
        },
      ],
    };
    const canopyJson: CanopyJsonPlanDetection = {
      rules: [
        {
          id: 'cj-1',
          label: 'Team plans',
          kind: 'include',
          pattern: 'team/*.md',
          enabled: true,
        },
      ],
    };
    const { includes } = resolvePlanDetectionRules({
      global: global({
        customRules: [
          {
            id: 'g-1',
            label: 'Global plans',
            kind: 'include',
            pattern: 'g/*.md',
            enabled: true,
          },
        ],
      }),
      workspaceLocal,
      canopyJson,
    });
    expect(includes.map((r) => r.id).sort()).toEqual([
      'cj-1',
      'g-1',
      'plan-md',
      'superpowers-specs',
      'ws-1',
    ]);
  });

  it('lets the project tier disable an inherited rule by id', () => {
    const { excludes } = resolvePlanDetectionRules({
      global: global(),
      workspaceLocal: { disabledRuleIds: ['superpowers-designs'] },
    });
    expect(excludes).toHaveLength(0);
  });

  it('omits rules whose enabled flag is false', () => {
    const { includes } = resolvePlanDetectionRules({
      global: global({
        customRules: [
          {
            id: 'g-off',
            label: 'off',
            kind: 'include',
            pattern: 'x/*.md',
            enabled: false,
          },
        ],
      }),
    });
    expect(includes.find((r) => r.id === 'g-off')).toBeUndefined();
  });
});

describe('normalizePlanDetectionRule', () => {
  const baseRule = {
    id: 'custom-plan',
    label: 'Custom Plan',
    kind: 'include',
    enabled: true,
  };

  it('normalizes relative patterns', () => {
    expect(
      normalizePlanDetectionRule({
        ...baseRule,
        pattern: String.raw`docs\plans\*.md`,
      }),
    ).toEqual({
      ...baseRule,
      pattern: 'docs/plans/*.md',
    });
  });

  it('rejects absolute and parent-traversing patterns', () => {
    for (const pattern of [
      '/tmp/plan.md',
      String.raw`C:\tmp\plan.md`,
      String.raw`\tmp\plan.md`,
      '../plan.md',
      'docs/../plan.md',
    ]) {
      expect(
        normalizePlanDetectionRule({
          ...baseRule,
          pattern,
        }),
      ).toBeNull();
    }
  });
});
