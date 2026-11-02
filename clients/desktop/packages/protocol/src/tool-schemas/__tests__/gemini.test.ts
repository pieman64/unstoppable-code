import Ajv2020 from 'ajv/dist/2020';
import { CHARS_PER_WORK_UNIT } from '../work-budget';
import {
  MAX_TOOL_SCHEMA_WORK,
  stripStrictNulls,
  toGeminiToolSchema,
  toStrictToolSchema,
  ToolSchemaWorkBudget,
  type JsonSchemaValue,
} from '../index';
import { measureWork, workGrowth } from '../../__tests__/helpers/work-meter';

type JsonSchemaObject = { [key in string]?: JsonSchemaValue };

function convert(schema: JsonSchemaValue): {
  result: JsonSchemaValue;
  lossy: string[];
} {
  const lossy: string[] = [];
  const result = toGeminiToolSchema(schema, {
    onLossy: (path, reason) => lossy.push(`${path}: ${reason}`),
  });
  return { result, lossy };
}

/** The value a local JSON pointer (`#/a/b`) names, or undefined. */
function resolvePointer(root: JsonSchemaValue, ref: string): unknown {
  let current: unknown = root;
  for (const raw of ref === '#' ? [] : ref.slice(2).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof current !== 'object' || current === null) return undefined;
    const descriptor: PropertyDescriptor | undefined =
      Object.getOwnPropertyDescriptor(current, segment);
    if (descriptor === undefined) return undefined;
    current = descriptor.value;
  }
  return current;
}

describe('toGeminiToolSchema', () => {
  it('moves a union beside other keywords into allOf, keeping each keyword once', () => {
    // The setup_watchers `target` shape Vertex rejected: a union beside
    // `type`, `properties` and `additionalProperties`.
    const parent = {
      type: 'object',
      description: 'Watcher target filter.',
      properties: {
        executionId: { type: 'string' },
        pipelineId: { type: 'string' },
      },
      additionalProperties: false,
    };
    const { result, lossy } = convert({
      type: 'object',
      properties: {
        target: {
          ...parent,
          anyOf: [{ required: ['executionId'] }, { required: ['pipelineId'] }],
        },
      },
    });

    expect(result).toEqual({
      type: 'object',
      properties: {
        target: {
          allOf: [
            parent,
            {
              anyOf: [
                { required: ['executionId'] },
                { required: ['pipelineId'] },
              ],
            },
          ],
        },
      },
    });
    expect(lossy).toEqual([]);
  });

  it('keeps a branch $ref as its own conjunct and keeps oneOf', () => {
    const { result } = convert({
      type: 'object',
      $defs: {
        Run: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: ['x'],
        },
      },
      properties: {
        v: {
          type: 'object',
          properties: { x: { type: 'string' } },
          oneOf: [{ $ref: '#/$defs/Run', required: ['y'] }, { type: 'null' }],
        },
      },
    });

    expect(result).toEqual({
      type: 'object',
      $defs: {
        Run: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: ['x'],
        },
      },
      properties: {
        v: {
          allOf: [
            { type: 'object', properties: { x: { type: 'string' } } },
            {
              oneOf: [
                { $ref: '#/$defs/Run', required: ['y'] },
                { type: 'null' },
              ],
            },
          ],
        },
      },
    });
  });

  it('moves a root union into allOf so the root stays a typed object', () => {
    const { result } = convert({
      type: 'object',
      properties: { a: { type: 'string' } },
      anyOf: [{ required: ['a'] }],
      oneOf: [{ minProperties: 1 }],
    });
    const parent = { type: 'object', properties: { a: { type: 'string' } } };

    expect(result).toEqual({
      ...parent,
      allOf: [
        { anyOf: [{ required: ['a'] }] },
        { oneOf: [{ minProperties: 1 }] },
      ],
    });
  });

  it('moves object keywords Gemini rejects into allOf instead of dropping them', () => {
    const { result, lossy } = convert({
      properties: {
        name: { type: 'string', required: ['x'] },
        loose: { properties: { a: { type: 'string' } }, required: ['a'] },
        object: {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a', 'missing'],
        },
      },
      required: ['name', 'missing'],
    });

    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', allOf: [{ required: ['x'] }] },
        loose: {
          allOf: [{ properties: { a: { type: 'string' } }, required: ['a'] }],
        },
        object: {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          allOf: [{ required: ['missing'] }],
        },
      },
      required: ['name'],
      allOf: [{ required: ['missing'] }],
    });
    expect(lossy).toEqual([
      '#/type: typed the root as an object, which Vertex AI requires',
    ]);
  });

  it('wraps a bare null branch beside an untyped branch for Vertex AI', () => {
    const { result } = convert({
      type: 'object',
      properties: {
        mode: {
          anyOf: [
            { allOf: [{ type: 'string', enum: ['raw'] }] },
            { type: 'null' },
          ],
        },
        kept: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    });

    expect(result).toEqual({
      type: 'object',
      properties: {
        mode: {
          anyOf: [
            { allOf: [{ type: 'string', enum: ['raw'] }] },
            { allOf: [{ type: 'null' }] },
          ],
        },
        kept: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    });
  });

  it('inlines local refs when asked, keeping keywords beside a ref as a conjunct', () => {
    const lossy: string[] = [];
    const result = toGeminiToolSchema(
      {
        type: 'object',
        $defs: {
          Mode: { type: 'string', enum: ['raw', 'hash'] },
          Node: {
            type: 'object',
            properties: { child: { $ref: '#/$defs/Node' } },
          },
        },
        properties: {
          mode: { $ref: '#/$defs/Mode', description: 'Email mode.' },
          tree: { $ref: '#/$defs/Node' },
        },
      },
      {
        inlineRefs: true,
        onLossy: (path, reason) => lossy.push(`${path}: ${reason}`),
      },
    );

    expect(result).toEqual({
      type: 'object',
      properties: {
        mode: {
          description: 'Email mode.',
          allOf: [{ type: 'string', enum: ['raw', 'hash'] }],
        },
        tree: { type: 'object', properties: { child: {} } },
      },
    });
    expect(JSON.stringify(result)).not.toContain('$ref');
    expect(lossy).toEqual([
      '#/properties/tree/properties/child: replaced a recursive "$ref" with an unconstrained schema',
    ]);
  });

  it('gives tuples an items schema', () => {
    const { result } = convert({
      type: 'object',
      properties: {
        pair: { type: 'array', prefixItems: [{ type: 'string' }] },
        draft7: {
          type: 'array',
          items: [{ type: 'string' }],
          additionalItems: { type: 'number' },
        },
      },
    });

    expect(result).toEqual({
      type: 'object',
      properties: {
        pair: { type: 'array', prefixItems: [{ type: 'string' }], items: {} },
        draft7: {
          type: 'array',
          prefixItems: [{ type: 'string' }],
          items: { type: 'number' },
        },
      },
    });
  });

  it('returns an already compliant schema deeply equal, without mutating it', () => {
    const accepted: JsonSchemaValue = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text.' },
        kind: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        filter: {
          anyOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' } },
              required: ['a'],
            },
            { type: 'null' },
          ],
        },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      },
      required: ['query'],
      additionalProperties: false,
    };
    const snapshot = JSON.stringify(accepted);

    const { result, lossy } = convert(accepted);

    expect(result).toEqual(accepted);
    expect(JSON.stringify(accepted)).toBe(snapshot);
    expect(lossy).toEqual([]);
  });

  it('is idempotent', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          anyOf: [{ required: ['a'] }, { required: ['b'] }],
        },
      },
    };
    const once = toGeminiToolSchema(schema);

    expect(toGeminiToolSchema(once)).toEqual(once);
  });
});

