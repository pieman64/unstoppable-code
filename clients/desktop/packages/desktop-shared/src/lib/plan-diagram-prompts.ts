/**
 * Pure prompt/schema builders for the plan diagram generators.
 *
 * This module must stay dependency-free (no Node/Electron imports) so it can be
 * shared between the main process (generation) and any other surface. The JSON
 * schemas mirror {@link ParsedPlanGraph} and {@link LogicDiffDiagram} for
 * structured-output generation.
 */

const JSON_ONLY_INSTRUCTION =
  'You output ONLY JSON conforming to the schema. Do not include markdown fences, commentary, status updates, or tool-use narration.';

export function buildPlanDiagramUserPrompt(planText: string): string {
  return ['# Plan', '', planText].join('\n');
}

export function buildSequenceDiagramPrompt(planText: string): string {
  return [
    buildSequenceDiagramSystemPrompt(),
    buildPlanDiagramUserPrompt(planText),
  ].join('\n\n');
}

export function buildSequenceDiagramSystemPrompt(): string {
  return [
    JSON_ONLY_INSTRUCTION,
    '',
    'You parse an implementation plan (markdown) into a structured phase/task graph. It is rendered as a horizontal row of PHASE blocks, each with its TASK blocks stacked vertically beneath it:',
    '',
    '    [Phase 1] ── [Phase 2] ── [Phase 3]',
    '       │            │            │',
    '    [task 1.1]   [task 2.1]   [task 3.1]',
    '       │            │',
    '    [task 1.2]   [task 2.2]',
    '',
    'Structure rules (these drive the layout — follow them exactly):',
    '- A PHASE is a major stage of the plan; a TASK is a concrete step within exactly one phase.',
    '- List the phase nodes in the `nodes` array in execution order (left to right). Phases must NOT have a parentId.',
    "- For every task, set parentId to its phase id, and list a phase's tasks in the `nodes` array in the order they should run (top to bottom). Every task must belong to a phase.",
    '- Aim for 2-6 phases; if the plan has only one stage, still create a single phase containing its tasks.',
    '',
    'Per-node fields: a stable kebab-case `id`, `kind` ("phase"|"task"), a short `title`, a one-line `description`, optional `detail` (full text) and `files`, and `planAnchor` (set headingPath — the markdown heading trail — and/or quote so the node maps back to the plan).',
    '',
    'Edges: use `edges` ONLY for genuine cross-cutting dependencies between tasks in DIFFERENT phases (kind "depends-on"). Do NOT add phase→phase, phase→task, or simple within-phase next-step edges — phase order comes from node order and the row/column connectors are drawn automatically. Most plans need few or no edges.',
    '',
    'Output MUST conform exactly to this JSON schema. schemaVersion is 1.',
    '',
    'JSON schema:',
    JSON.stringify(PARSED_PLAN_GRAPH_JSON_SCHEMA),
  ].join('\n');
}

export const PARSED_PLAN_GRAPH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['phase', 'task'] },
          title: { type: 'string' },
          description: { type: 'string' },
          parentId: { type: 'string' },
          planAnchor: {
            type: 'object',
            additionalProperties: false,
            properties: {
              headingPath: { type: 'array', items: { type: 'string' } },
              quote: { type: 'string' },
            },
          },
          files: { type: 'array', items: { type: 'string' } },
          detail: { type: 'string' },
        },
        required: ['id', 'kind', 'title', 'description', 'planAnchor'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { type: 'string', enum: ['depends-on', 'sequence'] },
        },
        required: ['from', 'to', 'kind'],
      },
    },
  },
  required: ['schemaVersion', 'nodes', 'edges'],
} as const;

export function buildLogicDiffPrompt(planText: string): string {
  return [
    buildLogicDiffSystemPrompt(),
    buildPlanDiagramUserPrompt(planText),
  ].join('\n\n');
}

