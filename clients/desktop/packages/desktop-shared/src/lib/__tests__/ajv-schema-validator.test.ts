import {
  normalizeAjvDataPath,
  validateAgainstSchema,
} from '../ajv-schema-validator';

describe('validateAgainstSchema', () => {
  it('never echoes a property name the schema did not declare', () => {
    // The failing property's NAME comes from the agent's response, not from
    // the pipeline. That message becomes the outbound structured-output retry
    // prompt and the persisted failure, so a configured value used as a
    // property name would travel back to the vendor. JSON Pointer escaping
    // also changes `/` to `~1`, which is exactly the kind of transformation
    // that a later exact-value pass cannot recognise — so neither the raw nor
    // the escaped form may appear.
    const result = validateAgainstSchema(
      { type: 'object', additionalProperties: { type: 'number' } },
      { 'EXAMPLE/VALUE': 'not a number' },
    );

    expect(result.ok).toBe(false);
    const message = result.error ?? '';
    expect(message).not.toContain('EXAMPLE/VALUE');
    expect(message).not.toContain('EXAMPLE~1VALUE');
    expect(message).not.toContain('EXAMPLE');
    // It still has to say something useful about what failed.
    expect(message).toContain('must be number');
  });

  it.each([
    '9384716502',
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
  ])(
    'hides the data-chosen property name %s even when the schema declares others',
    (name) => {
      // Two separate misclassifications leaked these. A numeric segment was
      // taken for an array position without checking that the data there IS
      // an array — JSON object keys can be any string, digits included. And
      // `segment in properties` answered yes for names inherited from
      // `Object.prototype`, which no schema author declared.
      const result = validateAgainstSchema(
        {
          type: 'object',
          properties: { declared: { type: 'number' } },
          additionalProperties: { type: 'number' },
        },
        JSON.parse(`{${JSON.stringify(name)}:"wrong-type"}`),
      );
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain(name);
      expect(result.error).toContain('/<property> must be number');
    },
  );

  it('keeps real array positions and hides numeric object keys', () => {
    const result = validateAgainstSchema(
      {
        type: 'object',
        properties: {
          list: { type: 'array', items: { type: 'number' } },
          map: { type: 'object', additionalProperties: { type: 'number' } },
        },
      },
      { list: [1, 'two'], map: { '7731': 'x' } },
    );
    expect(result.error).toContain('/list/1 must be number');
    expect(result.error).toContain('/map/<property> must be number');
    expect(result.error).not.toContain('7731');
  });

  it('keeps declared names reached through $ref and composition', () => {
    // A shallow walk of `properties` alone lost every author-written segment
    // behind a reference or a combinator — exactly the schemas most likely to
    // fail and most in need of a useful retry prompt.
    const result = validateAgainstSchema(
      {
        type: 'object',
        definitions: {
          item: {
            type: 'object',
            properties: { price: { type: 'number' } },
            additionalProperties: { type: 'number' },
          },
        },
        $defs: {
          meta: { type: 'object', properties: { owner: { type: 'string' } } },
        },
        allOf: [
          { properties: { order: { $ref: '#/definitions/item' } } },
          { properties: { meta: { $ref: '#/$defs/meta' } } },
        ],
        anyOf: [{ properties: { tag: { type: 'string' } } }],
        properties: {
          rows: {
            type: 'array',
            items: { oneOf: [{ $ref: '#/definitions/item' }] },
          },
        },
      },
      {
        order: { price: 'free', SECRETKEY: 'x' },
        meta: { owner: 5 },
        tag: 9,
        rows: [{ price: 'nope' }],
      },
    );
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('/order/price must be number');
    expect(error).toContain('/order/<property> must be number');
    expect(error).toContain('/meta/owner must be string');
    expect(error).toContain('/tag must be string');
    expect(error).toContain('/rows/0/price must be number');
    expect(error).not.toContain('SECRETKEY');
  });

  it('does not treat a declared-looking name under patternProperties as declared', () => {
    const result = validateAgainstSchema(
      {
        type: 'object',
        patternProperties: { '^S': { type: 'number' } },
      },
      { SECRETNAME: 'x' },
    );
    expect(result.error).not.toContain('SECRETNAME');
  });

  it('keeps naming the properties the schema itself declares', () => {
    // The opposite side of the same rule: a name the pipeline author wrote in
    // the schema is not agent-derived, and dropping it would make every retry
    // prompt useless.
    const result = validateAgainstSchema(
      {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          items: { type: 'array', items: { type: 'number' } },
        },
      },
      { summary: 7, items: [1, 'two'] },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('summary');
    // Array positions carry no payload text, so they stay too.
    expect(result.error).toContain('items/1');
  });

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

  it('flags a structured-output payload missing a required field', () => {
    const result = validateAgainstSchema(
      { type: 'object', required: ['summary'] },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('summary');
  });
});
