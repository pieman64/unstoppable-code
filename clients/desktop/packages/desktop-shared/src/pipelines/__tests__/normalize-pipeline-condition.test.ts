import { normalizePipeline } from '../normalize-pipeline';
import { parsePipelineText } from '../parse-pipeline';

/**
 * YAML parses unquoted `if: false` / `if: true` to booleans (JSON_SCHEMA),
 * not strings. Normalization must coerce them to the equivalent condition
 * strings so the executor's `evaluateCondition` (which expects a string
 * expression) skips or runs the step instead of crashing the whole
 * execution with `expression?.trim is not a function`.
 */
describe('normalizePipeline if: condition coercion', () => {
  function buildYaml(stepIf: string, jobIf = "'true'"): string {
    return [
      'name: Condition Pipeline',
      'on: dispatch',
      'jobs:',
      '  build:',
      `    if: ${jobIf}`,
      '    steps:',
      '      - id: gated',
      `        if: ${stepIf}`,
      '        run: echo gated',
    ].join('\n');
  }

  it('coerces an unquoted boolean step if: false to the string expression', () => {
    const normalized = normalizePipeline(parsePipelineText(buildYaml('false')));
    expect(normalized.jobs.build.steps[0].if).toBe('false');
  });

  it('coerces an unquoted boolean step if: true to the string expression', () => {
    const normalized = normalizePipeline(parsePipelineText(buildYaml('true')));
    expect(normalized.jobs.build.steps[0].if).toBe('true');
  });

  it('coerces an unquoted boolean job if: to the string expression', () => {
    const normalized = normalizePipeline(
      parsePipelineText(buildYaml("'true'", 'false')),
    );
    expect(normalized.jobs.build.if).toBe('false');
  });

  it('keeps string conditions untouched', () => {
    const normalized = normalizePipeline(
      parsePipelineText(buildYaml("${{ inputs.run_gated == 'yes' }}")),
    );
    expect(normalized.jobs.build.steps[0].if).toBe(
      "${{ inputs.run_gated == 'yes' }}",
    );
  });

  it('leaves an absent if: undefined', () => {
    const normalized = normalizePipeline(
      parsePipelineText(
        [
          'name: No Condition',
          'on: dispatch',
          'jobs:',
          '  build:',
          '    steps:',
          '      - id: plain',
          '        run: echo plain',
        ].join('\n'),
      ),
    );
    expect(normalized.jobs.build.steps[0].if).toBeUndefined();
    expect(normalized.jobs.build.if).toBeUndefined();
  });

  it('rejects non-string, non-boolean conditions with a clear error', () => {
    expect(() =>
      normalizePipeline(parsePipelineText(buildYaml('123'))),
    ).toThrow(/if/);
  });
});
