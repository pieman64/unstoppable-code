import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCoworkMigrationMapFilePath } from './paths';
import { isErrnoException, isRecord } from './type-guards';

export interface CoworkMigrationMapFile {
  version: 1;
  idMap: Record<string, string>;
}

/**
 * In-memory cache of the persisted id-map so
 * {@link getCoworkWorkspaceIdForLegacyChatProject} can offer a synchronous
 * lookup (mirrors the `workspace-registry.ts` pattern: an async writer
 * populates a module-level cache that a sync accessor reads). The cache is
 * primed by {@link loadCoworkMigrationMapCache} and kept current by
 * {@link writeCoworkMigrationMap}.
 */
let cachedIdMap: Record<string, string> = {};

function normalizeIdMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const idMap: Record<string, string> = {};
  for (const [legacyId, workspaceId] of Object.entries(value)) {
    if (typeof workspaceId === 'string') {
      idMap[legacyId] = workspaceId;
    }
  }
  return idMap;
}

export async function readCoworkMigrationMap(): Promise<CoworkMigrationMapFile> {
  try {
    const raw = await readFile(getCoworkMigrationMapFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) {
      return { version: 1, idMap: {} };
    }
    return { version: 1, idMap: normalizeIdMap(parsed.idMap) };
  } catch (error) {
    if (
      (isErrnoException(error) && error.code === 'ENOENT') ||
      error instanceof SyntaxError
    ) {
      return { version: 1, idMap: {} };
    }
    throw error;
  }
}

export async function writeCoworkMigrationMap(
  idMap: Record<string, string>,
): Promise<void> {
  const filePath = getCoworkMigrationMapFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const normalized = normalizeIdMap(idMap);
  await writeFile(
    filePath,
    `${JSON.stringify({ version: 1, idMap: normalized }, null, 2)}\n`,
    'utf8',
  );
  cachedIdMap = normalized;
}

/**
 * Loads the persisted id-map from disk into the in-memory cache. Safe to call
 * on every startup regardless of whether the migration itself has already
 * run, so translation lookups keep working across app restarts.
 */
export async function loadCoworkMigrationMapCache(): Promise<void> {
  const { idMap } = await readCoworkMigrationMap();
  cachedIdMap = idMap;
}

/**
 * Synchronous lookup of the cowork workspace id that a legacy standalone-chat
 * project id was migrated to. Returns `null` when the cache has not been
 * primed yet or the legacy id has no recorded mapping (e.g. it was never a
 * real chat project). Intended to back a future read-time translation shim
 * for persisted `linkTarget`s and other old-id references.
 */
export function getCoworkWorkspaceIdForLegacyChatProject(
  legacyId: string,
): string | null {
  return cachedIdMap[legacyId] ?? null;
}

/**
 * Resolves a legacy standalone-chat project id (or an already-current cowork
 * workspace id) to the cowork workspace id that main-process persistence
 * helpers should address. Falls back to the input id unchanged when there is
 * no recorded legacy mapping, so this is correct both before Plan 5 (renderer
 * still sends legacy chat-project ids) and after Plan 5 (renderer sends real
 * workspace ids directly, making the lookup a no-op).
 */
export function resolveCoworkWorkspaceId(legacyOrWorkspaceId: string): string {
  return (
    getCoworkWorkspaceIdForLegacyChatProject(legacyOrWorkspaceId) ??
    legacyOrWorkspaceId
  );
}

/** @internal - exposed for testing only */
export const coworkMigrationMapTestExports: {
  resetCache: () => void;
} = {
  resetCache: (): void => {
    cachedIdMap = {};
  },
};
