/**
 * Prompt builders for the Split PR Phase A planner — the feature's single LLM
 * step. The copy is transcribed from
 * `docs/planning/2026-06-30-pr-splits/03-executor-prompts.md` §"Phase A —
 * Planner prompt" (itself adapted from the stack-changes reference skill).
 *
 * Everything in this module is pure so tests can assert prompt content without
 * an LLM: the system prompt is a constant builder, the user prompt is derived
 * from the gathered PR/diff/repo-context inputs, and the retry addendum renders
 * deterministic-validation issues back to the model.
 */

import type {
  DiffFileEntry,
  PrDiffSnapshot,
} from '@canopy/desktop-shared/types/github';
import type { SplitPlanIssue } from '@canopy/desktop-shared/types/pr-split-plan';

export interface SplitPlannerPromptPr {
  prNumber: number;
  title: string;
  body: string;
  headBranch: string;
  /** Detected from the PR itself (`pulls.get().base.ref`), never assumed. */
  baseBranch: string;
  headSha: string;
}

export interface SplitPlannerRepoContext {
  codeowners: string | null;
  prTemplate: string | null;
  contributing: string | null;
  claudeMd: string | null;
  buildTestHint: string | null;
}

export interface SplitPlannerUserPromptInput {
  pr: SplitPlannerPromptPr;
  snapshot: PrDiffSnapshot;
  repoContext: SplitPlannerRepoContext;
}

/**
 * JSON schema for the structured Split Plan output. Mirrors the `SplitPlan`
 * type in `@canopy/desktop-shared/types/github`; `isSplitPlan` is the runtime
 * validator counterpart.
 */
export const SPLIT_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    finalGoal: {
      type: 'string',
      description: 'One sentence: what the whole PR accomplishes.',
    },
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          concern: { type: 'string' },
          kind: { type: 'string', enum: ['refactor', 'behavior'] },
        },
        required: ['concern', 'kind'],
      },
    },
    children: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', description: '1-based child index.' },
          title: {
            type: 'string',
            description:
              'Includes the refactor:/feat: type prefix; the UI adds [n/total].',
          },
          type: { type: 'string', enum: ['refactor', 'feature'] },
          dependsOn: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Parent child indices; lower indices only.',
          },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string' },
                hunks: {
                  anyOf: [
                    { type: 'string', enum: ['all'] },
                    { type: 'array', items: { type: 'integer' } },
                  ],
                  description:
                    '"all" when this child fully owns the file, otherwise the owned hunkIndex values.',
                },
              },
              required: ['file', 'hunks'],
            },
          },
          renames: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
              },
              required: ['from', 'to'],
            },
            description: 'Rename pairs owned by this child.',
          },
          testProof: {
            type: 'string',
            description: 'How this child proves itself.',
          },
          risk: { type: 'string', enum: ['low', 'med', 'high'] },
          rationale: {
            type: 'string',
            description:
              'One-line motivation, standalone (no forward references).',
          },
        },
        required: [
          'index',
          'title',
          'type',
          'dependsOn',
          'changes',
          'renames',
          'testProof',
          'risk',
          'rationale',
        ],
      },
    },
    parallelizable: {
      type: 'string',
      description:
        'Which children are independent (base directly on integration) vs stacked.',
    },
    landOrder: { type: 'string', description: 'Bottom-up land order.' },
    buildTestCommand: {
      type: 'string',
      description:
        'Detected build/test command used by the verify loop. It runs AFTER the worktree\'s configured setup script has finished, so it may assume a set-up worktree (dependencies installed, build performed). Prefer the plain test command (e.g. "npm test"). Still keep it reasonably self-contained when the repo has no setup script configured — including the install step (e.g. "npm ci && npm test") is safe and harmless when setup already ran. Use an empty string when no meaningful verify command exists.',
    },
    unassignedHunks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          hunkIndex: { type: 'integer' },
        },
        required: ['file', 'hunkIndex'],
      },
      description: 'MUST be empty; every hunk of the PR assigned once.',
    },
  },
  required: [
    'finalGoal',
    'concerns',
    'children',
    'parallelizable',
    'landOrder',
    'buildTestCommand',
    'unassignedHunks',
  ],
};

