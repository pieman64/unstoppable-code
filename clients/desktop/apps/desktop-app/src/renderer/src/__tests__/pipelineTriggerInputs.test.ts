import {
  resolveTriggerInputDefs,
  resolvePipelineTriggerInputs,
  initializeInputValues,
  isValidJsonInputValue,
  parseJsonInputValue,
  validateInputs,
  buildSubmitPayload,
  getVisibleTriggerInputDefs,
  shouldShowPipelineInputInUi,
} from '../lib/pipelineTriggerInputs';
import type {
  Pipeline,
  PipelineInputDef,
} from '@canopy/desktop-shared/types/pipeline';
import type { NormalizedPipeline } from '@canopy/desktop-shared/pipelines/types';

function makeMinimalPipeline(
  triggerInputs?: NormalizedPipeline['trigger_inputs'],
): NormalizedPipeline {
  return {
    name: 'test-pipeline',
    scope: ['directory'],
    trigger_inputs: triggerInputs,
    jobs: {},
  };
}

describe('resolveTriggerInputDefs', () => {
  it('returns empty object when pipeline has no trigger_inputs', () => {
    const pipeline = makeMinimalPipeline();
    const result = resolveTriggerInputDefs(pipeline, 'dispatch');
    expect(result).toEqual({});
  });

  it('returns dispatch inputs from normalized trigger_inputs', () => {
    const defs: Record<string, PipelineInputDef> = {
      env: { type: 'choice', options: ['dev', 'staging', 'prod'] },
    };
    const pipeline = makeMinimalPipeline({ dispatch: defs });
    const result = resolveTriggerInputDefs(pipeline, 'dispatch');
    expect(result).toEqual(defs);
  });

  it('returns plan_ready inputs from normalized trigger_inputs', () => {
    const defs: Record<string, PipelineInputDef> = {
      max_iterations: { type: 'number', default: 2, min: 1, max: 10 },
    };
    const pipeline = makeMinimalPipeline({ plan_ready: defs });
    const result = resolveTriggerInputDefs(pipeline, 'plan_ready');
    expect(result).toEqual(defs);
  });

  it('returns task_ready inputs from normalized trigger_inputs', () => {
    const defs: Record<string, PipelineInputDef> = {
      audience: { type: 'choice', options: ['eng', 'pm'] },
    };
    const pipeline = makeMinimalPipeline({ task_ready: defs });
    const result = resolveTriggerInputDefs(pipeline, 'task_ready');
    expect(result).toEqual(defs);
  });

  it('does not reuse dispatch inputs for plan_ready when plan_ready inputs are absent', () => {
    const defs: Record<string, PipelineInputDef> = {
      env: { type: 'string' },
    };
    const pipeline = makeMinimalPipeline({ dispatch: defs });
    const result = resolveTriggerInputDefs(pipeline, 'plan_ready');
    expect(result).toEqual({});
  });

  it('returns empty object when dispatch inputs are absent', () => {
    const defs: Record<string, PipelineInputDef> = {
      max_iterations: { type: 'number', default: 2 },
    };
    const pipeline = makeMinimalPipeline({ plan_ready: defs });
    const result = resolveTriggerInputDefs(pipeline, 'dispatch');
    expect(result).toEqual({});
  });

  it('does not leak inputs between trigger types', () => {
    const dispatchDefs: Record<string, PipelineInputDef> = {
      env: { type: 'string' },
    };
    const planReadyDefs: Record<string, PipelineInputDef> = {
      max_iterations: { type: 'number', default: 2 },
    };
    const pipeline = makeMinimalPipeline({
      dispatch: dispatchDefs,
      plan_ready: planReadyDefs,
    });

    expect(resolveTriggerInputDefs(pipeline, 'dispatch')).toEqual(dispatchDefs);
    expect(resolveTriggerInputDefs(pipeline, 'plan_ready')).toEqual(
      planReadyDefs,
    );
  });

  it('does not reuse dispatch inputs for task_ready when task_ready inputs are absent', () => {
    const defs: Record<string, PipelineInputDef> = {
      env: { type: 'string' },
    };
    const pipeline = makeMinimalPipeline({ dispatch: defs });
    const result = resolveTriggerInputDefs(pipeline, 'task_ready');
    expect(result).toEqual({});
  });

  it('falls back to raw trigger config when normalized trigger_inputs is empty', () => {
    const pipeline = makeMinimalPipeline();
    const rawTrigger = {
      dispatch: {
        inputs: {
          branch: { type: 'string' as const, required: true },
        },
      },
    };
    const result = resolveTriggerInputDefs(pipeline, 'dispatch', rawTrigger);
    expect(result).toEqual({ branch: { type: 'string', required: true } });
  });

  it('prefers normalized trigger_inputs over raw trigger when both exist', () => {
    const normalizedDefs: Record<string, PipelineInputDef> = {
      env: { type: 'string', default: 'prod' },
    };
    const pipeline = makeMinimalPipeline({ dispatch: normalizedDefs });
    const rawTrigger = {
      dispatch: {
        inputs: {
          env: { type: 'string' as const, default: 'staging' },
        },
      },
    };
    const result = resolveTriggerInputDefs(pipeline, 'dispatch', rawTrigger);
    expect(result).toEqual(normalizedDefs);
  });
});

