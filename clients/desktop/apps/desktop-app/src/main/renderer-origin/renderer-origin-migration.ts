import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Moving the renderer's origin-keyed storage between `file://` and the
 * renderer scheme (`app-renderer://bundle`).
 *
 * Chromium keys `localStorage` by origin, so the same renderer code sees a
 * different, empty store after the origin changes. Before either window
 * loads on a new origin, main copies the last-used origin's storage onto
 * it through a trusted host adapter (see `origin-storage-bridge.ts`); page
 * script cannot read another origin.
 *
 * Rules, all per installation (the record sits beside Chromium's own
 * storage in Electron's `sessionData`):
 *
 * - The record names the origin whose storage is authoritative
 *   (`lastUsedOrigin`, `file` when absent). It changes only after a copy
 *   completed, read back identically and was flushed to disk.
 * - A copy replaces the target origin with the source snapshot, so values
 *   changed or deleted on the source carry over and a repeated or
 *   interrupted copy converges. The source is never modified.
 * - A merge (after a degraded launch, see {@link fallBackToFileOrigin})
 *   writes only the keys that differ and never clears the target, so a merge
 *   that stops partway leaves every other key as it was.
 * - While `file://` holds a degraded launch's writes, no launch loads the
 *   scheme until they are merged into it.
 * - An empty source never clears the target: it more likely means storage
 *   could not be read than that every key was deleted.
 * - A copy in flight is recorded first (`pendingMigration`); a launch never
 *   loads an origin whose copy did not complete.
 * - A copy is bounded ({@link DEFAULT_MIGRATION_TIMEOUT_MS} in all): past
 *   that the bridge is stopped and the copy counts as failed, so a stuck
 *   copy cannot hold the first window.
 * - `flushStorageData()` only requests the write; Electron offers no
 *   completion signal. See the phase 17 risk entry in the performance
 *   ledger for the crash window this leaves.
 */

export type RendererOrigin = 'file' | 'scheme';

export type RendererOriginMigrationOutcome =
  | 'copied'
  | 'empty-source'
  /** The scheme copy could not be read during a fallback; left in place. */
  | 'abandoned';

export interface RendererOriginMigrationEntry {
  from: RendererOrigin;
  to: RendererOrigin;
  completedAt: string;
  outcome: RendererOriginMigrationOutcome;
  keyCount: number;
}

export interface RendererOriginRecord {
  version: 1;
  lastUsedOrigin: RendererOrigin;
  pendingMigration?: {
    from: RendererOrigin;
    to: RendererOrigin;
    startedAt: string;
    /**
     * `file://`'s storage when a fallback continued on it after a failed
     * copy back. The retry lays every key that launch changed over the
     * scheme's copy instead of replacing what it wrote.
     */
    mergeBase?: Array<[string, string]>;
  };
  /** Oldest first, capped at {@link MAX_MIGRATION_HISTORY}. */
  migrations: RendererOriginMigrationEntry[];
  lastFallback?: { at: string; reason: string };
}

export interface RendererOriginRecordStore {
  read(): Promise<RendererOriginRecord | null>;
  write(record: RendererOriginRecord): Promise<void>;
}

export interface OriginStorageSnapshot {
  localStorage: Array<[string, string]>;
  /** Reported, never moved: the renderer keeps nothing in IndexedDB. */
  indexedDbNames: string[];
}

/** The keys to remove from an origin and the entries to set on it. */
export interface OriginStorageChanges {
  set: Array<[string, string]>;
  remove: string[];
}

export interface OriginStorageBridge {
  read(origin: RendererOrigin): Promise<OriginStorageSnapshot>;
  replace(
    origin: RendererOrigin,
    entries: ReadonlyArray<readonly [string, string]>,
  ): Promise<void>;
  /**
   * Removes and sets only the given keys; every other key stays. A write
   * that throws puts back what it already changed.
   */
  update(origin: RendererOrigin, changes: OriginStorageChanges): Promise<void>;
  /** Ask Chromium to write buffered DOM storage to disk (not awaited by it). */
  flush(): Promise<void>;
  /**
   * Stop for good: close any open bridge page and refuse further work, so
   * a copy that timed out cannot write afterwards.
   */
  abort(): void;
}

/** The record's file name inside Electron's `sessionData` directory. */
export const RENDERER_ORIGIN_RECORD_FILE = 'renderer-origin-state.json';

const MAX_MIGRATION_HISTORY = 20;

/** The most one copy (read, replace, read back) may take before it fails. */
const DEFAULT_MIGRATION_TIMEOUT_MS = 10_000;

function isOrigin(value: unknown): value is RendererOrigin {
  return value === 'file' || value === 'scheme';
}

function isStorageEntries(value: unknown): value is Array<[string, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string',
    )
  );
}

