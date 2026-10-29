import Ajv2020 from 'ajv/dist/2020';
import { stripStrictNulls, toStrictToolSchema, type JsonSchemaValue } from '..';
import paritySchemas from './fixtures/parity-schemas.json';

// The schema cases of the parity harness shared with Agentic Core.
const cases: [string, JsonSchemaValue][] = Object.entries(paritySchemas);

function compileError(schema: JsonSchemaValue): string | null {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  try {
    if (
      typeof schema === 'boolean' ||
      (typeof schema === 'object' && schema && !Array.isArray(schema))
    ) {
      ajv.compile(schema);
      return null;
    }
    return 'not a schema';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('strict tool schemas compile in Ajv', () => {
  it.each(cases)('%s converts to a schema that compiles', (name, schema) => {
    // A case whose original already has a dangling reference cannot be fixed
    // by conversion; it only has to keep failing the same way.
    if (compileError(schema) !== null) {
      expect(name).toBe('description_move');
      return;
    }
    const converted = toStrictToolSchema(schema);
    expect(compileError(converted)).toBeNull();
    expect(compileError(toStrictToolSchema(converted))).toBeNull();
  });

  it('accepts strict-shaped arguments and strips them back for the original', () => {
    const schema = paritySchemas.array_union_branch_items;
    const ajv = new Ajv2020({ strict: false });
    const validateStrict = ajv.compile(toStrictToolSchema(schema));
    const strictArguments = { rows: [{ k: 'x', limit: null }] };
    expect(validateStrict(strictArguments)).toBe(true);
    const stripped = stripStrictNulls(strictArguments, schema);
    expect(stripped).toEqual({ rows: [{ k: 'x' }] });
    expect(new Ajv2020({ strict: false }).compile(schema)(stripped)).toBe(true);
  });

  // A nullable allOf member or $ref target must not hide a sibling `type`
  // that rejects null: the stripped arguments have to satisfy the original.
  it.each<[string, JsonSchemaValue]>([
    [
      'integer sibling with a nullable allOf member',
      {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', allOf: [{ type: ['integer', 'null'] }] },
        },
        required: ['query'],
      },
    ],
    [
      'integer sibling with a nullable $ref',
      {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', $ref: '#/$defs/N' },
        },
        required: ['query'],
        $defs: { N: { type: ['integer', 'null'] } },
      },
    ],
  ])('strips a null the original rejects: %s', (_name, schema) => {
    const strict = toStrictToolSchema(schema);
    expect(compileError(strict)).toBeNull();
    const modelArguments = { query: 'x', limit: null };
    const stripped = stripStrictNulls(modelArguments, schema);
    expect(stripped).toEqual({ query: 'x' });
    const validateOriginal = new Ajv2020({ strict: false }).compile(schema);
    expect(validateOriginal(modelArguments)).toBe(false);
    expect(validateOriginal(stripped)).toBe(true);
  });

  it('distributes a single-member allOf union so its calls validate', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      anyOf: [
        {
          allOf: [
            {
              type: 'object',
              properties: {
                query: { type: 'string' },
                limit: { type: 'integer' },
              },
              required: ['query'],
            },
          ],
        },
      ],
    };
    const strict = toStrictToolSchema(schema);
    expect(strict).not.toHaveProperty('properties');
    expect(strict).not.toHaveProperty('additionalProperties');
    const validateStrict = new Ajv2020({ strict: false }).compile(strict);
    const modelArguments = { query: 'x', limit: null };
    expect(validateStrict(modelArguments)).toBe(true);
    const stripped = stripStrictNulls(modelArguments, schema);
    expect(stripped).toEqual({ query: 'x' });
    expect(new Ajv2020({ strict: false }).compile(schema)(stripped)).toBe(true);
  });

  it('strips a null that two oneOf members would both accept', () => {
    const schema: JsonSchemaValue = {
      type: 'object',
      properties: {
        v: {
          oneOf: [{ type: ['string', 'null'] }, { type: ['number', 'null'] }],
        },
      },
    };
    const strict = toStrictToolSchema(schema);
    expect(new Ajv2020({ strict: false }).compile(strict)({ v: null })).toBe(
      true,
    );
    const validateOriginal = new Ajv2020({ strict: false }).compile(schema);
    expect(validateOriginal({ v: null })).toBe(false);
    const stripped = stripStrictNulls({ v: null }, schema);
    expect(stripped).toEqual({});
    expect(validateOriginal(stripped)).toBe(true);
  });
});