describe('tool schema conversion bounds', () => {
  const selfRefUnion: JsonSchemaValue = {
    type: 'object',
    anyOf: [{ $ref: '#' }, { $ref: '#' }],
  };

  /** Each level folds its `properties` into both branches of its union. */
  function doublingUnions(levels: number): JsonSchemaValue {
    let schema: JsonSchemaValue = { type: 'string' };
    for (let level = 0; level < levels; level += 1) {
      schema = {
        type: 'object',
        properties: { x: schema },
        anyOf: [{}, {}],
      };
    }
    return schema;
  }

  const mutualRefs: JsonSchemaValue = {
    type: 'object',
    $defs: {
      A: {
        type: 'object',
        properties: { a: { type: 'string' } },
        anyOf: [{ $ref: '#/$defs/B' }, { $ref: '#/$defs/B' }],
      },
      B: {
        type: 'object',
        properties: { b: { type: 'string' } },
        anyOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/A' }],
      },
    },
    anyOf: [{ $ref: '#/$defs/A' }],
  };

  /**
   * Run a conversion and check that the built-in work it scanned stays within
   * a fixed multiple of its input's size, so nothing it does re-scans the
   * input per node.
   */
  function bounded(
    schema: JsonSchemaValue,
    run: () => JsonSchemaValue,
  ): JsonSchemaValue {
    const { result, work } = measureWork(run);
    expect(work).toBeLessThan(4 * JSON.stringify(schema).length + 50_000);
    return result;
  }

  /** Work growth must stay near 2 when the input doubles; re-scanning gives 4. */
  const LINEAR_GROWTH = 2.5;

  /** One long description referenced from 1,000 properties. */
  function refFanOut(): JsonSchemaValue {
    const properties: JsonSchemaObject = {};
    for (let index = 0; index < 1000; index += 1) {
      properties[`p${index}`] = { $ref: '#/$defs/Big' };
    }
    return {
      type: 'object',
      $defs: { Big: { type: 'string', description: 'x'.repeat(1_000_000) } },
      properties,
    };
  }

  it.each([
    ['40 levels of doubling unions', doublingUnions(40), 'nested too deeply'],
  ])(
    'returns %s unchanged for Gemini, with bounded work and one report',
    (_name, schema, reason) => {
      const lossy: [string, string][] = [];
      const result = bounded(schema, () =>
        toGeminiToolSchema(schema, {
          onLossy: (path, why) => lossy.push([path, why]),
        }),
      );

      expect(result).toBe(schema);
      expect(lossy).toEqual([['#', expect.stringContaining(reason)]]);
      expect(lossy[0]?.[1]).toContain('schema left unchanged');
    },
  );

  it.each([
    ['a self-referencing union', selfRefUnion],
    ['mutually recursive definitions', mutualRefs],
    ['20 levels of doubling unions', doublingUnions(20)],
    ['40 levels of doubling unions', doublingUnions(40)],
  ])('converts %s to strict form with bounded work', (_name, schema) => {
    const result = bounded(schema, () => toStrictToolSchema(schema));

    expect(JSON.stringify(result).length).toBeLessThan(
      Math.max(20 * JSON.stringify(schema).length, 100_000),
    );
  });

  it.each([
    ['a self-referencing union', selfRefUnion],
    ['mutually recursive definitions', mutualRefs],
  ])(
    'converts %s for Gemini with bounded work, without following its $refs',
    (_name, schema) => {
      const result = bounded(schema, () => toGeminiToolSchema(schema));

      expect(JSON.stringify(result).length).toBeLessThan(
        10 * JSON.stringify(schema).length,
      );
      expect(toGeminiToolSchema(result)).toEqual(result);
    },
  );

  it('folds 20 levels of doubling unions in linear output', () => {
    const schema = doublingUnions(20);
    const result = bounded(schema, () => toGeminiToolSchema(schema));

    expect(JSON.stringify(result).length).toBeLessThan(
      3 * JSON.stringify(schema).length,
    );
  });

  it('keeps a 1 MB description beside 1,000 empty branches linear', () => {
    // Review case: copying the description into every branch amplified a
    // small request into gigabytes of output.
    const big = 'x'.repeat(1_000_000);
    const branches = Array.from({ length: 1000 }, () => ({}));
    const schemas: JsonSchemaValue[] = [
      {
        type: 'object',
        properties: {
          v: { type: 'object', description: big, anyOf: branches },
        },
      },
      {
        type: 'object',
        properties: {
          v: {
            type: 'object',
            properties: { a: { type: 'string', description: big } },
            anyOf: Array.from({ length: 1000 }, () => ({ required: ['a'] })),
          },
        },
      },
    ];
    for (const schema of schemas) {
      const size = JSON.stringify(schema).length;
      for (const convert of [toGeminiToolSchema, toStrictToolSchema]) {
        const lossy: string[] = [];
        const result = bounded(schema, () =>
          convert(schema, { onLossy: (_path, reason) => lossy.push(reason) }),
        );
        if (result === schema) {
          expect(lossy).toEqual([
            'work budget exceeded; schema left unchanged',
          ]);
        } else {
          expect(JSON.stringify(result).length).toBeLessThan(size + 200_000);
        }
      }
      // The Gemini fold emits the description once.
      expect(toGeminiToolSchema(schema)).not.toBe(schema);
    }
  });

  it('leaves a schema unchanged when inlining refs would repeat a long string', () => {
    const schema = refFanOut();
    const lossy: [string, string][] = [];
    const result = bounded(schema, () =>
      toGeminiToolSchema(schema, {
        inlineRefs: true,
        onLossy: (path, reason) => lossy.push([path, reason]),
      }),
    );

    expect(result).toBe(schema);
    expect(lossy).toEqual([
      ['#', 'work budget exceeded; schema left unchanged'],
    ]);
    // Without inlining the refs stay refs, so nothing is repeated.
    expect(JSON.stringify(toGeminiToolSchema(schema)).length).toBeLessThan(
      JSON.stringify(schema).length + 1000,
    );
  });

  /** One property named with `length` characters over `children` subschemas. */
  function longNameOverManyNodes(
    length: number,
    children: (index: number) => JsonSchemaValue,
    count: number,
  ): JsonSchemaValue {
    const properties: JsonSchemaObject = {};
    for (let index = 0; index < count; index += 1) {
      properties[`p${index}`] = children(index);
    }
    return {
      type: 'object',
      properties: { ['k'.repeat(length)]: { type: 'object', properties } },
    };
  }

  it('keeps the work per node independent of a long property name above it', () => {
    // Review case: deriving each node's depth from its JSON pointer scanned
    // every key above it again, for every node. Doubling both the name and
    // the nodes below it quadrupled the work.
    const make = (size: number): JsonSchemaValue =>
      longNameOverManyNodes(200 * size, () => ({ type: 'string' }), size);
    for (const inlineRefs of [true, false]) {
      const convert = (schema: JsonSchemaValue): JsonSchemaValue =>
        toGeminiToolSchema(schema, { inlineRefs });
      expect(workGrowth(make, convert, 500)).toBeLessThan(LINEAR_GROWTH);
      const schema = make(500);
      expect(convert(schema)).toEqual(schema);
    }
  });

  it('charges lossy report paths and caps how many are reported', () => {
    const make = (size: number): JsonSchemaValue =>
      longNameOverManyNodes(
        200 * size,
        () => ({ $ref: '#/$defs/Missing' }),
        size,
      );
    const convert = (schema: JsonSchemaValue): JsonSchemaValue =>
      toGeminiToolSchema(schema, { inlineRefs: true, onLossy: () => {} });

    expect(workGrowth(make, convert, 500)).toBeLessThan(LINEAR_GROWTH);

    // The same 100 unresolvable refs under a 1-character name and under a
    // 64,000-character one. Only two charges depend on the name: measuring
    // the input once (1,000 units more) and formatting each of the 20
    // reported paths, every one of which contains the name (about 1,000
    // units more each). Charged, the long name costs about 21,000 units
    // more; uncharged paths would leave only the 1,000 for measuring.
    const nameLength = 64_000;
    const unitsPerName = nameLength / CHARS_PER_WORK_UNIT;
    const spent = (length: number): number => {
      const budget = new ToolSchemaWorkBudget(MAX_TOOL_SCHEMA_WORK);
      const lossy: [string, string][] = [];
      const schema = longNameOverManyNodes(
        length,
        () => ({ $ref: '#/$defs/Missing' }),
        100,
      );
      const result = toGeminiToolSchema(schema, {
        budget,
        inlineRefs: true,
        onLossy: (path, reason) => lossy.push([path, reason]),
      });
      expect(result).not.toBe(schema);
      expect(lossy).toHaveLength(21);
      expect(lossy[19]?.[0].length).toBeGreaterThan(length);
      expect(lossy[20]).toEqual(['#', '80 more lossy changes not reported']);
      return MAX_TOOL_SCHEMA_WORK - budget.remainingUnits;
    };

    expect(spent(nameLength) - spent(1)).toBeGreaterThanOrEqual(
      20 * (unitsPerName - 1) + unitsPerName - 1,
    );
  });

  it('caps the reports of a conversion that succeeds', () => {
    const schema = longNameOverManyNodes(
      1,
      () => ({ $ref: '#/$defs/Missing' }),
      100,
    );
    const lossy: [string, string][] = [];
    const result = toGeminiToolSchema(schema, {
      inlineRefs: true,
      onLossy: (path, reason) => lossy.push([path, reason]),
    });

    expect(result).not.toBe(schema);
    expect(lossy).toHaveLength(21);
    expect(lossy[0]).toEqual([
      '#/properties/k/properties/p0',
      'replaced an unresolvable "$ref" with {}',
    ]);
    expect(lossy[20]).toEqual(['#', '80 more lossy changes not reported']);
  });

  it('resolves refs into a wide union without walking it once per ref', () => {
    const make = (count: number): JsonSchemaValue => {
      const properties: JsonSchemaObject = {
        u: {
          type: 'object',
          properties: { a: { type: 'string' } },
          anyOf: Array.from({ length: count }, (_, index) => ({
            required: [`a${index}`],
          })),
        },
      };
      for (let index = 0; index < count; index += 1) {
        properties[`r${index}`] = { $ref: `#/properties/u/anyOf/${index}` };
      }
      return { type: 'object', properties };
    };

    expect(workGrowth(make, toGeminiToolSchema, 1000)).toBeLessThan(
      LINEAR_GROWTH,
    );
    const schema = make(1000);
    const result = toGeminiToolSchema(schema);
    expect(JSON.stringify(result).length).toBeLessThan(
      4 * JSON.stringify(schema).length,
    );
  });

  it('copies moved ref targets in linear work, each resolvable', () => {
    const make = (count: number): JsonSchemaValue => {
      const properties: JsonSchemaObject = {};
      const refs: JsonSchemaObject = {};
      for (let index = 0; index < count; index += 1) {
        properties[`n${index}`] = {
          type: 'object',
          properties: { x: { type: 'string', minLength: index } },
          anyOf: [{ required: ['x'] }],
        };
        refs[`r${index}`] = { $ref: `#/properties/n${index}/properties/x` };
      }
      return { type: 'object', properties: { ...properties, ...refs } };
    };

    expect(workGrowth(make, toGeminiToolSchema, 500)).toBeLessThan(
      LINEAR_GROWTH,
    );
    const result = toGeminiToolSchema(make(1000));
    const ref = resolvePointer(result, '#/properties/r999/$ref');
    expect(typeof ref === 'string' && resolvePointer(result, ref)).toEqual({
      type: 'string',
      minLength: 999,
    });
  });

  it('merges long required lists for strict form in linear work', () => {
    const names = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `n${index}`);
    const shapes: ((count: number) => JsonSchemaValue)[] = [
      (count): JsonSchemaValue => ({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: names(count),
        anyOf: [{ required: names(count) }],
      }),
      (count): JsonSchemaValue => ({
        type: 'object',
        allOf: [{ required: names(count) }, { required: names(count) }],
      }),
    ];
    for (const make of shapes) {
      expect(workGrowth(make, toStrictToolSchema, 2000)).toBeLessThan(
        LINEAR_GROWTH,
      );
    }
  });

  it('strips a value with many null keys against a long required list in linear work', () => {
    const make = (count: number): [JsonSchemaValue, JsonSchemaValue] => {
      const names = Array.from({ length: count }, (_, index) => `n${index}`);
      const properties: JsonSchemaObject = {};
      const value: JsonSchemaObject = {};
      for (const name of names) {
        properties[name] = { type: ['string', 'null'] };
        value[name] = null;
      }
      const schema: JsonSchemaValue = {
        type: 'object',
        properties: {
          v: {
            anyOf: [
              { type: 'object', properties, required: names },
              { type: 'null' },
            ],
          },
        },
      };
      return [{ v: value }, schema];
    };
    const strip = ([value, schema]: [
      JsonSchemaValue,
      JsonSchemaValue,
    ]): JsonSchemaValue => stripStrictNulls(value, schema);

    expect(workGrowth(make, strip, 2000)).toBeLessThan(LINEAR_GROWTH);
  });

  it('converts the doubling unions that fit the budget', () => {
    const lossy: string[] = [];
    const schema = doublingUnions(4);

    const result = toGeminiToolSchema(schema, {
      onLossy: (_path, reason) => lossy.push(reason),
    });

    expect(result).not.toBe(schema);
    expect(lossy).toEqual([]);
  });

  it('charges a shared budget and leaves the next schema converted', () => {
    const budget = new ToolSchemaWorkBudget(10 * MAX_TOOL_SCHEMA_WORK);
    const target: JsonSchemaValue = {
      type: 'object',
      properties: { a: { type: 'string' } },
      anyOf: [{ required: ['a'] }],
    };

    expect(
      toGeminiToolSchema(refFanOut(), { budget, inlineRefs: true }),
    ).toEqual(refFanOut());
    // An exhausted conversion spends its own allowance, never more.
    const afterExhausted = budget.remainingUnits;
    expect(afterExhausted).toBeLessThan(10 * MAX_TOOL_SCHEMA_WORK);
    expect(afterExhausted).toBeGreaterThanOrEqual(9 * MAX_TOOL_SCHEMA_WORK);
    const parent = { type: 'object', properties: { a: { type: 'string' } } };
    expect(toGeminiToolSchema(target, { budget })).toEqual({
      ...parent,
      allOf: [{ anyOf: [{ required: ['a'] }] }],
    });
    expect(toStrictToolSchema(target, { budget })).not.toBe(target);
    expect(budget.remainingUnits).toBeLessThan(afterExhausted);
  });

  it('leaves every schema unchanged once the shared budget is spent', () => {
    const budget = new ToolSchemaWorkBudget(0);
    const target: JsonSchemaValue = {
      type: 'object',
      properties: { a: { type: 'string' } },
      anyOf: [{ required: ['a'] }],
    };
    const lossy: string[] = [];
    const onLossy = (_path: string, reason: string): void => {
      lossy.push(reason);
    };

    expect(toGeminiToolSchema(target, { budget, onLossy })).toBe(target);
    expect(toStrictToolSchema(target, { budget, onLossy })).toBe(target);
    expect(lossy).toEqual([
      'work budget exceeded; schema left unchanged',
      'work budget exceeded; schema left unchanged',
    ]);
  });
});

