import {
  beforeCacheIdentity,
  readBeforeCache,
  writeBeforeCache,
} from './before-cache';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import { CodeGraphParserRuntime } from '../parser/runtime';
import { canonicalRelativePath } from '../ids';
import { grammarForPath } from '../grammars/registry';
import { nonCodeExtractorForPath } from '../extract/extractor-registry';
import { readFileAtRef, type ChangedFileRanges } from '../git/diff';
import type { CodeGraphSymbolSummary } from '../store/graph-store';

// A larger scope means more `git show` invocations, more temp-file writes,
// and a bigger throwaway parse pass just to answer "what did this look like
// before?" — bounded the same way the rest of the impact pipeline bounds
// per-call work (see e.g. `getImpactRadius`'s maxNodes clamp).
export const BEFORE_GRAPH_MAX_SCOPED_FILES = 500;

// Process-unique on purpose: this repo's test suite now has more than one
// caller of `buildBeforeGraphForChanges` (before-graph.test.ts directly, and
// change-impact.test.ts's `assembleChangeImpact` end-to-end test), each
// potentially running concurrently in a DIFFERENT jest worker PROCESS. Jest's
// no-leftover-temp-workspace assertions work by diffing `os.tmpdir()`'s
// listing for this prefix before/after a call — embedding `process.pid`
// means a worker's own listing can only ever match temp dirs THAT SAME
// process created, so one worker's in-flight (not-yet-cleaned-up) temp
// workspace can never be mistaken for another worker's leftover.
export const BEFORE_GRAPH_TEMP_PREFIX = `code-graph-before-${process.pid}-`;

// One process-wide parser runtime shared by every DEFAULT-resourcesDir
// before-graph build. web-tree-sitter's `Language` instances (loaded grammar
// wasm) have NO `.delete()` — only `Tree`/`Query`/`Parser` do — so creating a
// fresh runtime per build (each engine loading its own grammar wasm) would
// leak a full copy of every touched grammar into the process-global heap on
// every CompareChangeImpact / GetReviewContext call. Loading grammars ONCE
// here and injecting this runtime into the throwaway engine (which does not
// dispose an injected runtime) holds grammar wasm at a single resident copy.
// Memoized as a promise so concurrent builds share one in-flight init.
let sharedBeforeGraphRuntimePromise: Promise<CodeGraphParserRuntime> | null =
  null;

function sharedBeforeGraphRuntime(): Promise<CodeGraphParserRuntime> {
  if (sharedBeforeGraphRuntimePromise === null) {
    sharedBeforeGraphRuntimePromise = CodeGraphParserRuntime.create().catch(
      (error: unknown) => {
        // A rejected init must not be memoized forever, or every later build
        // would replay the same failure — clear so the next call retries
        // (mirrors parser/runtime.ts's own init-retry contract).
        sharedBeforeGraphRuntimePromise = null;
        throw error instanceof Error ? error : new Error(String(error));
      },
    );
  }
  return sharedBeforeGraphRuntimePromise;
}

// Test seam (before-graph.test.ts): reads the memoized shared runtime (null
// until the first default-resourcesDir build creates it) so a test can assert
// that two sequential builds reuse ONE runtime instance. Intentionally narrow
// — the production contract exposes no runtime handle.
export async function getBeforeGraphRuntimeForTests(): Promise<CodeGraphParserRuntime | null> {
  return sharedBeforeGraphRuntimePromise;
}

// Test seam: drops the memo so a following build re-creates the shared runtime,
// making a "create is called exactly once across two builds" assertion
// deterministic regardless of earlier tests having already warmed the memo.
export function resetBeforeGraphRuntimeForTests(): void {
  sharedBeforeGraphRuntimePromise = null;
}

export interface BeforeGraphResult {
  symbols: Map<string, CodeGraphSymbolSummary>;
  filesBuilt: number;
  filesSkipped: number;
}

function isGraphEligible(relativePath: string): boolean {
  return (
    grammarForPath(relativePath) !== undefined ||
    nonCodeExtractorForPath(relativePath) !== undefined
  );
}

