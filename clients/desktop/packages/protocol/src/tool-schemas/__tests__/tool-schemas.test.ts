import {
  flattenToolJsonSchema,
  stripStrictNulls,
  toStrictToolSchema,
  type JsonSchemaValue,
} from '..';
import { measureWork } from '../../__tests__/helpers/work-meter';

const vector1: JsonSchemaValue = {
  type: 'object',
  properties: { query: { type: 'string' }, limit: { type: 'integer' } },
  required: ['query'],
};
const vector2: JsonSchemaValue = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { q: { type: 'string' }, limit: { type: 'integer' } },
        required: ['q'],
      },
    },
  },
  required: ['items'],
};
const vector3: JsonSchemaValue = {
  type: 'object',
  properties: { note: { type: ['string', 'null'] } },
};
const vector4: JsonSchemaValue = {
  type: 'object',
  properties: { mode: { type: 'string', enum: ['a', 'b'] } },
};
const vector5: JsonSchemaValue = {
  type: 'object',
  properties: {
    if: { type: 'string' },
    anyOf: { type: 'string' },
    required: { type: 'boolean' },
  },
  required: ['if'],
};
const vector6: JsonSchemaValue = {
  type: 'object',
  additionalProperties: true,
};

describe('toStrictToolSchema', () => {
  it('vector 1: requires every key and makes optional ones nullable', () => {
    expect(toStrictToolSchema(vector1)).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: ['integer', 'null'] },
      },
      required: ['query', 'limit'],
      additionalProperties: false,
    });
  });

  it('vector 2: makes an object nested in array items strict', () => {
    expect(toStrictToolSchema(vector2)).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              q: { type: 'string' },
              limit: { type: ['integer', 'null'] },
            },
            required: ['q', 'limit'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    });
  });

  it('vector 3: leaves an already-nullable optional unchanged apart from required', () => {
    expect(toStrictToolSchema(vector3)).toEqual({
      type: 'object',
      properties: { note: { type: ['string', 'null'] } },
      required: ['note'],
      additionalProperties: false,
    });
  });

  it('vector 4: appends null to an optional enum and its type', () => {
    expect(toStrictToolSchema(vector4)).toEqual({
      type: 'object',
      properties: {
        mode: { type: ['string', 'null'], enum: ['a', 'b', null] },
      },
      required: ['mode'],
      additionalProperties: false,
    });
  });

  it('vector 5: keeps properties named after keywords', () => {
    expect(toStrictToolSchema(vector5)).toEqual({
      type: 'object',
      properties: {
        if: { type: 'string' },
        anyOf: { type: ['string', 'null'] },
        required: { type: ['boolean', 'null'] },
      },
      required: ['if', 'anyOf', 'required'],
      additionalProperties: false,
    });
  });

  it('vector 6: closes an open record and reports it', () => {
    const onLossy = jest.fn();
    expect(toStrictToolSchema(vector6, { onLossy })).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(onLossy).toHaveBeenCalledWith(
      '#/additionalProperties',
      expect.stringContaining('open record'),
    );
  });

  it('vector 7: is idempotent on vectors 1 to 6', () => {
    for (const vector of [
      vector1,
      vector2,
      vector3,
      vector4,
      vector5,
      vector6,
    ]) {
      const once = toStrictToolSchema(vector);
      const onLossy = jest.fn();
      expect(toStrictToolSchema(once, { onLossy })).toEqual(once);
      expect(onLossy).not.toHaveBeenCalled();
    }
  });

  it('never mutates its input', () => {
    const input = structuredClone(vector2);
    toStrictToolSchema(input);
    expect(input).toEqual(vector2);
  });

  it('wraps a const, untyped, $ref or anyOf property and moves its description', () => {
    expect(
      toStrictToolSchema({
        type: 'object',
        properties: {
          kind: { const: 'x', type: 'string', description: 'Kind' },
          anything: { description: 'Any value at all', minimum: 1 },
          ref: { $ref: '#/$defs/Thing' },
          either: {
            type: 'string',
            anyOf: [{ minLength: 1 }, { maxLength: 0 }],
          },
          open: {},
        },
        $defs: {
          Thing: { type: 'object', properties: { a: { type: 'string' } } },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        kind: {
          description: 'Kind',
          anyOf: [{ const: 'x', type: 'string' }, { type: 'null' }],
        },
        anything: {
          description: 'Any value at all',
          anyOf: [{ minimum: 1 }, { type: 'null' }],
        },
        ref: { anyOf: [{ $ref: '#/$defs/Thing' }, { type: 'null' }] },
        either: {
          anyOf: [
            { type: 'string', anyOf: [{ minLength: 1 }, { maxLength: 0 }] },
            { type: 'null' },
          ],
        },
        open: {},
      },
      required: ['kind', 'anything', 'ref', 'either', 'open'],
      additionalProperties: false,
      $defs: {
        Thing: {
          type: 'object',
          properties: { a: { type: ['string', 'null'] } },
          required: ['a'],
          additionalProperties: false,
        },
      },
    });
  });

  it('treats an optional anyOf with a null member as already nullable', () => {
    expect(
      toStrictToolSchema({
        type: 'object',
        properties: {
          v: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          w: { enum: ['a', null] },
          x: { const: null },
          y: true,
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        v: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        w: { enum: ['a', null] },
        x: { const: null },
        y: true,
      },
      required: ['v', 'w', 'x', 'y'],
      additionalProperties: false,
    });
  });

  it('turns oneOf into anyOf and makes each member strict', () => {
    expect(
      toStrictToolSchema({
        oneOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'string' },
        ],
      }),
    ).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { a: { type: ['string', 'null'] } },
          required: ['a'],
          additionalProperties: false,
        },
        { type: 'string' },
      ],
    });
  });

  it('appends oneOf members to an existing anyOf and reports the merge', () => {
    const onLossy = jest.fn<void, [string, string]>();
    expect(
      toStrictToolSchema(
        {
          type: 'object',
          properties: {
            u: { oneOf: [{ type: 'string' }], anyOf: [{ type: 'number' }] },
          },
          required: ['u'],
        },
        { onLossy },
      ),
    ).toEqual({
      type: 'object',
      properties: { u: { anyOf: [{ type: 'number' }, { type: 'string' }] } },
      required: ['u'],
      additionalProperties: false,
    });
    expect(onLossy).toHaveBeenCalledTimes(1);
    expect(onLossy).toHaveBeenCalledWith(
      '#/properties/u/oneOf',
      expect.stringContaining('merged'),
    );
  });

  it('drops unsupported keywords and reports each one', () => {
    const onLossy = jest.fn<void, [string, string]>();
    expect(
      toStrictToolSchema(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            n: { type: 'integer', default: 3, not: { const: 0 } },
          },
          required: ['n'],
          if: { properties: { n: { const: 1 } } },
          then: { required: ['n'] },
          else: {},
          patternProperties: { '^x-': { type: 'string' } },
          dependentRequired: { n: [] },
          dependentSchemas: { n: {} },
          unevaluatedProperties: false,
          additionalProperties: false,
        },
        { onLossy },
      ),
    ).toEqual({
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
      additionalProperties: false,
    });
    expect(onLossy.mock.calls.map(([path]) => path).sort()).toEqual(
      [
        '#/$schema',
        '#/dependentRequired',
        '#/dependentSchemas',
        '#/else',
        '#/if',
        '#/patternProperties',
        '#/properties/n/default',
        '#/properties/n/not',
        '#/then',
        '#/unevaluatedProperties',
      ].sort(),
    );
  });

  it('inlines a single-member allOf and drops a conflicting multi-member one', () => {
    const onLossy = jest.fn();
    expect(
      toStrictToolSchema(
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          allOf: [{ properties: { b: { type: 'number' } }, required: ['b'] }],
        },
        { onLossy },
      ),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    });
    expect(onLossy).not.toHaveBeenCalled();

    expect(
      toStrictToolSchema(
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          allOf: [{ minProperties: 1 }, { minProperties: 2 }],
        },
        { onLossy },
      ),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(onLossy).toHaveBeenCalledWith('#/allOf', expect.any(String));
  });

  it('closes additionalProperties beside listed properties and reports it', () => {
    const onLossy = jest.fn();
    expect(
      toStrictToolSchema(
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: { type: 'string' },
        },
        { onLossy },
      ),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(onLossy).toHaveBeenCalledWith(
      '#/additionalProperties',
      expect.any(String),
    );
  });

  it('keeps assertion and annotation keywords', () => {
    const schema: JsonSchemaValue = {
      title: 'T',
      type: 'array',
      items: [{ type: 'string', pattern: '^a', format: 'uri' }],
      prefixItems: [{ type: 'integer', minimum: 0, maximum: 9 }],
      minItems: 1,
      maxItems: 3,
    };
    expect(toStrictToolSchema(schema)).toEqual(schema);
  });

  it('keeps a __proto__ property name as data', () => {
    const properties: { [key: string]: JsonSchemaValue } = {};
    Object.defineProperty(properties, '__proto__', {
      value: { type: 'string' },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const schema: JsonSchemaValue = {
      type: 'object',
      properties,
      required: ['__proto__'],
    };
    const result = toStrictToolSchema(schema);
    expect(JSON.stringify(result)).toBe(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}',
    );
  });
});

