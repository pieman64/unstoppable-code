import { CANOPY_ERROR_KINDS } from '@canopy/protocol/canopy-core';
import { serialize } from 'node:v8';
import {
  recordChatStorageScopeCommit,
  recordChatStorageScopeMutations,
  recordChatStorageScopeSync,
  recordChatStorageScopeWrite,
  type ChatStorageCommitTiming,
} from './chat-storage-activity';

/**
 * Process-wide work counters for the desktop performance harness.
 *
 * Counting is a cheap, always-on increment on paths that already run: IPC
 * handler invocations and main → renderer deliveries, canonical chat-storage
 * writes, provider event ingestion, and the backend each routed read used.
 * Nothing here changes what the instrumented code does, in what order, or
 * with which payloads. The two costly parts stay out of production: IPC byte
 * estimation runs only in an E2E build (`__CANOPY_E2E__`) whose harness asked
 * for it, and the snapshot and reset query is installed only in E2E builds.
 *
 * The module has no Electron dependency so a future core daemon can host it.
 * See `docs/desktop-app-performance.md` ("Work counters and the local
 * ratchet") for the counter names and how the harness reads them. The
 * chat-storage hooks also feed the per-scope accounting in
 * `chat-storage-activity.ts`, which local diagnostics summarize; the harness
 * reset never touches it.
 */

export type WorkCounterSource = 'ipc' | 'chatStorage' | 'provider' | 'route';

export interface WorkCountersSnapshot {
  /** Changes on every reset, so a reader can tell counts were cleared. */
  generation: number;
  ipc: Record<string, number>;
  chatStorage: Record<string, number>;
  provider: Record<string, number>;
  /**
   * Which backend served each routed read, for acceptance specs. The
   * performance harness does not sample it.
   */
  route: Record<string, number>;
}

export interface WorkCountersResetOptions {
  /**
   * Estimate main → renderer payload bytes with `v8.serialize`. Honoured only
   * in E2E builds; production builds compile the estimator out.
   */
  estimateIpcBytes?: boolean;
}

export interface WorkCountersQuery {
  snapshot(): WorkCountersSnapshot;
  reset(options?: WorkCountersResetOptions): WorkCountersSnapshot;
}

declare global {
  // Installed in E2E builds only, for the desktop performance harness.
  var __CANOPY_WORK_COUNTERS__: WorkCountersQuery | undefined;
}

export const WORK_COUNTERS_QUERY_KEY = '__CANOPY_WORK_COUNTERS__';

/** Distinct counter names kept per source; later names fold into overflow. */
export const WORK_COUNTER_KEY_LIMIT = 4096;

/** Counts increments that arrived after a source reached its key limit. */
export const WORK_COUNTER_OVERFLOW_KEY = 'overflow';

export type ChatStorageFileClass =
  /** The version 2 metadata write-ahead journal. */
  | 'journal'
  /** The delta journal of a version 3 scope (`delta-journal.log`). */
  | 'deltaJournal'
  | 'liveIndex'
  | 'archiveIndex'
  | 'recoveryIndex'
  | 'payload'
  | 'transcript'
  | 'appendStaging'
  | 'activeSidecar'
  | 'transcriptIndex'
  | 'turnIndex'
  | 'messageIndex'
  | 'artifact'
  /** A delegated agent's transcript log (`transcripts/delegations/`). */
  | 'delegationLog'
  | 'manifest'
  | 'other';

class BoundedCounters {
  private readonly values = new Map<string, number>();

  public add(key: string, delta: number): void {
    const current = this.values.get(key);
    if (current !== undefined) {
      this.values.set(key, current + delta);
      return;
    }
    if (this.values.size >= WORK_COUNTER_KEY_LIMIT) {
      this.values.set(
        WORK_COUNTER_OVERFLOW_KEY,
        (this.values.get(WORK_COUNTER_OVERFLOW_KEY) ?? 0) + 1,
      );
      return;
    }
    this.values.set(key, delta);
  }

  public snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  public clear(): void {
    this.values.clear();
  }
}

const counters: Record<WorkCounterSource, BoundedCounters> = {
  ipc: new BoundedCounters(),
  chatStorage: new BoundedCounters(),
  provider: new BoundedCounters(),
  route: new BoundedCounters(),
};
let generation = 0;
let estimateIpcBytes = false;

function isE2eBuild(): boolean {
  return typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__;
}

export function snapshotWorkCounters(): WorkCountersSnapshot {
  return {
    generation,
    ipc: counters.ipc.snapshot(),
    chatStorage: counters.chatStorage.snapshot(),
    provider: counters.provider.snapshot(),
    route: counters.route.snapshot(),
  };
}

/** Clears every counter and starts a new generation. */
export function resetWorkCounters(
  options: WorkCountersResetOptions = {},
): WorkCountersSnapshot {
  counters.ipc.clear();
  counters.chatStorage.clear();
  counters.provider.clear();
  counters.route.clear();
  generation += 1;
  estimateIpcBytes = options.estimateIpcBytes === true;
  return snapshotWorkCounters();
}