describe('Gemini conversion keeps validation behavior (Ajv)', () => {
  function validator(schema: JsonSchemaValue): (instance: unknown) => boolean {
    if (
      typeof schema !== 'object' ||
      schema === null ||
      Array.isArray(schema)
    ) {
      throw new Error('expected an object schema');
    }
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(schema);
    return (instance) => validate(instance) === true;
  }

  function expectSameVerdicts(
    original: JsonSchemaValue,
    samples: { valid: unknown[]; invalid: unknown[] },
  ): JsonSchemaValue {
    const converted = toGeminiToolSchema(original);
    const before = validator(original);
    const after = validator(converted);
    for (const instance of samples.valid) {
      expect([instance, before(instance), after(instance)]).toEqual([
        instance,
        true,
        true,
      ]);
    }
    for (const instance of samples.invalid) {
      expect([instance, before(instance), after(instance)]).toEqual([
        instance,
        false,
        false,
      ]);
    }
    return converted;
  }

  it('keeps a ref into root properties resolvable after they move into union branches', () => {
    const converted = expectSameVerdicts(
      {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2 },
          alias: { $ref: '#/properties/name' },
        },
        additionalProperties: false,
        anyOf: [{ required: ['name'] }, { required: ['alias'] }],
      },
      {
        valid: [{ name: 'ab' }, { alias: 'cd' }, { name: 'ab', alias: 'cd' }],
        invalid: [{}, { alias: 'c' }, { alias: 1 }, { name: 'ab', extra: 1 }],
      },
    );
    expect(JSON.stringify(converted)).toContain('#/properties/name');
  });

  it('keeps refs into a folded oneOf, its branches, and refs inside the copies', () => {
    expectSameVerdicts(
      {
        type: 'object',
        properties: {
          target: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 2 },
              copy: { $ref: '#/properties/target/properties/id' },
            },
            oneOf: [
              { required: ['copy'] },
              {
                type: 'object',
                properties: { id: { type: 'string', maxLength: 4 } },
                required: ['id'],
              },
            ],
          },
          sameId: { $ref: '#/properties/target/properties/id' },
          secondChoice: { $ref: '#/properties/target/oneOf/1' },
        },
        required: ['target'],
      },
      {
        valid: [
          { target: { id: 'ab' } },
          { target: { copy: 'cd' } },
          { target: { id: 'ab' }, sameId: 'cd' },
          { target: { id: 'ab' }, secondChoice: { id: 'abcd' } },
        ],
        invalid: [
          { target: {} },
          { target: { id: 'a' } },
          { target: { copy: 'c' } },
          // Both oneOf branches match.
          { target: { id: 'ab', copy: 'cd' } },
          { target: { id: 'ab' }, sameId: 'c' },
          { target: { id: 'ab' }, secondChoice: {} },
          { target: { id: 'ab' }, secondChoice: { id: 'abcde' } },
        ],
      },
    );
  });

  it('requires both schemas where a branch redeclares a parent keyword', () => {
    expectSameVerdicts(
      {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            pattern: '^[a-z]+$',
            allOf: [{ minLength: 2 }],
            anyOf: [
              { pattern: '^a', allOf: [{ maxLength: 4 }] },
              { pattern: 'z$' },
            ],
          },
        },
      },
      {
        valid: [{ code: 'ab' }, { code: 'abcd' }, { code: 'xyz' }],
        invalid: [
          { code: 'a' },
          { code: 'abcde1' },
          { code: 'ab1' },
          { code: 'Abc' },
          { code: 'abcdef' },
          { code: 'mm' },
        ],
      },
    );
  });

  it("keeps a parent's additionalProperties judged against its own properties", () => {
    expectSameVerdicts(
      {
        type: 'object',
        properties: { kind: { type: 'string' } },
        additionalProperties: false,
        anyOf: [
          { required: ['kind'] },
          { properties: { extra: { type: 'string' } }, required: ['extra'] },
        ],
      },
      {
        valid: [{ kind: 'a' }],
        invalid: [{}, { extra: 'x' }, { kind: 'a', extra: 'x' }, { other: 1 }],
      },
    );
  });

  it('carries number bounds into an integer branch of a nullable union', () => {
    const converted = expectSameVerdicts(
      {
        type: 'object',
        properties: {
          count: {
            type: ['number', 'null'],
            minimum: 1,
            maximum: 10,
            anyOf: [{ type: 'integer' }, { type: 'null' }],
          },
          ratio: {
            type: 'number',
            multipleOf: 0.5,
            anyOf: [{ type: ['integer', 'null'] }, { maximum: 2 }],
          },
        },
        required: ['count'],
      },
      {
        valid: [
          { count: 5 },
          { count: null },
          { count: 1, ratio: 4 },
          { count: 1, ratio: 1.5 },
        ],
        invalid: [
          { count: 0 },
          { count: 11 },
          { count: 5.5 },
          { count: '5' },
          { count: 1, ratio: 3.5 },
          { count: 1, ratio: 0.3 },
          { count: 1, ratio: null },
        ],
      },
    );
    expect(converted).toMatchObject({
      properties: {
        count: {
          allOf: [
            { type: ['number', 'null'], minimum: 1, maximum: 10 },
            { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          ],
        },
      },
    });
  });

  it('keeps required from both a $ref target and the keywords beside it', () => {
    // Review case: a branch `required: ['y']` beside a `$ref` whose target
    // requires `x` must still require both.
    expectSameVerdicts(
      {
        type: 'object',
        $defs: {
          X: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
        },
        properties: {
          v: {
            type: 'object',
            properties: { y: { type: 'string' } },
            anyOf: [{ $ref: '#/$defs/X', required: ['y'] }],
          },
        },
        required: ['v'],
      },
      {
        valid: [{ v: { x: 'a', y: 'b' } }],
        invalid: [{ v: { x: 'a' } }, { v: { y: 'b' } }, { v: {} }],
      },
    );
  });

  it('keeps a ref into object-valued items resolvable when a union moves them', () => {
    // Review case: `items` moved under `allOf/0` with the union's siblings,
    // and `#/properties/values/items` stopped resolving.
    expectSameVerdicts(
      {
        type: 'object',
        properties: {
          values: {
            type: 'array',
            items: { type: 'string', minLength: 2 },
            anyOf: [{ minItems: 2 }, { maxItems: 0 }],
          },
          first: { $ref: '#/properties/values/items' },
        },
      },
      {
        valid: [{ values: ['ab', 'cd'] }, { values: [] }, { first: 'cd' }],
        invalid: [
          { values: ['ab'] },
          { values: ['ab', 'c'] },
          { first: 'c' },
          { first: 1 },
        ],
      },
    );
  });

  it("keeps a ref into a draft-07 tuple's additionalItems resolvable", () => {
    const converted = toGeminiToolSchema({
      type: 'object',
      properties: {
        pair: {
          type: 'array',
          items: [{ type: 'string' }],
          additionalItems: { type: 'integer', minimum: 3 },
        },
        extra: { $ref: '#/properties/pair/additionalItems' },
      },
    });

    const ref = resolvePointer(converted, '#/properties/extra/$ref');
    expect(typeof ref === 'string' && resolvePointer(converted, ref)).toEqual({
      type: 'integer',
      minimum: 3,
    });
  });

  it('keeps unevaluatedProperties seeing the properties a union branch evaluates', () => {
    // Review case: `unevaluatedProperties` in one `allOf` member cannot see
    // what a union in another member evaluated.
    expectSameVerdicts(
      {
        type: 'object',
        properties: {
          v: {
            type: 'object',
            properties: { k: { type: 'boolean' } },
            unevaluatedProperties: false,
            anyOf: [
              { properties: { a: { type: 'string' } }, required: ['a'] },
              { properties: { b: { type: 'number' } } },
            ],
          },
        },
      },
      {
        valid: [{ v: { a: 'ok' } }, { v: { k: true, b: 2 } }, { v: {} }],
        invalid: [{ v: { c: 1 } }, { v: { a: 1 } }, { v: { k: 1 } }],
      },
    );
  });

  it('keeps unevaluatedProperties beside the applicators it depends on when object keywords move', () => {
    expectSameVerdicts(
      {
        type: 'object',
        $defs: { B: { properties: { b: { type: 'number' } } } },
        properties: {
          v: {
            allOf: [{ properties: { a: { type: 'string' } } }],
            $ref: '#/$defs/B',
            unevaluatedProperties: false,
          },
        },
      },
      {
        valid: [{ v: { a: 'x' } }, { v: { b: 1 } }, { v: {} }, { v: 'text' }],
        invalid: [{ v: { c: 1 } }, { v: { a: 1 } }, { v: { b: 'x' } }],
      },
    );
  });

  it('adds no items schema that unevaluatedItems would see', () => {
    expectSameVerdicts(
      {
        type: 'object',
        properties: {
          bare: {
            type: 'array',
            prefixItems: [{ type: 'string' }],
            unevaluatedItems: false,
          },
          nested: {
            type: 'array',
            unevaluatedItems: false,
            allOf: [{ prefixItems: [{ type: 'string' }] }],
          },
          union: {
            type: 'array',
            prefixItems: [{ type: 'string' }],
            unevaluatedItems: false,
            anyOf: [{ prefixItems: [{}, { type: 'number' }] }, { maxItems: 1 }],
          },
        },
      },
      {
        valid: [
          { bare: ['a'] },
          { nested: ['a'] },
          { nested: [] },
          { union: ['a'] },
          { union: ['a', 2] },
        ],
        invalid: [
          { bare: ['a', 1] },
          { nested: ['a', 1] },
          { nested: [1] },
          { union: ['a', 2, 3] },
          { union: ['a', 'b'] },
        ],
      },
    );
  });

  it('keeps both closures when parent and branch set additionalProperties false', () => {
    // Review case: both closed, with different property names.
    expectSameVerdicts(
      {
        type: 'object',
        properties: {
          v: {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: false,
            anyOf: [
              {
                properties: { b: { type: 'string' } },
                additionalProperties: false,
              },
              { required: ['a'] },
            ],
          },
        },
      },
      {
        valid: [{ v: {} }, { v: { a: 'x' } }],
        invalid: [
          { v: { b: 'x' } },
          { v: { a: 'x', b: 'y' } },
          { v: { c: 1 } },
        ],
      },
    );
  });
});