describe('stripStrictNulls', () => {
  it('vector 8: drops a null optional key', () => {
    expect(stripStrictNulls({ query: 'x', limit: null }, vector1)).toEqual({
      query: 'x',
    });
  });

  it('vector 9: keeps null for a nullable property', () => {
    expect(
      stripStrictNulls(
        { a: null },
        { type: 'object', properties: { a: { type: ['string', 'null'] } } },
      ),
    ).toEqual({ a: null });
  });

  it('vector 10: never strips a required key', () => {
    expect(
      stripStrictNulls(
        { a: null },
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
        },
      ),
    ).toEqual({ a: null });
  });

  it('vector 11: drops a nested null inside an array of objects', () => {
    expect(
      stripStrictNulls({ items: [{ limit: null, q: 'a' }] }, vector2),
    ).toEqual({ items: [{ q: 'a' }] });
  });

  it('leaves keys the schema does not list untouched', () => {
    expect(stripStrictNulls({ query: 'x', extra: null }, vector1)).toEqual({
      query: 'x',
      extra: null,
    });
  });

  it('follows local $defs and definitions references', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      properties: {
        filter: { $ref: '#/$defs/Filter' },
        legacy: { $ref: '#/definitions/Legacy' },
        remote: { $ref: 'https://example.com/schema' },
      },
      $defs: {
        Filter: { type: 'object', properties: { limit: { type: 'integer' } } },
      },
      definitions: {
        Legacy: { type: 'object', properties: { n: { type: 'string' } } },
      },
    };
    expect(
      stripStrictNulls(
        {
          filter: { limit: null },
          legacy: { n: null },
          remote: { limit: null },
        },
        schema,
      ),
    ).toEqual({ filter: {}, legacy: {}, remote: { limit: null } });
  });

  it('keeps null for an optional reference to a nullable definition', () => {
    expect(
      stripStrictNulls(
        { a: null },
        {
          type: 'object',
          properties: { a: { $ref: '#/$defs/N' } },
          $defs: { N: { type: ['string', 'null'] } },
        },
      ),
    ).toEqual({ a: null });
  });

  it('strips through the first matching object branch of a union', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      properties: {
        options: {
          anyOf: [
            { type: 'object', properties: { depth: { type: 'integer' } } },
            { type: 'null' },
          ],
        },
        ambiguous: {
          oneOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { b: { type: 'string' } } },
          ],
        },
      },
    };
    expect(
      stripStrictNulls(
        { options: { depth: null }, ambiguous: { a: null } },
        schema,
      ),
    ).toEqual({ options: {}, ambiguous: {} });
  });

  it('walks tuple items by position', () => {
    expect(
      stripStrictNulls([{ a: null }, { b: null }], {
        type: 'array',
        prefixItems: [
          { type: 'object', properties: { a: { type: 'string' } } },
        ],
        items: { type: 'object', properties: { b: { type: 'string' } } },
      }),
    ).toEqual([{}, {}]);
  });

  it('round-trips arguments produced against the strict schema', () => {
    const strict = toStrictToolSchema(vector2);
    expect(strict).not.toEqual(vector2);
    expect(
      stripStrictNulls({ items: [{ q: 'a', limit: null }] }, vector2),
    ).toEqual({ items: [{ q: 'a' }] });
  });

  it('does not mutate its input', () => {
    const value: JsonSchemaValue = { query: 'x', limit: null };
    stripStrictNulls(value, vector1);
    expect(value).toEqual({ query: 'x', limit: null });
  });
});

const objectSchema = (
  properties: { [key: string]: JsonSchemaValue },
  required?: string[],
  extra: { [key: string]: JsonSchemaValue } = {},
): JsonSchemaValue => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
  ...extra,
});

// A `write_artifact`-like root union: no parent properties.
const unionRoot: JsonSchemaValue = {
  type: 'object',
  description: 'Write an artifact',
  anyOf: [
    objectSchema(
      {
        kind: { const: 'document' },
        name: { type: 'string' },
        payload: objectSchema(
          { title: { type: 'string' }, body: { type: 'string' } },
          ['title'],
          { additionalProperties: false },
        ),
      },
      ['kind', 'payload'],
      { additionalProperties: false },
    ),
    objectSchema(
      {
        kind: { const: 'domain' },
        name: { type: 'string' },
        payload: objectSchema(
          {
            domains: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer' },
          },
          ['domains'],
          { additionalProperties: false },
        ),
      },
      ['kind', 'payload'],
      { additionalProperties: false },
    ),
  ],
};

// A `dispatch_action`-like union: parent properties plus branches.
const dispatchUnion: JsonSchemaValue = {
  type: 'object',
  properties: { kind: { type: 'string' }, label: { type: 'string' } },
  required: ['kind'],
  anyOf: [
    {
      properties: { kind: { const: 'task' } },
      required: ['kind'],
      description: 'Task profile',
    },
    {
      properties: { kind: { const: 'named' }, profileId: { type: 'string' } },
      required: ['kind', 'profileId'],
    },
  ],
};

// A watcher-like array of `oneOf` object items with no parent object.
const watcherUnion: JsonSchemaValue = objectSchema(
  {
    items: {
      type: 'array',
      items: {
        oneOf: [
          objectSchema(
            {
              kind: { const: 'workflow_run' },
              target: { type: 'string' },
              repository: { type: 'string' },
              runAttempt: { type: 'integer' },
            },
            ['kind', 'target'],
            { additionalProperties: false },
          ),
          objectSchema(
            { kind: { const: 'pull_request' }, target: { type: 'string' } },
            ['kind', 'target'],
            { additionalProperties: false },
          ),
        ],
      },
    },
  },
  ['items'],
);

function isUnionResult(
  value: JsonSchemaValue,
): value is { anyOf: { [key: string]: JsonSchemaValue }[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(value.anyOf) &&
    value.anyOf.every(
      (member) =>
        typeof member === 'object' && member !== null && !Array.isArray(member),
    )
  );
}

