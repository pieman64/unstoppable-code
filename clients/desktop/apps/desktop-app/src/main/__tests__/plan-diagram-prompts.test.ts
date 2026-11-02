import {
  DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
  LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
  PARSED_PLAN_GRAPH_JSON_SCHEMA,
  buildDataModelDiffPrompt,
  buildDataModelDiffSystemPrompt,
  buildLogicDiffPrompt,
  buildLogicDiffSystemPrompt,
  buildPlanDiagramUserPrompt,
  buildSequenceDiagramPrompt,
  buildSequenceDiagramSystemPrompt,
} from '@canopy/desktop-shared/lib/plan-diagram-prompts';

describe('buildPlanDiagramUserPrompt', () => {
  it('contains only the plan payload', () => {
    const prompt = buildPlanDiagramUserPrompt('# My Plan');

    expect(prompt).toBe('# Plan\n\n# My Plan');
    expect(prompt).not.toContain('JSON schema');
    expect(prompt).not.toContain('Diagram rules');
    expect(prompt).not.toContain('Applicability rules');
  });
});

describe('buildSequenceDiagramPrompt', () => {
  const planText = '# My Plan\n\n- Do the thing\n- Then the other thing';

  it('embeds the supplied plan text', () => {
    const prompt = buildSequenceDiagramPrompt(planText);
    expect(prompt).toContain(planText);
  });

  it('describes the phase-row / task-column structure', () => {
    const prompt = buildSequenceDiagramPrompt(planText);
    expect(prompt).toContain('PHASE');
    expect(prompt).toContain('parentId');
    expect(prompt).toContain('execution order');
  });

  it('instructs the model to conform to the JSON schema', () => {
    const prompt = buildSequenceDiagramSystemPrompt();
    expect(prompt).toContain('JSON schema');
    expect(prompt).toContain('schemaVersion is 1');
    expect(prompt).toContain('"nodes"');
  });

  it('includes a Plan heading before the plan text', () => {
    const prompt = buildSequenceDiagramPrompt(planText);
    const headingIndex = prompt.indexOf('# Plan');
    const planIndex = prompt.indexOf(planText);
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeGreaterThan(headingIndex);
  });
});

describe('PARSED_PLAN_GRAPH_JSON_SCHEMA', () => {
  it('is an object schema requiring nodes and edges', () => {
    expect(PARSED_PLAN_GRAPH_JSON_SCHEMA.type).toBe('object');
    expect(PARSED_PLAN_GRAPH_JSON_SCHEMA.required).toEqual([
      'schemaVersion',
      'nodes',
      'edges',
    ]);
  });

  it('defines node and edge array items', () => {
    expect(PARSED_PLAN_GRAPH_JSON_SCHEMA.properties.nodes.type).toBe('array');
    expect(PARSED_PLAN_GRAPH_JSON_SCHEMA.properties.edges.type).toBe('array');
    expect(
      PARSED_PLAN_GRAPH_JSON_SCHEMA.properties.nodes.items.required,
    ).toContain('id');
    expect(
      PARSED_PLAN_GRAPH_JSON_SCHEMA.properties.edges.items.required,
    ).toEqual(['from', 'to', 'kind']);
  });
});

describe('buildLogicDiffPrompt', () => {
  const planText = '# My Plan\n\n- Do the thing\n- Then the other thing';

  it('embeds the supplied plan text', () => {
    const prompt = buildLogicDiffPrompt(planText);
    expect(prompt).toContain(planText);
  });

  it('describes a current/planned behavior diagram', () => {
    const prompt = buildLogicDiffPrompt(planText);
    expect(prompt).toContain('current/planned');
    expect(prompt).toContain('NOT a file diff');
  });

  it('instructs the model to conform to the JSON schema', () => {
    const prompt = buildLogicDiffSystemPrompt();
    expect(prompt).toContain('JSON schema');
    expect(prompt).toContain('schemaVersion is 1');
    expect(prompt).toContain('Never use `text`');
    expect(prompt).toContain('Never return changes as an object');
  });

  it('includes a Plan heading before the plan text', () => {
    const prompt = buildLogicDiffPrompt(planText);
    const headingIndex = prompt.indexOf('# Plan');
    const planIndex = prompt.indexOf(planText);
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeGreaterThan(headingIndex);
  });
});

