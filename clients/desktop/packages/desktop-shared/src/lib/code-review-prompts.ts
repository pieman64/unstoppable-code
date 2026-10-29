/**
 * Pure prompt/schema builders for the code review annotation and diagram
 * generators.
 *
 * This module must stay dependency-free (no Node/Electron imports) so it can be
 * shared between the main process (generation) and any other surface. The
 * diagram schemas are reused from {@link ../lib/plan-diagram-prompts} to keep
 * the diagram data shapes consistent between plan diagrams and code review
 * diagrams.
 */

import {
  DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
  LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
} from './plan-diagram-prompts';

const JSON_ONLY_INSTRUCTION =
  'You output ONLY JSON conforming to the schema. Do not include markdown fences, commentary, status updates, or tool-use narration.';

export function buildCodeReviewDiagramUserPrompt(
  diffBundleText: string,
): string {
  return ['# Branch changes', '', diffBundleText].join('\n');
}

export const REVIEW_ANNOTATIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          repoId: { type: 'string' },
          filePath: { type: 'string' },
          side: { type: 'string', enum: ['old', 'new'] },
          lineStart: { type: 'integer', minimum: 1 },
          lineEnd: { type: 'integer', minimum: 1 },
          kind: {
            type: 'string',
            enum: ['explanation', 'caution', 'context'],
          },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: [
          'id',
          'repoId',
          'filePath',
          'side',
          'lineStart',
          'lineEnd',
          'kind',
          'title',
          'body',
        ],
      },
    },
  },
  required: ['schemaVersion', 'annotations'],
} as const;

export function buildReviewAnnotationsSystemPrompt(): string {
  return [
    JSON_ONLY_INSTRUCTION,
    '',
    'You annotate a branch diff (committed + uncommitted changes vs the merge-base with the base branch) with inline explanations a reviewer will read alongside the diff.',
    'Annotate ONLY complex, subtle, or noteworthy changes:',
    '- cross-file interactions and non-local effects of an edit',
    '- behavior changes that are easy to miss (changed defaults, inverted conditions, altered error handling)',
    '- risky edits (concurrency, persistence/migration, security-sensitive paths)',
    '- non-obvious idioms or intentional workarounds worth explaining',
    'Do NOT annotate obvious or mechanical changes (renames, formatting, import shuffles, straightforward additions). Fewer, higher-value annotations beat exhaustive coverage.',
    'Return at most 20 annotations across the whole diff.',
    'Rules:',
    '- repoId identifies which repo a file belongs to. Each "# Repo:" header shows the repo id in parentheses as "(id: ...)"; copy that id exactly into repoId for every annotation on a file in that section.',
    '- filePath is repo-relative, exactly as it appears in the diff headers.',
    "- side is 'new' for annotations on added/context lines of the new file, 'old' only for annotations that specifically explain removed lines.",
    '- lineStart/lineEnd are 1-based line numbers IN THE FILE on that side (not diff-hunk offsets). Derive them from the @@ hunk headers.',
    '- title: one short line (max ~80 chars). body: 1-4 sentences of markdown; no headings.',
    '- id: a short stable slug, unique within the set.',
    "- kind: 'explanation' clarifies how or why a change works; 'caution' flags risk or likely-unintended behavior; 'context' supplies background a reviewer needs (conventions, related code, history).",
    '- You may open files in the repository to confirm surrounding context before annotating.',
    '- Output MUST conform exactly to this JSON schema. schemaVersion is 1.',
    '',
    'JSON schema:',
    JSON.stringify(REVIEW_ANNOTATIONS_JSON_SCHEMA),
  ].join('\n');
}

export function buildReviewLogicDiffSystemPrompt(): string {
  return [
    JSON_ONLY_INSTRUCTION,
    '',
    'You model the LOGICAL behavior change a branch introduces, as a TOP-TO-BOTTOM before/after diagram. This is a behavior/interaction diagram, NOT a file diff.',
    'The input is the branch diff: all committed and uncommitted changes relative to the merge-base with the base branch.',
    'Produce:',
    '- current: the behavior at the merge-base (how the code behaved BEFORE this branch), as a vertical sequence of logic nodes + edges.',
    '- planned: the behavior WITH the branch applied (including uncommitted work).',
    '- changes: annotations keyed by node id with type added | removed | changed (+ optional note).',
    'Rules:',
    '- Keep a node id STABLE across current/planned when it represents the same step that is unchanged or merely changed.',
    '- A node only in "planned" is added; a node only in "current" is removed; a node in both but behaving differently is changed.',
    '- Where derivable, set files so nodes can be traced back to the diff.',
    '- Use node field `label` for display text. Never use `text`.',
    '- `changes` MUST be an array of objects. Never return changes as an object keyed by node id.',
    '- Each change object MUST use `nodeId`, not `id`, to identify the changed node.',
    '- You may open files in the repository to understand pre-branch behavior beyond the diff context lines.',
    '- Output MUST conform exactly to this JSON schema. schemaVersion is 1.',
    '',
    'JSON schema:',
    JSON.stringify(LOGIC_DIFF_DIAGRAM_JSON_SCHEMA),
  ].join('\n');
}

export function buildReviewDataModelDiffSystemPrompt(): string {
  return [
    JSON_ONLY_INSTRUCTION,
    '',
    'You determine whether a branch diff (committed + uncommitted changes vs the merge-base with the base branch) changes the persistent database data model, then model the change as an entity-relationship ERD current/planned/diff diagram when applicable.',
    '',
    'Applicability rules:',
    '- Return applicable: true only when the branch diff changes persistent database schema or data models.',
    '- Include schema migrations, ORM model changes, database table/column/index/constraint changes, relationships, foreign keys, persisted collections, and document-store schema changes.',
    '- Exclude purely in-memory TypeScript interfaces, API DTOs, UI-only state, cache-only data, and non-persistent validation types unless the branch diff explicitly ties them to persisted database schema.',
    '- If not applicable, return applicable: false, optionally include reason, and omit diagram.',
    '- If applicable, return applicable: true and a full diagram.',
    '',
    'Diagram rules for applicable branch diffs:',
    '- current represents the model at the merge-base, before this branch.',
    '- planned represents the model with the branch applied.',
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
    '- Use the diff as the relevance boundary. Include only entities that the branch diff names, directly changes, or needs to show an immediately affected relationship.',
    '- For each included entity, inspect the codebase as needed to hydrate the complete current entity shape: all persisted fields, key/index kind when evident, nullability, and relationships visible from the relevant schema/ORM/model files.',
    '- If a changed schema file adds or changes one field on an existing entity, include the rest of that entity from the codebase so the ERD row is complete instead of showing only the changed field.',
    '- Do NOT broaden the diagram to unrelated tables/models just because they exist nearby in the schema. Add neighboring entities only when they are directly referenced by an included entity relationship that matters to the branch diff.',
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