describe('toStrictToolSchema object unions', () => {
  it('distributes a root union into complete strict branches', () => {
    const onLossy = jest.fn<void, [string, string]>();
    expect(toStrictToolSchema(unionRoot, { onLossy })).toEqual({
      type: 'object',
      description: 'Write an artifact',
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'document' },
            name: { type: ['string', 'null'] },
            payload: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                body: { type: ['string', 'null'] },
              },
              required: ['title', 'body'],
              additionalProperties: false,
            },
          },
          required: ['kind', 'name', 'payload'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: { const: 'domain' },
            name: { type: ['string', 'null'] },
            payload: {
              type: 'object',
              properties: {
                domains: { type: 'array', items: { type: 'string' } },
                limit: { type: ['integer', 'null'] },
              },
              required: ['domains', 'limit'],
              additionalProperties: false,
            },
          },
          required: ['kind', 'name', 'payload'],
          additionalProperties: false,
        },
      ],
    });
    expect(onLossy).not.toHaveBeenCalled();
  });

  it('merges parent properties and required into every branch', () => {
    const result = toStrictToolSchema(dispatchUnion);
    if (!isUnionResult(result)) throw new Error('expected an object union');
    expect(result).toEqual({
      type: 'object',
      anyOf: [
        {
          type: 'object',
          description: 'Task profile',
          properties: {
            kind: { const: 'task' },
            label: { type: ['string', 'null'] },
          },
          required: ['kind', 'label'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: { const: 'named' },
            label: { type: ['string', 'null'] },
            profileId: { type: 'string' },
          },
          required: ['kind', 'label', 'profileId'],
          additionalProperties: false,
        },
      ],
    });
    for (const branch of result.anyOf) {
      expect(Object.keys(branch)[0]).toBe('type');
    }
    expect(result).not.toHaveProperty('properties');
    expect(result).not.toHaveProperty('required');
    expect(result).not.toHaveProperty('additionalProperties');
  });

  it('keeps non-object members in place and merges oneOf after anyOf', () => {
    expect(
      toStrictToolSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        anyOf: [{ type: 'null' }],
        oneOf: [objectSchema({ b: { type: 'number' } }, ['b'])],
      }),
    ).toEqual({
      // The parent's own `type: 'object'` rejects null, so it stays an object.
      type: 'object',
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            a: { type: ['string', 'null'] },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
          additionalProperties: false,
        },
      ],
    });
  });

  it('keeps definitions beside a distributed union', () => {
    const result = toStrictToolSchema({
      type: 'object',
      anyOf: [objectSchema({ r: { $ref: '#/$defs/R' } }, ['r'])],
      $defs: { R: objectSchema({ x: { type: 'string' } }) },
    });
    expect(result).toMatchObject({
      $defs: {
        R: {
          properties: { x: { type: ['string', 'null'] } },
          additionalProperties: false,
        },
      },
    });
  });

  it('makes each oneOf object item strict without a parent object', () => {
    expect(toStrictToolSchema(watcherUnion)).toMatchObject({
      properties: {
        items: {
          items: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  repository: { type: ['string', 'null'] },
                  runAttempt: { type: ['integer', 'null'] },
                },
                required: ['kind', 'target', 'repository', 'runAttempt'],
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['kind', 'target'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
    });
  });

  it('types a bare root union whose members are all objects', () => {
    const bareRoot: JsonSchemaValue = {
      anyOf: [
        objectSchema({ a: { type: 'string' } }, ['a']),
        objectSchema({ b: { type: 'number' } }),
      ],
    };
    const result = toStrictToolSchema(bareRoot);
    expect(result).toEqual({
      type: 'object',
      anyOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { b: { type: ['number', 'null'] } },
          required: ['b'],
          additionalProperties: false,
        },
      ],
    });
    expect(toStrictToolSchema(result)).toEqual(result);
  });

  it('leaves a bare root union with a non-object member untyped', () => {
    const result = toStrictToolSchema({
      oneOf: [objectSchema({ a: { type: 'string' } }, ['a']), { type: 'null' }],
    });
    expect(result).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    });
    expect(toStrictToolSchema(result)).toEqual(result);
  });

  it('leaves a nested bare object union untyped', () => {
    const result = toStrictToolSchema(
      objectSchema(
        {
          target: {
            anyOf: [
              objectSchema({ a: { type: 'string' } }, ['a']),
              objectSchema({ b: { type: 'string' } }, ['b']),
            ],
          },
        },
        ['target'],
      ),
    );
    expect(result).toHaveProperty('properties.target.anyOf');
    expect(result).not.toHaveProperty('properties.target.type');
    expect(toStrictToolSchema(result)).toEqual(result);
  });

  it('keeps null on a nullable object union (nullable_obj_union)', () => {
    const schema = objectSchema(
      {
        opt: {
          type: ['object', 'null'],
          anyOf: [
            objectSchema({ x: { const: 1 } }, ['x']),
            objectSchema({ y: { const: 2 } }, ['y']),
          ],
        },
      },
      ['opt'],
    );
    const result = toStrictToolSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        opt: {
          type: ['object', 'null'],
          anyOf: [
            {
              type: 'object',
              properties: { x: { const: 1 } },
              required: ['x'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { y: { const: 2 } },
              required: ['y'],
              additionalProperties: false,
            },
            { type: 'null' },
          ],
        },
      },
      required: ['opt'],
      additionalProperties: false,
    });
    expect(toStrictToolSchema(result)).toEqual(result);
    expect(stripStrictNulls({ opt: null }, schema)).toEqual({ opt: null });
  });

  it('is idempotent on object unions', () => {
    for (const schema of [unionRoot, dispatchUnion, watcherUnion]) {
      const once = toStrictToolSchema(schema);
      expect(toStrictToolSchema(once)).toEqual(once);
    }
  });
});

describe('toStrictToolSchema $ref nodes', () => {
  it('keeps a $ref node open and converts its definition (ref_object)', () => {
    const onLossy = jest.fn<void, [string, string]>();
    expect(
      toStrictToolSchema(
        {
          type: 'object',
          properties: { item: { type: 'object', $ref: '#/$defs/Item' } },
          required: ['item'],
          $defs: {
            Item: objectSchema(
              { name: { type: 'string' }, size: { type: 'integer' } },
              ['name'],
              { additionalProperties: false },
            ),
          },
        },
        { onLossy },
      ),
    ).toEqual({
      type: 'object',
      properties: { item: { type: 'object', $ref: '#/$defs/Item' } },
      required: ['item'],
      additionalProperties: false,
      $defs: {
        Item: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            size: { type: ['integer', 'null'] },
          },
          required: ['name', 'size'],
          additionalProperties: false,
        },
      },
    });
    expect(onLossy).not.toHaveBeenCalled();
  });

  it('drops other keywords beside $ref and still wraps an optional reference', () => {
    const onLossy = jest.fn<void, [string, string]>();
    expect(
      toStrictToolSchema(
        objectSchema({
          item: {
            $ref: '#/$defs/Item',
            description: 'An item',
            properties: { x: { type: 'string' } },
            minProperties: 1,
          },
        }),
        { onLossy },
      ),
    ).toEqual({
      type: 'object',
      properties: {
        item: {
          description: 'An item',
          anyOf: [{ $ref: '#/$defs/Item' }, { type: 'null' }],
        },
      },
      required: ['item'],
      additionalProperties: false,
    });
    expect(onLossy.mock.calls.map(([path]) => path).sort()).toEqual([
      '#/properties/item/minProperties',
      '#/properties/item/properties',
    ]);
  });
});

// An outer anyOf whose `a` branch carries its own inner anyOf.
const nestedUnion: JsonSchemaValue = {
  type: 'object',
  anyOf: [
    {
      properties: { kind: { const: 'a' } },
      required: ['kind'],
      anyOf: [
        objectSchema({ x: { type: 'string' } }, ['x']),
        objectSchema({ y: { type: 'number' } }, ['y']),
      ],
    },
    objectSchema({ kind: { const: 'b' }, z: { type: 'boolean' } }, ['kind']),
  ],
};

// A tree whose children reference the root schema.
const recursiveTree: JsonSchemaValue = objectSchema(
  {
    name: { type: 'string' },
    limit: { type: 'integer' },
    children: { type: 'array', items: { $ref: '#' } },
  },
  ['name'],
);

