import { load } from 'js-yaml';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphFileRecord,
  CodeGraphSymbolRecord,
} from '../types/code-graph';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import { isRecord } from '../store/database';
import type { NonCodeExtractorInput } from './extractor-registry';
import { isTestFilePath } from './tags-extractor';

// GitHub Actions workflow extractor (`.github/workflows/*.yml`/`.yaml`,
// routed by extract/extractor-registry.ts's `github-workflow` matcher).
// Mirrors manifest-extractors.ts's shape exactly: throw-on-parse-error so the
// engine's non-code failed-record path (`buildFailedNonCodeFileFacts` in
// ../engine.ts) takes over, `isRecord`/`Array.isArray` narrowing everywhere
// (never an `as` cast), and approximate line numbers recovered by searching
// the raw source instead of re-parsing with a location-aware YAML parser.
//
// js-yaml safety note (verified against the installed version): the repo
// root pins `"js-yaml": "^4.1.1"` (package.json) and node_modules/js-yaml is
// resolved at 4.1.1. js-yaml 3.x split `load` (resolves the FULL schema,
// including dangerous tags like `!!js/function`/`!!js/regexp` that can
// execute during parsing) from `safeLoad` (core/default schema only). 4.x
// removed `safeLoad`/`safeDump` entirely and made bare `load`/`dump` use that
// same safe schema by default -- confirmed by node_modules/js-yaml/README.md
// ("By default, does not support regexps, functions and undefined"). So
// calling `load(source)` below with no `schema` option is already the safe
// path; this is also exactly how the rest of the repo calls js-yaml today
// (e.g. apps/web/src/lib/pipelines/pipeline-parser.ts's `load(source)`).
//
// ONE deliberate divergence from manifest-extractors.ts: there, a non-object
// JSON root (e.g. `[]`) degrades to an empty-but-valid manifest instead of
// throwing. Here, a non-mapping parsed root THROWS instead. A real GitHub
// Actions workflow file is always a top-level mapping (`name`/`on`/`jobs`
// keys) -- a scalar or sequence root at a `.github/workflows/*.yml` path
// means the file isn't actually a workflow despite the path match, which is
// honestly a parse failure for this extractor's purposes, not an empty
// document.

const MAX_JOBS_PER_FILE = 100;
const MAX_USES_EDGES_PER_FILE = 200;

function isNonArrayRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function basenameOf(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath;
}

function lineCountOf(source: string): number {
  return Math.max(1, source.split('\n').length);
}