describe('schemas outside the modeled subset', () => {
  function compileAjv(schema: JsonSchemaValue): (instance: unknown) => boolean {
    if (
      typeof schema !== 'object' ||
      schema === null ||
      Array.isArray(schema)
    ) {
      throw new Error('expected an object schema');
    }
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(schema);
    return (instance) => validate(instance) === true;
  }

  /** A union beside other keywords, so a converted schema differs. */
  const folded: JsonSchemaValue = {
    type: 'object',
    properties: { k: { type: 'string' } },
    anyOf: [{ required: ['k'] }, {}],
  };

  function convertBoth(schema: JsonSchemaValue): [string, string][][] {
    return [false, true].map((inlineRefs) => {
      const lossy: [string, string][] = [];
      const result = toGeminiToolSchema(schema, {
        inlineRefs,
        onLossy: (path, reason) => lossy.push([path, reason]),
      });
      expect(result).toBe(schema);
      return lossy;
    });
  }

  it('leaves a schema with a nested $id unchanged instead of resolving its refs at the root', () => {
    // Review case: `#/$defs/Mode` inside a resource with its own `$id`
    // names that resource's `Mode`, not the root's.
    const schema: JsonSchemaValue = {
      type: 'object',
      $defs: { Mode: { enum: ['outer'] } },
      properties: {
        mode: {
          $id: 'https://example.com/inner',
          $defs: { Mode: { enum: ['inner'] } },
          allOf: [{ $ref: '#/$defs/Mode' }],
        },
        wrapped: folded,
      },
    };

    for (const lossy of convertBoth(schema)) {
      expect(lossy).toEqual([
        ['#', 'unsupported keyword "$id"; schema left unchanged'],
      ]);
    }
    const validate = compileAjv(schema);
    expect(validate({ mode: 'inner' })).toBe(true);
    expect(validate({ mode: 'outer' })).toBe(false);
  });

  it('leaves a schema with a named anchor unchanged instead of dropping its target', () => {
    // Review case: inlining dropped `$defs` and left `#Mode` dangling.
    const schema: JsonSchemaValue = {
      type: 'object',
      $defs: { Mode: { $anchor: 'Mode', enum: ['a', 'b'] } },
      properties: { mode: { $ref: '#Mode' }, wrapped: folded },
    };

    for (const lossy of convertBoth(schema)) {
      expect(lossy).toHaveLength(1);
      expect(lossy[0]?.[0]).toBe('#');
      expect(lossy[0]?.[1]).toMatch(
        /^unsupported keyword "\$(anchor|ref)"; schema left unchanged$/,
      );
    }
    const validate = compileAjv(schema);
    expect(validate({ mode: 'a' })).toBe(true);
    expect(validate({ mode: 'c' })).toBe(false);
  });

  it.each<[string, string, JsonSchemaValue]>([
    ['$anchor', '$anchor', { $anchor: 'A', type: 'string' }],
    ['$dynamicAnchor', '$dynamicAnchor', { $dynamicAnchor: 'A' }],
    ['$dynamicRef', '$dynamicRef', { $dynamicRef: '#A' }],
    ['$recursiveAnchor', '$recursiveAnchor', { $recursiveAnchor: true }],
    ['$recursiveRef', '$recursiveRef', { $recursiveRef: '#' }],
    ['a nested $id', '$id', { $id: 'inner.json', type: 'string' }],
    ['a remote $ref', '$ref', { $ref: 'https://example.com/s.json' }],
    ['a relative $ref', '$ref', { $ref: 'other.json#/$defs/A' }],
    ['an anchor $ref', '$ref', { $ref: '#A' }],
    ['a percent-encoded $ref', '$ref', { $ref: '#/$defs/a%20b' }],
    [
      'schema-valued dependencies',
      'dependencies',
      { dependencies: { a: { required: ['b'] } } },
    ],
  ])(
    'leaves a schema with %s unchanged in both modes, with one report',
    (_name, keyword, member) => {
      const schema: JsonSchemaValue = {
        type: 'object',
        $defs: { A: { type: 'string' }, 'a b': { type: 'string' } },
        properties: {
          v: { type: 'object', properties: { x: member }, anyOf: [{}] },
          wrapped: folded,
        },
      };

      for (const lossy of convertBoth(schema)) {
        expect(lossy).toEqual([
          ['#', `unsupported keyword "${keyword}"; schema left unchanged`],
        ]);
      }
    },
  );

  it('ignores the excluded keywords where they are data or property names', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      $id: 'https://example.com/tool',
      properties: {
        $anchor: { type: 'string' },
        $id: { const: { $id: 'x', $ref: 'https://example.com' } },
        deps: {
          type: 'object',
          dependencies: { a: ['b'] },
          enum: [{ $dynamicRef: '#x' }],
        },
        ref: { $ref: '#/properties/$anchor' },
        wrapped: folded,
      },
    };

    for (const inlineRefs of [false, true]) {
      const lossy: string[] = [];
      const result = toGeminiToolSchema(schema, {
        inlineRefs,
        onLossy: (_path, reason) => lossy.push(reason),
      });
      expect(result).not.toBe(schema);
      expect(lossy).toEqual([]);
      const before = compileAjv(schema);
      const after = compileAjv(result);
      for (const instance of [
        { ref: 'x' },
        { ref: 1 },
        { $id: { $id: 'x', $ref: 'https://example.com' } },
        { $id: 1 },
        { deps: { a: 1 } },
        { deps: { a: 1, b: 2 } },
        { wrapped: {} },
        { wrapped: { k: 'x' } },
      ]) {
        expect([inlineRefs, instance, after(instance)]).toEqual([
          inlineRefs,
          instance,
          before(instance),
        ]);
      }
    }
  });

  it('still converts a schema whose root declares $id', () => {
    const schema: JsonSchemaValue = {
      $id: 'https://example.com/tool',
      type: 'object',
      $defs: { S: { type: 'string', minLength: 2 } },
      properties: {
        a: { $ref: '#/$defs/S' },
        b: {
          type: 'object',
          properties: { c: { $ref: '#/$defs/S' } },
          anyOf: [{ required: ['c'] }],
        },
      },
    };

    for (const inlineRefs of [false, true]) {
      const result = toGeminiToolSchema(schema, { inlineRefs });
      expect(result).not.toBe(schema);
      const before = compileAjv(schema);
      const after = compileAjv(result);
      for (const instance of [
        { a: 'xy' },
        { a: 'x' },
        { b: {} },
        { b: { c: 'xy' } },
        { b: { c: 'x' } },
      ]) {
        expect(after(instance)).toBe(before(instance));
      }
    }
  });

  it('charges only the work spent for a schema outside the subset', () => {
    const budget = new ToolSchemaWorkBudget(MAX_TOOL_SCHEMA_WORK);
    const schema: JsonSchemaValue = {
      type: 'object',
      properties: { x: { $anchor: 'A' } },
    };

    expect(toGeminiToolSchema(schema, { budget })).toBe(schema);
    expect(budget.remainingUnits).toBeGreaterThan(MAX_TOOL_SCHEMA_WORK - 100);
  });
});