describe('resolvePipelineTriggerInputs', () => {
  it('returns normalized trigger inputs for a valid pipeline', () => {
    const pipeline: Pipeline = {
      name: 'valid-pipeline',
      version: '1',
      on: {
        dispatch: {
          inputs: {
            env: { type: 'choice', options: ['dev', 'prod'] },
          },
        },
      },
      jobs: {},
    };

    expect(resolvePipelineTriggerInputs(pipeline, 'dispatch')).toEqual({
      inputDefs: {
        env: { type: 'choice', options: ['dev', 'prod'] },
      },
      error: null,
    });
  });

  it('returns no inputs for plan_ready runs when only dispatch inputs exist', () => {
    const pipeline: Pipeline = {
      name: 'dispatch-fallback',
      version: '1',
      on: {
        dispatch: {
          inputs: {
            branch: { type: 'string', required: true },
          },
        },
        plan_ready: {},
      },
      jobs: {},
    };

    expect(resolvePipelineTriggerInputs(pipeline, 'plan_ready')).toEqual({
      inputDefs: {},
      error: null,
    });
  });

  it('returns a recoverable error for malformed stored pipelines', () => {
    const pipeline: Pipeline = {
      name: 'invalid-pipeline',
      version: '1',
      on: {},
      jobs: {},
    };

    expect(resolvePipelineTriggerInputs(pipeline, 'dispatch')).toEqual({
      inputDefs: {},
      error:
        'Pipeline "on" field must define at least one trigger type (e.g., "dispatch")',
    });
  });
});

describe('input UI visibility hints', () => {
  it('shows inputs by default', () => {
    expect(shouldShowPipelineInputInUi({ type: 'string' })).toBe(true);
  });

  it('hides hinted optional inputs', () => {
    expect(
      shouldShowPipelineInputInUi({
        type: 'string',
        required: false,
        'hint-hide-ui-option': true,
      }),
    ).toBe(false);
  });

  it('hides hinted required inputs when a default is available', () => {
    expect(
      shouldShowPipelineInputInUi({
        type: 'string',
        required: true,
        default: 'artifact.json',
        'hint-hide-ui-option': true,
      }),
    ).toBe(false);
  });

  it('keeps hinted required inputs visible when no default is available', () => {
    expect(
      shouldShowPipelineInputInUi({
        type: 'string',
        required: true,
        'hint-hide-ui-option': true,
      }),
    ).toBe(true);
  });

  it('filters hidden inputs from UI-facing definitions', () => {
    const defs: Record<string, PipelineInputDef> = {
      visible_required: { type: 'string', required: true },
      hidden_optional: {
        type: 'string',
        required: false,
        'hint-hide-ui-option': true,
      },
      hidden_defaulted: {
        type: 'string',
        required: true,
        default: 'default.txt',
        'hint-hide-ui-option': true,
      },
      visible_hinted_required: {
        type: 'string',
        required: true,
        'hint-hide-ui-option': true,
      },
    };

    expect(getVisibleTriggerInputDefs(defs)).toEqual({
      visible_required: defs.visible_required,
      visible_hinted_required: defs.visible_hinted_required,
    });
  });
});

