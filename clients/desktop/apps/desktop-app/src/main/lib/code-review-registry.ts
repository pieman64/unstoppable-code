import { mkdir, readFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCodeReviewRegistryFilePath } from './paths';
import { isErrnoException, isRecord } from './type-guards';
import { writeFileAtomically } from './atomic-file';

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
  const parsed: unknown = JSON.parse(raw);
  if (isRecord(parsed) && parsed.version !== 1) {
    throw new Error('Code review registry has an unsupported version.');
  }
  if (!isCodeReviewRegistryFile(parsed)) {
    throw new Error('Code review registry contains invalid data.');
  }
  return parsed;
}

/**
 * Cache keyed by resolved path and last-modified time (ms).
 * `resolveWorktreeCwd` is synchronous and may be called per turn, so
 * the synchronous read below avoids re-parsing the (tiny) registry file unless
 * it has actually changed on disk.
 */
let cachedRegistry: {
  filePath: string;
  mtimeMs: number;
  file: CodeReviewRegistryFile;
} | null = null;

async function readRegistry(filePath: string): Promise<CodeReviewRegistryFile> {
  try {
    return parseRegistry(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return emptyRegistry();
    }
    throw error;
  }
}

let mutationQueue: Promise<void> = Promise.resolve();

function mutateRegistry(
  update: (current: CodeReviewRegistryFile) => CodeReviewRegistryFile | null,
): Promise<void> {
  const filePath = getCodeReviewRegistryFilePath();
  const operation = mutationQueue.then(async () => {
    try {
      const next = update(await readRegistry(filePath));
      if (!next) return;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFileAtomically(filePath, JSON.stringify(next, null, 2), {
        encoding: 'utf8',
        durable: true,
      });
    } finally {
      // A failed post-install sync can leave the new file visible, not rolled back.
      cachedRegistry = null;
    }
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

export async function registerCodeReviewTarget(
  scopeKey: string,
  ref: CodeReviewTargetRef,
): Promise<void> {
  return mutateRegistry((current) => {
    // Define an own key even when downlevel compilation would invoke __proto__.
    Object.defineProperty(current.targets, scopeKey, {
      value: ref,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return current;
  });
}

function ownTarget(
  file: CodeReviewRegistryFile,
  scopeKey: string,
): CodeReviewTargetRef | null {
  return Object.prototype.hasOwnProperty.call(file.targets, scopeKey)
    ? file.targets[scopeKey]
    : null;
}

export async function getCodeReviewTarget(
  scopeKey: string,
): Promise<CodeReviewTargetRef | null> {
  try {
    return ownTarget(
      await readRegistry(getCodeReviewRegistryFilePath()),
      scopeKey,
    );
  } catch {
    // Lookup compatibility is permissive; mutation and cleanup reads are not.
    return null;
  }
}

/**
 * Synchronous registry read for `resolveWorktreeCwd`, which is synchronous.
 * Reads the tiny registry file via `readFileSync` and caches the parsed result
 * keyed by path and mtime so repeated cwd resolutions avoid re-reading and
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

  if (
    !cachedRegistry ||
    cachedRegistry.filePath !== filePath ||
    cachedRegistry.mtimeMs !== mtimeMs
  ) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      cachedRegistry = { filePath, mtimeMs, file: parseRegistry(raw) };
    } catch {
      cachedRegistry = null;
      return null;
    }
  }

  return ownTarget(cachedRegistry.file, scopeKey);
}

/** Unknown ownership must reject cleanup, not masquerade as an empty sweep. */
export async function listCodeReviewTargets(): Promise<
  Record<string, CodeReviewTargetRef>
> {
  return (await readRegistry(getCodeReviewRegistryFilePath())).targets;
}

export async function removeCodeReviewTarget(scopeKey: string): Promise<void> {
  return mutateRegistry((current) => {
    if (!Object.prototype.hasOwnProperty.call(current.targets, scopeKey)) {
      return null;
    }
    delete current.targets[scopeKey];
    return current;
  });
}