function parseWorkflowYamlOrThrow(
  source: string,
  relativePath: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = load(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML in "${relativePath}": ${message}`);
  }
  if (!isNonArrayRecord(parsed)) {
    throw new Error(
      `Expected a mapping at the root of workflow "${relativePath}" (got ${typeof parsed})`,
    );
  }
  return parsed;
}

function countNewlinesBefore(source: string, index: number): number {
  let count = 0;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) {
      count += 1;
    }
  }
  return count;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A minimal forward-only cursor over the raw YAML source, used to recover
// approximate line numbers without re-parsing with a location-aware YAML
// parser -- the same "cheap and honest" trade-off manifest-extractors.ts
// documents for JSON's `approximateLineNumber`. `index` only ever advances,
// so two occurrences of the same key/value later in the file (e.g. the same
// `uses:` action referenced from two different steps) resolve to two
// DIFFERENT lines in document order, rather than both collapsing onto the
// first match in the file.
interface LineCursor {
  index: number;
}

// Finds the next line at or after `cursor.index` whose (optionally quoted)
// mapping key is `key`, advances the cursor past that match, and returns its
// 1-based line number. Falls back to the cursor's current line (never
// advancing) when no such line is found, so a missing/malformed anchor never
// throws -- it just leaves later approximate lookups searching from the same
// position.
//
// `indentation: 'root'` requires the key at column 0 (used for the
// workflow's own top-level `name:`/`jobs:` keys, so a job's own indented
// `name:` field can never be mistaken for the workflow's). `'any'` allows
// arbitrary leading whitespace AND an optional YAML sequence-item dash
// (`- uses: ...`), since job ids are indented under `jobs:` and step keys are
// indented under `steps:` -- sometimes as the first key on a dashed list
// item, sometimes as a continuation line of the same mapping.
function advanceToKeyLine(
  source: string,
  cursor: LineCursor,
  key: string,
  indentation: 'root' | 'any',
): number {
  const escapedKey = escapeRegExp(key);
  const pattern =
    indentation === 'root'
      ? new RegExp(`^(['"]?)${escapedKey}\\1[ \\t]*:`, 'gm')
      : new RegExp(`^[ \\t]*(-[ \\t]+)?(['"]?)${escapedKey}\\2[ \\t]*:`, 'gm');
  pattern.lastIndex = cursor.index;
  const match = pattern.exec(source);
  if (match === null) {
    return countNewlinesBefore(source, cursor.index) + 1;
  }
  cursor.index = match.index + match[0].length;
  return countNewlinesBefore(source, match.index) + 1;
}

interface JobStepUsage {
  stepIndex: number;
  uses: string;
}

// Only steps with a string `uses:` value are extractable -- a `run:`-only
// step (or any step whose `uses` is missing/non-string) contributes no edge,
// exactly per contract.
function collectStepUsages(stepsValue: unknown): JobStepUsage[] {
  if (!Array.isArray(stepsValue)) {
    return [];
  }
  const usages: JobStepUsage[] = [];
  // Iterated via for-of (never an indexed `stepsValue[i]` read): TypeScript's
  // `Array.isArray` narrows `unknown` to `any[]`, and indexing an `any[]`
  // trips `@typescript-eslint/no-unsafe-assignment` on the resulting
  // variable. `for...of` avoids that entirely -- same shape as
  // manifest-extractors.ts's `references` array walk.
  let stepIndex = 0;
  for (const step of stepsValue) {
    if (isNonArrayRecord(step)) {
      const usesValue = step.uses;
      if (typeof usesValue === 'string') {
        usages.push({ stepIndex, uses: usesValue });
      }
    }
    stepIndex += 1;
  }
  return usages;
}

interface PendingJob {
  id: string;
  steps: JobStepUsage[];
}

// One pending job per `jobs.<id>` key, in source (insertion) order. A
// malformed job value (not a mapping) still produces the job symbol itself --
// the contract is "one workflow_job per jobs.<id> KEY" -- it just contributes
// zero step usages, mirroring how a malformed nested block elsewhere in this
// extractor family degrades to "nothing further to extract" rather than
// dropping the parent fact.
function collectJobs(jobsValue: unknown): PendingJob[] {
  if (!isNonArrayRecord(jobsValue)) {
    return [];
  }
  const jobs: PendingJob[] = [];
  for (const [id, jobValue] of Object.entries(jobsValue)) {
    const steps = isNonArrayRecord(jobValue)
      ? collectStepUsages(jobValue.steps)
      : [];
    jobs.push({ id, steps });
  }
  return jobs;
}

function buildFileSymbol(input: NonCodeExtractorInput): CodeGraphSymbolRecord {
  const fileId = fileRowId(input.repoId, input.relativePath);
  const qualifiedName = fileQualifiedName(input.relativePath);
  return {
    id: symbolRowId(input.repoId, qualifiedName),
    repositoryId: input.repoId,
    fileId,
    kind: 'file',
    name: basenameOf(input.relativePath),
    qualifiedName,
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: lineCountOf(input.source),
    byteStart: 0,
    byteEnd: input.sizeBytes,
    signature: null,
    exported: false,
    isTest: isTestFilePath(input.relativePath),
    extra: {},
  };
}

function buildFileRecord(
  input: NonCodeExtractorInput,
  languageId: string,
): CodeGraphFileRecord {
  return {
    id: fileRowId(input.repoId, input.relativePath),
    repositoryId: input.repoId,
    relativePath: input.relativePath,
    absolutePath: input.absolutePath,
    language: languageId,
    contentHash: input.contentHash,
    sizeBytes: input.sizeBytes,
    mtimeNs: input.mtimeNs,
    lineCount: lineCountOf(input.source),
    grammarId: languageId,
    grammarAbi: null,
    parseStatus: 'parsed',
    hasErrors: false,
    updatedAt: Date.now(),
  };
}

function containsEdge(
  repoId: string,
  fileId: string,
  sourceSymbolId: string,
  targetSymbol: CodeGraphSymbolRecord,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId,
      kind: 'CONTAINS',
      sourceId: sourceSymbolId,
      target: targetSymbol.id,
      line: targetSymbol.lineStart,
    }),
    repositoryId: repoId,
    kind: 'CONTAINS',
    sourceSymbolId,
    targetSymbolId: targetSymbol.id,
    sourceFileId: fileId,
    targetRef: null,
    line: targetSymbol.lineStart,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: {},
  };
}