const SYSTEM_PROMPT = [
  // System/role framing (adapted from SKILL.md Overview + One-Thing Rule).
  'You are splitting one large, already-open pull request into a stack of small, single-thesis pull requests. One diff, one thesis: each child change must make exactly one argument, and that argument must be buildable and testable by itself. "One thing" is a communication rule, not a size rule — if a reviewer can\'t state a child\'s thesis in one sentence, it carries more than one.',
  '',
  'You will NOT touch git in this phase. You will produce a Split Plan for the user to approve.',
  '',
  '## Decomposition procedure',
  '',
  '1. Map the end state — list every file the PR touches and why each is touched; group the "whys." Each distinct why is a candidate child.',
  '2. Find the seams — split by thesis. Consider seams in payoff order: refactor-vs-behavior (most common; refactors ship first so features become small diffs) · independent-feature vs independent-feature · behavior-vs-behavior · ownership boundary (CODEOWNERS) · risky-vs-safe.',
  '3. Order by dependency — topological sort so each child depends only on earlier children. Refactors first; the integrating/wiring child last.',
  "4. Size & scope — target ~200–400 lines of coherent thesis per child; keep the stack shallow (~3–7 children); never split a single concern to hit a line target (over-split litmus: if a child can't be motivated without referencing a later child, merge it upward).",
  '',
  '## Hard constraints (the plan is rejected if any is violated)',
  '',
  '- Split by thesis, not by file. A child is one logical concern, and it may span several files and/or own only part of a file. Do NOT emit one PR per file, and do NOT fold distinct theses together just because they touch the same file. The flagship case is refactor-first: the refactor child owns the reshaping hunks of a file and the later feature child owns the feature hunks of the same file — a within-file split, and the highest-value division. Target ~200–400 lines of coherent thesis per child; batch trivial same-concern edits; never split a single concern to hit a line target.',
  '- Partition at the hunk level. Every hunk in the PR diff is assigned to exactly one child (`unassignedHunks` must be empty; no hunk may appear in two children). A file may be owned wholly by one child (`hunks: "all"`) or split hunk-by-hunk across children.',
  '- Shared-file children must be stacked (correctness rule). If two children own hunks of the same file, they must be in a linear ancestor relationship (one `dependsOn` the other, transitively), so their hunks apply in dependency order on top of each other. Independent children (both based directly on the integration branch, reviewed in parallel) must be file-disjoint.',
  "- Ancestry rooted at the integration branch. `dependsOn` references only lower indices; a child with `dependsOn: []` bases directly on the integration branch. Each child MUST have exactly one parent at most (`dependsOn` length 0 or 1): the carve applies a child's hunks on top of one base branch, so multi-parent dependencies are not supported and the plan is rejected if any child declares more than one parent. Model shared history as a single linear chain instead.",
  "- Aggregate equals original. The union of all children's hunks must reproduce the original PR diff exactly — do not drop or add changes.",
  '- Shallow. Keep the stack ~3–7 children and dependency depth at most 7. Avoid fragment children with no independent value or test of their own — fold them upward per the right-sizing guidance.',
  "- Renames stay atomic: a renamed file's `{ from, to }` pair is listed in exactly one child's `renames`, the same child that owns the file's changes. Binary files are always owned whole (`hunks: \"all\"`) by exactly one child.",
  '',
  '## Within-file limitation (honest scope)',
  '',
  'The partition is at git-hunk granularity. If two theses are interleaved inside a single hunk (no clean hunk boundary between them), that hunk cannot be split deterministically — keep such changes in one child (usually correct: tightly interleaved edits are often one thesis). This is far less restrictive than whole-file-only and preserves refactor-first.',
  '',
  '## Output',
  '',
  'Return exactly one structured Split Plan object matching the provided schema. Child titles include a refactor:/feat: type prefix. Each `rationale` must be standalone with no forward references. `buildTestCommand` is the detected build/test command; it runs AFTER the worktree setup script has finished, so it may assume a set-up worktree (dependencies installed, build performed) and can be the plain test command (for example `npm test`). Still keep it reasonably self-contained when the repo has no setup script configured — including the install step (for example `npm ci && npm test`) is safe and harmless when setup already ran. Use an empty string when no meaningful verify command exists. `unassignedHunks` MUST be an empty array.',
].join('\n');