describe('Gemini conversion is equivalent on generated schemas (Ajv)', () => {
  /** Deterministic pseudo-random numbers, so a failure reproduces by seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4_294_967_296;
    };
  }

  const NAMES = ['a', 'b', 'c'];

  function pick<T>(next: () => number, values: readonly T[]): T {
    const value = values[Math.floor(next() * values.length)];
    if (value === undefined) throw new Error('empty choice');
    return value;
  }

  function subset(next: () => number): string[] {
    return NAMES.filter(() => next() < 0.4);
  }

  /** A value schema for one property. */
  function leaf(next: () => number): JsonSchemaValue {
    return pick(next, [
      { anyOf: [{ allOf: [{ $ref: '#/$defs/Short' }] }, { type: 'null' }] },
      { type: 'string', minLength: 1 },
      { type: 'integer', minimum: 0, maximum: 5 },
      { type: 'number', maximum: 3, multipleOf: 0.5 },
      { type: ['number', 'null'], minimum: 1 },
      { type: 'boolean' },
      { anyOf: [{ type: 'integer' }, { type: 'null' }], minimum: 2 },
      { $ref: '#/$defs/Short' },
    ]);
  }

  /** An object schema whose keywords may sit beside unions at any level. */
  function objectSchema(next: () => number, depth: number): JsonSchemaObject {
    const node: JsonSchemaObject = {};
    if (next() < 0.8) node.type = 'object';
    const properties: JsonSchemaObject = {};
    for (const name of subset(next)) {
      properties[name] =
        depth > 0 && next() < 0.3 ? objectSchema(next, depth - 1) : leaf(next);
    }
    if (Object.keys(properties).length > 0 || next() < 0.3) {
      node.properties = properties;
    }
    const required = subset(next);
    if (required.length > 0) node.required = required;
    if (next() < 0.4) node.additionalProperties = false;
    if (next() < 0.2) node.minProperties = 1;
    if (next() < 0.2) node.$ref = '#/$defs/Closed';
    if (depth > 0 && next() < 0.7) {
      const branches = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
        next() < 0.3
          ? { required: subset(next) }
          : next() < 0.2
            ? { $ref: '#/$defs/Closed', required: subset(next) }
            : objectSchema(next, depth - 1),
      );
      node[next() < 0.6 ? 'anyOf' : 'oneOf'] = branches;
    }
    return node;
  }

  function generatedSchema(seed: number): JsonSchemaObject {
    const next = random(seed);
    return {
      type: 'object',
      $defs: {
        Short: { type: 'string', maxLength: 2 },
        Closed: {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: false,
          required: ['a'],
        },
      },
      properties: { v: objectSchema(next, 3) },
      required: ['v'],
    };
  }

  function sampleValue(next: () => number, depth: number): unknown {
    const kind = Math.floor(next() * (depth > 0 ? 9 : 7));
    switch (kind) {
      case 0:
        return null;
      case 1:
        return pick(next, ['', 'x', 'xyz']);
      case 2:
        return pick(next, [0, 1, 2, 3, 6]);
      case 3:
        return pick(next, [0.5, 1.5, 2.25]);
      case 4:
        return next() < 0.5;
      case 5:
      case 6:
        return pick(next, [-1, 4]);
      default: {
        const value: Record<string, unknown> = {};
        for (const name of [...NAMES, 'z']) {
          if (next() < 0.5) value[name] = sampleValue(next, depth - 1);
        }
        return value;
      }
    }
  }

  function samples(seed: number): unknown[] {
    const next = random(seed * 7919);
    return [
      { v: {} },
      { v: { a: 'x' } },
      { v: { a: 'x', b: 'y' } },
      { v: { a: 'xy', b: 1, c: true } },
      ...Array.from({ length: 60 }, () => ({ v: sampleValue(next, 3) })),
    ];
  }

  function compile(schema: JsonSchemaValue): (instance: unknown) => boolean {
    if (
      typeof schema !== 'object' ||
      schema === null ||
      Array.isArray(schema)
    ) {
      throw new Error('expected an object schema');
    }
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(schema);
    return (instance) => validate(instance) === true;
  }

  it('compiles and gives every sample the original verdict on 300 schemas', () => {
    let accepted = 0;
    let rejected = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const original = generatedSchema(seed);
      const converted = toGeminiToolSchema(original);
      const inlined = toGeminiToolSchema(original, { inlineRefs: true });
      // Check Gemini's accepted subset on these same conversion results;
      // a second pass over the identical 300 seeds adds no distinct input.
      expect([seed, geminiViolations(converted)]).toEqual([seed, []]);
      expect([seed, geminiViolations(inlined)]).toEqual([seed, []]);
      const before = compile(original);
      const after = compile(converted);
      const afterInlined = compile(inlined);
      for (const instance of samples(seed)) {
        const verdict = before(instance);
        if (verdict) accepted += 1;
        else rejected += 1;
        expect([
          seed,
          instance,
          after(instance),
          afterInlined(instance),
        ]).toEqual([seed, instance, verdict, verdict]);
      }
      expect(toGeminiToolSchema(converted)).toEqual(converted);
      expect(JSON.stringify(inlined)).not.toContain('$ref');
    }
    // The samples exercise both verdicts, not just one.
    expect(accepted).toBeGreaterThan(250);
    expect(rejected).toBeGreaterThan(5000);
  });

  /** JSON pointers to every subschema under `path`. */
  function subschemaPointers(
    schema: JsonSchemaValue,
    path: string,
    found: string[],
  ): string[] {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
      return found;
    const node: JsonSchemaObject = schema;
    found.push(path);
    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) continue;
      if (['properties', '$defs'].includes(key) && typeof value === 'object') {
        for (const [name, member] of Object.entries(value ?? {})) {
          if (member === undefined) continue;
          subschemaPointers(member, `${path}/${key}/${name}`, found);
        }
      } else if (['anyOf', 'oneOf', 'allOf'].includes(key)) {
        if (Array.isArray(value)) {
          value.forEach((member, index) =>
            subschemaPointers(member, `${path}/${key}/${index}`, found),
          );
        }
      } else if (key === 'items') {
        subschemaPointers(value, `${path}/${key}`, found);
      }
    }
    return found;
  }

  /**
   * A generated schema with an array property beside a union, sometimes
   * `unevaluatedProperties: false` on `v`, and root properties that refer to
   * random subschemas.
   */
  function generatedSchemaWithRefs(seed: number): JsonSchemaObject {
    const schema = generatedSchema(seed);
    const next = random(seed * 31);
    const original = schema.properties;
    const properties: JsonSchemaObject = {};
    if (
      typeof original === 'object' &&
      original !== null &&
      !Array.isArray(original)
    ) {
      const record: JsonSchemaObject = original;
      for (const [name, member] of Object.entries(record)) {
        if (member !== undefined) properties[name] = member;
      }
    }
    const v = properties.v;
    if (
      next() < 0.4 &&
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v)
    ) {
      properties.v = { ...v, unevaluatedProperties: false };
    }
    properties.list = {
      type: 'array',
      items: { type: 'string', maxLength: 2 },
      anyOf: [{ minItems: 2 }, { maxItems: 0 }],
    };
    schema.properties = properties;
    const pointers = subschemaPointers(schema, '#', []).filter(
      (pointer) => pointer !== '#',
    );
    for (const name of ['r0', 'r1', 'r2']) {
      properties[name] = { $ref: pick(next, pointers) };
    }
    return schema;
  }

  it('keeps refs to any subschema meaning the same on 300 schemas', () => {
    let accepted = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const original = generatedSchemaWithRefs(seed);
      const before = compile(original);
      const next = random(seed * 131);
      const maybe = (value: () => unknown): Record<string, unknown> =>
        next() < 0.3 ? { value: value() } : {};
      const instances = samples(seed).map((sample) => {
        const instance: Record<string, unknown> = {
          ...(sample !== null && typeof sample === 'object' ? sample : {}),
        };
        const list = maybe(() =>
          pick(next, [[], ['ab', 'c'], ['ab', 'abc'], ['a'], [1, 2]]),
        );
        if ('value' in list) instance.list = list.value;
        for (const name of ['r0', 'r1', 'r2']) {
          const value = maybe(() =>
            next() < 0.5
              ? sampleValue(next, 2)
              : pick(next, ['ab', 'abc', 1, {}, { a: 'x' }]),
          );
          if ('value' in value) instance[name] = value.value;
        }
        return instance;
      });
      for (const options of [{}, { inlineRefs: true }]) {
        const converted = toGeminiToolSchema(original, options);
        const after = compile(converted);
        for (const instance of instances) {
          const verdict = before(instance);
          if (verdict) accepted += 1;
          expect([seed, options, instance, after(instance)]).toEqual([
            seed,
            options,
            instance,
            verdict,
          ]);
        }
        expect([seed, geminiViolations(converted)]).toEqual([seed, []]);
      }
    }
    expect(accepted).toBeGreaterThan(100);
  });
});

