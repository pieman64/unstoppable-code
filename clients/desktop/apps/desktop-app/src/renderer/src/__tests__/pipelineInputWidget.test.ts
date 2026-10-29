import {
  getTypedInputInitialValue,
  hasTypedWidget,
  valueFitsTypedWidget,
} from '../lib/pipelineInputWidget';

describe('hasTypedWidget', () => {
  it('returns false for unset and string types', () => {
    expect(hasTypedWidget({})).toBe(false);
    expect(hasTypedWidget({ type: 'string' })).toBe(false);
  });

  it('returns true for boolean and number types', () => {
    expect(hasTypedWidget({ type: 'boolean' })).toBe(true);
    expect(hasTypedWidget({ type: 'number' })).toBe(true);
  });

  it('returns true for choice only when options are present', () => {
    expect(hasTypedWidget({ type: 'choice' })).toBe(false);
    expect(hasTypedWidget({ type: 'choice', options: [] })).toBe(false);
    expect(hasTypedWidget({ type: 'choice', options: ['a', 'b'] })).toBe(true);
  });
});

describe('valueFitsTypedWidget', () => {
  it('treats empty values as fitting any widget', () => {
    expect(valueFitsTypedWidget('', { type: 'choice', options: ['a'] })).toBe(
      true,
    );
    expect(valueFitsTypedWidget('', { type: 'boolean' })).toBe(true);
    expect(valueFitsTypedWidget('', { type: 'number' })).toBe(true);
  });

  it('accepts only true/false for boolean', () => {
    expect(valueFitsTypedWidget('true', { type: 'boolean' })).toBe(true);
    expect(valueFitsTypedWidget('false', { type: 'boolean' })).toBe(true);
    expect(valueFitsTypedWidget('TRUE', { type: 'boolean' })).toBe(false);
    expect(valueFitsTypedWidget('1', { type: 'boolean' })).toBe(false);
    expect(valueFitsTypedWidget('{{CANOPY_PR_URL}}', { type: 'boolean' })).toBe(
      false,
    );
  });

  it('accepts finite numbers within min/max for number', () => {
    expect(valueFitsTypedWidget('5', { type: 'number' })).toBe(true);
    expect(valueFitsTypedWidget('5.25', { type: 'number' })).toBe(true);
    expect(valueFitsTypedWidget('-3', { type: 'number' })).toBe(true);
    expect(valueFitsTypedWidget('abc', { type: 'number' })).toBe(false);
    expect(
      valueFitsTypedWidget('{{CANOPY_PRIORITY}}', { type: 'number' }),
    ).toBe(false);
    expect(valueFitsTypedWidget('5', { type: 'number', min: 10 })).toBe(false);
    expect(valueFitsTypedWidget('5', { type: 'number', max: 3 })).toBe(false);
    expect(valueFitsTypedWidget('5', { type: 'number', min: 1, max: 10 })).toBe(
      true,
    );
  });

  it('accepts only listed options for choice', () => {
    const def = { type: 'choice' as const, options: ['daily', 'weekly'] };
    expect(valueFitsTypedWidget('daily', def)).toBe(true);
    expect(valueFitsTypedWidget('weekly', def)).toBe(true);
    expect(valueFitsTypedWidget('hourly', def)).toBe(false);
    expect(valueFitsTypedWidget('{{CANOPY_CADENCE}}', def)).toBe(false);
  });

  it('accepts any value for choice when options are absent', () => {
    expect(valueFitsTypedWidget('anything', { type: 'choice' })).toBe(true);
  });

  it('always fits unset and string types', () => {
    expect(valueFitsTypedWidget('anything', {})).toBe(true);
    expect(valueFitsTypedWidget('anything', { type: 'string' })).toBe(true);
    expect(valueFitsTypedWidget('{{CANOPY_PR_URL}}', { type: 'string' })).toBe(
      true,
    );
  });
});

describe('getTypedInputInitialValue', () => {
  it('uses the pipeline default when present', () => {
    expect(
      getTypedInputInitialValue({
        type: 'choice',
        options: ['daily', 'weekly'],
        default: 'weekly',
      }),
    ).toBe('weekly');
    expect(getTypedInputInitialValue({ type: 'boolean', default: true })).toBe(
      'true',
    );
    expect(getTypedInputInitialValue({ type: 'number', default: 42 })).toBe(
      '42',
    );
  });

  it('falls back to false for boolean without a default', () => {
    expect(getTypedInputInitialValue({ type: 'boolean' })).toBe('false');
  });

  it('falls back to the first option for choice without a default', () => {
    expect(
      getTypedInputInitialValue({
        type: 'choice',
        options: ['daily', 'weekly'],
      }),
    ).toBe('daily');
  });

  it('returns empty when no default and no fallback applies', () => {
    expect(getTypedInputInitialValue({ type: 'number' })).toBe('');
    expect(getTypedInputInitialValue({ type: 'string' })).toBe('');
    expect(getTypedInputInitialValue({})).toBe('');
    expect(getTypedInputInitialValue({ type: 'choice' })).toBe('');
  });
});

describe('json input widget', () => {
  it('has no typed widget to toggle (its widget is the raw textarea)', () => {
    expect(hasTypedWidget({ type: 'json' })).toBe(false);
  });

  it('treats parseable JSON as fitting and unparseable text as a raw override', () => {
    expect(valueFitsTypedWidget('[1,2]', { type: 'json' })).toBe(true);
    expect(valueFitsTypedWidget('null', { type: 'json' })).toBe(true);
    expect(valueFitsTypedWidget('{oops', { type: 'json' })).toBe(false);
    expect(valueFitsTypedWidget('', { type: 'json' })).toBe(true);
  });

  it('serializes a structured default instead of stringifying it', () => {
    expect(getTypedInputInitialValue({ type: 'json', default: { a: 1 } })).toBe(
      '{\n  "a": 1\n}',
    );
    expect(getTypedInputInitialValue({ type: 'json', default: ['a'] })).toBe(
      '[\n  "a"\n]',
    );
  });
});