export function buildLogicDiffSystemPrompt(): string {
  return [
    JSON_ONLY_INSTRUCTION,
    '',
    'You model the LOGICAL behavior change an implementation plan introduces, as a TOP-TO-BOTTOM current/planned diagram. This is a behavior/interaction diagram, NOT a file diff.',
    'Produce:',
    '- current: the current behavior as a vertical sequence of logic nodes + edges (how the code behaves now, before the plan is executed).',
    '- planned: the projected behavior once the plan is executed.',
    '- changes: annotations keyed by node id with type added | removed | changed (+ optional note).',
    'Rules:',
    '- Keep a node id STABLE across current/planned when it represents the same step that is unchanged or merely changed.',
    '- A node only in "planned" is added; a node only in "current" is removed; a node in both but behaving differently is changed.',
    '- Where derivable, set planNodeIds (ids that would appear in the plan sequence graph) and files so edits can flag affected nodes.',
    '- Use node field `label` for display text. Never use `text`.',
    '- `changes` MUST be an array of objects. Never return changes as an object keyed by node id.',
    '- Each change object MUST use `nodeId`, not `id`, to identify the changed node.',
    '- Output MUST conform exactly to this JSON schema. schemaVersion is 1.',
    '',
    'JSON schema:',
    JSON.stringify(LOGIC_DIFF_DIAGRAM_JSON_SCHEMA),
  ].join('\n');
}

export const LOGIC_DIFF_DIAGRAM_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    current: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              detail: { type: 'string' },
              planNodeIds: { type: 'array', items: { type: 'string' } },
              files: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'label'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['nodes', 'edges'],
    },
    planned: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              detail: { type: 'string' },
              planNodeIds: { type: 'array', items: { type: 'string' } },
              files: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'label'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['nodes', 'edges'],
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodeId: { type: 'string' },
          type: { type: 'string', enum: ['added', 'removed', 'changed'] },
          note: { type: 'string' },
        },
        required: ['nodeId', 'type'],
      },
    },
  },
  required: ['schemaVersion', 'current', 'planned', 'changes'],
} as const;

export function buildDataModelDiffPrompt(planText: string): string {
  return [
    buildDataModelDiffSystemPrompt(),
    buildPlanDiagramUserPrompt(planText),
  ].join('\n\n');
}

export function buildDataModelDiffSystemPrompt(): string {
  return [
    JSON_ONLY_INSTRUCTION,
    '',
    'You determine whether an implementation plan changes the persistent database data model, then model the change as an entity-relationship ERD current/planned/diff diagram when applicable.',
    '',
    'Applicability rules:',
    '- Return applicable: true only when the plan changes persistent database schema or data models.',
    '- Include schema migrations, ORM model changes, database table/column/index/constraint changes, relationships, foreign keys, persisted collections, and document-store schema changes.',
    '- Exclude purely in-memory TypeScript interfaces, API DTOs, UI-only state, cache-only data, and non-persistent validation types unless the plan explicitly ties them to persisted database schema.',
    '- If not applicable, return applicable: false, optionally include reason, and omit diagram.',
    '- If applicable, return applicable: true and a full diagram.',
    '',
    'Diagram rules for applicable plans:',
    '- current represents the inferred model before the plan.',
    '- planned represents the projected model after the plan.',
    '- changes annotates added, removed, and changed entities, fields, and relationships.',
    '- The target rendering is an entity-relationship ERD view: each entity lists fields with type, nullability, and key kind; each relationship carries a cardinality.',
    '- Entity ids must be globally unique and reused across current/planned when representing the same entity.',
    '- Relationship ids must be globally unique, stable, and reused across current/planned when representing the same relationship.',
    '- Field ids must be reused across current/planned for the same field, but only need to be unique within their owning entity. Different entities may each have field ids like id or createdAt.',
    "- Every field-level change MUST include the owning entity's entityId plus fieldId. Without entityId, field ids are ambiguous.",
    '- Every entity-level change MUST include entityId.',
    '- Every relationship-level change MUST include relationshipId.',
    '',
    'Codebase hydration rules:',
    '- Use the plan as the relevance boundary. Include only entities that the plan names, directly changes, or needs to show an immediately affected relationship.',
    '- For each included entity, inspect the codebase as needed to hydrate the complete current entity shape: all persisted fields, key/index kind when evident, nullability, and relationships visible from the relevant schema/ORM/model files.',
    '- If the plan adds or changes one field on an existing entity, include the rest of that entity from the codebase so the ERD row is complete instead of showing only the changed field.',
    '- Do NOT broaden the diagram to unrelated tables/models just because they exist nearby in the schema. Add neighboring entities only when they are directly referenced by an included entity relationship that matters to the plan.',
    '- If the codebase cannot confirm a detail, omit that optional detail rather than inventing it.',
    '',
    'Schema field rules:',
    '- Entity objects MUST use `id`, not `entityId`.',
    '- Field objects MUST use `id`, not `fieldId`.',
    '- Field key kind MUST use `kind` with one of primary, foreign, unique, indexed, regular. Never use `keyKind`.',
    '- `changes` MUST be an array of discriminated change objects with `target` and `type`. Never return changes as an object.',
    '- Change `type` MUST be one of added, removed, changed. Never use `changeType` or `modified`.',
    '- Do not include enum changes, default values, or other fields that are not present in the JSON schema.',
    '',
    'Output MUST conform exactly to this JSON schema. schemaVersion is 1.',
    '',
    'Valid change object examples:',
    '{"id":"add-user","target":"entity","type":"added","entityId":"user","note":"Adds User table."}',
    '{"id":"add-user-email","target":"field","type":"added","entityId":"user","fieldId":"email","note":"Adds persisted email column."}',
    '{"id":"change-user-org","target":"relationship","type":"changed","relationshipId":"user-org","note":"Changes cardinality."}',
    '',
    'JSON schema:',
    JSON.stringify(DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA),
  ].join('\n');
}

