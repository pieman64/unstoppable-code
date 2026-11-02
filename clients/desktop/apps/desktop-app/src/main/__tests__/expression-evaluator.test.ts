jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

import {
  buildExpressionContext,
  evaluateCondition,
  evaluateExpression,
  interpolateExpression,
  referencesMatrixContext,
  referencesPhysicalJobContext,
} from '@canopy/desktop-shared/node/pipelines/executor';

describe('expression-evaluator', () => {
  const context = buildExpressionContext({
    env: { NAME: 'canopy' },
    steps: {
      build: {
        outputs: { tag: 'v1' },
        outcome: 'success',
        conclusion: 'success',
      },
    },
    needs: {
      lint: {
        outputs: { report: 'clean' },
        result: 'success',
      },
    },
  });

  it('supports literals, property access, parentheses, and operators', () => {
    expect(evaluateExpression("'hi'", context)).toBe('hi');
    expect(evaluateExpression('steps.build.outputs.tag', context)).toBe('v1');
    expect(evaluateExpression('(1 < 2) && (2 < 3)', context)).toBe(true);
    expect(evaluateExpression('env.NAME == "canopy"', context)).toBe(true);
  });

  it('evaluates boolean conditions without crashing', () => {
    // Pre-fix pipeline definitions (and persisted execution state) can still
    // carry raw YAML booleans for `if:`; evaluateCondition must treat them
    // as their literal value rather than throwing
    // "expression?.trim is not a function".
    expect(evaluateCondition(false, context)).toBe(false);
    expect(evaluateCondition(true, context)).toBe(true);
    expect(evaluateCondition('false', context)).toBe(false);
    expect(evaluateCondition('true', context)).toBe(true);
  });

  it('detects matrix context references without matching string literals', () => {
    expect(referencesMatrixContext('matrix.item == "value"')).toBe(true);
    expect(referencesMatrixContext("contains('matrix.item', 'matrix')")).toBe(
      false,
    );
    expect(referencesMatrixContext('success()')).toBe(false);
  });

  it('detects physical job context without matching string literals', () => {
    expect(referencesPhysicalJobContext('job.status == "success"')).toBe(true);
    expect(referencesPhysicalJobContext('matrix.target == "desktop"')).toBe(
      true,
    );
    expect(
      referencesPhysicalJobContext(
        'inputs.mode != \'matrix\' && inputs.label != "job"',
      ),
    ).toBe(false);
    expect(referencesPhysicalJobContext('needs.matrix.result')).toBe(false);
    expect(referencesPhysicalJobContext('inputs.job == "build"')).toBe(false);
    expect(referencesMatrixContext('needs.matrix.result')).toBe(false);
  });

  it('supports status functions and missing values', () => {
    expect(
      evaluateCondition('success() && !cancelled()', context, {
        success: () => true,
        cancelled: () => false,
      }),
    ).toBe(true);
    expect(
      evaluateExpression('steps.missing.outputs.tag', context),
    ).toBeUndefined();
  });

  it('supports interpolation and array helpers', () => {
    expect(
      interpolateExpression('release-${{ steps.build.outputs.tag }}', context),
    ).toBe('release-v1');
    expect(
      evaluateExpression("join(values, ',')", {
        ...context,
        values: ['alpha', 'beta'],
      }),
    ).toBe('alpha,beta');
    expect(
      evaluateExpression("contains(values, 'beta')", {
        ...context,
        values: ['alpha', 'beta'],
      }),
    ).toBe(true);
    expect(
      evaluateExpression(
        'parseJson(\'{"languages":[{"name":"Python"}]}\').languages[0].name',
        context,
      ),
    ).toBe('Python');
    expect(evaluateExpression('toJson(steps.build.outputs)', context)).toBe(
      '{"tag":"v1"}',
    );
    expect(
      evaluateExpression('parseJson(toJson(steps.build.outputs)).tag', context),
    ).toBe('v1');
  });

  it('rejects invalid JSON passed to parseJson', () => {
    expect(() => evaluateExpression("parseJson('nope')", context)).toThrow(
      /invalid JSON/,
    );
  });

  it('parses both sides of || when left is truthy (no short-circuit skip)', () => {
    const ctx = buildExpressionContext({
      needs: {
        a: { outputs: {}, result: 'success' },
        b: { outputs: {}, result: 'success' },
      },
    });
    expect(
      evaluateCondition(
        "needs.a.result == 'success' && (needs.b.result == 'success' || needs.b.result == 'skipped')",
        ctx,
      ),
    ).toBe(true);
  });

  it('parses both sides of && when left is falsy (no short-circuit skip)', () => {
    const ctx = buildExpressionContext({
      needs: {
        a: { outputs: {}, result: 'failure' },
        b: { outputs: {}, result: 'success' },
      },
    });
    expect(
      evaluateCondition(
        "needs.a.result == 'success' && needs.b.result == 'success'",
        ctx,
      ),
    ).toBe(false);
  });

  it('resolves canopy.event_name from expression context', () => {
    expect(evaluateExpression('canopy.event_name', context)).toBe('dispatch');
  });

  it('supports canopy context in interpolation', () => {
    expect(
      interpolateExpression('event=${{ canopy.event_name }}', context),
    ).toBe('event=dispatch');
  });
});
