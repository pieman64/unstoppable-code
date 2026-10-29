import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getGitFetchFreshnessFilePath } from './paths';

const FILE_VERSION = 2;
const MAX_ENTRIES = 2_000;
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 120_000;

export interface GitFetchFreshnessIdentity {
  commonDir: string;
  originUrl: string;
  prune: boolean;
}

export interface GitFetchFreshnessEntry extends GitFetchFreshnessIdentity {
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  retryAfterAt?: string;
  consecutiveFailures: number;
}

interface PersistedGitFetchFreshnessEntry {
  commonDir: string;
  originHash: string;
  prune: boolean;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  retryAfterAt?: string;
  consecutiveFailures: number;
}

interface GitFetchFreshnessFile {
  version: 2;
  entries: Record<string, PersistedGitFetchFreshnessEntry>;
}

let loadedFile: GitFetchFreshnessFile | null = null;
let loadPromise: Promise<GitFetchFreshnessFile> | null = null;
let writeChain = Promise.resolve();

function readProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function entryKey(
  identity: Pick<GitFetchFreshnessIdentity, 'commonDir' | 'prune'>,
): string {
  return createHash('sha256')
    .update(identity.commonDir)
    .update('\0')
    .update(identity.prune ? 'prune' : 'no-prune')
    .digest('hex');
}

function hashOriginUrl(originUrl: string): string {
  return createHash('sha256').update(originUrl).digest('hex');
}

function parseEntry(value: unknown): PersistedGitFetchFreshnessEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const commonDir = readProperty(value, 'commonDir');
  const originHash = readProperty(value, 'originHash');
  const prune = readProperty(value, 'prune');
  const lastAttemptAt = readProperty(value, 'lastAttemptAt');
  const lastSuccessAt = readProperty(value, 'lastSuccessAt');
  const lastFailureAt = readProperty(value, 'lastFailureAt');
  const retryAfterAt = readProperty(value, 'retryAfterAt');
  const storedConsecutiveFailures = readProperty(value, 'consecutiveFailures');
  if (
    typeof commonDir !== 'string' ||
    typeof originHash !== 'string' ||
    typeof prune !== 'boolean' ||
    typeof lastAttemptAt !== 'string' ||
    !Number.isFinite(Date.parse(lastAttemptAt))
  ) {
    return null;
  }
  return {
    commonDir,
    originHash,
    prune,
    lastAttemptAt,
    ...(typeof lastSuccessAt === 'string' &&
    Number.isFinite(Date.parse(lastSuccessAt))
      ? { lastSuccessAt }
      : {}),
    ...(typeof lastFailureAt === 'string' &&
    Number.isFinite(Date.parse(lastFailureAt))
      ? { lastFailureAt }
      : {}),
    ...(typeof retryAfterAt === 'string' &&
    Number.isFinite(Date.parse(retryAfterAt))
      ? { retryAfterAt }
      : {}),
    consecutiveFailures:
      typeof storedConsecutiveFailures === 'number' &&
      Number.isSafeInteger(storedConsecutiveFailures) &&
      storedConsecutiveFailures >= 0
        ? storedConsecutiveFailures
        : 0,
  };
}

async function loadFile(): Promise<GitFetchFreshnessFile> {
  if (loadedFile) return loadedFile;
  if (loadPromise) return loadPromise;
  loadPromise = (async (): Promise<GitFetchFreshnessFile> => {
    const entries: Record<string, PersistedGitFetchFreshnessEntry> = {};
    let replaceLegacyFile = false;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(getGitFetchFreshnessFilePath(), 'utf8'),
      );
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        readProperty(parsed, 'version') === FILE_VERSION
      ) {
        const rawEntries = readProperty(parsed, 'entries');
        if (
          typeof rawEntries === 'object' &&
          rawEntries !== null &&
          !Array.isArray(rawEntries)
        ) {
          for (const [key, value] of Object.entries(rawEntries)) {
            const entry = parseEntry(value);
            if (entry) entries[key] = entry;
          }
        }
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        readProperty(parsed, 'version') === 1
      ) {
        replaceLegacyFile = true;
      }
    } catch {
      // Missing and corrupt advisory state are ordinary cold-cache misses.
    }
    loadedFile = { version: FILE_VERSION, entries };
    if (replaceLegacyFile) {
      await persistFile(loadedFile);
    }
    return loadedFile;
  })();
  return loadPromise;
}

function pruneEntries(
  entries: Record<string, PersistedGitFetchFreshnessEntry>,
): void {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .sort(
      (left, right) =>
        Date.parse(entries[left]?.lastAttemptAt ?? '') -
        Date.parse(entries[right]?.lastAttemptAt ?? ''),
    )
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((key) => delete entries[key]);
}

