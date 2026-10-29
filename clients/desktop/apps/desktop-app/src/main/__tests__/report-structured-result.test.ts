import {
  normalizeAjvDataPath,
  validateAgainstSchema,
} from '../canopy-tools/report-structured-result';

describe('validateAgainstSchema', () => {
  it('accepts payloads that match the provided JSON schema', () => {
    const result = validateAgainstSchema(
      {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
      { title: 'Ship workers' },
    );

    expect(result).toEqual({ ok: true });
  });

  it('returns a validation error for mismatched payloads', () => {
    const result = validateAgainstSchema(
      {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
      { title: 42 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('/title');
  });

  it('normalizes AJV v6 quoted bracket property paths', () => {
    expect(normalizeAjvDataPath(".items['foo bar'][0]")).toBe(
      '/items/foo bar/0',
    );
    expect(normalizeAjvDataPath('.items["foo-bar"]')).toBe('/items/foo-bar');
  });

  it('accepts schemas with non-standard keywords for dynamic tool compatibility', () => {
    const result = validateAgainstSchema(
      {
        type: 'object',
        properties: { title: { type: 'string', customKeyword: true } },
      },
      { title: 'Ship workers' },
    );

    expect(result).toEqual({ ok: true });
  });

  it('returns an error for malformed schemas', () => {
    const result = validateAgainstSchema(
      { type: 'definitely-not-json-schema' },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
