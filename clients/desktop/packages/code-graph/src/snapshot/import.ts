import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  CODE_GRAPH_SNAPSHOT_SCHEMA_VERSION,
  type CodeGraphSnapshotEdge,
  type CodeGraphSnapshotEnvelope,
  type CodeGraphSnapshotFile,
  type CodeGraphSnapshotGrammar,
  type CodeGraphSnapshotSymbol,
} from '../types/code-graph-tools';
import {
  CODE_GRAPH_CONFIDENCE_TIERS,
  CODE_GRAPH_EDGE_KINDS,
  CODE_GRAPH_PARSE_STATUSES,
  CODE_GRAPH_SYMBOL_KINDS,
  type CodeGraphEdgeRecord,
  type CodeGraphFileRecord,
  type CodeGraphSymbolRecord,
} from '../types/code-graph';
import { edgeRowId, fileRowId, symbolRowId } from '../ids';
import { isTestFilePath } from '../extract/tags-extractor';
import {
  deleteMetadataValue,
  isRecord,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from '../store/database';
import { CODE_GRAPH_DERIVED_PENDING_KEY } from '../deferred-derived';
import { clearCodeGraphSummaryProjection } from '../summary-projection';
import { rebuildSymbolFts } from '../store/fts';
import type { CodeGraphStore } from '../store/graph-store';
import { readBundledGrammarManifest } from './export';

/**
 * Thrown when a snapshot's `schemaVersion` does not match the version this
 * build of Canopy knows how to import. There is deliberately no
 * cross-version migration path yet — schemaVersion 1 is the only version
 * that exists.
 */
export class CodeGraphSnapshotVersionError extends Error {
  public constructor(expected: number, actual: unknown) {
    super(
      `Unsupported code-graph snapshot schemaVersion ${JSON.stringify(actual)} ` +
        `(expected ${expected}).`,
    );
    this.name = 'CodeGraphSnapshotVersionError';
  }
}

// --- Validation (isRecord narrowing; every field checked, no `as` casts) ---

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Snapshot import: "${field}" must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Snapshot import: "${field}" must be an array.`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Snapshot import: "${field}" must be a string.`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, field);
}

// A snapshot's `relativePath` must stay a repo-relative POSIX path.
// `toFileRecord` reconstructs an absolute path with
// `path.join(rootPath, relativePath)`, so a `..` segment or an absolute value
// (leading `/` or a Windows drive prefix) could escape the import target's
// root. ANY backslash is rejected outright, not just a leading (UNC) one: a
// legit export can never contain one (`canonicalRelativePath` normalizes `\`
// to `/` before paths ever reach the store), and on Windows `path.join`
// treats `\` as a separator — so e.g. `"..\\evil"` would dodge the
// slash-split `..` check below while still traversing out of the root.
function requireSafeRelativePath(value: unknown, field: string): string {
  const relativePath = requireString(value, field);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split('/').includes('..')
  ) {
    throw new Error(
      `Snapshot import: "${field}" must be a non-empty repo-relative path ` +
        `without ".." segments, backslashes, or an absolute prefix: ` +
        `${JSON.stringify(relativePath)}.`,
    );
  }
  return relativePath;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Snapshot import: "${field}" must be a number.`);
  }
  return value;
}

function requireNullableNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  return requireNumber(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Snapshot import: "${field}" must be a boolean.`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value === 'string') {
    for (const candidate of allowed) {
      if (candidate === value) {
        return candidate;
      }
    }
  }
  throw new Error(
    `Snapshot import: "${field}" has an invalid value ${JSON.stringify(value)}.`,
  );
}

function parseSnapshotGrammar(
  value: unknown,
  index: number,
): CodeGraphSnapshotGrammar {
  const row = requireRecord(value, `grammars[${index}]`);
  const grammar: CodeGraphSnapshotGrammar = {
    package: requireString(row.package, `grammars[${index}].package`),
    version: requireString(row.version, `grammars[${index}].version`),
  };
  if (typeof row.grammar === 'string') {
    grammar.grammar = row.grammar;
  }
  if (typeof row.built === 'boolean') {
    grammar.built = row.built;
  }
  return grammar;
}