describe('nested unions and local references', () => {
  it('distributes an inner union inside a merged branch (nested_union)', () => {
    const result = toStrictToolSchema(nestedUnion);
    expect(result).toEqual({
      type: 'object',
      anyOf: [
        {
          type: 'object',
          anyOf: [
            {
              type: 'object',
              properties: { kind: { const: 'a' }, x: { type: 'string' } },
              required: ['kind', 'x'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { kind: { const: 'a' }, y: { type: 'number' } },
              required: ['kind', 'y'],
              additionalProperties: false,
            },
          ],
        },
        {
          type: 'object',
          properties: {
            kind: { const: 'b' },
            z: { type: ['boolean', 'null'] },
          },
          required: ['kind', 'z'],
          additionalProperties: false,
        },
      ],
    });
    expect(toStrictToolSchema(result)).toEqual(result);
  });

  it('strips through the first matching sub-branch of a nested union', () => {
    // The x sub-branch matches; `y` is not one of its keys, so it stays.
    expect(
      stripStrictNulls({ kind: 'a', x: 'ok', y: null }, nestedUnion),
    ).toEqual({ kind: 'a', x: 'ok', y: null });
    expect(stripStrictNulls({ kind: 'b', z: null }, nestedUnion)).toEqual({
      kind: 'b',
    });
    // No sub-branch of `a` matches without x or y, and `b` rejects the
    // kind, so the value is returned unchanged.
    const unmatched: JsonSchemaValue = { kind: 'a', w: null };
    expect(stripStrictNulls(unmatched, nestedUnion)).toEqual(unmatched);
  });

  it('strips nulls through a self-referencing children array (recursive_ref)', () => {
    expect(
      stripStrictNulls(
        {
          name: 'root',
          limit: null,
          children: [{ name: 'c', limit: null, children: [] }],
        },
        recursiveTree,
      ),
    ).toEqual({ name: 'root', children: [{ name: 'c', children: [] }] });
    const result = toStrictToolSchema(recursiveTree);
    expect(result).toHaveProperty('properties.children.items', {
      $ref: '#/$defs/__root',
    });
    expect(toStrictToolSchema(result)).toEqual(result);
  });

  it('resolves local JSON Pointers with escaped segments and array indexes', () => {
    expect(
      stripStrictNulls(
        { a: { n: null }, b: { n: null }, c: { n: null } },
        objectSchema(
          {
            a: { $ref: '#/properties/shape' },
            b: { $ref: '#/$defs/a~1b~0c' },
            c: { $ref: '#/$defs/list/0' },
            shape: objectSchema({ n: { type: 'string' } }),
          },
          [],
          {
            $defs: {
              'a/b~c': objectSchema({ n: { type: 'string' } }),
              list: [objectSchema({ n: { type: 'string' } })],
            },
          },
        ),
      ),
    ).toEqual({ a: {}, b: {}, c: {} });
    expect(
      stripStrictNulls(
        { a: { n: null } },
        objectSchema({ a: { $ref: 'other.json#/x' } }),
      ),
    ).toEqual({ a: { n: null } });
  });
});

describe('stripStrictNulls object unions', () => {
  it('strips through the first matching root branch (union_doc)', () => {
    expect(
      stripStrictNulls(
        {
          kind: 'document',
          payload: { title: 't', body: null },
          name: null,
        },
        unionRoot,
      ),
    ).toEqual({ kind: 'document', payload: { title: 't' } });
  });

  it('skips a branch whose const does not match (union_domain)', () => {
    expect(
      stripStrictNulls(
        {
          kind: 'domain',
          payload: { domains: ['a.com'], limit: null },
          name: null,
        },
        unionRoot,
      ),
    ).toEqual({ kind: 'domain', payload: { domains: ['a.com'] } });
  });

  it('strips through a branch merged with the parent (dispatch_task)', () => {
    expect(
      stripStrictNulls(
        { kind: 'task', profileId: null, label: null },
        dispatchUnion,
      ),
    ).toEqual({ kind: 'task', profileId: null });
  });

  it('picks the branch whose required keys are present (dispatch_named)', () => {
    expect(
      stripStrictNulls(
        { kind: 'named', profileId: 'p1', label: null },
        dispatchUnion,
      ),
    ).toEqual({ kind: 'named', profileId: 'p1' });
  });

  it('strips oneOf array items by branch (watcher_run)', () => {
    expect(
      stripStrictNulls(
        {
          items: [
            {
              kind: 'workflow_run',
              target: '123',
              repository: null,
              runAttempt: null,
            },
            { kind: 'pull_request', target: 'o/r#1' },
          ],
        },
        watcherUnion,
      ),
    ).toEqual({
      items: [
        { kind: 'workflow_run', target: '123' },
        { kind: 'pull_request', target: 'o/r#1' },
      ],
    });
  });

  it('rejects a closed branch for an unlisted key and a missing required key', () => {
    const value: JsonSchemaValue = { kind: 'document', extra: 1, name: null };
    expect(stripStrictNulls(value, unionRoot)).toEqual(value);
    expect(
      stripStrictNulls({ kind: 'named', label: null }, dispatchUnion),
    ).toEqual({ kind: 'named', label: null });
  });

  it('matches union branches by the JSON type of each value (typed_union_num)', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        objectSchema(
          { id: { type: 'string' }, note: { type: ['string', 'null'] } },
          ['id'],
          { additionalProperties: false },
        ),
        objectSchema(
          { id: { type: 'integer' }, note: { type: 'string' } },
          ['id'],
          { additionalProperties: false },
        ),
      ],
    };
    expect(stripStrictNulls({ id: 1, note: null }, schema)).toEqual({ id: 1 });
    expect(stripStrictNulls({ id: 'a', note: null }, schema)).toEqual({
      id: 'a',
      note: null,
    });
    expect(stripStrictNulls({ id: 1.5, note: null }, schema)).toEqual({
      id: 1.5,
      note: null,
    });
  });

  it('requires enum membership for enums of any length (enum_union_c)', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        objectSchema(
          {
            kind: { enum: ['a', 'b'] },
            note: { type: ['string', 'null'] },
          },
          ['kind', 'note'],
          { additionalProperties: false },
        ),
        objectSchema(
          { kind: { enum: ['c', 'd'] }, note: { type: 'string' } },
          ['kind'],
          { additionalProperties: false },
        ),
      ],
    };
    expect(stripStrictNulls({ kind: 'c', note: null }, schema)).toEqual({
      kind: 'c',
    });
    expect(stripStrictNulls({ kind: 'a', note: null }, schema)).toEqual({
      kind: 'a',
      note: null,
    });
  });

  it('matches a single-value enum like a const', () => {
    const schema: JsonSchemaValue = {
      oneOf: [
        objectSchema({ k: { enum: ['a'] }, x: { type: 'string' } }, ['k']),
        objectSchema({ k: { enum: ['b'] }, y: { type: 'string' } }, ['k']),
      ],
    };
    expect(stripStrictNulls({ k: 'b', y: null }, schema)).toEqual({ k: 'b' });
  });

  it('keeps null for an allOf whose members all accept null (allof_nullable)', () => {
    const schema = objectSchema({
      v: { allOf: [{ type: ['string', 'null'] }, { maxLength: 5 }] },
    });
    expect(stripStrictNulls({ v: null }, schema)).toEqual({ v: null });
    expect(
      stripStrictNulls(
        { v: null },
        objectSchema({
          v: { allOf: [{ type: ['string', 'null'] }, { type: 'string' }] },
        }),
      ),
    ).toEqual({});
  });

  it('keeps null for an optional reference to a nullable definition (nullable_ref)', () => {
    expect(
      stripStrictNulls(
        { note: null },
        {
          type: 'object',
          properties: { note: { $ref: '#/$defs/NullableNote' } },
          $defs: { NullableNote: { type: ['string', 'null'] } },
        },
      ),
    ).toEqual({ note: null });
  });
});

// Each level is a two-branch union whose branches both hold the next level,
// as a 2^30 tree when walked naively.
function sharedUnionChain(depth: number): JsonSchemaValue {
  let level: JsonSchemaValue = objectSchema({ leaf: { type: 'string' } }, [], {
    additionalProperties: false,
  });
  for (let index = 0; index < depth; index += 1) {
    const next = level;
    level = {
      type: 'object',
      anyOf: [
        { properties: { [`a${index}`]: { type: 'string' } }, anyOf: [next] },
        { properties: { [`b${index}`]: { type: 'string' } }, anyOf: [next] },
      ],
    };
  }
  return level;
}

// The same fan-out expressed in plain JSON through distinct $defs.
function refUnionChain(depth: number): JsonSchemaValue {
  const definitions: { [key: string]: JsonSchemaValue } = {
    L0: objectSchema({ leaf: { type: 'string' } }, [], {
      additionalProperties: false,
    }),
  };
  for (let index = 1; index <= depth; index += 1) {
    const previous = `#/$defs/L${index - 1}`;
    definitions[`L${index}`] = {
      type: 'object',
      anyOf: [{ $ref: previous }, { $ref: previous }],
    };
  }
  return { $ref: `#/$defs/L${depth}`, $defs: definitions };
}