/**
 * Explicit OUTPUT SCHEMA section appended to the system prompt for BOTH
 * providers. For Claude this is redundant with the real JSON-schema param
 * passed via `runStructuredHelper` (harmless — Claude's structured output is
 * already schema-enforced). For Codex it is load-bearing: the Codex path only
 * conveys the schema as prose via `combinedPrompt` /
 * `runCodexStructuredHelperQuery`, so this section is the only thing standing
 * between the model and the observed dogfood failure mode (2026-07-02): a
 * top-level `pr` wrapper object, per-child `files` instead of `changes`,
 * 0-based indices, a per-child `buildTestCommand`, and missing top-level keys
 * such as `finalGoal`/`concerns`/`unassignedHunks`. Keep this compact — it
 * rides on every planning call.
 */
const OUTPUT_SCHEMA_SECTION = [
  '## Output schema (required — read carefully)',
  '',
  'Return ONLY a single JSON object matching this exact shape. No prose, no code fence, no wrapper object.',
  '',
  '```',
  '{',
  '  "finalGoal": string,',
  '  "concerns": [ { "concern": string, "kind": "refactor" | "behavior" } ],',
  '  "children": [',
  '    {',
  '      "index": number,           // 1-based; the first child is 1, not 0',
  '      "title": string,           // includes a refactor:/feat: prefix',
  '      "type": "refactor" | "feature",',
  '      "dependsOn": number[],     // lower child indices only; at most one entry',
  '      "changes": [ { "file": string, "hunks": "all" | number[] } ],',
  '      "renames": [ { "from": string, "to": string } ],',
  '      "testProof": string,',
  '      "risk": "low" | "med" | "high",',
  '      "rationale": string',
  '    }',
  '  ],',
  '  "parallelizable": string,',
  '  "landOrder": string,',
  '  "buildTestCommand": string,   // ONE plan-level command; never per-child',
  '  "unassignedHunks": []          // must always be empty',
  '}',
  '```',
  '',
  'Minimal valid example (one child, one change):',
  '',
  '```json',
  '{',
  '  "finalGoal": "Extract the registry seam before wiring the client feature",',
  '  "concerns": [{ "concern": "extract registry seam", "kind": "refactor" }],',
  '  "children": [',
  '    {',
  '      "index": 1,',
  '      "title": "refactor: extract registry seam",',
  '      "type": "refactor",',
  '      "dependsOn": [],',
  '      "changes": [{ "file": "src/registry.ts", "hunks": "all" }],',
  '      "renames": [],',
  '      "testProof": "existing tests unchanged",',
  '      "risk": "low",',
  '      "rationale": "reshapes the registry without behavior change"',
  '    }',
  '  ],',
  '  "parallelizable": "child 1 only",',
  '  "landOrder": "1",',
  '  "buildTestCommand": "npm test",',
  '  "unassignedHunks": []',
  '}',
  '```',
  '',
  'Do NOT do any of the following (all observed failure modes):',
  '- Do NOT wrap the object in a `pr` field or any other top-level wrapper — the JSON object above IS the entire response.',
  '- Do NOT use a `files` key on a child — the field is `changes`.',
  '- Do NOT use 0-based `index` values — indices are 1-based.',
  '- Do NOT put `buildTestCommand` on individual children — there is exactly ONE plan-level `buildTestCommand`, never per-child.',
  '- Do NOT omit any top-level key, including `finalGoal`, `concerns`, `parallelizable`, `landOrder`, and `unassignedHunks`.',
].join('\n');

export function buildSplitPlannerSystemPrompt(): string {
  return `${SYSTEM_PROMPT}\n\n${OUTPUT_SCHEMA_SECTION}`;
}

function pluralizeHunks(count: number): string {
  return count === 1 ? '1 hunk' : `${count} hunks`;
}

function describeFileEntry(file: DiffFileEntry): string {
  const renamePart =
    file.kind === 'renamed' && file.oldPath
      ? ` (renamed from ${file.oldPath})`
      : '';
  const binaryPart = file.isBinary ? ' [binary]' : '';
  return `- ${file.kind} ${file.path}${renamePart} (+${file.additions}/-${file.deletions}, ${pluralizeHunks(file.hunks.length)})${binaryPart}`;
}

function describeFileHunks(file: DiffFileEntry): string {
  const lines: string[] = [`### ${file.path}`];
  if (file.isBinary) {
    lines.push(
      '(binary file — must be owned whole by exactly one child via `hunks: "all"`)',
    );
    return lines.join('\n');
  }
  if (file.hunks.length === 0) {
    lines.push('(no text hunks — own the whole file via `hunks: "all"`)');
    return lines.join('\n');
  }
  for (const hunk of file.hunks) {
    lines.push(
      `#### hunkIndex ${hunk.hunkIndex} — \`${hunk.header}\` — +${hunk.additions}/-${hunk.deletions} — id ${hunk.contentHash}`,
    );
    lines.push('```diff');
    lines.push(hunk.preview);
    lines.push('```');
  }
  return lines.join('\n');
}