const DATA_MODEL_FIELD_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string' },
    nullable: { type: 'boolean' },
    kind: {
      type: 'string',
      enum: ['primary', 'foreign', 'unique', 'indexed', 'regular'],
    },
    detail: { type: 'string' },
  },
  required: ['id', 'name'],
} as const;

const DATA_MODEL_ENTITY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['table', 'model', 'collection', 'entity'] },
    detail: { type: 'string' },
    fields: {
      type: 'array',
      items: DATA_MODEL_FIELD_JSON_SCHEMA,
    },
    planNodeIds: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'name', 'fields'],
} as const;

const DATA_MODEL_RELATIONSHIP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    label: { type: 'string' },
    cardinality: {
      type: 'string',
      enum: [
        'one-to-one',
        'one-to-many',
        'many-to-one',
        'many-to-many',
        'unknown',
      ],
    },
    detail: { type: 'string' },
    fields: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'from', 'to'],
} as const;

const DATA_MODEL_GRAPH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entities: {
      type: 'array',
      items: DATA_MODEL_ENTITY_JSON_SCHEMA,
    },
    relationships: {
      type: 'array',
      items: DATA_MODEL_RELATIONSHIP_JSON_SCHEMA,
    },
  },
  required: ['entities', 'relationships'],
} as const;

export const DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    applicable: { type: 'boolean' },
    reason: { type: 'string' },
    diagram: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'integer', enum: [1] },
        current: DATA_MODEL_GRAPH_JSON_SCHEMA,
        planned: DATA_MODEL_GRAPH_JSON_SCHEMA,
        changes: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  target: { type: 'string', enum: ['entity'] },
                  type: {
                    type: 'string',
                    enum: ['added', 'removed', 'changed'],
                  },
                  entityId: { type: 'string' },
                  note: { type: 'string' },
                },
                required: ['id', 'target', 'type', 'entityId'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  target: { type: 'string', enum: ['field'] },
                  type: {
                    type: 'string',
                    enum: ['added', 'removed', 'changed'],
                  },
                  entityId: { type: 'string' },
                  fieldId: { type: 'string' },
                  note: { type: 'string' },
                },
                required: ['id', 'target', 'type', 'entityId', 'fieldId'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  target: { type: 'string', enum: ['relationship'] },
                  type: {
                    type: 'string',
                    enum: ['added', 'removed', 'changed'],
                  },
                  relationshipId: { type: 'string' },
                  note: { type: 'string' },
                },
                required: ['id', 'target', 'type', 'relationshipId'],
              },
            ],
          },
        },
      },
      required: ['schemaVersion', 'current', 'planned', 'changes'],
    },
  },
  required: ['schemaVersion', 'applicable'],
} as const;
