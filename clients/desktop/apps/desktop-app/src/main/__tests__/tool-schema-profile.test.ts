import { applyToolSchemaProfile } from '../codex/tool-schema-profile';
import { dispatchActionJsonSchema } from '../canopy-tools/definitions';
import type { JsonValue } from '@canopy/desktop-shared/node/codex-runtime/generated/serde_json/JsonValue';

describe('applyToolSchemaProfile', () => {
  it('retains browser profile field guidance for flat providers', () => {
    expect(
      applyToolSchemaProfile(dispatchActionJsonSchema, 'flat'),
    ).toMatchObject({
      properties: {
        action: {
          properties: {
            selection: {
              type: 'object',
              properties: {
                kind: { enum: ['task', 'named'] },
                profileId: { type: 'string' },
              },
            },
            operation: {
              type: 'object',
              properties: {
                kind: { enum: ['cache', 'reset', 'site'] },
                origin: { type: 'string' },
              },
            },
            expectedRuntimeGeneration: { type: 'integer', minimum: 1 },
          },
        },
      },
    });
  });
  it('drops a sibling anyOf while keeping the parent type/properties (setup_watchers shape)', () => {
    const schema: JsonValue = {
      type: 'object',
      anyOf: [{ required: ['executionId'] }, { required: ['triggerName'] }],
      properties: {
        executionId: { type: 'string', description: 'exec id' },
        triggerName: { type: 'string' },
      },
      additionalProperties: false,
    };

    expect(applyToolSchemaProfile(schema, 'flat')).toEqual({
      type: 'object',
      properties: {
        executionId: { type: 'string', description: 'exec id' },
        triggerName: { type: 'string' },
      },
      additionalProperties: false,
    });
  });

  it('flattens allOf/if/then/oneOf/not conditionals (dispatch_action shape)', () => {
    const schema: JsonValue = {
      type: 'object',
      properties: { type: { type: 'string', enum: ['a', 'b'] } },
      allOf: [
        {
          if: { properties: { type: { const: 'a' } } },
          then: {
            oneOf: [
              { required: ['x'], not: { required: ['y'] } },
              { required: ['y'] },
            ],
          },
        },
      ],
      additionalProperties: true,
    };

    expect(applyToolSchemaProfile(schema, 'flat')).toEqual({
      type: 'object',
      properties: { type: { type: 'string', enum: ['a', 'b'] } },
      additionalProperties: true,
    });
  });

  it('recurses through nested properties, items, and additionalProperties', () => {
    const schema: JsonValue = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { anyOf: [{ type: 'string' }], type: 'string' },
        },
        nested: {
          type: 'object',
          properties: {
            inner: { oneOf: [{ type: 'number' }], type: 'number' },
          },
        },
      },
    };

    expect(applyToolSchemaProfile(schema, 'flat')).toEqual({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'string' } },
        nested: {
          type: 'object',
          properties: { inner: { type: 'number' } },
        },
      },
    });
  });

  it('preserves a property literally named like a combinator keyword', () => {
    const schema: JsonValue = {
      type: 'object',
      properties: {
        // A tool param named "if" must NOT be treated as the `if` keyword.
        if: { type: 'string', description: 'a field named if' },
        anyOf: { type: 'boolean' },
      },
    };

    expect(applyToolSchemaProfile(schema, 'flat')).toEqual({
      type: 'object',
      properties: {
        if: { type: 'string', description: 'a field named if' },
        anyOf: { type: 'boolean' },
      },
    });
  });

  it('is a no-op for schemas without combinators', () => {
    const schema: JsonValue = {
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string', minLength: 1, enum: ['x', 'y'] },
        b: { type: 'integer', minimum: 0, maximum: 10 },
      },
      additionalProperties: false,
    };

    expect(applyToolSchemaProfile(schema, 'standard')).toBe(schema);
  });

  it('passes through primitives and arrays', () => {
    expect(applyToolSchemaProfile('s', 'flat')).toBe('s');
    expect(applyToolSchemaProfile(3, 'flat')).toBe(3);
    expect(applyToolSchemaProfile(true, 'flat')).toBe(true);
    expect(applyToolSchemaProfile(null, 'flat')).toBeNull();
    expect(applyToolSchemaProfile([{ anyOf: [] }, 1], 'flat')).toEqual([{}, 1]);
  });
});