export function buildSplitPlannerUserPrompt(
  input: SplitPlannerUserPromptInput,
): string {
  const { pr, snapshot, repoContext } = input;
  const sections: string[] = [];

  sections.push(
    [
      '# Pull request to split',
      '',
      `- PR: #${pr.prNumber} — ${pr.title}`,
      `- Head branch: ${pr.headBranch} (head SHA ${pr.headSha})`,
      `- Base branch (detected from the PR itself — may be master/develop/a release branch or another feature branch, never assumed to be main): ${pr.baseBranch}`,
    ].join('\n'),
  );

  sections.push(
    [
      '## PR description',
      '',
      pr.body.trim().length > 0 ? pr.body : '(no description)',
    ].join('\n'),
  );

  sections.push(
    [
      `## Files changed (${snapshot.files.length} files, +${snapshot.totalAdditions}/-${snapshot.totalDeletions})`,
      '',
      ...snapshot.files.map(describeFileEntry),
    ].join('\n'),
  );

  sections.push(
    [
      '## Hunk enumeration',
      '',
      'Assign every hunk below to exactly one child, either by owning the whole file (`{ "file": ..., "hunks": "all" }`) or by owning specific hunk indices (`{ "file": ..., "hunks": [0, 2] }`).',
      '',
      ...snapshot.files.map(describeFileHunks),
    ].join('\n'),
  );

  const contextParts: string[] = [];
  if (repoContext.codeowners) {
    contextParts.push(`### CODEOWNERS\n\n${repoContext.codeowners}`);
  }
  if (repoContext.prTemplate) {
    contextParts.push(`### Pull request template\n\n${repoContext.prTemplate}`);
  }
  if (repoContext.contributing) {
    contextParts.push(`### CONTRIBUTING.md\n\n${repoContext.contributing}`);
  }
  if (repoContext.claudeMd) {
    contextParts.push(`### CLAUDE.md\n\n${repoContext.claudeMd}`);
  }
  if (repoContext.buildTestHint) {
    contextParts.push(
      `### Build/test command hints\n\n${repoContext.buildTestHint}`,
    );
  }
  if (contextParts.length > 0) {
    sections.push(
      ['## Repo context', '', contextParts.join('\n\n')].join('\n'),
    );
  }

  return sections.join('\n\n');
}

export function buildSplitPlanValidationRetryAddendum(
  issues: SplitPlanIssue[],
): string {
  return [
    '## Validation issues in your previous plan',
    '',
    'Your previous Split Plan failed deterministic validation. Produce a corrected Split Plan that resolves every issue below while still honoring all hard constraints:',
    '',
    ...issues.map((issue) => `- [${issue.code}] ${issue.message}`),
  ].join('\n');
}

/**
 * Retry addendum for a STRUCTURAL failure (the previous response did not even
 * parse into the required `SplitPlan` shape — `isSplitPlan` rejected it), as
 * opposed to `buildSplitPlanValidationRetryAddendum` which is for a
 * structurally-valid plan that failed deterministic hunk/topology validation.
 * Names the required top-level keys and repeats the specific mistakes seen in
 * the 2026-07-02 dogfood failure so the model self-corrects on the retry.
 */
export function buildSplitPlanStructuralRetryAddendum(): string {
  return [
    '## Your previous response was not valid',
    '',
    'Your previous response could not be parsed as a Split Plan. Return ONLY the JSON object described in the OUTPUT SCHEMA section above, with no wrapper and no missing keys. In particular, check for these common mistakes:',
    '',
    '- No top-level `pr` wrapper — the JSON object IS the Split Plan, not nested inside another field.',
    '- Every top-level key is present: `finalGoal`, `concerns`, `children`, `parallelizable`, `landOrder`, `buildTestCommand`, `unassignedHunks`.',
    '- Each child uses `changes`, not `files`.',
    '- Each child `index` is 1-based (the first child is 1, not 0).',
    '- `buildTestCommand` appears exactly once, at the plan level — never per-child.',
  ].join('\n');
}