// Scope = the diff's `modified`/`deleted` files plus a `renamed` entry's
// OLD path (`previousPath`). A rename's NEW path is not this module's
// concern at all — it exists in the CURRENT graph and is handled by the
// current-graph mapping (`impact/changed-symbols.ts` maps it whole-file as
// `added-file`); only the vanished old path needs a base-ref lookup here.
// `added` files are excluded: by definition there is no base-ref content
// for them. Deduped (a path can appear via more than one change entry) and
// filtered to graph-eligible paths only, mirroring the scanner's own
// eligibility filter (`grammarForPath`/`nonCodeExtractorForPath`) so the
// temp workspace never wastes a `git show` on a path the engine would
// ignore anyway.
function computeScopedPaths(changes: readonly ChangedFileRanges[]): string[] {
  const scoped = new Set<string>();
  for (const change of changes) {
    if (change.status === 'modified' || change.status === 'deleted') {
      scoped.add(canonicalRelativePath(change.relativePath));
    } else if (
      change.status === 'renamed' &&
      change.previousPath !== undefined
    ) {
      scoped.add(canonicalRelativePath(change.previousPath));
    }
  }
  return Array.from(scoped).filter(isGraphEligible).sort();
}

// Writes each scoped path's base-ref content under `<filesRoot>/<relativePath>`
// (creating parent directories as needed) so the temp workspace mirrors the
// original repo's directory layout closely enough for relative imports to
// resolve. A path with no content at `baseRef` (e.g. it never existed there —
// can only happen for a caller-supplied `changes` list that doesn't actually
// match `baseRef`) is counted as skipped rather than treated as an error: the
// before-graph is best-effort per file, not all-or-nothing.
async function materializeBeforeRefFiles(input: {
  rootPath: string;
  baseRef: string;
  scopedPaths: readonly string[];
  filesRoot: string;
}): Promise<{ filesBuilt: number; filesSkipped: number }> {
  let filesBuilt = 0;
  let filesSkipped = 0;
  for (const relativePath of input.scopedPaths) {
    // A `..` segment would escape filesRoot in the `path.join` below,
    // letting a hostile/corrupt diff entry write outside the temp
    // workspace. `git show` happens to fail for out-of-tree paths anyway
    // (readFileAtRef → null), but the containment guarantee should not
    // depend on git's behavior — reject explicitly and count as skipped.
    if (relativePath.split('/').includes('..')) {
      filesSkipped += 1;
      continue;
    }
    const content = await readFileAtRef(
      input.rootPath,
      input.baseRef,
      relativePath,
    );
    if (content === null) {
      filesSkipped += 1;
      continue;
    }
    const destination = path.join(input.filesRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, 'utf8');
    filesBuilt += 1;
  }
  return { filesBuilt, filesSkipped };
}