describe('work budget', () => {
  const cyclicUnion: JsonSchemaValue = {
    type: 'object',
    anyOf: [{ $ref: '#' }, { $ref: '#' }],
  };

  it('returns on a self-referencing union (cyclic_union)', () => {
    const onLossy = jest.fn<void, [string, string]>();
    const result = toStrictToolSchema(cyclicUnion, { onLossy });
    expect(toStrictToolSchema(result)).toEqual(result);
    const value: JsonSchemaValue = { a: { b: null } };
    expect(stripStrictNulls(value, cyclicUnion)).toEqual(value);
    const mixed: JsonSchemaValue = { a: null, b: [1, { c: null }] };
    expect(stripStrictNulls(mixed, cyclicUnion)).toEqual(mixed);
  });

  it('reports an exhausted conversion once and returns the schema unchanged', () => {
    for (const schema of [sharedUnionChain(30), refUnionChain(30)]) {
      const onLossy = jest.fn<void, [string, string]>();
      expect(toStrictToolSchema(schema, { onLossy })).toBe(schema);
      expect(onLossy.mock.calls).toEqual([
        ['#', 'work budget exceeded; schema left unchanged'],
      ]);
    }
  });

  it('returns the original value when stripping runs out of budget', () => {
    const value: JsonSchemaValue = { zzz: 1, leaf: null };
    expect(stripStrictNulls(value, refUnionChain(30))).toBe(value);
    expect(stripStrictNulls(value, sharedUnionChain(30))).toBe(value);
  });

  it('does not hang on 30 nested two-branch unions', () => {
    const shared = sharedUnionChain(30);
    const refs = refUnionChain(30);
    const { work } = measureWork(() => {
      toStrictToolSchema(shared);
      toStrictToolSchema(refs);
      stripStrictNulls({ zzz: 1, leaf: null }, shared);
      stripStrictNulls({ zzz: 1, leaf: null }, refs);
      stripStrictNulls({ a: { b: null } }, cyclicUnion);
    });
    // Their work budgets keep this near 400,000 built-in steps; expanding
    // both branches at every level would take about 2^30.
    expect(work).toBeLessThan(2_000_000);
  });

  it('keeps stripping a recursive tree at every depth', () => {
    expect(
      stripStrictNulls(
        {
          name: 'a',
          limit: null,
          children: [
            {
              name: 'b',
              limit: null,
              children: [{ name: 'c', limit: null, children: [] }],
            },
          ],
        },
        recursiveTree,
      ),
    ).toEqual({
      name: 'a',
      children: [{ name: 'b', children: [{ name: 'c', children: [] }] }],
    });
  });
});

describe('branch-local definitions and array unions', () => {
  it('hoists the own $defs of a branch to the root (branch_defs)', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        {
          properties: {
            kind: { const: 'a' },
            item: { $ref: '#/anyOf/0/$defs/Item' },
          },
          required: ['kind'],
          $defs: { Item: objectSchema({ n: { type: 'string' } }) },
        },
        objectSchema({ kind: { const: 'b' } }, ['kind']),
      ],
    };
    const result = toStrictToolSchema(schema);
    expect(result).toEqual({
      type: 'object',
      $defs: {
        'anyOf.0.Item': {
          type: 'object',
          properties: { n: { type: ['string', 'null'] } },
          required: ['n'],
          additionalProperties: false,
        },
      },
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'a' },
            item: {
              anyOf: [{ $ref: '#/$defs/anyOf.0.Item' }, { type: 'null' }],
            },
          },
          required: ['kind', 'item'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { kind: { const: 'b' } },
          required: ['kind'],
          additionalProperties: false,
        },
      ],
    });
    expect(JSON.stringify(toStrictToolSchema(result))).toBe(
      JSON.stringify(result),
    );
    expect(stripStrictNulls({ kind: 'a', item: { n: null } }, schema)).toEqual({
      kind: 'a',
      item: {},
    });
  });

  const multiArray = objectSchema({
    entries: {
      anyOf: [
        { type: 'array', items: { type: 'string' } },
        {
          type: 'array',
          items: objectSchema(
            { name: { type: 'string' }, limit: { type: 'integer' } },
            ['name'],
          ),
        },
      ],
    },
  });

  it('picks the array branch whose items fit every element (multi_array_obj)', () => {
    expect(
      stripStrictNulls({ entries: [{ name: 'a', limit: null }] }, multiArray),
    ).toEqual({ entries: [{ name: 'a' }] });
  });

  it('keeps primitive elements through their own branch (multi_array_prim)', () => {
    expect(stripStrictNulls({ entries: ['x', 'y'] }, multiArray)).toEqual({
      entries: ['x', 'y'],
    });
  });

  it('leaves an array no branch fits unchanged', () => {
    const value: JsonSchemaValue = {
      entries: ['x', { name: 'a', limit: null }],
    };
    expect(stripStrictNulls(value, multiArray)).toEqual(value);
  });
});

function definitionNames(schema: JsonSchemaValue): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [];
  }
  const definitions = schema.$defs;
  return typeof definitions === 'object' &&
    definitions !== null &&
    !Array.isArray(definitions)
    ? Object.keys(definitions)
    : [];
}