function parseSnapshotFile(
  value: unknown,
  index: number,
): CodeGraphSnapshotFile {
  const row = requireRecord(value, `files[${index}]`);
  return {
    relativePath: requireSafeRelativePath(
      row.relativePath,
      `files[${index}].relativePath`,
    ),
    language: requireNullableString(row.language, `files[${index}].language`),
    contentHash: requireNullableString(
      row.contentHash,
      `files[${index}].contentHash`,
    ),
    sizeBytes: requireNumber(row.sizeBytes, `files[${index}].sizeBytes`),
    mtimeNs: requireString(row.mtimeNs, `files[${index}].mtimeNs`),
    lineCount: requireNullableNumber(
      row.lineCount,
      `files[${index}].lineCount`,
    ),
    grammarId: requireNullableString(
      row.grammarId,
      `files[${index}].grammarId`,
    ),
    grammarAbi: requireNullableNumber(
      row.grammarAbi,
      `files[${index}].grammarAbi`,
    ),
    parseStatus: requireEnum(
      row.parseStatus,
      CODE_GRAPH_PARSE_STATUSES,
      `files[${index}].parseStatus`,
    ),
    hasErrors: requireBoolean(row.hasErrors, `files[${index}].hasErrors`),
  };
}

function parseSnapshotSymbol(
  value: unknown,
  index: number,
): CodeGraphSnapshotSymbol {
  const row = requireRecord(value, `symbols[${index}]`);
  return {
    qualifiedName: requireString(
      row.qualifiedName,
      `symbols[${index}].qualifiedName`,
    ),
    kind: requireEnum(
      row.kind,
      CODE_GRAPH_SYMBOL_KINDS,
      `symbols[${index}].kind`,
    ),
    signature: requireNullableString(
      row.signature,
      `symbols[${index}].signature`,
    ),
    filePath: requireString(row.filePath, `symbols[${index}].filePath`),
  };
}

function parseSnapshotEdge(
  value: unknown,
  index: number,
): CodeGraphSnapshotEdge {
  const row = requireRecord(value, `edges[${index}]`);
  // Deliberately lenient (default to `{}`, never throw): unlike every other
  // field on this shape, `evidence` is a free-form diagnostic bag (see
  // CodeGraphEdgeRecord['evidence']) rather than identity/structural data, so
  // a missing or malformed value degrades gracefully instead of failing the
  // whole import over auxiliary debugging context.
  const evidence = row.evidence;
  return {
    kind: requireEnum(row.kind, CODE_GRAPH_EDGE_KINDS, `edges[${index}].kind`),
    sourceFilePath: requireString(
      row.sourceFilePath,
      `edges[${index}].sourceFilePath`,
    ),
    sourceQualifiedName: requireNullableString(
      row.sourceQualifiedName,
      `edges[${index}].sourceQualifiedName`,
    ),
    targetQualifiedName: requireNullableString(
      row.targetQualifiedName,
      `edges[${index}].targetQualifiedName`,
    ),
    targetRef: requireNullableString(
      row.targetRef,
      `edges[${index}].targetRef`,
    ),
    line: requireNullableNumber(row.line, `edges[${index}].line`),
    confidenceTier: requireEnum(
      row.confidenceTier,
      CODE_GRAPH_CONFIDENCE_TIERS,
      `edges[${index}].confidenceTier`,
    ),
    confidenceScore: requireNumber(
      row.confidenceScore,
      `edges[${index}].confidenceScore`,
    ),
    resolverId: requireNullableString(
      row.resolverId,
      `edges[${index}].resolverId`,
    ),
    evidence: isRecord(evidence) ? evidence : {},
  };
}