/**
 * Approximate wire size of IPC arguments: Electron clones them with the same
 * V8 serializer. `undefined` when a value cannot be serialized.
 */
export function estimateIpcPayloadBytes(
  args: readonly unknown[],
): number | undefined {
  try {
    return serialize(args).byteLength;
  } catch {
    return undefined;
  }
}

/** One renderer → main invocation of a registered IPC handler. */
export function recordIpcInvoke(channel: string): void {
  counters.ipc.add(`invoke.${channel}`, 1);
}

/** One main → renderer message delivered on `channel` to one window. */
export function recordIpcSend(
  channel: string,
  windowLabel: string,
  args: readonly unknown[],
): void {
  const key = `send.${channel}.${windowLabel}`;
  counters.ipc.add(`${key}.messages`, 1);
  if (isE2eBuild() && estimateIpcBytes) {
    const bytes = estimateIpcPayloadBytes(args);
    if (bytes !== undefined) counters.ipc.add(`${key}.bytes`, bytes);
  }
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/);
}

/** Drops the `.<uuid>.tmp` suffix atomic writers give their staging files. */
function publishedName(name: string): string {
  return name.replace(/\.[0-9a-f-]{36}\.tmp$/i, '');
}

function classifyTranscriptFile(name: string): ChatStorageFileClass {
  if (name.endsWith('.append.tmp')) return 'appendStaging';
  if (name.endsWith('.rewrite.tmp')) return 'transcript';
  const published = publishedName(name);
  if (published.endsWith('.active.json')) return 'activeSidecar';
  if (published.endsWith('.index.json')) return 'transcriptIndex';
  if (published.endsWith('.turns.json')) return 'turnIndex';
  if (published.endsWith('.jsonl')) return 'transcript';
  return 'other';
}

/**
 * The role a file plays in canonical chat storage
 * (`chat-storage-v2/<scope>/…` and its authority manifests), or `undefined`
 * for files outside it. Temporary files take the class of their target.
 */
export function classifyChatStorageFile(
  path: string,
): ChatStorageFileClass | undefined {
  const segments = pathSegments(path);
  const root = segments.lastIndexOf('chat-storage-v2');
  if (root === -1) {
    return segments.includes('chat-storage-manifests') ? 'manifest' : undefined;
  }
  const [area, entry] = segments.slice(root + 2);
  if (area === undefined) return 'other';
  if (area.startsWith('metadata-journal.jsonl')) return 'journal';
  if (area.startsWith('delta-journal.log')) return 'deltaJournal';
  if (area.startsWith('live-index.json')) return 'liveIndex';
  if (area.startsWith('archive-index.json')) return 'archiveIndex';
  if (area.startsWith('recovery-index.json')) return 'recoveryIndex';
  if (area === 'pending-transcripts') return 'payload';
  if (area !== 'transcripts' || entry === undefined) return 'other';
  if (entry === 'tool-output' || entry === 'visuals') return 'artifact';
  if (entry === 'delegations') return 'delegationLog';
  if (entry === 'message-index') return 'messageIndex';
  return classifyTranscriptFile(entry);
}

/** Whether a file or directory belongs to canonical chat storage. */
export function isChatStoragePath(path: string): boolean {
  const segments = pathSegments(path);
  return (
    segments.includes('chat-storage-v2') ||
    segments.includes('chat-storage-manifests')
  );
}

/**
 * Bytes a chat-storage writer put in `path`. `serialized` marks bytes it also
 * produced by JSON serialization rather than by copying existing bytes.
 */
export function recordChatStorageFileWrite(
  path: string,
  bytes: number,
  serialized: boolean,
): void {
  const fileClass = classifyChatStorageFile(path);
  if (fileClass === undefined) return;
  if (serialized)
    counters.chatStorage.add(`serialized.${fileClass}.bytes`, bytes);
  counters.chatStorage.add(`written.${fileClass}.bytes`, bytes);
  recordChatStorageScopeWrite(path, bytes);
}

export function recordChatStorageFileSync(path: string): void {
  if (!isChatStoragePath(path)) return;
  counters.chatStorage.add('syncs.file', 1);
  // A subset of `syncs.file`: delta-journal commits and segment rotations.
  if (classifyChatStorageFile(path) === 'deltaJournal')
    counters.chatStorage.add('syncs.file.deltaJournal', 1);
  recordChatStorageScopeSync(path, 'file');
}

export function recordChatStorageDirectorySync(path: string): void {
  if (!isChatStoragePath(path)) return;
  counters.chatStorage.add('syncs.directory', 1);
  recordChatStorageScopeSync(path, 'directory');
}

/** A rename that atomically published or replaced `path`. */
export function recordChatStorageAtomicReplacement(path: string): void {
  if (isChatStoragePath(path))
    counters.chatStorage.add('atomicReplacements', 1);
}

/** One delta-journal checkpoint that published its index files. */
export function recordChatStorageDeltaJournalCheckpoint(): void {
  counters.chatStorage.add('deltaJournal.checkpoints', 1);
}