export function extractWorkflowFacts(
  input: NonCodeExtractorInput,
): CodeGraphFileFacts {
  const fileId = fileRowId(input.repoId, input.relativePath);
  const fileSymbol = buildFileSymbol(input);
  const root = parseWorkflowYamlOrThrow(input.source, input.relativePath);

  const cursor: LineCursor = { index: 0 };
  const nameValue = root.name;
  const hasStringName = typeof nameValue === 'string';
  const workflowName = hasStringName
    ? nameValue
    : basenameOf(input.relativePath);
  const workflowLine = hasStringName
    ? advanceToKeyLine(input.source, cursor, 'name', 'root')
    : 1;

  const workflowQualifiedName = symbolQualifiedName(
    input.relativePath,
    [],
    'workflow',
  );
  const workflowSymbol: CodeGraphSymbolRecord = {
    id: symbolRowId(input.repoId, workflowQualifiedName),
    repositoryId: input.repoId,
    fileId,
    kind: 'workflow',
    name: workflowName,
    qualifiedName: workflowQualifiedName,
    parentSymbolId: null,
    lineStart: workflowLine,
    lineEnd: fileSymbol.lineEnd,
    byteStart: 0,
    byteEnd: input.sizeBytes,
    signature: null,
    exported: false,
    isTest: false,
    extra: {},
  };

  const symbols: CodeGraphSymbolRecord[] = [fileSymbol, workflowSymbol];
  const edges: CodeGraphEdgeRecord[] = [
    containsEdge(input.repoId, fileId, fileSymbol.id, workflowSymbol),
  ];

  const jobs = collectJobs(root.jobs);
  const truncatedJobs = Math.max(0, jobs.length - MAX_JOBS_PER_FILE);
  const retainedJobs = jobs.slice(0, MAX_JOBS_PER_FILE);

  // Anchor the job-id search to the `jobs:` block so job ids resolve in
  // document order instead of each one restarting from byte 0 -- mirrors
  // manifest-extractors.ts's groupKey anchor for scripts/dependencies.
  advanceToKeyLine(input.source, cursor, 'jobs', 'root');

  let usesEdgeCount = 0;
  let truncatedUsesEdges = 0;

  for (const job of retainedJobs) {
    const jobLine = advanceToKeyLine(input.source, cursor, job.id, 'any');
    const jobQualifiedName = symbolQualifiedName(
      input.relativePath,
      ['jobs'],
      job.id,
    );
    const jobSymbol: CodeGraphSymbolRecord = {
      id: symbolRowId(input.repoId, jobQualifiedName),
      repositoryId: input.repoId,
      fileId,
      kind: 'workflow_job',
      name: job.id,
      qualifiedName: jobQualifiedName,
      parentSymbolId: workflowSymbol.id,
      lineStart: jobLine,
      lineEnd: jobLine,
      byteStart: 0,
      byteEnd: 0,
      signature: null,
      exported: false,
      isTest: false,
      extra: {},
    };
    symbols.push(jobSymbol);
    edges.push(
      containsEdge(input.repoId, fileId, workflowSymbol.id, jobSymbol),
    );

    for (const usage of job.steps) {
      if (usesEdgeCount >= MAX_USES_EDGES_PER_FILE) {
        truncatedUsesEdges += 1;
        continue;
      }
      const usesLine = advanceToKeyLine(input.source, cursor, 'uses', 'any');
      // External refs (e.g. `actions/checkout@v4`) stay unresolved forever --
      // there is no local symbol they could ever resolve to. A local
      // `./.github/actions/foo` path ref MAY be resolvable to a real
      // `action.yml`/`action.yaml` symbol in a future phase, but Phase 5
      // deliberately leaves it unresolved too (targetSymbolId stays null for
      // both cases here).
      //
      // Step-index id discriminator (mirrors manifest-extractors.ts's
      // `idDiscriminator` precedent): two steps in the SAME job with an
      // identical `uses` value can land on the SAME approximate line -- e.g.
      // a flow-style single-line steps array, where advanceToKeyLine's
      // line-start regex finds no `uses:` match at all and falls back to the
      // cursor's current line for every occurrence. Without a discriminator,
      // `target: usage.uses` + `line: usesLine` would hash to the SAME edge
      // id for both steps, and the store's INSERT OR REPLACE would silently
      // drop one step's edge. `stepIndex` is always unique within a job's
      // own steps array, so folding it into the id-hash target keeps every
      // step's edge distinct even when `uses` and `line` collide.
      edges.push({
        id: edgeRowId({
          repoId: input.repoId,
          kind: 'USES_PIPELINE_ACTION',
          sourceId: jobSymbol.id,
          target: `${usage.uses}#${usage.stepIndex}`,
          line: usesLine,
        }),
        repositoryId: input.repoId,
        kind: 'USES_PIPELINE_ACTION',
        sourceSymbolId: jobSymbol.id,
        targetSymbolId: null,
        sourceFileId: fileId,
        targetRef: usage.uses,
        line: usesLine,
        confidenceTier: 'EXTRACTED',
        confidenceScore: 1.0,
        resolverId: null,
        evidence: { stepIndex: usage.stepIndex },
      });
      usesEdgeCount += 1;
    }
  }

  const truncatedFacts = truncatedJobs + truncatedUsesEdges;
  if (truncatedFacts > 0) {
    fileSymbol.extra = { ...fileSymbol.extra, truncatedFacts };
  }

  return {
    file: buildFileRecord(input, 'github-workflow'),
    symbols,
    edges,
  };
}