describe('LOGIC_DIFF_DIAGRAM_JSON_SCHEMA', () => {
  it('is an object schema requiring current, planned, and changes', () => {
    expect(LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.type).toBe('object');
    expect(LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.required).toEqual([
      'schemaVersion',
      'current',
      'planned',
      'changes',
    ]);
  });

  it('defines current/planned flows with nodes and edges', () => {
    expect(LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.properties.current.type).toBe(
      'object',
    );
    expect(LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.properties.current.required).toEqual([
      'nodes',
      'edges',
    ]);
    expect(LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.properties.planned.required).toEqual([
      'nodes',
      'edges',
    ]);
    expect(
      LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.properties.current.properties.nodes.items
        .required,
    ).toEqual(['id', 'label']);
  });

  it('defines change annotations with nodeId and type', () => {
    expect(LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.properties.changes.type).toBe(
      'array',
    );
    expect(
      LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.properties.changes.items.required,
    ).toEqual(['nodeId', 'type']);
    expect(
      LOGIC_DIFF_DIAGRAM_JSON_SCHEMA.properties.changes.items.properties.type
        .enum,
    ).toEqual(['added', 'removed', 'changed']);
  });
});

describe('buildDataModelDiffPrompt', () => {
  const planText =
    '# My Plan\n\n- Add a Prisma migration for User.email\n- Update DTOs';

  it('embeds the supplied plan text', () => {
    const prompt = buildDataModelDiffPrompt(planText);
    expect(prompt).toContain(planText);
  });

  it('describes conditional database data model applicability', () => {
    const prompt = buildDataModelDiffPrompt(planText);
    expect(prompt).toContain('applicable');
    expect(prompt).toContain('database data model');
    expect(prompt).toContain('ERD');
  });

  it('describes current/planned/changes output', () => {
    const prompt = buildDataModelDiffPrompt(planText);
    expect(prompt).toContain('current');
    expect(prompt).toContain('planned');
    expect(prompt).toContain('changes');
  });

  it('instructs the model to conform to the JSON schema', () => {
    const prompt = buildDataModelDiffSystemPrompt();
    expect(prompt).toContain('JSON schema');
    expect(prompt).toContain('schemaVersion is 1');
    expect(prompt).toContain('Never use `keyKind`');
    expect(prompt).toContain('Never use `changeType`');
    expect(prompt).toContain('"fieldId"');
  });

  it('limits codebase hydration to plan-relevant entities', () => {
    const prompt = buildDataModelDiffSystemPrompt();

    expect(prompt).toContain('Use the plan as the relevance boundary');
    expect(prompt).toContain('hydrate the complete current entity shape');
    expect(prompt).toContain(
      'include the rest of that entity from the codebase',
    );
    expect(prompt).toContain('Do NOT broaden the diagram to unrelated');
  });
});

describe('DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA', () => {
  it('requires only the wrapper schemaVersion and applicable fields', () => {
    expect(DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA.type).toBe('object');
    expect(DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA.required).toEqual([
      'schemaVersion',
      'applicable',
    ]);
    expect(
      DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA.properties.diagram,
    ).toBeDefined();
  });

  it('allows the non-applicability wrapper shape to omit diagram', () => {
    expect(
      DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA.properties.applicable.type,
    ).toBe('boolean');
    expect(DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA.properties.reason.type).toBe(
      'string',
    );
    expect(DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA.required).not.toContain(
      'diagram',
    );
  });

  it('requires current, planned, and changes inside a present diagram', () => {
    const diagramSchema =
      DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA.properties.diagram;
    expect(diagramSchema.required).toEqual([
      'schemaVersion',
      'current',
      'planned',
      'changes',
    ]);
    expect(diagramSchema.properties.current.required).toEqual([
      'entities',
      'relationships',
    ]);
    expect(diagramSchema.properties.planned.required).toEqual([
      'entities',
      'relationships',
    ]);
  });

  it('requires entityId on field-level changes', () => {
    const changesSchema =
      DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA.properties.diagram.properties
        .changes;
    const fieldChangeSchema = changesSchema.items.anyOf.find((schema) => {
      const requiredFields: readonly string[] = schema.required;
      return requiredFields.includes('fieldId');
    });

    expect(fieldChangeSchema?.required).toEqual([
      'id',
      'target',
      'type',
      'entityId',
      'fieldId',
    ]);
  });
});
