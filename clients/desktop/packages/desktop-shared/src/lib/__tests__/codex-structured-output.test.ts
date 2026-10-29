import {
  makeCodexStrictJsonSchema,
  normalizeCodexStructuredOutput,
} from '../codex-structured-output';
import {
  DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
  LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
  PARSED_PLAN_GRAPH_JSON_SCHEMA,
} from '../plan-diagram-prompts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordProperty(
  value: unknown,
  property: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[property];
  return isRecord(child) ? child : undefined;
}

function collectNonStrictObjectPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectNonStrictObjectPaths(entry, `${path}[${index}]`),
    );
  }
  if (!isRecord(value)) return [];

  const failures: string[] = [];
  if (isRecord(value.properties)) {
    const required = new Set(
      Array.isArray(value.required)
        ? value.required.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [],
    );
    if (Object.keys(value.properties).some((key) => !required.has(key))) {
      failures.push(path);
    }
    if (value.additionalProperties !== false) {
      failures.push(`${path}.additionalProperties`);
    }
  }

  return failures.concat(
    Object.entries(value).flatMap(([key, child]) =>
      collectNonStrictObjectPaths(child, `${path}.${key}`),
    ),
  );
}

describe('makeCodexStrictJsonSchema', () => {
  it.each([
    ['sequence', PARSED_PLAN_GRAPH_JSON_SCHEMA],
    ['logic diff', LOGIC_DIFF_DIAGRAM_JSON_SCHEMA],
    ['data model diff', DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA],
  ])(
    'makes the %s diagram schema strict at every object level',
    (_name, schema) => {
      expect(
        collectNonStrictObjectPaths(makeCodexStrictJsonSchema(schema)),
      ).toEqual([]);
    },
  );

  it('makes optional nested properties required and nullable', () => {
    const strict = makeCodexStrictJsonSchema(PARSED_PLAN_GRAPH_JSON_SCHEMA);
    const properties = recordProperty(strict, 'properties');
    const nodes = recordProperty(properties, 'nodes');
    const node = recordProperty(nodes, 'items');
    const nodeProperties = recordProperty(node, 'properties');
    const anchor = recordProperty(nodeProperties, 'planAnchor');
    const anchorProperties = recordProperty(anchor, 'properties');
    const parentId = recordProperty(nodeProperties, 'parentId');
    const headingPath = recordProperty(anchorProperties, 'headingPath');

    expect(node?.required).toContain('parentId');
    expect(parentId?.type).toEqual(['string', 'null']);
    expect(anchor?.required).toEqual(['headingPath', 'quote']);
    expect(headingPath?.type).toEqual(['array', 'null']);
  });
});

describe('normalizeCodexStructuredOutput', () => {
  it('removes synthetic nulls from optional nested properties', () => {
    const value = {
      schemaVersion: 1,
      nodes: [
        {
          id: 'phase-1',
          kind: 'phase',
          title: 'Phase 1',
          description: 'First phase',
          parentId: null,
          planAnchor: { headingPath: null, quote: 'Phase 1' },
          files: null,
          detail: null,
        },
      ],
      edges: [],
    };

    expect(
      normalizeCodexStructuredOutput(value, PARSED_PLAN_GRAPH_JSON_SCHEMA),
    ).toEqual({
      schemaVersion: 1,
      nodes: [
        {
          id: 'phase-1',
          kind: 'phase',
          title: 'Phase 1',
          description: 'First phase',
          planAnchor: { quote: 'Phase 1' },
        },
      ],
      edges: [],
    });
  });

  it('normalizes optional fields inside discriminated anyOf branches', () => {
    const value = {
      schemaVersion: 1,
      applicable: true,
      reason: null,
      diagram: {
        schemaVersion: 1,
        current: { entities: [], relationships: [] },
        planned: { entities: [], relationships: [] },
        changes: [
          {
            id: 'relationship-change',
            target: 'relationship',
            type: 'changed',
            relationshipId: 'user-org',
            note: null,
          },
        ],
      },
    };

    expect(
      normalizeCodexStructuredOutput(
        value,
        DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
      ),
    ).toEqual({
      schemaVersion: 1,
      applicable: true,
      diagram: {
        schemaVersion: 1,
        current: { entities: [], relationships: [] },
        planned: { entities: [], relationships: [] },
        changes: [
          {
            id: 'relationship-change',
            target: 'relationship',
            type: 'changed',
            relationshipId: 'user-org',
          },
        ],
      },
    });
  });

  it('preserves nulls that were required by the original schema', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
      required: ['value'],
    };

    expect(normalizeCodexStructuredOutput({ value: null }, schema)).toEqual({
      value: null,
    });
  });

  it('preserves nulls allowed by an originally nullable optional property', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
      required: [],
    };

    expect(normalizeCodexStructuredOutput({ value: null }, schema)).toEqual({
      value: null,
    });
  });
});
