import * as yaml from 'js-yaml';
import type {
  GitHubWorkflowDefinitionGraph,
  GitHubWorkflowGraphJob,
} from '../types/github-watchers';

/** Upper bounds for a persisted definition graph; larger graphs are dropped. */
export const MAX_GITHUB_WORKFLOW_GRAPH_JOBS = 200;
export const MAX_GITHUB_WORKFLOW_GRAPH_NAMES = 500;
export const MAX_GITHUB_WORKFLOW_GRAPH_NAME_LENGTH = 200;
/** Reusable workflows read for one run; extra `uses:` jobs collapse to one node. */
export const MAX_GITHUB_WORKFLOW_CALLED_FILES = 10;
/** Matrix variants expanded per job; larger matrices are treated as dynamic. */
const MAX_MATRIX_VARIANTS = 256;
const MAX_MATRIX_TRAVERSAL_DEPTH = 32;
const MAX_MATRIX_TRAVERSAL_NODES = 2_048;

const EXPRESSION_PATTERN = /\$\{\{/;
const MATRIX_EXPRESSION = /\$\{\{\s*matrix\.([A-Za-z0-9_.-]+)\s*\}\}/g;
const JOB_INDEX_EXPRESSION = /\$\{\{\s*strategy\.job-index\s*\}\}/g;
const JOB_TOTAL_EXPRESSION = /\$\{\{\s*strategy\.job-total\s*\}\}/g;

interface ParsedJob {
  id: string;
  /** `name:` when present, else the job key, exactly as GitHub displays it. */
  template: string;
  needs: string[];
  uses: string | undefined;
  matrix: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkflowJobs(text: string): ParsedJob[] | null {
  let document: unknown;
  try {
    document = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch {
    return null;
  }
  if (!isRecord(document) || !isRecord(document.jobs)) return null;
  const jobs: ParsedJob[] = [];
  for (const [id, raw] of Object.entries(document.jobs)) {
    if (!isRecord(raw)) continue;
    const needs = Array.isArray(raw.needs)
      ? raw.needs.filter((need): need is string => typeof need === 'string')
      : typeof raw.needs === 'string'
        ? [raw.needs]
        : [];
    const strategy = isRecord(raw.strategy) ? raw.strategy : undefined;
    jobs.push({
      id,
      template:
        typeof raw.name === 'string' && raw.name.trim().length > 0
          ? raw.name
          : id,
      needs,
      uses: typeof raw.uses === 'string' ? raw.uses : undefined,
      matrix: strategy?.matrix,
    });
  }
  return jobs;
}

/** Raw `uses:` values of every reusable-workflow job in a workflow file. */
export function listGitHubWorkflowCalls(text: string): string[] {
  const jobs = parseWorkflowJobs(text) ?? [];
  const calls: string[] = [];
  for (const job of jobs) {
    if (job.uses && !calls.includes(job.uses)) calls.push(job.uses);
  }
  return calls;
}

function containsExpression(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let visitedNodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visitedNodes += 1;
    if (visitedNodes > MAX_MATRIX_TRAVERSAL_NODES) return true;
    if (typeof current.value === 'string') {
      if (EXPRESSION_PATTERN.test(current.value)) return true;
      continue;
    }
    if (!Array.isArray(current.value) && !isRecord(current.value)) continue;
    if (
      current.depth >= MAX_MATRIX_TRAVERSAL_DEPTH ||
      seen.has(current.value)
    ) {
      return true;
    }
    seen.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    if (
      visitedNodes + pending.length + children.length >
      MAX_MATRIX_TRAVERSAL_NODES
    ) {
      return true;
    }
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function lookupPath(combo: Record<string, unknown>, path: string): unknown {
  let current: unknown = combo;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Expand a `strategy.matrix` into concrete combinations following GitHub's
 * rules closely enough for display names: the cartesian product of the
 * list-valued keys, `include` entries that either extend matching
 * combinations or add new ones, and `exclude` entries that remove matches.
 * Returns null when any part is an expression or the matrix is too large.
 */
function expandMatrix(
  matrix: unknown,
  nameBudget: number,
): Record<string, unknown>[] | null | undefined {
  if (!isRecord(matrix) || containsExpression(matrix)) return null;
  const keys = Object.keys(matrix).filter(
    (key) => key !== 'include' && key !== 'exclude',
  );
  let combos: Record<string, unknown>[] = [{}];
  for (const key of keys) {
    const values: unknown = matrix[key];
    if (!Array.isArray(values)) return null;
    const variants: unknown[] = values;
    const expandedLength = combos.length * variants.length;
    if (expandedLength > MAX_MATRIX_VARIANTS) return null;
    if (expandedLength > nameBudget) return undefined;
    combos = combos.flatMap((combo) =>
      variants.map((value) => ({ ...combo, [key]: value })),
    );
  }
  if (keys.length === 0) combos = [];

  // GitHub removes excluded combinations before processing `include`, which
  // lets an include entry add a previously excluded combination back.
  const exclude = Array.isArray(matrix.exclude) ? matrix.exclude : [];
  for (const entry of exclude) {
    if (!isRecord(entry)) return null;
    combos = combos.filter(
      (combo) =>
        !Object.entries(entry).every(([key, value]) =>
          sameValue(combo[key], value),
        ),
    );
  }
  const originalCombos = combos.map((combo) => ({ ...combo }));
  const standaloneIncludes: Record<string, unknown>[] = [];

  const include = Array.isArray(matrix.include) ? matrix.include : [];
  for (const entry of include) {
    if (!isRecord(entry)) return null;
    const matchingIndexes = originalCombos.flatMap((combo, index) =>
      Object.entries(entry).every(
        ([key, value]) => !(key in combo) || sameValue(combo[key], value),
      )
        ? [index]
        : [],
    );
    if (matchingIndexes.length > 0) {
      for (const index of matchingIndexes) {
        combos[index] = { ...combos[index], ...entry };
      }
    } else {
      if (combos.length + standaloneIncludes.length >= nameBudget) {
        return undefined;
      }
      standaloneIncludes.push({ ...entry });
    }
    if (combos.length + standaloneIncludes.length > MAX_MATRIX_VARIANTS) {
      return null;
    }
  }
  combos.push(...standaloneIncludes);
  return combos;
}

function boundedName(name: string): string {
  return name.slice(0, MAX_GITHUB_WORKFLOW_GRAPH_NAME_LENGTH);
}

/** Display names for one job: one per matrix variant, or null when dynamic. */
function expandNames(
  template: string,
  matrix: unknown,
  nameBudget: number,
): string[] | null | undefined {
  if (matrix === undefined) {
    return nameBudget >= 1 ? [boundedName(template)] : undefined;
  }
  const combos = expandMatrix(matrix, nameBudget);
  if (combos === undefined) return undefined;
  if (!combos) return null;
  const usesMatrix = new RegExp(MATRIX_EXPRESSION.source).test(template);
  return combos.map((combo, index) => {
    let name = template
      .replace(MATRIX_EXPRESSION, (expression, path: string) => {
        const value = lookupPath(combo, path);
        return value === undefined ? expression : displayValue(value);
      })
      .replace(JOB_INDEX_EXPRESSION, String(index))
      .replace(JOB_TOTAL_EXPRESSION, String(combos.length));
    if (!usesMatrix) {
      const values = Object.values(combo).map(displayValue).join(', ');
      if (values.length > 0) name = `${name} (${values})`;
    }
    return boundedName(name);
  });
}

interface DraftNode {
  id: string;
  template: string;
  names: string[];
  dynamic: boolean;
  /** Unresolved job keys at the level the node was declared. */
  rawNeeds: string[];
  /** For reusable-workflow inner nodes, the caller's job key. */
  caller?: string;
}

export interface BuildGitHubWorkflowDefinitionGraphInput {
  /** Commit every file was read at. */
  sha: string;
  observedAt: string;
  /** YAML text of the run's own workflow file. */
  root: string;
  /**
   * YAML text of each called reusable workflow keyed by the exact `uses:`
   * value. A caller whose file is missing collapses into one dynamic node.
   */
  called: ReadonlyMap<string, string>;
}

/**
 * Build the bounded job graph for one run from its workflow definitions.
 * Returns null when the root workflow does not parse, declares no jobs, or
 * exceeds the persisted bounds; callers then fall back to timestamp-inferred
 * tiers rather than showing a partial graph.
 */
export function buildGitHubWorkflowDefinitionGraph(
  input: BuildGitHubWorkflowDefinitionGraphInput,
): GitHubWorkflowDefinitionGraph | null {
  const rootJobs = parseWorkflowJobs(input.root);
  if (!rootJobs || rootJobs.length === 0) return null;

  const drafts: DraftNode[] = [];
  let nameCount = 0;
  const retainDraft = (draft: DraftNode): boolean => {
    if (
      drafts.length >= MAX_GITHUB_WORKFLOW_GRAPH_JOBS ||
      nameCount + draft.names.length > MAX_GITHUB_WORKFLOW_GRAPH_NAMES
    ) {
      return false;
    }
    drafts.push(draft);
    nameCount += draft.names.length;
    return true;
  };
  /** Job key → node ids it resolves to (a reusable caller → its inner nodes). */
  const resolution = new Map<string, string[]>();

  for (const job of rootJobs) {
    if (drafts.length >= MAX_GITHUB_WORKFLOW_GRAPH_JOBS) return null;
    if (job.uses === undefined) {
      const names = expandNames(
        job.template,
        job.matrix,
        MAX_GITHUB_WORKFLOW_GRAPH_NAMES - nameCount,
      );
      if (names === undefined) return null;
      if (
        !retainDraft({
          id: job.id,
          template: job.template,
          names: names ?? [],
          dynamic: names === null,
          rawNeeds: job.needs,
        })
      ) {
        return null;
      }
      resolution.set(job.id, [job.id]);
      continue;
    }
    const calledText = input.called.get(job.uses);
    const innerJobs =
      calledText !== undefined && job.matrix === undefined
        ? parseWorkflowJobs(calledText)
        : null;
    if (!innerJobs || innerJobs.length === 0) {
      // Unknown or matrix-called reusable workflow: one placeholder that the
      // caller's dependents wait on and that GitHub's `Caller / Job` names
      // still match by prefix.
      if (
        !retainDraft({
          id: job.id,
          template: `${job.template} / \${{ job }}`,
          names: [],
          dynamic: true,
          rawNeeds: job.needs,
        })
      ) {
        return null;
      }
      resolution.set(job.id, [job.id]);
      continue;
    }
    const innerIds = new Set(innerJobs.map((inner) => inner.id));
    const innerNodeIds: string[] = [];
    for (const inner of innerJobs) {
      if (drafts.length >= MAX_GITHUB_WORKFLOW_GRAPH_JOBS) return null;
      const id = `${job.id}/${inner.id}`;
      const template = `${job.template} / ${inner.template}`;
      const names =
        inner.uses === undefined
          ? expandNames(
              template,
              inner.matrix,
              MAX_GITHUB_WORKFLOW_GRAPH_NAMES - nameCount,
            )
          : null;
      if (names === undefined) return null;
      const innerNeeds = inner.needs.filter((need) => innerIds.has(need));
      if (
        !retainDraft({
          id,
          template,
          names: names ?? [],
          dynamic: names === null,
          // Inner roots inherit the caller's dependencies; inner dependents keep
          // their own, namespaced under the caller.
          rawNeeds:
            innerNeeds.length > 0
              ? innerNeeds.map((need) => `${job.id}/${need}`)
              : job.needs,
          caller: job.id,
        })
      ) {
        return null;
      }
      innerNodeIds.push(id);
      resolution.set(id, [id]);
    }
    resolution.set(job.id, innerNodeIds);
  }

  const jobs: GitHubWorkflowGraphJob[] = drafts.map((draft) => {
    const needs: string[] = [];
    for (const need of draft.rawNeeds) {
      for (const resolved of resolution.get(need) ?? []) {
        if (resolved !== draft.id && !needs.includes(resolved)) {
          needs.push(resolved);
        }
      }
    }
    return {
      id: draft.id,
      template: boundedName(draft.template),
      names: draft.names,
      needs,
      dynamic: draft.dynamic,
    };
  });
  return { sha: input.sha, jobs, observedAt: input.observedAt };
}

/**
 * Longest-path depth of every job over its `needs`, with cycles (which GitHub
 * itself rejects) and unknown ids treated as roots. Exported so the renderer
 * and tests share one definition of a tier.
 */
export function githubWorkflowGraphDepths(
  jobs: readonly GitHubWorkflowGraphJob[],
): Map<string, number> {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const job = byId.get(id);
    if (!job || visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const need of job.needs) {
      if (byId.has(need)) value = Math.max(value, depth(need) + 1);
    }
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  for (const job of jobs) depth(job.id);
  return depths;
}