/**
 * Validates and narrows a raw parsed-JSON value into a
 * {@link CodeGraphSnapshotEnvelope}. Rejects a wrong/missing `schemaVersion`
 * with the typed {@link CodeGraphSnapshotVersionError}; every other shape
 * problem throws a plain, field-named `Error` via the `require*` helpers
 * above. Also rejects: a `files[].relativePath` that is absolute, contains a
 * `..` segment, or contains any backslash (it would escape the import
 * target's root on reconstruction — see `requireSafeRelativePath`); a
 * symbol/edge that references a file not present in the
 * snapshot's own `files` list; an edge whose non-null source/target
 * qualifiedName is absent from the `symbols` list; and duplicate
 * `files`/`symbols` entries (same relativePath / qualifiedName twice) — a
 * snapshot whose facts don't agree with its own file/symbol lists, or that
 * repeats a unique key a real export can never repeat, is malformed, not just
 * "missing extra detail".
 */
export function parseCodeGraphSnapshotEnvelope(
  raw: unknown,
): CodeGraphSnapshotEnvelope {
  const root = requireRecord(raw, 'snapshot');
  if (root.schemaVersion !== CODE_GRAPH_SNAPSHOT_SCHEMA_VERSION) {
    throw new CodeGraphSnapshotVersionError(
      CODE_GRAPH_SNAPSHOT_SCHEMA_VERSION,
      root.schemaVersion,
    );
  }
  const repository = requireRecord(root.repository, 'repository');
  const grammars = requireArray(root.grammars, 'grammars').map(
    parseSnapshotGrammar,
  );
  const files = requireArray(root.files, 'files').map(parseSnapshotFile);
  const symbols = requireArray(root.symbols, 'symbols').map(
    parseSnapshotSymbol,
  );
  const edges = requireArray(root.edges, 'edges').map(parseSnapshotEdge);

  // Duplicate files/symbols entries are rejected loudly rather than being
  // silently last-write-wins'd by INSERT OR REPLACE at apply time: a real
  // export can never produce them (the operational tables have UNIQUE
  // constraints on exactly these keys — see store/migrations.ts), so their
  // presence means a hand-edited or corrupted snapshot, and they would also
  // silently falsify `applyCodeGraphSnapshot`'s files/symbols counts, which
  // are derived from these array lengths.
  const knownRelativePaths = new Set<string>();
  for (const file of files) {
    if (knownRelativePaths.has(file.relativePath)) {
      throw new Error(
        `Snapshot import: duplicate files entry for "${file.relativePath}".`,
      );
    }
    knownRelativePaths.add(file.relativePath);
  }
  const seenQualifiedNames = new Set<string>();
  for (const symbol of symbols) {
    if (seenQualifiedNames.has(symbol.qualifiedName)) {
      throw new Error(
        `Snapshot import: duplicate symbols entry for "${symbol.qualifiedName}".`,
      );
    }
    seenQualifiedNames.add(symbol.qualifiedName);
    if (!knownRelativePaths.has(symbol.filePath)) {
      throw new Error(
        `Snapshot import: symbol "${symbol.qualifiedName}" references a ` +
          `file not present in the snapshot's files list: "${symbol.filePath}".`,
      );
    }
  }
  for (const edge of edges) {
    if (!knownRelativePaths.has(edge.sourceFilePath)) {
      throw new Error(
        `Snapshot import: an edge references a file not present in the ` +
          `snapshot's files list: "${edge.sourceFilePath}".`,
      );
    }
    // A non-null source/target qualifiedName means the operational edge was
    // bound to a real symbol (see CodeGraphSnapshotEdge). A legit export can
    // only produce a qualifiedName its own symbols list carries (export maps
    // symbol ids through that same listing), so an edge naming a symbol absent
    // from `symbols` is malformed — reject it, consistent with the file-
    // reference check above.
    if (
      edge.sourceQualifiedName !== null &&
      !seenQualifiedNames.has(edge.sourceQualifiedName)
    ) {
      throw new Error(
        `Snapshot import: an edge references a source symbol not present in ` +
          `the snapshot's symbols list: "${edge.sourceQualifiedName}".`,
      );
    }
    if (
      edge.targetQualifiedName !== null &&
      !seenQualifiedNames.has(edge.targetQualifiedName)
    ) {
      throw new Error(
        `Snapshot import: an edge references a target symbol not present in ` +
          `the snapshot's symbols list: "${edge.targetQualifiedName}".`,
      );
    }
  }

  return {
    schemaVersion: CODE_GRAPH_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: requireString(root.generatedAt, 'generatedAt'),
    repository: {
      repoId: requireString(repository.repoId, 'repository.repoId'),
      gitHead: requireNullableString(repository.gitHead, 'repository.gitHead'),
    },
    grammars,
    files,
    symbols,
    edges,
  };
}

