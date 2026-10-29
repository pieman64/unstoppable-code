import {
  PLAN_DIAGRAM_SCHEMA_VERSION,
  isDataModelDiffDiagram,
  isDataModelDiffGenerationResult,
  isPlanDiagramArtifacts,
} from '../types/plan-diagrams';
import type {
  DataModelDiffDiagram,
  PlanDiagramArtifacts,
} from '../types/plan-diagrams';

const validDiagram: DataModelDiffDiagram = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: {
    entities: [
      {
        id: 'user',
        name: 'User',
        kind: 'table',
        fields: [{ id: 'id', name: 'id', kind: 'primary' }],
      },
    ],
    relationships: [],
  },
  planned: {
    entities: [
      {
        id: 'user',
        name: 'User',
        kind: 'table',
        fields: [
          { id: 'id', name: 'id', kind: 'primary' },
          { id: 'email', name: 'email', kind: 'unique' },
        ],
      },
    ],
    relationships: [],
  },
  changes: [
    {
      id: 'c1',
      target: 'field',
      type: 'added',
      entityId: 'user',
      fieldId: 'email',
    },
  ],
};

describe('isDataModelDiffDiagram', () => {
  it('accepts a well-formed diagram', () => {
    expect(isDataModelDiffDiagram(validDiagram)).toBe(true);
  });

  it('rejects a non-record', () => {
    expect(isDataModelDiffDiagram(null)).toBe(false);
    expect(isDataModelDiffDiagram(42)).toBe(false);
  });

  it('rejects a wrong schema version', () => {
    expect(isDataModelDiffDiagram({ ...validDiagram, schemaVersion: 99 })).toBe(
      false,
    );
  });

  it('rejects a graph missing entities/relationships arrays', () => {
    expect(
      isDataModelDiffDiagram({
        ...validDiagram,
        current: { relationships: [] },
      }),
    ).toBe(false);
  });

  it('rejects unscoped field changes', () => {
    expect(
      isDataModelDiffDiagram({
        ...validDiagram,
        changes: [
          {
            id: 'c1',
            target: 'field',
            type: 'changed',
            fieldId: 'email',
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects relationship changes without a relationship id', () => {
    expect(
      isDataModelDiffDiagram({
        ...validDiagram,
        changes: [
          {
            id: 'c1',
            target: 'relationship',
            type: 'removed',
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('isDataModelDiffGenerationResult', () => {
  it('accepts a non-applicable wrapper with no diagram', () => {
    expect(
      isDataModelDiffGenerationResult({
        schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
        applicable: false,
      }),
    ).toBe(true);
  });

  it('accepts a non-applicable wrapper with a reason', () => {
    expect(
      isDataModelDiffGenerationResult({
        schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
        applicable: false,
        reason: 'No persistent schema changes described.',
      }),
    ).toBe(true);
  });

  it('accepts an applicable wrapper with a valid diagram', () => {
    expect(
      isDataModelDiffGenerationResult({
        schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
        applicable: true,
        diagram: validDiagram,
      }),
    ).toBe(true);
  });

  it('rejects an applicable wrapper with an absent diagram', () => {
    expect(
      isDataModelDiffGenerationResult({
        schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
        applicable: true,
      }),
    ).toBe(false);
  });

  it('rejects an applicable wrapper with a malformed diagram', () => {
    expect(
      isDataModelDiffGenerationResult({
        schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
        applicable: true,
        diagram: { schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION },
      }),
    ).toBe(false);
  });

  it('rejects an applicable wrapper whose field change omits entityId', () => {
    expect(
      isDataModelDiffGenerationResult({
        schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
        applicable: true,
        diagram: {
          ...validDiagram,
          changes: [
            {
              id: 'c1',
              target: 'field',
              type: 'added',
              fieldId: 'email',
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it('rejects a wrapper with a non-boolean applicable', () => {
    expect(
      isDataModelDiffGenerationResult({
        schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
        applicable: 'no',
      }),
    ).toBe(false);
  });
});

describe('isPlanDiagramArtifacts with dataModelDiff', () => {
  it('accepts a plan with no dataModelDiff key (backward compatible)', () => {
    const artifacts: PlanDiagramArtifacts = {
      sequence: {
        data: null,
        derivedFromRevision: 1,
        status: 'ready',
      },
    };
    expect(isPlanDiagramArtifacts(artifacts)).toBe(true);
  });

  it('accepts a plan with a valid dataModelDiff artifact', () => {
    const artifacts: PlanDiagramArtifacts = {
      dataModelDiff: {
        data: validDiagram,
        derivedFromRevision: 3,
        status: 'ready',
        generatedAt: '2026-06-09T00:00:00.000Z',
      },
    };
    expect(isPlanDiagramArtifacts(artifacts)).toBe(true);
  });

  it('rejects a malformed dataModelDiff artifact', () => {
    expect(
      isPlanDiagramArtifacts({
        dataModelDiff: { status: 'ready' },
      }),
    ).toBe(false);
  });

  it('ignores unknown extra diagram keys', () => {
    expect(
      isPlanDiagramArtifacts({
        somethingElse: { totally: 'unknown' },
      }),
    ).toBe(true);
  });
});