const OBJECT_KEYWORD_NAMES = [
  'properties',
  'patternProperties',
  'additionalProperties',
  'required',
  'minProperties',
  'maxProperties',
];

/**
 * Nodes outside `allOf` members that Gemini rejects: a union beside another
 * keyword, object keywords on a schema not typed `object`, `required` naming
 * an undeclared property, and `prefixItems` without `items`.
 */
function geminiViolations(schema: JsonSchemaValue): string[] {
  const found: string[] = [];
  const visit = (
    node: JsonSchemaValue,
    path: string,
    conjunct: boolean,
  ): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node))
      return;
    const record: JsonSchemaObject = node;
    const keys = Object.keys(record);
    const union = keys.includes('anyOf') || keys.includes('oneOf');
    const typed =
      record.type === 'object' ||
      (Array.isArray(record.type) && record.type.includes('object'));
    if (!conjunct && path !== '#') {
      if (
        union &&
        keys.some((key) => !['anyOf', 'oneOf', '$defs'].includes(key))
      ) {
        found.push(`${path}: union beside other keywords`);
      }
      if (!typed && keys.some((key) => OBJECT_KEYWORD_NAMES.includes(key))) {
        found.push(`${path}: object keywords without type object`);
      }
    }
    if (!conjunct && Array.isArray(record.required)) {
      const properties = record.properties;
      const declared =
        typeof properties === 'object' &&
        properties !== null &&
        !Array.isArray(properties)
          ? properties
          : {};
      for (const name of record.required) {
        if (typeof name !== 'string' || !(name in declared)) {
          found.push(`${path}: required ${JSON.stringify(name)} undeclared`);
        }
      }
    }
    if (record.prefixItems !== undefined && record.items === undefined) {
      found.push(`${path}: prefixItems without items`);
    }
    for (const keyword of ['anyOf', 'oneOf']) {
      const members = record[keyword];
      if (!Array.isArray(members)) continue;
      const bareNull = members.some(
        (member) =>
          typeof member === 'object' &&
          member !== null &&
          !Array.isArray(member) &&
          member.type === 'null' &&
          Object.keys(member).length === 1,
      );
      const untyped = members.some(
        (member) =>
          typeof member === 'object' &&
          member !== null &&
          !Array.isArray(member) &&
          member.type === undefined,
      );
      if (bareNull && untyped) {
        found.push(`${path}/${keyword}: bare null beside an untyped branch`);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'allOf' && Array.isArray(value)) {
        value.forEach((member, index) =>
          visit(member, `${path}/allOf/${index}`, true),
        );
      } else if (Array.isArray(value)) {
        // A union inside an `allOf` member is not checked either.
        const unchecked = conjunct && (key === 'anyOf' || key === 'oneOf');
        value.forEach((member, index) =>
          visit(member, `${path}/${key}/${index}`, unchecked),
        );
      } else if (
        ['properties', '$defs', 'patternProperties'].includes(key) &&
        value &&
        typeof value === 'object'
      ) {
        for (const [name, member] of Object.entries(value)) {
          if (member !== undefined)
            visit(member, `${path}/${key}/${name}`, false);
        }
      } else if (value !== null && typeof value === 'object') {
        visit(value, `${path}/${key}`, false);
      }
    }
  };
  visit(schema, '#', false);
  return found;
}