// Builds a throwaway code graph scoped to only the files a diff touched, as
// they existed at `baseRef` — used to recover "what did this symbol look
// like before?" for deleted files and changed signatures, which the CURRENT
// (post-build) graph can no longer answer. The whole thing lives under one
// `mkdtemp` root that is always removed in `finally`, whether the build
// succeeds or throws.
//
// IMPORTANT: this reuses the ordinary `CodeGraphEngine` — there is no
// parallel extraction path. The temp workspace has no `.git` directory, so
// `CodeGraphEngine.open`'s best-effort `git rev-parse` (for `gitHead`) fails
// silently to `null`, and the scanner's enumeration falls back from
// `git ls-files` to a plain fs walk (already supported — see
// `scan/scanner.ts`). Cross-file resolution (imports/calls) only ever binds
// within this scoped file set, so signatures/kinds are reliable but
// cross-file edges are not — acceptable because the before-graph exists to
// answer "what was the OLD signature/shape", not to reproduce full
// cross-file fidelity for a graph that, by construction, only contains a
// small changed slice of the repo.
//
// Default builds share ONE process-wide parser runtime (see
// `sharedBeforeGraphRuntime` above) so grammar wasm is loaded once rather than
// leaked per call. Do not pass a custom `resourcesDir` unless the caller
// actually needs a non-default grammar resources location: it bypasses that
// shared runtime (creating + disposing a per-call one), and
// `CodeGraphParserRuntime`'s underlying WASM init is a process-wide singleton
// that throws if reinitialized with a different `resourcesDir` than an
// already-open engine.
export async function buildBeforeGraphForChanges(input: {
  rootPath: string;
  repoId: string;
  baseRef: string;
  changes: readonly ChangedFileRanges[];
  resourcesDir?: string;
  cachePath?: string;
}): Promise<BeforeGraphResult> {
  const scopedPaths = computeScopedPaths(input.changes);
  if (scopedPaths.length > BEFORE_GRAPH_MAX_SCOPED_FILES) {
    throw new Error(
      `before-graph scope of ${scopedPaths.length} files exceeds the ` +
        `${BEFORE_GRAPH_MAX_SCOPED_FILES}-file limit`,
    );
  }
  if (scopedPaths.length === 0) {
    // Nothing to recover (e.g. an add-only diff, or no graph-eligible
    // paths): return before ANY side effect — no mkdtemp, no git
    // invocation, no engine/db.
    return { symbols: new Map(), filesBuilt: 0, filesSkipped: 0 };
  }

  const identity =
    input.cachePath === undefined
      ? null
      : await beforeCacheIdentity(input, scopedPaths);
  if (identity !== null && input.cachePath !== undefined) {
    const cached = readBeforeCache(input.cachePath, identity.key);
    if (cached !== null) return cached;
  }

  let tmpRoot: string | null = null;
  let engine: CodeGraphEngine | null = null;
  try {
    tmpRoot = await fs.mkdtemp(path.join(tmpdir(), BEFORE_GRAPH_TEMP_PREFIX));
    const filesRoot = path.join(tmpRoot, 'files');
    // materializeBeforeRefFiles only mkdirs parent dirs for files it
    // actually writes, so without this an all-skipped scope would hand the
    // engine a nonexistent rootPath and the scanner's fs-walk would throw
    // ENOENT. The filesBuilt === 0 short-circuit below already avoids
    // opening the engine in that case — this unconditional mkdir is
    // defense-in-depth so no residual path ever builds on a missing root.
    await fs.mkdir(filesRoot, { recursive: true });
    const { filesBuilt, filesSkipped } = await materializeBeforeRefFiles({
      rootPath: input.rootPath,
      baseRef: identity?.commit ?? input.baseRef,
      scopedPaths,
      filesRoot,
    });
    if (filesBuilt === 0) {
      // Every scoped path skipped (no base-ref content / rejected): there
      // is nothing for the engine to parse, so skip the open+build
      // entirely. The finally block still removes the temp workspace.
      return { symbols: new Map(), filesBuilt: 0, filesSkipped };
    }

    const openOptions: Parameters<typeof CodeGraphEngine.open>[0] = {
      dbPath: path.join(tmpRoot, 'before.db'),
      repositories: [{ repoId: input.repoId, rootPath: filesRoot }],
    };
    if (input.resourcesDir !== undefined) {
      // Custom (non-default) grammar resources: bypass the shared-runtime memo
      // (keyed to the single default resourcesDir) and let the engine create
      // — and, since no runtime is injected, DISPOSE — its own per-call runtime.
      openOptions.resourcesDir = input.resourcesDir;
    } else {
      // Default resourcesDir: inject the process-wide shared runtime so grammar
      // wasm is loaded once for the process rather than leaking a fresh
      // (undeletable) `Language` copy per build. The engine will not dispose an
      // injected runtime — ownership stays with this module.
      openOptions.parserRuntime = await sharedBeforeGraphRuntime();
    }
    engine = await CodeGraphEngine.open(openOptions);
    // Ephemeral graph, thrown away in this same call's `finally` below: it
    // exists only to answer "what did this look like before", never to
    // maintain a persistent community/flow partition. Paying Louvain +
    // flow-tracing cost on every impact-radius/review-context call would be
    // wasted work for derived data nothing ever reads back out of this
    // temp db.
    await engine.buildOrUpdate({ computeDerived: false });

    const symbols = new Map<string, CodeGraphSymbolSummary>();
    for (const symbol of engine.listSymbols(input.repoId)) {
      symbols.set(symbol.qualifiedName, symbol);
    }
    const result = { symbols, filesBuilt, filesSkipped };
    if (
      identity !== null &&
      input.cachePath !== undefined &&
      engine.getStatus().filesWithErrors === 0
    ) {
      writeBeforeCache(input.cachePath, identity.key, result);
    }
    return result;
  } finally {
    if (engine !== null) {
      engine.close();
    }
    if (tmpRoot !== null) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  }
}