function grammarLabel(grammar: CodeGraphSnapshotGrammar): string {
  return grammar.grammar === undefined
    ? grammar.package
    : `${grammar.package}/${grammar.grammar}`;
}

/**
 * Compares the snapshot's recorded grammars against the LOCAL bundled
 * manifest (the same one `export.ts` reads from). A missing or
 * version-mismatched grammar never blocks the import — it only contributes a
 * warning string — because a snapshot is a best-effort seed, not a strict
 * contract with the importing machine's exact toolchain.
 */
export async function checkSnapshotGrammarCompatibility(
  snapshotGrammars: readonly CodeGraphSnapshotGrammar[],
): Promise<string[]> {
  const localGrammars = await readBundledGrammarManifest();
  const warnings: string[] = [];
  for (const snapshotGrammar of snapshotGrammars) {
    const local = localGrammars.find(
      (candidate) =>
        candidate.package === snapshotGrammar.package &&
        candidate.grammar === snapshotGrammar.grammar,
    );
    if (local === undefined) {
      warnings.push(
        `Grammar "${grammarLabel(snapshotGrammar)}" from the snapshot is not present in this machine's bundled grammars.`,
      );
      continue;
    }
    if (local.version !== snapshotGrammar.version) {
      warnings.push(
        `Grammar "${grammarLabel(snapshotGrammar)}" version mismatch: snapshot has ${snapshotGrammar.version}, this machine has ${local.version}.`,
      );
    }
  }
  return warnings;
}

// --- Reconstruction into full store rows ------------------------------------

// A snapshot symbol's qualifiedName is either a bare canonical relative path
// (file-kind symbols) or `${path}::a.b.c` (member path). Recovers a
// reasonable `name` for the full `CodeGraphSymbolRecord` from that alone.
// This is an APPROXIMATION for symbol kinds whose real `name` is not
// derivable from qualifiedName (e.g. `rationale` symbols, whose real name is
// the marker text like "NOTE" — see extract/rationale.ts) — acceptable
// because, like every other field this reconstruction cannot recover
// (parentSymbolId, line/byte ranges, exported, extra), it is corrected by
// the next real `buildOrUpdate()` for any file whose content changes.
function nameFromQualifiedName(
  qualifiedName: string,
  filePath: string,
): string {
  const separatorIndex = qualifiedName.indexOf('::');
  if (separatorIndex === -1) {
    const segments = filePath.split('/');
    return segments[segments.length - 1] ?? filePath;
  }
  const memberPath = qualifiedName.slice(separatorIndex + 2);
  const segments = memberPath.split('.');
  return segments[segments.length - 1] ?? memberPath;
}

function toFileRecord(input: {
  file: CodeGraphSnapshotFile;
  repoId: string;
  rootPath: string;
}): CodeGraphFileRecord {
  return {
    id: fileRowId(input.repoId, input.file.relativePath),
    repositoryId: input.repoId,
    relativePath: input.file.relativePath,
    // The ONE field the brief calls out by name for reconstruction: a
    // snapshot never carries absolute paths, so this rebuilds it from the
    // IMPORT TARGET's actual rootPath, not anything recorded in the snapshot.
    absolutePath: path.join(input.rootPath, input.file.relativePath),
    language: input.file.language,
    contentHash: input.file.contentHash,
    sizeBytes: input.file.sizeBytes,
    mtimeNs: input.file.mtimeNs,
    lineCount: input.file.lineCount,
    grammarId: input.file.grammarId,
    grammarAbi: input.file.grammarAbi,
    parseStatus: input.file.parseStatus,
    hasErrors: input.file.hasErrors,
    updatedAt: Date.now(),
  };
}