describe('initializeInputValues', () => {
  it('returns empty object for empty defs', () => {
    expect(initializeInputValues({})).toEqual({});
  });

  it('fills defaults from definitions', () => {
    const defs: Record<string, PipelineInputDef> = {
      iterations: { type: 'number', default: 3 },
      name: { type: 'string', default: 'hello' },
    };
    const result = initializeInputValues(defs);
    expect(result).toEqual({ iterations: '3', name: 'hello' });
  });

  it('uses empty string when no default is provided', () => {
    const defs: Record<string, PipelineInputDef> = {
      required_field: { type: 'string', required: true },
    };
    const result = initializeInputValues(defs);
    expect(result).toEqual({ required_field: '' });
  });

  it('converts boolean defaults to string', () => {
    const defs: Record<string, PipelineInputDef> = {
      flag: { type: 'boolean', default: true },
    };
    const result = initializeInputValues(defs);
    expect(result).toEqual({ flag: 'true' });
  });
});

describe('validateInputs', () => {
  it('returns empty errors for valid inputs', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string' },
    };
    const result = validateInputs(defs, { name: 'test' });
    expect(result).toEqual({});
  });

  it('reports required field when empty', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string', required: true },
    };
    const result = validateInputs(defs, { name: '' });
    expect(result).toEqual({ name: 'This field is required' });
  });

  it('skips validation for empty optional fields', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string' },
    };
    const result = validateInputs(defs, { name: '' });
    expect(result).toEqual({});
  });

  it('validates number type - not a number', () => {
    const defs: Record<string, PipelineInputDef> = {
      count: { type: 'number' },
    };
    const result = validateInputs(defs, { count: 'abc' });
    expect(result).toEqual({ count: 'Must be a valid number' });
  });

  it('validates number type - below min', () => {
    const defs: Record<string, PipelineInputDef> = {
      count: { type: 'number', min: 1 },
    };
    const result = validateInputs(defs, { count: '0' });
    expect(result).toEqual({ count: 'Must be at least 1' });
  });

  it('validates number type - above max', () => {
    const defs: Record<string, PipelineInputDef> = {
      count: { type: 'number', max: 10 },
    };
    const result = validateInputs(defs, { count: '11' });
    expect(result).toEqual({ count: 'Must be at most 10' });
  });

  it('validates choice type - invalid option', () => {
    const defs: Record<string, PipelineInputDef> = {
      env: { type: 'choice', options: ['dev', 'staging', 'prod'] },
    };
    const result = validateInputs(defs, { env: 'invalid' });
    expect(result).toEqual({
      env: 'Must be one of: dev, staging, prod',
    });
  });

  it('validates choice type - valid option', () => {
    const defs: Record<string, PipelineInputDef> = {
      env: { type: 'choice', options: ['dev', 'staging', 'prod'] },
    };
    const result = validateInputs(defs, { env: 'staging' });
    expect(result).toEqual({});
  });

  it('reports multiple errors for multiple invalid fields', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string', required: true },
      count: { type: 'number', min: 1 },
    };
    const result = validateInputs(defs, { name: '', count: '0' });
    expect(Object.keys(result)).toHaveLength(2);
    expect(result.name).toBe('This field is required');
    expect(result.count).toBe('Must be at least 1');
  });

  it('treats missing values as empty strings', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string', required: true },
    };
    const result = validateInputs(defs, {});
    expect(result).toEqual({ name: 'This field is required' });
  });
});

describe('buildSubmitPayload', () => {
  it('returns empty object for empty defs', () => {
    expect(buildSubmitPayload({}, {})).toEqual({});
  });

  it('includes non-empty values', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string' },
      count: { type: 'number' },
    };
    const result = buildSubmitPayload(defs, { name: 'hello', count: '5' });
    expect(result).toEqual({ name: 'hello', count: '5' });
  });

  it('excludes empty values', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string' },
      opt: { type: 'string' },
    };
    const result = buildSubmitPayload(defs, { name: 'hello', opt: '' });
    expect(result).toEqual({ name: 'hello' });
  });

  it('trims whitespace from values', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string' },
    };
    const result = buildSubmitPayload(defs, { name: '  hello  ' });
    expect(result).toEqual({ name: 'hello' });
  });

  it('excludes whitespace-only values', () => {
    const defs: Record<string, PipelineInputDef> = {
      name: { type: 'string' },
    };
    const result = buildSubmitPayload(defs, { name: '   ' });
    expect(result).toEqual({});
  });
});