describe('definition hoisting', () => {
  it('hoists a definition under a oneOf member (branch_local_defs_oneof)', () => {
    const result = toStrictToolSchema(
      objectSchema(
        {
          v: {
            oneOf: [
              {
                $defs: { Item: objectSchema({ n: { type: 'string' } }) },
                type: 'array',
                items: { $ref: '#/properties/v/oneOf/0/$defs/Item' },
              },
              { type: 'string' },
            ],
          },
        },
        ['v'],
      ),
    );
    expect(result).toEqual({
      type: 'object',
      properties: {
        v: {
          anyOf: [
            {
              type: 'array',
              items: { $ref: '#/$defs/properties.v.oneOf.0.Item' },
            },
            { type: 'string' },
          ],
        },
      },
      required: ['v'],
      $defs: {
        'properties.v.oneOf.0.Item': {
          type: 'object',
          properties: { n: { type: ['string', 'null'] } },
          required: ['n'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  it('keeps a reference resolvable inside a nullable wrapper (nullable_ref_wrapper)', () => {
    expect(
      toStrictToolSchema(
        objectSchema({
          filter: {
            $defs: { Value: { type: 'string' } },
            anyOf: [
              { $ref: '#/properties/filter/$defs/Value' },
              { type: 'number' },
            ],
          },
        }),
      ),
    ).toEqual({
      type: 'object',
      properties: {
        filter: {
          anyOf: [
            {
              anyOf: [
                { $ref: '#/$defs/properties.filter.Value' },
                { type: 'number' },
              ],
            },
            { type: 'null' },
          ],
        },
      },
      required: ['filter'],
      $defs: { 'properties.filter.Value': { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('merges root definitions, renames collisions and rewrites deep refs', () => {
    const result = toStrictToolSchema({
      type: 'object',
      properties: {
        a: { $ref: '#/definitions/A' },
        b: { $ref: '#/definitions/Shared' },
        c: { $ref: '#/properties/n/$defs/X/properties/y' },
        d: { $ref: '#/properties/n/$defs/X/$defs/Deep' },
        e: { $ref: '#/properties/a' },
        n: {
          type: 'object',
          properties: { $defs: { type: 'string' } },
          $defs: {
            X: {
              type: 'object',
              properties: { y: { type: 'integer' } },
              $defs: { Deep: { type: 'boolean' } },
            },
          },
        },
        'p/q': { $defs: { 'a~b': { type: 'string' } } },
      },
      required: ['a', 'b', 'c', 'd', 'e', 'n', 'p/q'],
      $defs: { Shared: { type: 'string' }, 'properties.n.X': { type: 'null' } },
      definitions: { A: { type: 'number' }, Shared: { type: 'boolean' } },
    });
    expect(result).toMatchObject({
      properties: {
        a: { $ref: '#/$defs/A' },
        b: { $ref: '#/$defs/definitions.Shared' },
        c: { $ref: '#/$defs/$defs.properties.n.X_2.properties.y' },
        d: { $ref: '#/$defs/properties.n.$defs.X.Deep' },
        e: { $ref: '#/$defs/properties.a' },
        n: { properties: { $defs: { type: ['string', 'null'] } } },
      },
    });
    expect(result).not.toHaveProperty('definitions');
    expect(result).not.toHaveProperty('properties.n.$defs');
    expect(definitionNames(result)).toEqual([
      'Shared',
      'properties.n.X',
      'properties.n.X_2',
      'properties.n.$defs.X.Deep',
      'properties.p/q.a~b',
      'A',
      'definitions.Shared',
      '$defs.properties.n.X_2.properties.y',
      'properties.a',
    ]);
  });

  it('leaves a schema with nothing to hoist unchanged', () => {
    expect(toStrictToolSchema(vector1)).toEqual(toStrictToolSchema(vector1));
    expect(
      stripStrictNulls(
        { a: { y: null } },
        objectSchema(
          {
            a: { $ref: '#/$defs/A' },
          },
          [],
          { $defs: { A: objectSchema({ y: { type: 'string' } }) } },
        ),
      ),
    ).toEqual({ a: {} });
  });

  it('strips through a hoisted definition', () => {
    expect(
      stripStrictNulls(
        { f: { y: null } },
        objectSchema({
          f: {
            $defs: { V: objectSchema({ y: { type: 'string' } }) },
            $ref: '#/properties/f/$defs/V',
          },
        }),
      ),
    ).toEqual({ f: {} });
  });
});

const refUnionMembers: JsonSchemaValue = {
  type: 'object',
  $defs: {
    A: objectSchema({ kind: { const: 'a' }, extra: { type: 'string' } }, [
      'kind',
    ]),
    B: objectSchema({ kind: { const: 'b' }, n: { type: 'number' } }, [
      'kind',
      'n',
    ]),
  },
  anyOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }],
};

describe('round 5 unions', () => {
  it('distributes referenced union members (ref_union_members)', () => {
    const result = toStrictToolSchema(refUnionMembers);
    expect(result).not.toHaveProperty('properties');
    expect(result).toMatchObject({
      type: 'object',
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'a' },
            extra: { type: ['string', 'null'] },
          },
          required: ['kind', 'extra'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { kind: { const: 'b' }, n: { type: 'number' } },
          required: ['kind', 'n'],
          additionalProperties: false,
        },
      ],
    });
    expect(toStrictToolSchema(result)).toEqual(result);
    expect(
      stripStrictNulls({ kind: 'a', extra: null }, refUnionMembers),
    ).toEqual({ kind: 'a' });
  });

  it('matches a nested discriminator recursively (nested_discriminator)', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        objectSchema(
          {
            settings: objectSchema(
              { mode: { const: 'a' }, note: { type: ['string', 'null'] } },
              ['mode'],
            ),
          },
          ['settings'],
        ),
        objectSchema(
          {
            settings: objectSchema(
              { mode: { const: 'b' }, note: { type: 'string' } },
              ['mode'],
            ),
          },
          ['settings'],
        ),
      ],
    };
    expect(
      stripStrictNulls({ settings: { mode: 'b', note: null } }, schema),
    ).toEqual({ settings: { mode: 'b' } });
    expect(
      stripStrictNulls({ settings: { mode: 'a', note: null } }, schema),
    ).toEqual({ settings: { mode: 'a', note: null } });
  });

  it('rejects a branch whose nested value has the wrong type', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        objectSchema({ cfg: objectSchema({ n: { type: 'string' } }) }),
        objectSchema({
          cfg: objectSchema({ n: { type: 'integer' }, x: { type: 'string' } }),
        }),
      ],
    };
    expect(stripStrictNulls({ cfg: { n: 1, x: null } }, schema)).toEqual({
      cfg: { n: 1 },
    });
  });

  it('rejects a closed branch for any key outside it, even a null one', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        objectSchema({ a: { type: 'string' } }, ['a'], {
          additionalProperties: false,
        }),
        objectSchema({ a: { type: 'string' }, b: { type: 'string' } }, ['a']),
      ],
    };
    expect(stripStrictNulls({ a: 'x', b: null }, schema)).toEqual({ a: 'x' });
  });

  it('selects an array branch before the plain array path (array_union_branch_items)', () => {
    const schema = objectSchema(
      {
        rows: {
          type: 'array',
          anyOf: [
            { items: { type: 'string' } },
            {
              items: objectSchema(
                { k: { type: 'string' }, limit: { type: 'integer' } },
                ['k'],
              ),
            },
          ],
        },
      },
      ['rows'],
    );
    expect(
      stripStrictNulls({ rows: [{ k: 'x', limit: null }] }, schema),
    ).toEqual({ rows: [{ k: 'x' }] });
    expect(stripStrictNulls({ rows: ['a', 'b'] }, schema)).toEqual({
      rows: ['a', 'b'],
    });
  });
});

describe('round 6', () => {
  // A `write_artifact`-shaped union whose domain rows are themselves a union.
  const largeArtifact: JsonSchemaValue = {
    type: 'object',
    anyOf: [
      objectSchema(
        {
          kind: { const: 'domains' },
          rows: {
            type: 'array',
            items: {
              anyOf: [
                objectSchema(
                  {
                    domain: { type: 'string' },
                    label: { type: 'string' },
                    score: { type: 'number' },
                  },
                  ['domain'],
                ),
                objectSchema(
                  {
                    name: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                  },
                  ['name'],
                ),
              ],
            },
          },
        },
        ['kind', 'rows'],
      ),
      objectSchema(
        {
          kind: { const: 'document' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        ['kind', 'title'],
      ),
    ],
  };

  it('strips every optional null from 500 artifact rows (large_artifact)', () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      domain: `d${index}.com`,
      label: null,
      score: null,
    }));
    expect(stripStrictNulls({ kind: 'domains', rows }, largeArtifact)).toEqual({
      kind: 'domains',
      rows: rows.map(({ domain }) => ({ domain })),
    });
  });

  it('converts a large schema without exhausting the budget', () => {
    const properties: { [key: string]: JsonSchemaValue } = {};
    for (let index = 0; index < 2000; index += 1) {
      properties[`p${index}`] = {
        type: 'string',
        description: `field ${index}`,
      };
    }
    const onLossy = jest.fn<void, [string, string]>();
    const result = toStrictToolSchema(objectSchema(properties), { onLossy });
    expect(onLossy).not.toHaveBeenCalled();
    expect(result).toHaveProperty('properties.p1999.type', ['string', 'null']);
  });

  const mixedTypeUnion = objectSchema(
    {
      v: {
        type: ['object', 'string'],
        anyOf: [
          objectSchema({ a: { type: 'string' } }, ['a']),
          objectSchema({ b: { type: 'number' } }, ['b']),
        ],
      },
    },
    ['v'],
  );

  it('keeps the non-object types of a mixed union (mixed_type_union)', () => {
    const result = toStrictToolSchema(mixedTypeUnion);
    expect(result).toEqual({
      type: 'object',
      properties: {
        v: {
          type: ['object', 'string'],
          anyOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' } },
              required: ['a'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { b: { type: 'number' } },
              required: ['b'],
              additionalProperties: false,
            },
            { type: 'string' },
          ],
        },
      },
      required: ['v'],
      additionalProperties: false,
    });
    expect(toStrictToolSchema(result)).toEqual(result);
  });

  it('puts several non-object types in one member before the null member', () => {
    expect(
      toStrictToolSchema({
        type: ['object', 'string', 'number', 'null'],
        anyOf: [objectSchema({ a: { type: 'string' } }, ['a'])],
      }),
    ).toEqual({
      type: ['object', 'string', 'number', 'null'],
      anyOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        { type: ['string', 'number'] },
        { type: 'null' },
      ],
    });
  });

  it('returns a non-object value of a mixed union unchanged (mixed_type_union_str)', () => {
    expect(stripStrictNulls({ v: 'hello' }, mixedTypeUnion)).toEqual({
      v: 'hello',
    });
    // An object still goes through branch matching: it matches the open
    // `b` branch, which does not list `a`, so that key is left alone.
    expect(stripStrictNulls({ v: { b: 1, a: null } }, mixedTypeUnion)).toEqual({
      v: { b: 1, a: null },
    });
  });

  it('matches a string through a mixed union nested in a branch', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        objectSchema(
          { kind: { const: 'x' }, v: mixedTypeUnion, note: { type: 'string' } },
          ['kind'],
        ),
      ],
    };
    expect(
      stripStrictNulls({ kind: 'x', v: { v: 'hi' }, note: null }, schema),
    ).toEqual({ kind: 'x', v: { v: 'hi' } });
  });
});