function toSymbolRecord(input: {
  symbol: CodeGraphSnapshotSymbol;
  repoId: string;
}): CodeGraphSymbolRecord {
  return {
    id: symbolRowId(input.repoId, input.symbol.qualifiedName),
    repositoryId: input.repoId,
    fileId: fileRowId(input.repoId, input.symbol.filePath),
    kind: input.symbol.kind,
    name: nameFromQualifiedName(
      input.symbol.qualifiedName,
      input.symbol.filePath,
    ),
    qualifiedName: input.symbol.qualifiedName,
    // Everything below is unrecoverable from the snapshot's narrow symbol
    // projection (see CodeGraphSnapshotSymbol's doc comment) and is filled
    // with placeholders here — corrected by the next real `buildOrUpdate()`
    // for any file whose content actually changed; a content-identical file
    // keeps these placeholders until something else forces a reparse.
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: 1,
    byteStart: 0,
    byteEnd: 0,
    signature: input.symbol.signature,
    exported: false,
    isTest: isTestFilePath(input.symbol.filePath),
    extra: {},
  };
}

// Ids for imported edges do not need to reproduce whatever formula the
// ORIGINAL extractor used for that edge kind (CONTAINS/CALLS/IMPORTS_FROM/etc.
// each hash slightly different (sourceId, target) conventions — see
// extract/*.ts). This uses one consistent generic formula (resolved symbol
// id when known, else the raw file/ref text) across every edge kind rather
// than replicating each extractor's own convention.
//
// What that IS safe against: re-imports. `replaceFileFacts` deletes every
// edge for a file before inserting, so importing the same snapshot twice is
// idempotent regardless of the exact formula.
//
// What it is NOT safe against: two DISTINCT original edges collapsing into
// one reconstructed id. The original per-kind formulas hash the RAW
// pre-resolution reference text, while this generic formula prefers the
// RESOLVED target symbol id — so e.g. two aliased imports of one function,
// called on the same line from the same enclosing symbol, are two distinct
// edges in the source graph (different raw text ⇒ different original ids)
// but hash identically here. `applyCodeGraphSnapshot` detects those
// collisions before insert, keeps the first, drops the rest, and reports
// them via `warnings` so `edgesImported` stays honest.
function toEdgeRecord(input: {
  edge: CodeGraphSnapshotEdge;
  repoId: string;
}): CodeGraphEdgeRecord {
  const sourceSymbolId =
    input.edge.sourceQualifiedName === null
      ? null
      : symbolRowId(input.repoId, input.edge.sourceQualifiedName);
  const targetSymbolId =
    input.edge.targetQualifiedName === null
      ? null
      : symbolRowId(input.repoId, input.edge.targetQualifiedName);
  const sourceFileId = fileRowId(input.repoId, input.edge.sourceFilePath);
  const offset = input.edge.evidence.offset;
  const discriminator =
    (input.edge.kind === 'CALLS' || input.edge.kind === 'REFERENCES') &&
    typeof offset === 'number' &&
    Number.isSafeInteger(offset) &&
    offset >= 0
      ? `${input.edge.targetRef ?? targetSymbolId ?? ''}@${offset}`
      : (targetSymbolId ?? input.edge.targetRef ?? '');
  return {
    id: edgeRowId({
      repoId: input.repoId,
      kind: input.edge.kind,
      sourceId: sourceSymbolId ?? sourceFileId,
      target: discriminator,
      line: input.edge.line,
    }),
    repositoryId: input.repoId,
    kind: input.edge.kind,
    sourceSymbolId,
    targetSymbolId,
    sourceFileId,
    targetRef: input.edge.targetRef,
    line: input.edge.line,
    confidenceTier: input.edge.confidenceTier,
    confidenceScore: input.edge.confidenceScore,
    resolverId: input.edge.resolverId,
    evidence: input.edge.evidence,
  };
}