describe('structured (json) trigger inputs', () => {
  const defs: Record<string, PipelineInputDef> = {
    items: { type: 'json' },
  };

  it('pre-fills the textarea from array, object, scalar, and null defaults', () => {
    expect(
      initializeInputValues({ items: { type: 'json', default: ['a', 'b'] } })
        .items,
    ).toBe('[\n  "a",\n  "b"\n]');
    expect(
      initializeInputValues({ items: { type: 'json', default: { a: 1 } } })
        .items,
    ).toBe('{\n  "a": 1\n}');
    expect(
      initializeInputValues({ items: { type: 'json', default: 7 } }).items,
    ).toBe('7');
    expect(
      initializeInputValues({ items: { type: 'json', default: null } }).items,
    ).toBe('null');
  });

  it.each(['plain', '[1,2]', 'null', 'true', '1'])(
    'quotes the string default %p so submission preserves its type',
    (value) => {
      expect(
        initializeInputValues({ items: { type: 'json', default: value } })
          .items,
      ).toBe(JSON.stringify(value));
    },
  );

  it('preserves native arrays and scalar defaults without quoting them', () => {
    expect(
      initializeInputValues({ items: { type: 'json', default: [1, 2] } }).items,
    ).toBe('[\n  1,\n  2\n]');
    expect(
      initializeInputValues({ items: { type: 'json', default: true } }).items,
    ).toBe('true');
  });

  it('leaves scalar-typed defaults serialized exactly as before', () => {
    expect(
      initializeInputValues({
        count: { type: 'number', default: 3 },
        flag: { type: 'boolean', default: false },
      }),
    ).toEqual({ count: '3', flag: 'false' });
  });

  it('accepts arrays, objects, scalars, and null on submit', () => {
    for (const value of ['[1,2]', '{"a":1}', '"text"', '3', 'true', 'null']) {
      expect(validateInputs(defs, { items: value })).toEqual({});
    }
  });

  it('blocks submission on invalid JSON', () => {
    expect(validateInputs(defs, { items: '{oops' })).toEqual({
      items: 'Enter valid JSON.',
    });
    expect(validateInputs(defs, { items: 'plain text' })).toEqual({
      items: 'Enter valid JSON.',
    });
  });

  it('still treats an empty optional json input as valid', () => {
    expect(validateInputs(defs, { items: '' })).toEqual({});
    expect(
      validateInputs(
        { items: { type: 'json', required: true } },
        {
          items: '',
        },
      ),
    ).toEqual({ items: 'This field is required' });
  });

  it('forwards the raw string, keeping the launch payload Record<string, string>', () => {
    const payload = buildSubmitPayload(defs, { items: ' [1, 2] ' });
    expect(payload).toEqual({ items: '[1, 2]' });
    expect(typeof payload['items']).toBe('string');
  });
});

describe('parseJsonInputValue', () => {
  it('parses arrays, object maps, scalars, and null', () => {
    expect(parseJsonInputValue('[1, 2]')).toEqual([1, 2]);
    expect(parseJsonInputValue('{"a": {"b": [true, null]}}')).toEqual({
      a: { b: [true, null] },
    });
    expect(parseJsonInputValue('"text"')).toBe('text');
    expect(parseJsonInputValue('3')).toBe(3);
    expect(parseJsonInputValue('true')).toBe(true);
    // `null` is a legitimate value, so the failure signal is `undefined`.
    expect(parseJsonInputValue('null')).toBeNull();
    expect(isValidJsonInputValue('null')).toBe(true);
  });

  it('validates nested values recursively', () => {
    // Deeply nested structures are walked all the way down rather than
    // accepted on the strength of the top-level parse alone.
    expect(
      parseJsonInputValue('[{"a": [{"b": [1, "two", false, null]}]}]'),
    ).toEqual([{ a: [{ b: [1, 'two', false, null] }] }]);
    expect(
      isValidJsonInputValue('[{"a": [{"b": [1, "two", false, null]}]}]'),
    ).toBe(true);
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseJsonInputValue('{oops')).toBeUndefined();
    expect(parseJsonInputValue('plain text')).toBeUndefined();
    expect(parseJsonInputValue('')).toBeUndefined();
    expect(parseJsonInputValue('[1, 2')).toBeUndefined();
    expect(isValidJsonInputValue('{oops')).toBe(false);
  });
});