describe('round 6 references and required-only unions', () => {
  it('keeps an allOf that inlines to a reference open (allof_ref_only)', () => {
    const onLossy = jest.fn<void, [string, string]>();
    const result = toStrictToolSchema(
      objectSchema(
        { item: { type: 'object', allOf: [{ $ref: '#/$defs/Item' }] } },
        ['item'],
        {
          $defs: { Item: objectSchema({ name: { type: 'string' } }, ['name']) },
        },
      ),
      { onLossy },
    );
    expect(result).toEqual({
      type: 'object',
      properties: { item: { type: 'object', $ref: '#/$defs/Item' } },
      required: ['item'],
      $defs: {
        Item: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
    expect(onLossy).not.toHaveBeenCalled();
    expect(toStrictToolSchema(result)).toEqual(result);
    expect(
      stripStrictNulls(
        { item: { name: 'n', size: null } },
        objectSchema({ item: { allOf: [{ $ref: '#/$defs/I' }] } }, [], {
          $defs: {
            I: objectSchema({
              name: { type: 'string' },
              size: { type: 'integer' },
            }),
          },
        }),
      ),
    ).toEqual({ item: { name: 'n' } });
  });

  // The SetupWatchers pattern: one of two identifiers must be present.
  const setupWatcher: JsonSchemaValue = {
    type: 'object',
    properties: {
      executionId: { type: 'string' },
      pipelineId: { type: 'string' },
      label: { type: 'string' },
    },
    anyOf: [{ required: ['executionId'] }, { required: ['pipelineId'] }],
  };

  it('distributes required-only members into merged branches (required_only_union)', () => {
    const result = toStrictToolSchema(setupWatcher);
    expect(result).toEqual({
      type: 'object',
      anyOf: [
        {
          type: 'object',
          properties: {
            executionId: { type: 'string' },
            pipelineId: { type: ['string', 'null'] },
            label: { type: ['string', 'null'] },
          },
          required: ['executionId', 'pipelineId', 'label'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            executionId: { type: ['string', 'null'] },
            pipelineId: { type: 'string' },
            label: { type: ['string', 'null'] },
          },
          required: ['executionId', 'pipelineId', 'label'],
          additionalProperties: false,
        },
      ],
    });
    expect(toStrictToolSchema(result)).toEqual(result);
  });

  it('strips through the matching required-only branch (required_only_union_exec)', () => {
    expect(
      stripStrictNulls(
        { executionId: 'e1', pipelineId: null, label: null },
        setupWatcher,
      ),
    ).toEqual({ executionId: 'e1' });
    expect(
      stripStrictNulls(
        { executionId: null, pipelineId: 'p1', label: 'x' },
        setupWatcher,
      ),
    ).toEqual({ pipelineId: 'p1', label: 'x' });
  });

  it('does not treat a required-only member as an object without an object parent', () => {
    const bare: JsonSchemaValue = {
      anyOf: [{ required: ['a'] }, objectSchema({ b: { type: 'string' } })],
    };
    expect(toStrictToolSchema(bare)).toEqual({
      anyOf: [
        { required: ['a'] },
        {
          type: 'object',
          properties: { b: { type: ['string', 'null'] } },
          required: ['b'],
          additionalProperties: false,
        },
      ],
    });
  });
});

describe('round 7', () => {
  it('copies a referenced property into $defs (ref_to_property)', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      properties: { a: objectSchema({ x: { type: 'string' } }) },
      anyOf: [
        objectSchema(
          { kind: { const: 1 }, other: { $ref: '#/properties/a' } },
          ['kind'],
        ),
        objectSchema({ kind: { const: 2 } }, ['kind']),
      ],
    };
    const result = toStrictToolSchema(schema);
    expect(definitionNames(result)).toEqual(['properties.a']);
    expect(result).toMatchObject({
      anyOf: [
        {
          properties: {
            other: {
              anyOf: [{ $ref: '#/$defs/properties.a' }, { type: 'null' }],
            },
          },
        },
        {},
      ],
    });
    expect(toStrictToolSchema(result)).toEqual(result);
    expect(stripStrictNulls({ kind: 1, other: { x: null } }, schema)).toEqual({
      kind: 1,
      other: {},
    });
  });

  it('copies a referenced union branch into $defs (ref_to_branch)', () => {
    const result = toStrictToolSchema(
      objectSchema({
        source: {
          oneOf: [
            objectSchema({ url: { type: 'string' } }, ['url']),
            objectSchema({ path: { type: 'string' } }, ['path']),
          ],
        },
        fallback: { $ref: '#/properties/source/oneOf/0' },
      }),
    );
    expect(result).toMatchObject({
      properties: {
        fallback: {
          anyOf: [
            { $ref: '#/$defs/properties.source.oneOf.0' },
            { type: 'null' },
          ],
        },
      },
      $defs: {
        'properties.source.oneOf.0': {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          additionalProperties: false,
        },
      },
    });
  });

  it('rewrites # to a root copy, including refs inside the copy', () => {
    const result = toStrictToolSchema(recursiveTree);
    expect(definitionNames(result)).toEqual(['__root']);
    expect(result).toMatchObject({
      $defs: {
        __root: {
          properties: {
            children: { items: { $ref: '#/$defs/__root' } },
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('"#"');
    expect(toStrictToolSchema(result)).toEqual(result);
  });

  it('rewrites refs inside copied targets until every ref points into $defs', () => {
    const result = toStrictToolSchema(
      objectSchema({
        a: objectSchema({ b: { $ref: '#/properties/c' } }),
        c: { type: 'string' },
        d: { $ref: '#/properties/a' },
      }),
    );
    expect(definitionNames(result)).toEqual(['properties.c', 'properties.a']);
    expect(JSON.stringify(result)).not.toContain('"#/properties');
  });

  it('reports an unresolvable local ref and leaves it unchanged', () => {
    const onLossy = jest.fn<void, [string, string]>();
    const result = toStrictToolSchema(
      objectSchema({ a: { $ref: '#/properties/missing' } }, ['a']),
      { onLossy },
    );
    expect(result).toMatchObject({
      properties: { a: { $ref: '#/properties/missing' } },
    });
    expect(onLossy).toHaveBeenCalledWith(
      '#/properties/missing',
      'unresolvable local $ref left unchanged',
    );
  });

  it('treats annotation-only schemas as nullable (annotation_only)', () => {
    const schema = objectSchema({
      payload: { description: 'JSON payload' },
      note: { title: 'Note', examples: ['x'], $comment: 'c', default: 'y' },
    });
    expect(stripStrictNulls({ payload: null, note: null }, schema)).toEqual({
      payload: null,
      note: null,
    });
    expect(toStrictToolSchema(schema)).toEqual({
      type: 'object',
      properties: {
        payload: { description: 'JSON payload' },
        note: { title: 'Note', examples: ['x'], $comment: 'c' },
      },
      required: ['payload', 'note'],
      additionalProperties: false,
    });
    expect(
      stripStrictNulls(
        { v: null },
        objectSchema({ v: { description: 'd', minLength: 1 } }),
      ),
    ).toEqual({});
  });
});

describe('round 8: acceptsNull is conjunctive', () => {
  it('lets a sibling type veto a nullable allOf member (sibling_type_allof)', () => {
    expect(
      stripStrictNulls(
        { limit: null },
        objectSchema({
          limit: { type: 'integer', allOf: [{ type: ['integer', 'null'] }] },
        }),
      ),
    ).toEqual({});
  });

  it('lets a sibling type veto a nullable $ref target (sibling_type_ref)', () => {
    expect(
      stripStrictNulls(
        { limit: null },
        objectSchema({ limit: { type: 'integer', $ref: '#/$defs/N' } }, [], {
          $defs: { N: { type: ['integer', 'null'] } },
        }),
      ),
    ).toEqual({});
  });

  it('lets a sibling enum veto a nullable anyOf (sibling_enum_anyof)', () => {
    const schema = objectSchema({
      mode: {
        enum: ['a', 'b'],
        anyOf: [{ type: 'string' }, { type: 'null' }],
      },
    });
    expect(stripStrictNulls({ mode: null }, schema)).toEqual({});
    expect(toStrictToolSchema(schema)).toMatchObject({
      properties: {
        mode: {
          anyOf: [
            { enum: ['a', 'b'], anyOf: [{ type: 'string' }, { type: 'null' }] },
            { type: 'null' },
          ],
        },
      },
    });
  });

  it('accepts null through an allOf beside a type-free assertion (allof_nullable_minimum)', () => {
    expect(
      stripStrictNulls(
        { v: null },
        objectSchema({
          v: { minimum: 1, allOf: [{ type: ['integer', 'null'] }] },
        }),
      ),
    ).toEqual({ v: null });
  });

  it('needs positive evidence beyond a cyclic ref or bare assertions', () => {
    const cyclic = objectSchema({ v: { $ref: '#/$defs/Loop' } }, [], {
      $defs: { Loop: { $ref: '#/$defs/Loop' } },
    });
    expect(stripStrictNulls({ v: null }, cyclic)).toEqual({});
    expect(
      stripStrictNulls({ v: null }, objectSchema({ v: { minimum: 1 } })),
    ).toEqual({});
    expect(
      stripStrictNulls(
        { v: null },
        objectSchema({ v: { const: null, description: 'nothing' } }),
      ),
    ).toEqual({ v: null });
  });
});

describe('round 9', () => {
  it('distributes an allOf-wrapped object member (allof_union_branch)', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        {
          allOf: [
            objectSchema({ kind: { const: 'a' }, note: { type: 'string' } }, [
              'kind',
            ]),
          ],
        },
        objectSchema({ kind: { const: 'b' }, n: { type: 'number' } }, [
          'kind',
          'n',
        ]),
      ],
    };
    const result = toStrictToolSchema(schema);
    expect(result).toMatchObject({
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'a' },
            note: { type: ['string', 'null'] },
          },
          required: ['kind', 'note'],
          additionalProperties: false,
        },
        {},
      ],
    });
    expect(toStrictToolSchema(result)).toEqual(result);
    expect(stripStrictNulls({ kind: 'a', note: null }, schema)).toEqual({
      kind: 'a',
    });
  });

  it('distributes an allOf-wrapped reference member (allof_ref_union_branch)', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      $defs: {
        A: objectSchema({ kind: { const: 'a' }, note: { type: 'string' } }, [
          'kind',
        ]),
      },
      anyOf: [
        { allOf: [{ $ref: '#/$defs/A' }] },
        objectSchema({ kind: { const: 'b' } }, ['kind']),
      ],
    };
    const result = toStrictToolSchema(schema);
    expect(result).toMatchObject({
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'a' },
            note: { type: ['string', 'null'] },
          },
          required: ['kind', 'note'],
          additionalProperties: false,
        },
        {},
      ],
    });
    expect(toStrictToolSchema(result)).toEqual(result);
    expect(stripStrictNulls({ kind: 'a', note: null }, schema)).toEqual({
      kind: 'a',
    });
  });

  it('reports a dropped multi-member allOf at the member pointer', () => {
    const onLossy = jest.fn<void, [string, string]>();
    toStrictToolSchema(
      {
        type: 'object',
        anyOf: [
          {
            properties: { a: { type: 'string' } },
            allOf: [{ minProperties: 1 }, { minProperties: 2 }],
          },
        ],
      },
      { onLossy },
    );
    expect(onLossy).toHaveBeenCalledWith(
      '#/anyOf/0/allOf',
      'dropped allOf that cannot be merged',
    );
  });

  it('accepts null in a oneOf only when exactly one member does', () => {
    expect(
      stripStrictNulls(
        { v: null },
        objectSchema({
          v: {
            oneOf: [{ type: ['string', 'null'] }, { type: ['number', 'null'] }],
          },
        }),
      ),
    ).toEqual({});
    expect(
      stripStrictNulls(
        { v: null },
        objectSchema({
          v: { oneOf: [{ type: 'string' }, { type: ['number', 'null'] }] },
        }),
      ),
    ).toEqual({ v: null });
    expect(
      stripStrictNulls(
        { v: null },
        objectSchema({
          v: {
            anyOf: [{ type: ['string', 'null'] }, { type: ['number', 'null'] }],
          },
        }),
      ),
    ).toEqual({ v: null });
  });
});

