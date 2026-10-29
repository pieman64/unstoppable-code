import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCodeReviewRegistryFilePath } from './paths';
import { isRecord } from './type-guards';

/**
 * The real project/worktree a code-review chat scope runs against. The
 * code-review sentinel scope uses `projectId = CODE_REVIEW_CHAT_PROJECT_ID` and
 * `worktreeId = <scopeKey>` (the `projectId--worktreeId` composite, because
 * worktree ids are only unique within a workspace). This ref maps that
 * composite scope key back to the REAL `(projectId, worktreeId)` whose checkout
 * the code-review session runs in. The registry maps `scopeKey -> ref`; the ref
 * stores both real ids so no callsite ever has to parse the composite.
 */
export interface CodeReviewTargetRef {
  projectId: string;
  worktreeId: string;
}

interface CodeReviewRegistryFile {
  version: 1;
  targets: Record<string, CodeReviewTargetRef>;
}

function isCodeReviewTargetRef(value: unknown): value is CodeReviewTargetRef {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string'
  );
}

function isCodeReviewRegistryFile(
  value: unknown,
): value is CodeReviewRegistryFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.targets)) {
    return false;
  }
  return Object.values(value.targets).every(isCodeReviewTargetRef);
}

function emptyRegistry(): CodeReviewRegistryFile {
  return { version: 1, targets: {} };
}

function parseRegistry(raw: string): CodeReviewRegistryFile {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isCodeReviewRegistryFile(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to empty registry on corrupt JSON.
  }
  return emptyRegistry();
}

/**
 * In-memory cache of the parsed registry keyed by the file's last-modified
 * time (ms). `resolveWorktreeCwd` is synchronous and may be called per turn, so
 * the synchronous read below avoids re-parsing the (tiny) registry file unless
 * it has actually changed on disk.
 */
let cachedRegistry: { mtimeMs: number; file: CodeReviewRegistryFile } | null =
  null;

async function readRegistry(): Promise<CodeReviewRegistryFile> {
  try {
    const raw = await readFile(getCodeReviewRegistryFilePath(), 'utf8');
    return parseRegistry(raw);
  } catch {
    return emptyRegistry();
  }
}

export async function registerCodeReviewTarget(
  scopeKey: string,
  ref: CodeReviewTargetRef,
): Promise<void> {
  const filePath = getCodeReviewRegistryFilePath();
  const current = await readRegistry();
  const next: CodeReviewRegistryFile = {
    version: 1,
    targets: { ...current.targets, [scopeKey]: ref },
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), 'utf8');
  cachedRegistry = null;
}

export async function getCodeReviewTarget(
  scopeKey: string,
): Promise<CodeReviewTargetRef | null> {
  const file = await readRegistry();
  return file.targets[scopeKey] ?? null;
}

/**
 * Synchronous registry read for `resolveWorktreeCwd`, which is synchronous.
 * Reads the tiny registry file via `readFileSync` and caches the parsed result
 * keyed by the file's mtime so repeated cwd resolutions avoid re-reading and
 * re-parsing unless the registry changed.
 */
export function getCodeReviewTargetSync(
  scopeKey: string,
): CodeReviewTargetRef | null {
  const filePath = getCodeReviewRegistryFilePath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    cachedRegistry = null;
    return null;
  }

  if (!cachedRegistry || cachedRegistry.mtimeMs !== mtimeMs) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      cachedRegistry = { mtimeMs, file: parseRegistry(raw) };
    } catch {
      cachedRegistry = null;
      return null;
    }
  }

  return cachedRegistry.file.targets[scopeKey] ?? null;
}

/** Ownership is stored explicitly; never parse a composite legacy scope key. */
export async function listCodeReviewTargets(): Promise<
  Record<string, CodeReviewTargetRef>
> {
  return (await readRegistry()).targets;
}

let removalQueue: Promise<void> = Promise.resolve();
export function removeCodeReviewTarget(scopeKey: string): Promise<void> {
  const operation = removalQueue.then(async () => {
    const current = await readRegistry();
    if (!(scopeKey in current.targets)) return;
    delete current.targets[scopeKey];
    const filePath = getCodeReviewRegistryFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(current, null, 2), 'utf8');
    cachedRegistry = null;
  });
  removalQueue = operation.catch(() => undefined);
  return operation;
}
