import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getDefaultCodeGraphResourcesDir } from '../resources';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
  CODE_GRAPH_SYMBOL_KINDS,
} from '../types/code-graph';
import {
  CODE_GRAPH_GRAMMARS,
  CODE_GRAPH_MARKDOWN_GRAMMARS,
} from '../grammars/registry';
import { isSafeGitRef } from '../git/diff';
import {
  openCodeGraphDatabase,
  requireRow,
  requireString,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from '../store/database';
import type { BeforeGraphResult } from './before-graph';

const execFileAsync = promisify(execFile);
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const BEFORE_CACHE_MAX_ENTRIES = 8;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const payloadSchema = z.object({
  version: z.literal(1),
  filesBuilt: z.number().int().nonnegative(),
  filesSkipped: z.literal(0),
  symbols: z.array(
    z.object({
      qualifiedName: z.string(),
      kind: z.enum(CODE_GRAPH_SYMBOL_KINDS),
      signature: z.string().nullable(),
      filePath: z.string(),
    }),
  ),
});

/** Commit covers all source/config bytes. Resource bytes cover local grammar overrides;
 * the version covers extraction semantics. Never key on a moving branch name. */
export async function beforeCacheIdentity(
  input: {
    rootPath: string;
    repoId: string;
    baseRef: string;
    resourcesDir?: string;
  },
  scopedPaths: readonly string[],
): Promise<{ key: string; commit: string } | null> {
  if (!isSafeGitRef(input.baseRef))
    throw new Error(`Unsafe git ref: ${input.baseRef}`);
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        input.rootPath,
        'rev-parse',
        '--verify',
        `${input.baseRef}^{commit}`,
      ],
      { timeout: 15000, maxBuffer: 4096 },
    );
    const commit = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return null;
    const dir = input.resourcesDir ?? getDefaultCodeGraphResourcesDir();
    const hash = createHash('sha256').update(
      JSON.stringify({
        version: 1,
        commit,
        root: await fs.realpath(input.rootPath),
        repoId: input.repoId,
        scopedPaths,
        schema: CODE_GRAPH_SCHEMA_VERSION,
        extractor: CODE_GRAPH_EXTRACTOR_VERSION,
        // Before graphs intentionally use built-in grammars, matching the uncached path.
        grammarConfig: CODE_GRAPH_GRAMMARS,
      }),
    );
    const assets = new Set([
      'manifest.json',
      'runtime/web-tree-sitter.wasm',
      ...Object.values(CODE_GRAPH_MARKDOWN_GRAMMARS),
      ...CODE_GRAPH_GRAMMARS.flatMap((grammar) => [
        grammar.wasmFile,
        ...grammar.tagsFiles,
      ]),
    ]);
    for (const asset of Array.from(assets).sort())
      hash.update(asset).update(await fs.readFile(path.join(dir, asset)));
    return { key: hash.digest('hex'), commit };
  } catch {
    return null;
  }
}

function withCache<T>(
  cachePath: string,
  fn: (db: CodeGraphDatabase) => T,
): T | null {
  let db: CodeGraphDatabase | undefined;
  try {
    db = openCodeGraphDatabase(cachePath);
    db.exec(
      'CREATE TABLE IF NOT EXISTS before_facts_v1 (key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    return fn(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function readBeforeCache(
  cachePath: string,
  key: string,
): BeforeGraphResult | null {
  return withCache(cachePath, (db) => {
    // Expiry applies on reads too. Bounded payload reads reject corrupt/foreign entries.
    db.prepare('DELETE FROM before_facts_v1 WHERE created_at < ?').run(
      Date.now() - MAX_AGE_MS,
    );
    const row = db
      .prepare(
        'SELECT payload FROM before_facts_v1 WHERE key = ? AND length(CAST(payload AS BLOB)) <= ?',
      )
      .get(key, MAX_ENTRY_BYTES);
    if (row === undefined) return null;
    const parsed = payloadSchema.safeParse(
      JSON.parse(requireString(requireRow(row), 'payload')),
    );
    if (!parsed.success) return null;
    return {
      filesBuilt: parsed.data.filesBuilt,
      filesSkipped: 0,
      symbols: new Map(
        parsed.data.symbols.map((symbol) => [symbol.qualifiedName, symbol]),
      ),
    };
  });
}

export function writeBeforeCache(
  cachePath: string,
  key: string,
  result: BeforeGraphResult,
): void {
  if (result.filesSkipped !== 0) return;
  const payload = JSON.stringify({
    version: 1,
    filesBuilt: result.filesBuilt,
    filesSkipped: 0,
    symbols: Array.from(result.symbols.values()),
  });
  if (Buffer.byteLength(payload) > MAX_ENTRY_BYTES) return;
  withCache(cachePath, (db) =>
    withImmediateTransaction(db, () => {
      db.prepare('INSERT OR REPLACE INTO before_facts_v1 VALUES (?, ?, ?)').run(
        key,
        payload,
        Date.now(),
      );
      db.prepare(
        'DELETE FROM before_facts_v1 WHERE created_at < ? OR key IN (SELECT key FROM before_facts_v1 ORDER BY created_at DESC, key LIMIT -1 OFFSET ?)',
      ).run(Date.now() - MAX_AGE_MS, BEFORE_CACHE_MAX_ENTRIES);
    }),
  );
}