/**
 * `theirs` with every key `ours` changed since `base` laid over it: a key
 * `ours` set or changed takes its value, and a key `ours` deleted is
 * deleted.
 */
function mergeOverBase(
  theirs: ReadonlyArray<readonly [string, string]>,
  ours: ReadonlyArray<readonly [string, string]>,
  base: ReadonlyArray<readonly [string, string]>,
): Array<[string, string]> {
  const merged = new Map<string, string>(theirs);
  const ourValues = new Map<string, string>(ours);
  const baseValues = new Map<string, string>(base);
  const keys = new Set([
    ...Array.from(ourValues.keys()),
    ...Array.from(baseValues.keys()),
  ]);
  for (const key of Array.from(keys)) {
    const ourValue = ourValues.get(key);
    if (ourValue === baseValues.get(key)) continue;
    if (ourValue === undefined) merged.delete(key);
    else merged.set(key, ourValue);
  }
  return Array.from(merged);
}

/** The keys to set and remove that turn `current` into `next`. */
function storageChanges(
  current: ReadonlyArray<readonly [string, string]>,
  next: ReadonlyArray<readonly [string, string]>,
): OriginStorageChanges {
  const currentValues = new Map<string, string>(current);
  const nextValues = new Map<string, string>(next);
  return {
    set: Array.from(nextValues).filter(
      ([key, value]) => currentValues.get(key) !== value,
    ),
    remove: Array.from(currentValues.keys()).filter(
      (key) => !nextValues.has(key),
    ),
  };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEntry(value: unknown): RendererOriginMigrationEntry | null {
  if (!isRecordObject(value)) return null;
  const { from, to, completedAt, outcome, keyCount } = value;
  if (
    !isOrigin(from) ||
    !isOrigin(to) ||
    typeof completedAt !== 'string' ||
    (outcome !== 'copied' &&
      outcome !== 'empty-source' &&
      outcome !== 'abandoned') ||
    typeof keyCount !== 'number' ||
    !Number.isInteger(keyCount) ||
    keyCount < 0
  ) {
    return null;
  }
  return { from, to, completedAt, outcome, keyCount };
}

/** A valid version 1 record, or null for anything else. */
export function normalizeRendererOriginRecord(
  value: unknown,
): RendererOriginRecord | null {
  if (!isRecordObject(value) || value['version'] !== 1) return null;
  const lastUsedOrigin = value['lastUsedOrigin'];
  const migrations = value['migrations'];
  if (!isOrigin(lastUsedOrigin) || !Array.isArray(migrations)) return null;
  const record: RendererOriginRecord = {
    version: 1,
    lastUsedOrigin,
    migrations: migrations
      .map(normalizeEntry)
      .filter((entry): entry is RendererOriginMigrationEntry => entry !== null)
      .slice(-MAX_MIGRATION_HISTORY),
  };
  const pending = value['pendingMigration'];
  if (
    isRecordObject(pending) &&
    isOrigin(pending['from']) &&
    isOrigin(pending['to']) &&
    typeof pending['startedAt'] === 'string'
  ) {
    const mergeBase = pending['mergeBase'];
    record.pendingMigration = {
      from: pending['from'],
      to: pending['to'],
      startedAt: pending['startedAt'],
      ...(isStorageEntries(mergeBase) ? { mergeBase } : {}),
    };
  }
  const fallback = value['lastFallback'];
  if (
    isRecordObject(fallback) &&
    typeof fallback['at'] === 'string' &&
    typeof fallback['reason'] === 'string'
  ) {
    record.lastFallback = { at: fallback['at'], reason: fallback['reason'] };
  }
  return record;
}

/**
 * The record as a JSON file. Reads treat a missing, unreadable or foreign
 * file as absent; writes go through a temporary file and a rename so a
 * crash never leaves a half-written record.
 */
export function createFileRendererOriginRecordStore(
  filePath: string,
): RendererOriginRecordStore {
  return {
    async read(): Promise<RendererOriginRecord | null> {
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
        return normalizeRendererOriginRecord(parsed);
      } catch {
        return null;
      }
    },
    async write(record: RendererOriginRecord): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${String(process.pid)}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flush: true,
      });
      await rename(temporary, filePath);
    },
  };
}