describe('flattenToolJsonSchema', () => {
  it('removes combinators while keeping property names verbatim', () => {
    expect(
      flattenToolJsonSchema({
        type: 'object',
        anyOf: [{ required: ['a'] }],
        properties: { if: { type: 'string', oneOf: [{ minLength: 1 }] } },
      }),
    ).toEqual({ type: 'object', properties: { if: { type: 'string' } } });
  });
});

describe('stripStrictNulls nullStringPlaceholders', () => {
  const placeholders = { nullStringPlaceholders: true };
  const optionalStrings: JsonSchemaValue = {
    type: 'object',
    properties: {
      assignee: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'integer' },
    },
  };

  it('changes nothing when the option is off', () => {
    const cases: Array<[JsonSchemaValue, JsonSchemaValue]> = [
      [{ query: 'null', limit: null }, vector1],
      [{ assignee: 'null', query: 'null', limit: null }, optionalStrings],
      [{ items: [{ q: 'null', limit: 'null' }] }, vector2],
      [{ note: 'null' }, vector3],
    ];
    for (const [value, schema] of cases) {
      const expected = stripStrictNulls(value, schema);
      expect(stripStrictNulls(value, schema, {})).toEqual(expected);
      expect(
        stripStrictNulls(value, schema, { nullStringPlaceholders: false }),
      ).toEqual(expected);
    }
    expect(
      stripStrictNulls(
        { assignee: 'null', query: 'null', limit: null },
        optionalStrings,
      ),
    ).toEqual({ assignee: 'null', query: 'null' });
  });

  it('drops "null" placeholders on optional keys', () => {
    expect(
      stripStrictNulls(
        { assignee: 'null', query: 'null', limit: null },
        optionalStrings,
        placeholders,
      ),
    ).toEqual({});
  });

  it('keeps "null" on a required key', () => {
    expect(
      stripStrictNulls({ query: 'null', limit: 'null' }, vector1, placeholders),
    ).toEqual({ query: 'null' });
  });

  it('keeps "null" on a property that accepts null', () => {
    expect(stripStrictNulls({ note: 'null' }, vector3, placeholders)).toEqual({
      note: 'null',
    });
  });

  it('walks nested objects and leaves array elements alone', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      properties: {
        items: vector2,
        tags: { type: 'array', items: { type: 'string' } },
      },
    };
    expect(
      stripStrictNulls(
        {
          items: { items: [{ q: 'null', limit: 'null' }] },
          tags: ['null', 'a'],
        },
        schema,
        placeholders,
      ),
    ).toEqual({ items: { items: [{ q: 'null' }] }, tags: ['null', 'a'] });
  });

  it('matches union branches on the real values', () => {
    const discriminated: JsonSchemaValue = {
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'null' },
            limit: { type: 'string' },
          },
          required: ['kind'],
        },
        {
          type: 'object',
          properties: { kind: { const: 'id' }, id: { type: 'string' } },
          required: ['kind', 'id'],
        },
      ],
    };
    expect(
      stripStrictNulls(
        { kind: 'null', limit: 'null' },
        discriminated,
        placeholders,
      ),
    ).toEqual({ kind: 'null' });

    const search: JsonSchemaValue = {
      anyOf: [
        {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query'],
        },
        {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      ],
    };
    expect(
      stripStrictNulls({ query: 'null', limit: null }, search, placeholders),
    ).toEqual({ query: 'null' });
  });

  it('keeps an optional "null" a const or enum names', () => {
    const schema: JsonSchemaValue = {
      $defs: { mode: { enum: ['null', 'all'] } },
      type: 'object',
      properties: {
        kind: { const: 'null' },
        state: { enum: ['open', 'null'] },
        mode: { $ref: '#/$defs/mode' },
        sort: { anyOf: [{ const: 'null' }, { type: 'integer' }] },
        other: { type: 'string' },
      },
    };
    expect(
      stripStrictNulls(
        {
          kind: 'null',
          state: 'null',
          mode: 'null',
          sort: 'null',
          other: 'null',
        },
        schema,
        placeholders,
      ),
    ).toEqual({ kind: 'null', state: 'null', mode: 'null', sort: 'null' });
  });
});