describe('deeply nested schemas', () => {
  function nested(levels: number): JsonSchemaValue {
    let schema: JsonSchemaValue = { type: 'string' };
    for (let level = 0; level < levels; level += 1) {
      schema = { type: 'object', properties: { x: schema } };
    }
    return schema;
  }

  function nestedUnions(levels: number): JsonSchemaValue {
    let schema: JsonSchemaValue = { type: 'string' };
    for (let level = 0; level < levels; level += 1) {
      schema = { anyOf: [schema] };
    }
    return schema;
  }

  it.each([
    ['properties', nested(5000)],
    ['unions', nestedUnions(5000)],
  ])(
    'returns a schema nested 5000 levels deep in %s unchanged, after one measuring walk',
    (_name, schema) => {
      for (const convert of [toGeminiToolSchema, toStrictToolSchema]) {
        const lossy: [string, string][] = [];
        const { result, work } = measureWork(() =>
          convert(schema, {
            onLossy: (path, reason) => lossy.push([path, reason]),
          }),
        );
        // Measuring enumerates each object's keys once; nothing converts.
        expect(work).toBeLessThanOrEqual(4 * 5000);
        expect(result).toBe(schema);
        expect(lossy).toEqual([
          ['#', 'schema nested too deeply; schema left unchanged'],
        ]);
      }
      const value: JsonSchemaValue = { x: null };
      expect(stripStrictNulls(value, schema)).toBe(value);
    },
  );

  it('leaves a value nested 5000 levels deep unstripped', () => {
    let value: JsonSchemaValue = null;
    for (let level = 0; level < 5000; level += 1) value = { x: value };
    expect(stripStrictNulls(value, nested(3))).toBe(value);
  });
});