function emptyRecord(): RendererOriginRecord {
  return { version: 1, lastUsedOrigin: 'file', migrations: [] };
}

/** The record without a copy in flight. */
function withoutPending(record: RendererOriginRecord): RendererOriginRecord {
  return {
    version: 1,
    lastUsedOrigin: record.lastUsedOrigin,
    migrations: record.migrations,
    ...(record.lastFallback ? { lastFallback: record.lastFallback } : {}),
  };
}

function withMigration(
  record: RendererOriginRecord,
  entry: RendererOriginMigrationEntry,
): RendererOriginRecord {
  return {
    ...withoutPending(record),
    lastUsedOrigin: entry.to,
    migrations: [...record.migrations, entry].slice(-MAX_MIGRATION_HISTORY),
  };
}

function sameEntries(
  left: ReadonlyArray<readonly [string, string]>,
  right: ReadonlyArray<readonly [string, string]>,
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(left);
  if (expected.size !== left.length) return false;
  return right.every(([key, value]) => expected.get(key) === value);
}

/**
 * `promise`, or a rejection once `timeoutMs` passes; `onTimeout` runs first
 * so the work underneath can be stopped.
 */
function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error('Copying renderer storage timed out.'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Writes `merged` over an origin whose storage is `current`, changing only
 * the keys that differ, and checks that it reads back. Returns how many keys
 * it changed.
 */
async function writeMerged(
  bridge: OriginStorageBridge,
  origin: RendererOrigin,
  current: ReadonlyArray<readonly [string, string]>,
  merged: Array<[string, string]>,
): Promise<number> {
  const changes = storageChanges(current, merged);
  const changed = changes.set.length + changes.remove.length;
  if (changed === 0) return 0;
  await bridge.update(origin, changes);
  const written = await bridge.read(origin);
  if (!sameEntries(merged, written.localStorage)) {
    throw new Error('Renderer storage did not read back after the merge.');
  }
  return changed;
}

/** The merge base of a copy back that left a degraded launch's writes on file://. */
function degradedFileWritesBase(
  record: RendererOriginRecord | null,
): Array<[string, string]> | undefined {
  const pending = record?.pendingMigration;
  return record?.lastUsedOrigin === 'scheme' &&
    pending?.from === 'scheme' &&
    pending.to === 'file'
    ? pending.mergeBase
    : undefined;
}

/**
 * The source origin's storage could not be read, so nothing is known about
 * it. Every other copy failure happens after the source was read, which
 * means the source is intact and still authoritative.
 */
export class OriginStorageSourceReadError extends Error {
  readonly sourceError: unknown;
  constructor(sourceError: unknown) {
    super("Could not read the source origin's renderer storage.");
    this.name = 'OriginStorageSourceReadError';
    this.sourceError = sourceError;
  }
}

export interface MigrateOriginStorageOptions {
  from: RendererOrigin;
  to: RendererOrigin;
  bridge: OriginStorageBridge;
  store: RendererOriginRecordStore;
  record: RendererOriginRecord | null;
  now: () => Date;
}

export interface MigrateOriginStorageResult {
  record: RendererOriginRecord;
  outcome: 'copied' | 'empty-source';
  keyCount: number;
  indexedDbNames: string[];
}

/**
 * Copies `from`'s storage onto `to` and records completion. Rejects, with
 * the record still naming `from` and the copy pending, on any failure.
 */
export async function migrateOriginStorage(
  options: MigrateOriginStorageOptions,
): Promise<MigrateOriginStorageResult> {
  const { from, to, bridge, store, now } = options;
  if (from === to) {
    throw new Error(`Cannot migrate renderer storage from ${from} to itself.`);
  }
  const base = options.record ?? emptyRecord();
  const previous = base.pendingMigration;
  const mergeBase =
    previous?.from === from && previous.to === to
      ? previous.mergeBase
      : undefined;
  const pending: RendererOriginRecord = {
    ...base,
    lastUsedOrigin: from,
    pendingMigration: {
      from,
      to,
      startedAt: now().toISOString(),
      ...(mergeBase ? { mergeBase } : {}),
    },
  };
  await store.write(pending);

  let source: OriginStorageSnapshot = { localStorage: [], indexedDbNames: [] };
  let sourceRead = false;
  const copy = async (): Promise<'copied' | 'empty-source'> => {
    try {
      source = await bridge.read(from);
    } catch (error) {
      throw new OriginStorageSourceReadError(error);
    }
    sourceRead = true;
    if (source.localStorage.length === 0) return 'empty-source';
    if (!mergeBase) {
      await bridge.replace(to, source.localStorage);
      const written = await bridge.read(to);
      if (!sameEntries(source.localStorage, written.localStorage)) {
        throw new Error('Renderer storage did not read back after the copy.');
      }
      return 'copied';
    }
    // A merging copy changes only the keys that differ, so one that stops
    // partway leaves the degraded launch's writes in place.
    const current = (await bridge.read(to)).localStorage;
    await writeMerged(
      bridge,
      to,
      current,
      mergeOverBase(source.localStorage, current, mergeBase),
    );
    return 'copied';
  };
  let outcome: 'copied' | 'empty-source';
  try {
    outcome = await withDeadline(copy(), DEFAULT_MIGRATION_TIMEOUT_MS, () => {
      bridge.abort();
    });
  } catch (error) {
    // A deadline that passed before the source was read is a failed read.
    if (!sourceRead && !(error instanceof OriginStorageSourceReadError)) {
      throw new OriginStorageSourceReadError(error);
    }
    throw error;
  }
  await bridge.flush();

  const completed = withMigration(pending, {
    from,
    to,
    completedAt: now().toISOString(),
    outcome,
    keyCount: source.localStorage.length,
  });
  await store.write(completed);
  return {
    record: completed,
    outcome,
    keyCount: source.localStorage.length,
    indexedDbNames: source.indexedDbNames,
  };
}

export interface PrepareRendererLaunchOriginOptions {
  schemeEnabled: boolean;
  /** The record read for this launch (null when absent). */
  record: RendererOriginRecord | null;
  store: RendererOriginRecordStore;
  createBridge: () => OriginStorageBridge;
  /** Serves the scheme; called before anything loads or copies over it. */
  registerHandler: () => void;
  now: () => Date;
}

export interface RendererLaunchOriginDecision {
  /** The origin both windows load from this launch. */
  origin: RendererOrigin;
  /** Whether the scheme handler was registered (the origin may need it). */
  needsHandler: boolean;
  /** The scheme cannot be used this launch: the setting should turn off. */
  disableSetting: boolean;
  /**
   * The copy back to `file://` failed, so this launch stays on the scheme:
   * the setting should turn back on to match, which also stops the next
   * launch retrying until the user turns it off again. Not when `file://`
   * holds a degraded launch's writes: then the launch runs on `file://`.
   */
  reenableSetting: boolean;
  record: RendererOriginRecord | null;
  migration?: MigrateOriginStorageResult & {
    from: RendererOrigin;
    to: RendererOrigin;
  };
  migrationError?: unknown;
}

/**
 * Decides the origin for this launch and moves storage onto it when it
 * changed since the last launch. With the setting off and no record (every
 * install that never opted in) it returns at once, doing nothing.
 */
export async function prepareRendererLaunchOrigin(
  options: PrepareRendererLaunchOriginOptions,
): Promise<RendererLaunchOriginDecision> {
  const { record, store, now } = options;
  const target: RendererOrigin = options.schemeEnabled ? 'scheme' : 'file';
  const lastUsed: RendererOrigin = record?.lastUsedOrigin ?? 'file';
  const settled = {
    needsHandler: false,
    disableSetting: false,
    reenableSetting: false,
  };

  if (target === 'file' && lastUsed === 'file') {
    // A copy into the scheme that never finished is no longer wanted;
    // file:// is still authoritative.
    return {
      ...settled,
      origin: 'file',
      record: await withoutStalePending(record, store),
    };
  }

  // The scheme is the target or still holds the authoritative storage.
  try {
    options.registerHandler();
  } catch (error) {
    if (lastUsed === 'file') {
      return {
        ...settled,
        origin: 'file',
        disableSetting: true,
        record: await withoutStalePending(record, store),
        migrationError: error,
      };
    }
    // The scheme holds the data but cannot be served, so it cannot even be
    // read. This launch must run on file://, so file:// becomes
    // authoritative now: the scheme's copy is left untouched and recorded
    // as abandoned, and no later launch copies it back over what the user
    // writes on file:// from here on.
    return {
      ...settled,
      origin: 'file',
      disableSetting: target === 'scheme',
      record: await abandonSchemeStorage(record, store, now, 'handler-error'),
      migrationError: error,
    };
  }

  if (lastUsed === target) {
    const mergeBase = degradedFileWritesBase(record);
    if (record && mergeBase) {
      // A degraded launch ran on file:// after a failed copy back, and the
      // setting is back on: carry what it wrote there into the scheme.
      try {
        return {
          ...settled,
          origin: 'scheme',
          needsHandler: true,
          record: await foldDegradedFileWrites({
            bridge: options.createBridge(),
            store,
            record,
            mergeBase,
            now,
          }),
        };
      } catch (error) {
        // The scheme must not load without those writes, so this launch runs
        // on file:// again with the copy and its base still pending, and the
        // setting turns off: the next launch completes the copy back.
        return {
          ...settled,
          origin: 'file',
          needsHandler: true,
          disableSetting: true,
          record,
          migrationError: error,
        };
      }
    }
    // A copy to the other origin that never finished is no longer wanted.
    return {
      ...settled,
      origin: target,
      needsHandler: true,
      record: await withoutStalePending(record, store),
    };
  }

  try {
    const migration = await migrateOriginStorage({
      from: lastUsed,
      to: target,
      bridge: options.createBridge(),
      store,
      record,
      now,
    });
    return {
      ...settled,
      origin: target,
      needsHandler: true,
      record: migration.record,
      migration: { ...migration, from: lastUsed, to: target },
    };
  } catch (error) {
    const latest = (await store.read().catch(() => null)) ?? record;
    if (degradedFileWritesBase(latest)) {
      // file:// holds a degraded launch's writes. Loading the scheme would
      // hide them, and the next merge would lay them over newer writes
      // there, so this launch runs on file:// again and the next one
      // retries. A scheme that cannot even be read is abandoned instead, as
      // a fallback does, so no launch keeps retrying it.
      return {
        ...settled,
        origin: 'file',
        needsHandler: true,
        disableSetting: true,
        record:
          error instanceof OriginStorageSourceReadError
            ? await abandonSchemeStorage(
                latest,
                store,
                now,
                'scheme-storage-unreadable',
              )
            : latest,
        migrationError: error,
      };
    }
    // Stay on the origin whose storage is still authoritative, and make the
    // setting say so: off after a failed copy into the scheme, back on after
    // a failed copy out of it. Either way the next launch does not retry
    // until the user changes the setting.
    return {
      ...settled,
      origin: lastUsed,
      needsHandler: true,
      disableSetting: target === 'scheme',
      reenableSetting: target === 'file',
      record: latest,
      migrationError: error,
    };
  }
}

/**
 * Lays every key `file://` changed since `mergeBase` over the scheme's
 * storage and clears the pending copy. A degraded launch that ran on
 * `file://` after a failed copy back wrote those keys. Only those keys are
 * written, so a fold that stops partway leaves the scheme's other keys.
 */
async function foldDegradedFileWrites(options: {
  bridge: OriginStorageBridge;
  store: RendererOriginRecordStore;
  record: RendererOriginRecord;
  mergeBase: ReadonlyArray<readonly [string, string]>;
  now: () => Date;
}): Promise<RendererOriginRecord> {
  const { bridge, store, record, mergeBase, now } = options;
  const fold = async (): Promise<number> => {
    const scheme = await bridge.read('scheme');
    const file = await bridge.read('file');
    return writeMerged(
      bridge,
      'scheme',
      scheme.localStorage,
      mergeOverBase(scheme.localStorage, file.localStorage, mergeBase),
    );
  };
  const keyCount = await withDeadline(
    fold(),
    DEFAULT_MIGRATION_TIMEOUT_MS,
    () => {
      bridge.abort();
    },
  );
  await bridge.flush();
  const next = withMigration(withoutPending(record), {
    from: 'file',
    to: 'scheme',
    completedAt: now().toISOString(),
    outcome: 'copied',
    keyCount,
  });
  await store.write(next);
  return next;
}

/** The record without a copy in flight, written back when it had one. */
async function withoutStalePending(
  record: RendererOriginRecord | null,
  store: RendererOriginRecordStore,
): Promise<RendererOriginRecord | null> {
  if (!record?.pendingMigration) return record;
  const cleared = withoutPending(record);
  await store.write(cleared).catch(() => undefined);
  return cleared;
}

/**
 * Makes `file://` authoritative without copying the scheme's storage, which
 * stays in place and is recorded as an abandoned copy.
 */
async function abandonSchemeStorage(
  record: RendererOriginRecord | null,
  store: RendererOriginRecordStore,
  now: () => Date,
  reason: string,
): Promise<RendererOriginRecord> {
  const next: RendererOriginRecord = {
    ...withMigration(record ?? emptyRecord(), {
      from: 'scheme',
      to: 'file',
      completedAt: now().toISOString(),
      outcome: 'abandoned',
      keyCount: 0,
    }),
    lastFallback: { at: now().toISOString(), reason },
  };
  await store.write(next).catch(() => undefined);
  return next;
}

export interface FallBackToFileOriginOptions {
  record: RendererOriginRecord | null;
  store: RendererOriginRecordStore;
  bridge: OriginStorageBridge;
  /**
   * A fresh bridge for reading `file://` after a failed copy back: the copy's
   * own bridge is stopped when its deadline passes.
   */
  createBridge?: () => OriginStorageBridge;
  reason: string;
  now: () => Date;
}

export interface FallBackToFileOriginResult {
  record: RendererOriginRecord;
  migrated: boolean;
  /**
   * The copy back failed after the scheme's storage was read: the scheme
   * stays authoritative and the next launch retries the copy before it
   * loads `file://`.
   */
  schemeRetained?: boolean;
  error?: unknown;
}

/**
 * The fail-safe after the scheme could not load: copy the scheme's storage
 * back to `file://` when the scheme was authoritative, so this launch can
 * continue there.
 *
 * - When the scheme cannot even be read, its storage is left in place and
 *   recorded as abandoned, and `file://` becomes authoritative.
 * - When the copy fails after the scheme was read, the scheme's storage is
 *   intact, so it stays authoritative with the copy pending: this launch
 *   continues on `file://`'s older state, recorded as the copy's merge base,
 *   and the next launch completes the copy before it loads `file://`,
 *   keeping every key this launch changed there.
 */
export async function fallBackToFileOrigin(
  options: FallBackToFileOriginOptions,
): Promise<FallBackToFileOriginResult> {
  const { store, now, reason } = options;
  const lastFallback = { at: now().toISOString(), reason };
  const record = options.record ?? emptyRecord();
  if (record.lastUsedOrigin === 'file') {
    const next: RendererOriginRecord = {
      ...withoutPending(record),
      lastFallback,
    };
    await store.write(next).catch(() => undefined);
    return { record: next, migrated: false };
  }
  try {
    const migration = await migrateOriginStorage({
      from: 'scheme',
      to: 'file',
      bridge: options.bridge,
      store,
      record,
      now,
    });
    const next: RendererOriginRecord = { ...migration.record, lastFallback };
    await store.write(next).catch(() => undefined);
    return { record: next, migrated: true };
  } catch (error) {
    if (error instanceof OriginStorageSourceReadError) {
      const next = await abandonSchemeStorage(record, store, now, reason);
      return { record: next, migrated: false, error };
    }
    // This launch continues on file://, so record what it starts from: the
    // retry keeps every key it changes. Without a base, the retry replaces
    // file:// as before.
    const previous = record.pendingMigration;
    const existingBase =
      previous?.from === 'scheme' && previous.to === 'file'
        ? previous.mergeBase
        : undefined;
    const baseBridge = options.createBridge?.() ?? options.bridge;
    const mergeBase =
      existingBase ??
      (await withDeadline(
        baseBridge.read('file'),
        DEFAULT_MIGRATION_TIMEOUT_MS,
        () => {
          baseBridge.abort();
        },
      ).then(
        (snapshot) => snapshot.localStorage,
        () => undefined,
      ));
    const next: RendererOriginRecord = {
      ...record,
      lastUsedOrigin: 'scheme',
      pendingMigration: {
        from: 'scheme',
        to: 'file',
        startedAt: now().toISOString(),
        ...(mergeBase ? { mergeBase } : {}),
      },
      lastFallback,
    };
    await store.write(next).catch(() => undefined);
    return { record: next, migrated: false, schemeRetained: true, error };
  }
}