async function persistFile(file: GitFetchFreshnessFile): Promise<void> {
  const filePath = getGitFetchFreshnessFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  pruneEntries(file.entries);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readGitFetchFreshness(
  identity: GitFetchFreshnessIdentity,
): Promise<GitFetchFreshnessEntry | null> {
  await writeChain;
  const file = await loadFile();
  const entry = file.entries[entryKey(identity)];
  if (
    !entry ||
    entry.commonDir !== identity.commonDir ||
    entry.originHash !== hashOriginUrl(identity.originUrl) ||
    entry.prune !== identity.prune
  ) {
    return null;
  }
  return {
    commonDir: identity.commonDir,
    originUrl: identity.originUrl,
    prune: identity.prune,
    lastAttemptAt: entry.lastAttemptAt,
    ...(entry.lastSuccessAt ? { lastSuccessAt: entry.lastSuccessAt } : {}),
    ...(entry.lastFailureAt ? { lastFailureAt: entry.lastFailureAt } : {}),
    ...(entry.retryAfterAt ? { retryAfterAt: entry.retryAfterAt } : {}),
    consecutiveFailures: entry.consecutiveFailures,
  };
}

export async function invalidateGitFetchFreshness(
  identity: GitFetchFreshnessIdentity,
): Promise<void> {
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const file = await loadFile();
      const key = entryKey(identity);
      const stored = file.entries[key];
      if (
        !stored ||
        stored.commonDir !== identity.commonDir ||
        stored.originHash !== hashOriginUrl(identity.originUrl) ||
        stored.prune !== identity.prune
      ) {
        return;
      }
      delete file.entries[key];
      await persistFile(file);
    });
  await writeChain;
}

export async function recordGitFetchSuccess(args: {
  identity: GitFetchFreshnessIdentity;
  succeededAt: number;
}): Promise<void> {
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const file = await loadFile();
      file.entries[entryKey(args.identity)] = {
        commonDir: args.identity.commonDir,
        originHash: hashOriginUrl(args.identity.originUrl),
        prune: args.identity.prune,
        lastAttemptAt: new Date(args.succeededAt).toISOString(),
        lastSuccessAt: new Date(args.succeededAt).toISOString(),
        consecutiveFailures: 0,
      };
      await persistFile(file);
    });
  await writeChain;
}

export async function recordGitFetchFailure(args: {
  identity: GitFetchFreshnessIdentity;
  failedAt: number;
}): Promise<GitFetchFreshnessEntry> {
  let updated: PersistedGitFetchFreshnessEntry | undefined;
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const file = await loadFile();
      const key = entryKey(args.identity);
      const stored = file.entries[key];
      const storedMatchesIdentity =
        stored &&
        stored.commonDir === args.identity.commonDir &&
        stored.originHash === hashOriginUrl(args.identity.originUrl) &&
        stored.prune === args.identity.prune;
      const consecutiveFailures = storedMatchesIdentity
        ? stored.consecutiveFailures + 1
        : 1;
      const lastSuccessAt = storedMatchesIdentity
        ? stored.lastSuccessAt
        : undefined;
      const backoffMs = Math.min(
        FAILURE_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1),
        FAILURE_BACKOFF_MAX_MS,
      );
      updated = {
        commonDir: args.identity.commonDir,
        originHash: hashOriginUrl(args.identity.originUrl),
        prune: args.identity.prune,
        ...(lastSuccessAt ? { lastSuccessAt } : {}),
        lastAttemptAt: new Date(args.failedAt).toISOString(),
        lastFailureAt: new Date(args.failedAt).toISOString(),
        retryAfterAt: new Date(args.failedAt + backoffMs).toISOString(),
        consecutiveFailures,
      };
      file.entries[key] = updated;
      await persistFile(file);
    });
  await writeChain;
  const entry = updated ?? {
    commonDir: args.identity.commonDir,
    originHash: hashOriginUrl(args.identity.originUrl),
    prune: args.identity.prune,
    lastAttemptAt: new Date(args.failedAt).toISOString(),
    lastFailureAt: new Date(args.failedAt).toISOString(),
    retryAfterAt: new Date(
      args.failedAt + FAILURE_BACKOFF_BASE_MS,
    ).toISOString(),
    consecutiveFailures: 1,
  };
  return {
    commonDir: args.identity.commonDir,
    originUrl: args.identity.originUrl,
    prune: args.identity.prune,
    lastAttemptAt: entry.lastAttemptAt,
    ...(entry.lastSuccessAt ? { lastSuccessAt: entry.lastSuccessAt } : {}),
    lastFailureAt: entry.lastFailureAt,
    retryAfterAt: entry.retryAfterAt,
    consecutiveFailures: entry.consecutiveFailures,
  };
}