const ACTION_MANIFEST_LANGUAGE = 'github-action-manifest';

// Minimal extractor for local composite/Docker/JavaScript action manifests
// (`action.yml`/`action.yaml`), routed here by extract/extractor-registry.ts's
// `github-action-manifest` matcher (Phase 6 addition). These files live
// ANYWHERE a local action is checked out in the repo -- conventionally
// `.github/actions/<name>/action.yml`, but GitHub does not require that
// directory, and `uses: ./` even points at a repository-root manifest -- and
// today's ONLY reason they need a graph presence at all is so
// resolve/workflow-action-resolver.ts's LOCAL `uses: ./path` refs have a real
// file symbol to bind to (see that resolver's own comment for why
// `nullDanglingEdgeTargets` would otherwise immediately erase any such
// binding on the next build, if the target symbol did not durably exist).
//
// This deliberately does NOT parse the action manifest's own schema
// (name/description/inputs/outputs/runs) -- that is a separate, larger
// extraction task and out of Phase 6 Task 2's scope; only file-symbol
// PRESENCE is needed for path-based resolution, so this never even attempts
// a YAML parse and therefore never throws.
export function extractActionManifestFacts(
  input: NonCodeExtractorInput,
): CodeGraphFileFacts {
  return {
    file: buildFileRecord(input, ACTION_MANIFEST_LANGUAGE),
    symbols: [buildFileSymbol(input)],
    edges: [],
  };
}