/**
 * One scope transaction that published its journal record. `timing` also
 * attributes it, with its duration, to its scope's local diagnostics.
 */
export function recordChatStorageCommit(
  timing?: ChatStorageCommitTiming,
): void {
  counters.chatStorage.add('commits', 1);
  recordChatStorageScopeCommit(timing);
}

/** Canonical mutations carried by one commit, in `scopeDirectory` if known. */
export function recordChatStorageMutations(
  count: number,
  scopeDirectory?: string,
): void {
  counters.chatStorage.add('mutations', count);
  recordChatStorageScopeMutations(count, scopeDirectory);
}

/** Whole live, archive, or recovery indexes serialized to disk. */
export function recordChatStorageIndexSerializations(count: number): void {
  counters.chatStorage.add('indexSerializations', count);
}

/** One `structuredClone` of a whole index or index set. */
export function recordChatStorageIndexClone(): void {
  counters.chatStorage.add('indexClones', 1);
}

/** Whole live, archive, or recovery indexes parsed from disk. */
export function recordChatStorageIndexParses(count: number): void {
  counters.chatStorage.add('indexParses', count);
}

/**
 * One pass that reads a staged transcript payload back from disk and parses
 * its rows. `hashed` marks a pass that also recomputed the payload digest to
 * verify it. The digest a commit computes while writing the payload is not a
 * read and is not counted.
 */
export function recordChatStoragePayloadPass(hashed: boolean): void {
  counters.chatStorage.add('payloadReads', 1);
  counters.chatStorage.add('payloadParses', 1);
  if (hashed) counters.chatStorage.add('payloadHashes', 1);
}

/** One tool-output artifact file newly published. */
export function recordChatStorageArtifactPublished(): void {
  counters.chatStorage.add('artifactsPublished', 1);
}

export function recordProviderEventIngested(): void {
  counters.provider.add('eventsIngested', 1);
}

/** A provider event whose ingestion committed a canonical change. */
export function recordProviderEventApplied(): void {
  counters.provider.add('eventsApplied', 1);
}

export type FilesRouteOperation = 'roots' | 'directory';

/**
 * One Files IPC read and the backend it was routed to (`direct` or `daemon`).
 * Counted once per request, before the backend runs.
 */
export function recordFilesRouteSelected(
  operation: FilesRouteOperation,
  backend: 'direct' | 'daemon',
): void {
  counters.route.add(`files.${operation}.${backend}`, 1);
}

/**
 * What a routed Files read did: `daemon.queries` per daemon query sent,
 * `daemon.retries` per conflict refresh, `daemon.served` when a daemon result
 * was returned, `daemon.failed.<kind>` for a typed failure, and
 * `direct.discarded` when a direct result was dropped because the route
 * changed while it ran.
 */
export function recordFilesRouteOutcome(
  operation: FilesRouteOperation,
  outcome:
    | 'daemon.queries'
    | 'daemon.retries'
    | 'daemon.served'
    | `daemon.failed.${string}`
    | 'direct.discarded',
): void {
  counters.route.add(`files.${operation}.${outcome}`, 1);
}

/**
 * Exposes `snapshot()` and `reset()` to the harness as
 * `globalThis.__CANOPY_WORK_COUNTERS__`. A no-op outside E2E builds.
 */
export function installWorkCountersQuery(): boolean {
  if (!isE2eBuild()) return false;
  const query: WorkCountersQuery = Object.freeze({
    snapshot: snapshotWorkCounters,
    reset: resetWorkCounters,
  });
  Object.defineProperty(globalThis, WORK_COUNTERS_QUERY_KEY, {
    configurable: true,
    value: query,
  });
  return true;
}

/** Production-safe Files-only projection; never installs the E2E reset API. */
export interface FilesWorkCountersSnapshot {
  generation: number;
  overflow: number;
  invocations: { roots: number; directory: number };
  route: Record<string, number>;
}

export function snapshotFilesWorkCounters(): FilesWorkCountersSnapshot {
  const ipc = counters.ipc.snapshot();
  const route = counters.route.snapshot();
  const operations = ['roots', 'directory'];
  const outcomes = [
    'direct',
    'daemon',
    'daemon.queries',
    'daemon.retries',
    'daemon.served',
    'direct.discarded',
  ];
  const failures = CANOPY_ERROR_KINDS;
  return {
    generation,
    overflow:
      (ipc[WORK_COUNTER_OVERFLOW_KEY] ?? 0) +
      (route[WORK_COUNTER_OVERFLOW_KEY] ?? 0),
    invocations: {
      roots: ipc['invoke.file-tree:roots'] ?? 0,
      directory: ipc['invoke.file-tree:directory'] ?? 0,
    },
    route: Object.fromEntries(
      operations.flatMap((operation) =>
        [...outcomes, ...failures.map((kind) => `daemon.failed.${kind}`)].map(
          (outcome) => {
            const key = `files.${operation}.${outcome}`;
            return [key, route[key] ?? 0];
          },
        ),
      ),
    ),
  };
}