function groupByFilePath<T>(
  items: readonly T[],
  filePathOf: (item: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = filePathOf(item);
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }
  return grouped;
}

export interface CodeGraphSnapshotImportResult {
  warnings: string[];
  filesImported: number;
  symbolsImported: number;
  edgesImported: number;
}

/** Cap on individual dropped-edge collision warnings appended to
 * `CodeGraphSnapshotImportResult.warnings`; drops beyond the cap are rolled
 * into a single trailing "+N more" summary line so a pathological snapshot
 * cannot flood the caller with thousands of near-identical strings. */
export const SNAPSHOT_IMPORT_MAX_COLLISION_WARNINGS = 20;

/**
 * Writes an already-validated snapshot envelope into the operational
 * database for `repoId`, delete-and-replace per file (via
 * `store.replaceFileFacts`, reusing the exact same store primitive real
 * builds use), reconstructing `absolutePath` from `rootPath` and re-hashing
 * every id against `repoId` (never trusting anything id-shaped from the
 * snapshot itself — see snapshot/export.ts's translation comment). Also
 * clears `repoId`'s derived-analysis tables (communities/flows/their
 * memberships) via `store.replaceDerivedForRepo(repoId, [], [], [], [])`:
 * symbol ids are pure (repoId, qualifiedName) hashes, so a pre-import
 * community/flow membership row would otherwise keep joining fine against
 * post-import symbols and silently describe the WRONG (pre-import)
 * partition — communities/flows query modes, ExplainCodeSymbol enrichment,
 * and the risk formula's flow/community terms would read stale data with no
 * `CODE_GRAPH_DERIVED_NONE_NOTE` to flag it. Clearing makes those surfaces
 * honestly empty until the next real `buildOrUpdate()` recomputes derived
 * analysis for this repo, matching the documented "an imported graph has no
 * derived data until the next real build" contract for every import, not
 * just a first-ever one. Sets `imported_from_snapshot` graph metadata and
 * the repository's `git_head` to the snapshot's recorded origin commit, then
 * rebuilds the symbol FTS index.
 *
 * Honest counts: `edgesImported` is the number of edges actually inserted
 * after collision-dropping (see `toEdgeRecord`'s comment for how two
 * distinct original edges can reconstruct to one id; each drop is reported
 * in `warnings`, capped by {@link SNAPSHOT_IMPORT_MAX_COLLISION_WARNINGS}).
 * `filesImported`/`symbolsImported` remain the envelope array lengths, which
 * IS the inserted count for those: their reconstructed ids are pure hashes
 * of relativePath/qualifiedName, and `parseCodeGraphSnapshotEnvelope`
 * rejects duplicates of those keys outright, so files/symbols cannot
 * collide by construction.
 */
export async function applyCodeGraphSnapshot(input: {
  store: CodeGraphStore;
  db: CodeGraphDatabase;
  repoId: string;
  rootPath: string;
  envelope: CodeGraphSnapshotEnvelope;
}): Promise<CodeGraphSnapshotImportResult> {
  const warnings = await checkSnapshotGrammarCompatibility(
    input.envelope.grammars,
  );

  const symbolsByFile = groupByFilePath(
    input.envelope.symbols,
    (symbol) => symbol.filePath,
  );
  const edgesByFile = groupByFilePath(
    input.envelope.edges,
    (edge) => edge.sourceFilePath,
  );

  return withImmediateTransaction(input.db, () => {
    input.store.upsertRepository({
      repoId: input.repoId,
      rootPath: input.rootPath,
      gitHead: input.envelope.repository.gitHead,
    });

    // One Set across ALL file groups, not per group: the edges table's
    // INSERT OR REPLACE conflicts globally on id, so a cross-file-group
    // collision (only possible in a hand-crafted snapshot, but cheap to cover)
    // would silently clobber just like a within-file one.
    const seenEdgeIds = new Set<string>();
    let edgesInserted = 0;
    let edgesDropped = 0;
    const collisionWarnings: string[] = [];

    for (const file of input.envelope.files) {
      const symbols = (symbolsByFile.get(file.relativePath) ?? []).map(
        (symbol) => toSymbolRecord({ symbol, repoId: input.repoId }),
      );
      const edges: CodeGraphEdgeRecord[] = [];
      for (const snapshotEdge of edgesByFile.get(file.relativePath) ?? []) {
        const record = toEdgeRecord({
          edge: snapshotEdge,
          repoId: input.repoId,
        });
        if (seenEdgeIds.has(record.id)) {
          edgesDropped += 1;
          if (
            collisionWarnings.length < SNAPSHOT_IMPORT_MAX_COLLISION_WARNINGS
          ) {
            collisionWarnings.push(
              `Dropped duplicate reconstructed edge in "${file.relativePath}": ` +
                `${snapshotEdge.kind}` +
                `${snapshotEdge.line === null ? '' : ` at line ${snapshotEdge.line}`}` +
                `${snapshotEdge.targetRef === null ? '' : ` (targetRef "${snapshotEdge.targetRef}")`}` +
                ' collides with an already-imported edge.',
            );
          }
          continue;
        }
        seenEdgeIds.add(record.id);
        edges.push(record);
      }
      edgesInserted += edges.length;
      input.store.replaceFileFacts({
        file: toFileRecord({
          file,
          repoId: input.repoId,
          rootPath: input.rootPath,
        }),
        symbols,
        edges,
      });
    }

    warnings.push(...collisionWarnings);
    if (edgesDropped > collisionWarnings.length) {
      warnings.push(
        `+${edgesDropped - collisionWarnings.length} more duplicate reconstructed edge(s) dropped.`,
      );
    }

    // Clear this repo's derived-analysis tables (see this function's doc
    // comment above) -- an import replaces files/symbols/edges but derived
    // community/flow data is never part of the snapshot contract, so any rows
    // already in the store for `repoId` would otherwise silently describe a
    // partition of the PRE-import graph.
    input.store.replaceDerivedForRepo(input.repoId, [], [], [], []);
    new SqliteResolutionDependencyWriter(input.db).clearRepository(
      input.repoId,
    );
    deleteMetadataValue(input.db, 'last_build_at');
    deleteMetadataValue(input.db, 'completed_build_at');
    deleteMetadataValue(input.db, 'derived_at');
    deleteMetadataValue(input.db, 'graph_diagnostics');
    deleteMetadataValue(input.db, CODE_GRAPH_DERIVED_PENDING_KEY);
    clearCodeGraphSummaryProjection(input.db);

    setMetadataValue(
      input.db,
      'imported_from_snapshot',
      new Date().toISOString(),
    );
    rebuildSymbolFts(input.db);

    return {
      warnings,
      filesImported: input.envelope.files.length,
      symbolsImported: input.envelope.symbols.length,
      edgesImported: edgesInserted,
    };
  });
}

/**
 * Reads `inPath`, validates it (`parseCodeGraphSnapshotEnvelope`), and
 * applies it (`applyCodeGraphSnapshot`) — the single entrypoint the CLI's
 * `code-graph snapshot import` command uses.
 */
export async function importCodeGraphSnapshotFromFile(input: {
  store: CodeGraphStore;
  db: CodeGraphDatabase;
  repoId: string;
  rootPath: string;
  inPath: string;
}): Promise<CodeGraphSnapshotImportResult> {
  const raw = await fs.readFile(input.inPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const envelope = parseCodeGraphSnapshotEnvelope(parsed);
  return applyCodeGraphSnapshot({
    store: input.store,
    db: input.db,
    repoId: input.repoId,
    rootPath: input.rootPath,
    envelope,
  });
}
