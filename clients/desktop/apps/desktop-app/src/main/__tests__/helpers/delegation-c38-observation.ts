import { Buffer } from 'node:buffer';
import type { ReadStream, WriteStream } from 'node:fs';
import fsStreams from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotWorkCounters,
  type WorkCountersSnapshot,
} from '@canopy/desktop-shared/node/work-counters';
import {
  ChatDeltaJournalWriter,
  type DeltaJournalCommitInput,
} from '../../lib/chat-delta-journal/writer';
import { ChatStateV2Backend } from '../../services/chat-state-v2-backend';
import {
  setChatTranscriptRewriteDiagnosticsForTests,
  type ChatTranscriptFullRewriteDiagnostic,
} from '../../services/chat-transcript-rewrite-diagnostics';

export type C38IoClass =
  | 'parent-jsonl'
  | 'active-sidecar'
  | 'parent-index'
  | 'child-log'
  | 'artifact'
  | 'metadata';

export interface C38IoClassTotals {
  bytesRead: number;
  bytesWritten: number;
  readOperations: number;
  writeOperations: number;
}

export type C38IoTotals = Readonly<Record<C38IoClass, C38IoClassTotals>>;

export interface C38IoSnapshot {
  readonly totals: C38IoTotals;
  /** Keys are `${owningClass}/${API}`; successful bytes, not device I/O. */
  readonly apiTotals: Readonly<Record<string, C38IoClassTotals>>;
  readonly unclassifiedPaths: readonly string[];
  readonly unmeasuredApis: readonly string[];
  readonly replacements: readonly C38ReplacementPublication[];
  readonly openHandles: number;
}

export interface C38ReplacementPublication {
  readonly from: string;
  readonly to: string;
  readonly fromOwner: C38IoClass | undefined;
  readonly toOwner: C38IoClass | undefined;
}

export interface C38IoWindow {
  readonly label: string;
  readonly totals: C38IoTotals;
  readonly apiTotals: Readonly<Record<string, C38IoClassTotals>>;
  readonly unclassifiedPaths: readonly string[];
  readonly unmeasuredApis: readonly string[];
  readonly replacements: readonly C38ReplacementPublication[];
  readonly openHandles: number;
  readonly complete: boolean;
}

export interface C38MutationInputObservation {
  readonly checkpointRequested: boolean;
}

export interface C38WriterInputObservation {
  readonly writeKinds: readonly DeltaJournalCommitInput['writes'][number]['kind'][];
}

export type C38CheckpointRequestKind =
  | 'flush'
  | 'checkpointPendingJournal'
  | 'writer-checkpoint';

export interface C38CheckpointRequestObservation {
  readonly kind: C38CheckpointRequestKind;
  readonly trigger?: 'timer';
}

export type C38CheckpointBoundaryKind = C38CheckpointRequestKind;

export interface C38CheckpointBoundaryObservation {
  readonly kind: C38CheckpointBoundaryKind;
  readonly result: 'completed' | 'failed';
}

export interface C38CheckpointSnapshot {
  readonly mutationInputs: readonly C38MutationInputObservation[];
  readonly writerInputs: readonly C38WriterInputObservation[];
  readonly requests: readonly C38CheckpointRequestObservation[];
  readonly boundaries: readonly C38CheckpointBoundaryObservation[];
  readonly workCounters: WorkCountersSnapshot;
}

export interface C38CheckpointWindow {
  readonly mutationInputs: readonly C38MutationInputObservation[];
  readonly writerInputs: readonly C38WriterInputObservation[];
  readonly requests: readonly C38CheckpointRequestObservation[];
  readonly boundaries: readonly C38CheckpointBoundaryObservation[];
  readonly completedCheckpoints: number | undefined;
  readonly requestCauses: readonly string[];
  readonly workCounterDelta: C38WorkCounterDelta;
}

export interface C38WorkCounterDelta {
  readonly generationBefore: number;
  readonly generationAfter: number;
  readonly generationChanged: boolean;
  readonly ipc: Readonly<Record<string, number>>;
  readonly chatStorage: Readonly<Record<string, number>>;
  readonly provider: Readonly<Record<string, number>>;
}

export interface C38ObservationWindow {
  readonly label: string;
  readonly io: C38IoWindow;
  readonly rewrites: readonly ChatTranscriptFullRewriteDiagnostic[];
  readonly checkpoints: C38CheckpointWindow;
}

export interface C38ObservedWindowResult<T> {
  readonly value: T;
  readonly window: C38ObservationWindow;
}

export interface C38ObservationOptions {
  /**
   * Install before creating the fixture/repository. This should be an ancestor
   * of the fixture's eventual directory; `ownerForPath` may close over a
   * backing that is assigned after construction so long-lived handles opened
   * during setup are still instrumented. Take the first measurement snapshot
   * only after setup has completed.
   */
  readonly root: string;
  readonly ownerForPath: (path: string) => C38IoClass | undefined;
  /** Optional bounded diagnostic consumer; successful parent reads only. */
  readonly onParentRead?: (event: C38ParentRead) => void;
}

export interface C38ParentRead {
  readonly window: string | undefined;
  readonly path: string;
  readonly bytes: number;
  readonly api: string;
  readonly stack: string | undefined;
}

export interface C38Observation {
  readonly io: C38IoObserver;
  readonly checkpoints: C38CheckpointObserver;
  readonly rewrites: C38RewriteCapture;
  readonly lastWindow: C38ObservationWindow | undefined;
  withDrainedWindow<T>(
    label: string,
    drainBefore: () => Promise<void>,
    operation: () => Promise<T>,
    drainAfter: () => Promise<void>,
  ): Promise<C38ObservedWindowResult<T>>;
  restore(): void;
}

export interface C38IoObserver {
  snapshot(): C38IoSnapshot;
  setActiveWindow(label: string | undefined): void;
  windowSince(
    label: string,
    before: C38IoSnapshot,
    after?: C38IoSnapshot,
  ): C38IoWindow;
  restore(): void;
}

export interface C38CheckpointObserver {
  snapshot(): C38CheckpointSnapshot;
  windowSince(
    before: C38CheckpointSnapshot,
    after?: C38CheckpointSnapshot,
  ): C38CheckpointWindow;
  restore(): void;
}

export interface C38RewriteCapture {
  readonly records: readonly ChatTranscriptFullRewriteDiagnostic[];
  restore(): void;
}

export interface C38SerializedSizeSummary {
  readonly count: number;
  readonly minBytes: number | null;
  readonly p50Bytes: number | null;
  readonly p95Bytes: number | null;
  readonly maxBytes: number | null;
  readonly sumBytes: number;
  readonly sizesBytes: readonly number[];
}

export interface C38GarbageCollector {
  readonly method: string;
  readonly verified: boolean;
  collect(): void;
}

export interface C38MemorySample {
  readonly gcAvailable: boolean;
  readonly gcMethod: string | null;
  readonly rawHeapUsedBytes: number;
  readonly rawRssBytes: number;
  readonly postGcHeapUsedBytes: number | null;
  readonly postGcRssBytes: number | null;
}

export interface C38StatusEvaluation {
  readonly passed: boolean;
  readonly violations: readonly string[];
}

export interface C38StatusOracles {
  readonly rawParentRowsUnchanged?: boolean;
  readonly rawReferenceUnchanged?: boolean;
}

function subtractCounterRecords(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const delta: Record<string, number> = {};
  for (const key of Object.keys({ ...before, ...after })) {
    delta[key] = (after[key] ?? 0) - (before[key] ?? 0);
  }
  return delta;
}

export function deltaC38WorkCounters(
  before: WorkCountersSnapshot,
  after: WorkCountersSnapshot,
): C38WorkCounterDelta {
  return {
    generationBefore: before.generation,
    generationAfter: after.generation,
    generationChanged: before.generation !== after.generation,
    ipc: subtractCounterRecords(before.ipc, after.ipc),
    chatStorage: subtractCounterRecords(before.chatStorage, after.chatStorage),
    provider: subtractCounterRecords(before.provider, after.provider),
  };
}

type FilePath = string | Buffer | URL;
type Restore = () => void;
type TrackedSpy = { mockClear(): unknown; mockRestore(): void };

/**
 * `jest.spyOn` for one object's own method, without Jest's spy registry:
 * jest-mock 30 keeps a restored spy's restore closure, so per-handle and
 * per-stream spies would retain every handle and stream until the run ends.
 */
function patchMethod(
  object: object,
  key: string,
  implementation: unknown,
): TrackedSpy {
  const original: unknown = Reflect.get(object, key);
  if (typeof original !== 'function')
    throw new Error(`Cannot observe ${key}: not a method`);
  const owned = Object.prototype.hasOwnProperty.call(object, key);
  Reflect.set(object, key, implementation);
  return {
    mockClear: () => undefined,
    mockRestore: (): void => {
      if (owned) Reflect.set(object, key, original);
      else Reflect.deleteProperty(object, key);
    },
  };
}

function emptyTotals(): Record<C38IoClass, C38IoClassTotals> {
  return {
    'parent-jsonl': {
      bytesRead: 0,
      bytesWritten: 0,
      readOperations: 0,
      writeOperations: 0,
    },
    'active-sidecar': {
      bytesRead: 0,
      bytesWritten: 0,
      readOperations: 0,
      writeOperations: 0,
    },
    'parent-index': {
      bytesRead: 0,
      bytesWritten: 0,
      readOperations: 0,
      writeOperations: 0,
    },
    'child-log': {
      bytesRead: 0,
      bytesWritten: 0,
      readOperations: 0,
      writeOperations: 0,
    },
    artifact: {
      bytesRead: 0,
      bytesWritten: 0,
      readOperations: 0,
      writeOperations: 0,
    },
    metadata: {
      bytesRead: 0,
      bytesWritten: 0,
      readOperations: 0,
      writeOperations: 0,
    },
  };
}

function cloneTotals(
  totals: Record<C38IoClass, C38IoClassTotals>,
): C38IoTotals {
  return {
    'parent-jsonl': { ...totals['parent-jsonl'] },
    'active-sidecar': { ...totals['active-sidecar'] },
    'parent-index': { ...totals['parent-index'] },
    'child-log': { ...totals['child-log'] },
    artifact: { ...totals.artifact },
    metadata: { ...totals.metadata },
  };
}

function subtractTotals(before: C38IoTotals, after: C38IoTotals): C38IoTotals {
  return {
    'parent-jsonl': {
      bytesRead:
        after['parent-jsonl'].bytesRead - before['parent-jsonl'].bytesRead,
      bytesWritten:
        after['parent-jsonl'].bytesWritten -
        before['parent-jsonl'].bytesWritten,
      readOperations:
        after['parent-jsonl'].readOperations -
        before['parent-jsonl'].readOperations,
      writeOperations:
        after['parent-jsonl'].writeOperations -
        before['parent-jsonl'].writeOperations,
    },
    'active-sidecar': {
      bytesRead:
        after['active-sidecar'].bytesRead - before['active-sidecar'].bytesRead,
      bytesWritten:
        after['active-sidecar'].bytesWritten -
        before['active-sidecar'].bytesWritten,
      readOperations:
        after['active-sidecar'].readOperations -
        before['active-sidecar'].readOperations,
      writeOperations:
        after['active-sidecar'].writeOperations -
        before['active-sidecar'].writeOperations,
    },
    'parent-index': {
      bytesRead:
        after['parent-index'].bytesRead - before['parent-index'].bytesRead,
      bytesWritten:
        after['parent-index'].bytesWritten -
        before['parent-index'].bytesWritten,
      readOperations:
        after['parent-index'].readOperations -
        before['parent-index'].readOperations,
      writeOperations:
        after['parent-index'].writeOperations -
        before['parent-index'].writeOperations,
    },
    'child-log': {
      bytesRead: after['child-log'].bytesRead - before['child-log'].bytesRead,
      bytesWritten:
        after['child-log'].bytesWritten - before['child-log'].bytesWritten,
      readOperations:
        after['child-log'].readOperations - before['child-log'].readOperations,
      writeOperations:
        after['child-log'].writeOperations -
        before['child-log'].writeOperations,
    },
    artifact: {
      bytesRead: after.artifact.bytesRead - before.artifact.bytesRead,
      bytesWritten: after.artifact.bytesWritten - before.artifact.bytesWritten,
      readOperations:
        after.artifact.readOperations - before.artifact.readOperations,
      writeOperations:
        after.artifact.writeOperations - before.artifact.writeOperations,
    },
    metadata: {
      bytesRead: after.metadata.bytesRead - before.metadata.bytesRead,
      bytesWritten: after.metadata.bytesWritten - before.metadata.bytesWritten,
      readOperations:
        after.metadata.readOperations - before.metadata.readOperations,
      writeOperations:
        after.metadata.writeOperations - before.metadata.writeOperations,
    },
  };
}

function asPath(path: FilePath): string {
  return resolve(path instanceof URL ? fileURLToPath(path) : path.toString());
}

function pathIsWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function countReadResult(
  value: Buffer | string,
  encoding?: BufferEncoding,
): number {
  return typeof value === 'string'
    ? Buffer.byteLength(value, encoding)
    : value.byteLength;
}

function isWritePayload(
  value: unknown,
): value is string | NodeJS.ArrayBufferView {
  return typeof value === 'string' || ArrayBuffer.isView(value);
}

function countWriteData(
  value: string | NodeJS.ArrayBufferView,
  encoding?: BufferEncoding,
): number {
  return typeof value === 'string'
    ? Buffer.byteLength(value, encoding)
    : value.byteLength;
}

function readEncoding(
  options: Parameters<typeof fs.readFile>[1],
): BufferEncoding | undefined {
  if (typeof options === 'string') return options;
  const encoding = options?.encoding;
  return encoding ?? undefined;
}

function handleReadEncoding(
  options: Parameters<FileHandle['readFile']>[0],
): BufferEncoding | undefined {
  if (typeof options === 'string') return options;
  const encoding = options?.encoding;
  return encoding ?? undefined;
}

function writeEncoding(
  options: Parameters<typeof fs.writeFile>[2],
): BufferEncoding | undefined {
  if (typeof options === 'string') return options;
  const encoding = options?.encoding;
  return encoding ?? undefined;
}

function handleWriteEncoding(
  options: Parameters<FileHandle['writeFile']>[1],
): BufferEncoding | undefined {
  if (typeof options === 'string') return options;
  const encoding = options?.encoding;
  return encoding ?? undefined;
}

function isPathLike(path: unknown): path is FilePath {
  return (
    typeof path === 'string' || Buffer.isBuffer(path) || path instanceof URL
  );
}

function makeRestoreStack(): {
  readonly add: (restore: Restore) => void;
  readonly restore: () => void;
  readonly restored: boolean;
} {
  const restores: Restore[] = [];
  let restored = false;
  return {
    get restored(): boolean {
      return restored;
    },
    add(restore): void {
      if (restored) throw new Error('Cannot add an observer after restore');
      restores.push(restore);
    },
    restore(): void {
      if (restored) return;
      restored = true;
      let failure: unknown;
      for (const restore of restores.reverse()) {
        try {
          restore();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined)
        throw failure instanceof Error
          ? failure
          : new Error('Observer restoration failed');
    },
  };
}

export function installC38IoObserver(
  options: C38ObservationOptions,
): C38IoObserver {
  const root = resolve(options.root);
  const totals = emptyTotals();
  const apiTotals: Record<string, C38IoClassTotals> = {};
  // Keep occurrences, not sets: reaching the same unsupported path/API again
  // in a later window must not disappear just because setup reached it first.
  const unclassifiedPaths: string[] = [];
  const unmeasuredApis: string[] = [];
  const replacements: C38ReplacementPublication[] = [];
  const activeHandles = new Set<FileHandle>();
  const handlesWithReadStreams = new Set<FileHandle>();
  const handlesWithWriteStreams = new Set<FileHandle>();
  const wrappedHandles = new WeakSet<FileHandle>();
  const restoreStack = makeRestoreStack();
  // Spies forget their calls on every observed operation and per-handle or
  // per-stream spies are restored at close: Jest's recorded calls and results
  // would otherwise retain every read buffer and stream until final restore.
  const liveSpies = new Set<TrackedSpy>();
  const recordingSpies = new Set<TrackedSpy>();
  let activeWindow: string | undefined;

  const forgetCalls = (): void => {
    recordingSpies.forEach((spy) => spy.mockClear());
  };

  const release = (spies: TrackedSpy[]): void => {
    let failure: unknown;
    for (const spy of spies.reverse()) {
      if (!liveSpies.delete(spy)) continue;
      recordingSpies.delete(spy);
      try {
        spy.mockRestore();
      } catch (error) {
        failure ??= error;
      }
    }
    spies.length = 0;
    if (failure !== undefined)
      throw failure instanceof Error
        ? failure
        : new Error('Observer restoration failed');
  };
  restoreStack.add(() => {
    const all: TrackedSpy[] = [];
    liveSpies.forEach((spy) => all.push(spy));
    release(all);
  });

  const ownerFor = (path: string): C38IoClass | undefined =>
    options.ownerForPath(resolve(path));

  const record = (
    path: string,
    direction: 'read' | 'write',
    bytes: number,
    api = 'unknown',
    origin?: string,
  ): void => {
    forgetCalls();
    const normalized = resolve(path);
    if (!pathIsWithin(root, normalized)) return;
    const owner = ownerFor(normalized);
    if (owner === undefined) {
      unclassifiedPaths.push(normalized);
      return;
    }
    if (direction === 'read') {
      totals[owner].bytesRead += bytes;
      totals[owner].readOperations++;
    } else {
      totals[owner].bytesWritten += bytes;
      totals[owner].writeOperations++;
    }
    const key = `${owner}/${api}`;
    const apiTotal = apiTotals[key] ?? {
      bytesRead: 0,
      bytesWritten: 0,
      readOperations: 0,
      writeOperations: 0,
    };
    if (direction === 'read') {
      apiTotal.bytesRead += bytes;
      apiTotal.readOperations++;
    } else {
      apiTotal.bytesWritten += bytes;
      apiTotal.writeOperations++;
    }
    apiTotals[key] = apiTotal;
    if (
      direction === 'read' &&
      owner === 'parent-jsonl' &&
      bytes > 0 &&
      options.onParentRead
    ) {
      options.onParentRead({
        window: activeWindow,
        path: normalized,
        bytes,
        api,
        stack: origin ?? new Error(`C38 ${api}`).stack,
      });
    }
  };

  const trackSpy = (spy: TrackedSpy, group?: TrackedSpy[]): void => {
    if (restoreStack.restored)
      throw new Error('Cannot add an observer after restore');
    liveSpies.add(spy);
    // Only module-level Jest spies record calls; per-object patches never do.
    if (group) group.push(spy);
    else recordingSpies.add(spy);
  };

  const wrapHandle = (handle: FileHandle, path: string): void => {
    if (!pathIsWithin(root, path) || wrappedHandles.has(handle)) return;
    wrappedHandles.add(handle);
    activeHandles.add(handle);
    const spies: TrackedSpy[] = [];

    const read = handle.read.bind(handle);
    const readSpy = patchMethod(
      handle,
      'read',
      async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        if (!handlesWithReadStreams.has(handle)) {
          record(path, 'read', result.bytesRead, 'FileHandle.read');
        }
        return result;
      },
    );
    trackSpy(readSpy, spies);

    const readFile = handle.readFile.bind(handle);
    const readFileSpy = patchMethod(
      handle,
      'readFile',
      async (...args: Parameters<typeof readFile>) => {
        const result = await readFile(...args);
        record(
          path,
          'read',
          countReadResult(result, handleReadEncoding(args[0])),
          'FileHandle.readFile',
        );
        return result;
      },
    );
    trackSpy(readFileSpy, spies);

    const readv = handle.readv.bind(handle);
    const readvSpy = patchMethod(
      handle,
      'readv',
      async (...args: Parameters<typeof readv>) => {
        const result = await readv(...args);
        if (!handlesWithReadStreams.has(handle)) {
          record(path, 'read', result.bytesRead, 'FileHandle.readv');
        }
        return result;
      },
    );
    trackSpy(readvSpy, spies);

    const write = handle.write.bind(handle);
    const writeSpy = patchMethod(
      handle,
      'write',
      async (...args: Parameters<typeof write>) => {
        const result = await write(...args);
        if (!handlesWithWriteStreams.has(handle)) {
          record(path, 'write', result.bytesWritten, 'FileHandle.write');
        }
        return result;
      },
    );
    trackSpy(writeSpy, spies);

    const writeFile = handle.writeFile.bind(handle);
    const writeFileSpy = patchMethod(
      handle,
      'writeFile',
      async (
        data: Parameters<typeof writeFile>[0],
        writeOptions: Parameters<typeof writeFile>[1],
      ) => {
        await writeFile(data, writeOptions);
        if (!handlesWithWriteStreams.has(handle)) {
          record(
            path,
            'write',
            countWriteData(data, handleWriteEncoding(writeOptions)),
            'FileHandle.writeFile',
          );
        }
      },
    );
    trackSpy(writeFileSpy, spies);

    const writev = handle.writev.bind(handle);
    const writevSpy = patchMethod(
      handle,
      'writev',
      async (...args: Parameters<typeof writev>) => {
        const result = await writev(...args);
        if (!handlesWithWriteStreams.has(handle)) {
          record(path, 'write', result.bytesWritten, 'FileHandle.writev');
        }
        return result;
      },
    );
    trackSpy(writevSpy, spies);

    const close = handle.close.bind(handle);
    const closeSpy = patchMethod(handle, 'close', async () => {
      try {
        await close();
      } finally {
        activeHandles.delete(handle);
        release(spies);
      }
    });
    trackSpy(closeSpy, spies);

    const createReadStream = handle.createReadStream.bind(handle);
    const createReadStreamSpy = patchMethod(
      handle,
      'createReadStream',
      (streamOptions: Parameters<typeof createReadStream>[0]) => {
        const stream = createReadStream(streamOptions);
        handlesWithReadStreams.add(handle);
        const releaseReadStream = (): void => {
          handlesWithReadStreams.delete(handle);
        };
        stream.once('end', releaseReadStream);
        stream.once('close', releaseReadStream);
        wrapReadStream(
          stream,
          path,
          'FileHandle.createReadStream',
          options.onParentRead
            ? new Error('FileHandle.createReadStream origin').stack
            : undefined,
        );
        return stream;
      },
    );
    trackSpy(createReadStreamSpy, spies);

    const createWriteStream = handle.createWriteStream.bind(handle);
    const createWriteStreamSpy = patchMethod(
      handle,
      'createWriteStream',
      (streamOptions: Parameters<typeof createWriteStream>[0]) => {
        const stream = createWriteStream(streamOptions);
        handlesWithWriteStreams.add(handle);
        const releaseWriteStream = (): void => {
          handlesWithWriteStreams.delete(handle);
        };
        stream.once('finish', releaseWriteStream);
        stream.once('close', releaseWriteStream);
        wrapWriteStream(stream, path);
        return stream;
      },
    );
    trackSpy(createWriteStreamSpy, spies);
  };

  const open = fs.open.bind(fs);
  const openSpy = jest.spyOn(fs, 'open');
  openSpy.mockImplementation(async (path, flags, mode) => {
    const normalized = asPath(path);
    const handle = await open(path, flags, mode);
    wrapHandle(handle, normalized);
    return handle;
  });
  trackSpy(openSpy);

  const readFile = fs.readFile.bind(fs);
  const readFileSpy = jest.spyOn(fs, 'readFile');
  readFileSpy.mockImplementation(async (path, readOptions) => {
    const result = await readFile(path, readOptions);
    if (isPathLike(path)) {
      const normalized = asPath(path);
      record(
        normalized,
        'read',
        countReadResult(result, readEncoding(readOptions)),
        'fs.promises.readFile',
      );
    }
    return result;
  });
  trackSpy(readFileSpy);

  const writeFile = fs.writeFile.bind(fs);
  const writeFileSpy = jest.spyOn(fs, 'writeFile');
  writeFileSpy.mockImplementation(async (path, data, writeOptions) => {
    await writeFile(path, data, writeOptions);
    if (isPathLike(path)) {
      const normalized = asPath(path);
      if (isWritePayload(data)) {
        record(
          normalized,
          'write',
          countWriteData(data, writeEncoding(writeOptions)),
          'fs.promises.writeFile',
        );
      } else if (pathIsWithin(root, normalized)) {
        unmeasuredApis.push(`fs.writeFile(stream-or-iterable):${normalized}`);
      }
    }
  });
  trackSpy(writeFileSpy);

  const rename = fs.rename.bind(fs);
  const renameSpy = jest.spyOn(fs, 'rename');
  renameSpy.mockImplementation(async (from, to) => {
    await rename(from, to);
    const source = asPath(from);
    const destination = asPath(to);
    if (pathIsWithin(root, source) || pathIsWithin(root, destination)) {
      const fromOwner = ownerFor(source);
      const toOwner = ownerFor(destination);
      replacements.push({
        from: source,
        to: destination,
        fromOwner,
        toOwner,
      });
      if (pathIsWithin(root, source) && fromOwner === undefined) {
        unclassifiedPaths.push(source);
      }
      if (pathIsWithin(root, destination) && toOwner === undefined) {
        unclassifiedPaths.push(destination);
      }
    }
  });
  trackSpy(renameSpy);

  const copyFile = fs.copyFile.bind(fs);
  const copyFileSpy = jest.spyOn(fs, 'copyFile');
  copyFileSpy.mockImplementation(async (source, destination, mode) => {
    await copyFile(source, destination, mode);
    const sourcePath = asPath(source);
    const destinationPath = asPath(destination);
    const sourceInside = pathIsWithin(root, sourcePath);
    const destinationInside = pathIsWithin(root, destinationPath);
    if (sourceInside || destinationInside) {
      const { size } = await fs.stat(destinationPath);
      if (sourceInside)
        record(sourcePath, 'read', size, 'fs.promises.copyFile');
      if (destinationInside)
        record(destinationPath, 'write', size, 'fs.promises.copyFile');
    }
  });
  trackSpy(copyFileSpy);

  const createReadStream = fsStreams.createReadStream.bind(fsStreams);
  const streamSpy = jest.spyOn(fsStreams, 'createReadStream');
  streamSpy.mockImplementation((path, streamOptions) => {
    const stream = createReadStream(path, streamOptions);
    const normalized = asPath(path);
    if (pathIsWithin(root, normalized))
      wrapReadStream(
        stream,
        normalized,
        'fs.createReadStream',
        options.onParentRead
          ? new Error('fs.createReadStream origin').stack
          : undefined,
      );
    return stream;
  });
  trackSpy(streamSpy);

  const createWriteStream = fsStreams.createWriteStream.bind(fsStreams);
  const createWriteStreamSpy = jest.spyOn(fsStreams, 'createWriteStream');
  createWriteStreamSpy.mockImplementation((path, streamOptions) => {
    const stream = createWriteStream(path, streamOptions);
    const normalized = asPath(path);
    if (pathIsWithin(root, normalized)) wrapWriteStream(stream, normalized);
    return stream;
  });
  trackSpy(createWriteStreamSpy);

  const wrapReadStream = (
    stream: ReadStream,
    path: string,
    api: string,
    origin?: string,
  ): void => {
    const spies: TrackedSpy[] = [];
    stream.once('close', () => release(spies));
    const read = stream.read.bind(stream);
    const readSpy = patchMethod(
      stream,
      'read',
      (size: Parameters<typeof read>[0]) => {
        const chunk: unknown = read(size);
        if (Buffer.isBuffer(chunk)) {
          record(path, 'read', chunk.byteLength, api, origin);
        } else if (typeof chunk === 'string') {
          const encoding = stream.readableEncoding;
          record(
            path,
            'read',
            Buffer.byteLength(
              chunk,
              typeof encoding === 'string' ? encoding : undefined,
            ),
            api,
            origin,
          );
        }
        return chunk;
      },
    );
    trackSpy(readSpy, spies);
  };

  const wrapWriteStream = (stream: WriteStream, path: string): void => {
    const spies: TrackedSpy[] = [];
    stream.once('close', () => release(spies));
    const write = stream.write.bind(stream);
    const writeSpy = patchMethod(
      stream,
      'write',
      (
        chunk: Parameters<typeof write>[0],
        encoding: Parameters<typeof write>[1],
        callback: Parameters<typeof write>[2],
      ) => {
        if (!isWritePayload(chunk)) {
          if (pathIsWithin(root, path)) {
            unmeasuredApis.push(`WriteStream.write:${path}`);
          }
          if (typeof encoding === 'function') return write(chunk, encoding);
          return write(chunk, encoding, callback);
        }
        const bytes = countWriteData(
          chunk,
          typeof encoding === 'string' ? encoding : undefined,
        );
        const completed = (error?: Error | null): void => {
          if (error === undefined || error === null)
            record(path, 'write', bytes, 'WriteStream.write');
          if (typeof callback === 'function') callback(error);
        };
        if (typeof encoding === 'function') return write(chunk, completed);
        return write(chunk, encoding ?? 'utf8', completed);
      },
    );
    trackSpy(writeSpy, spies);

    const end = stream.end.bind(stream);
    const endSpy = patchMethod(
      stream,
      'end',
      (
        chunk: Parameters<typeof end>[0],
        encoding: Parameters<typeof end>[1],
        callback: Parameters<typeof end>[2],
      ) => {
        if (typeof chunk === 'function') return end(chunk);
        if (!isWritePayload(chunk)) {
          if (chunk !== undefined && pathIsWithin(root, path)) {
            unmeasuredApis.push(`WriteStream.end:${path}`);
          }
          if (typeof encoding === 'function') return end(chunk, encoding);
          if (chunk === undefined) return end(callback);
          return end(chunk, encoding, callback);
        }
        const bytes = countWriteData(
          chunk,
          typeof encoding === 'string' ? encoding : undefined,
        );
        stream.once('finish', () =>
          record(path, 'write', bytes, 'WriteStream.end'),
        );
        if (typeof encoding === 'function') return end(chunk, encoding);
        return end(chunk, encoding ?? 'utf8', callback);
      },
    );
    trackSpy(endSpy, spies);
  };

  const snapshot = (): C38IoSnapshot => ({
    totals: cloneTotals(totals),
    apiTotals: Object.fromEntries(
      Object.entries(apiTotals).map(([key, total]) => [key, { ...total }]),
    ),
    unclassifiedPaths: unclassifiedPaths.slice(),
    unmeasuredApis: unmeasuredApis.slice(),
    replacements: replacements.slice(),
    openHandles: activeHandles.size,
  });

  return {
    snapshot,
    setActiveWindow(label): void {
      if (label !== undefined && activeWindow !== undefined) {
        throw new Error(`I/O window already active: ${activeWindow}`);
      }
      activeWindow = label;
    },
    windowSince(label, before, after = snapshot()): C38IoWindow {
      const newUnclassified = after.unclassifiedPaths.slice(
        before.unclassifiedPaths.length,
      );
      const newUnmeasured = after.unmeasuredApis.slice(
        before.unmeasuredApis.length,
      );
      const totalsSince = subtractTotals(before.totals, after.totals);
      const apiSince: Record<string, C38IoClassTotals> = {};
      for (const key of Object.keys(after.apiTotals)) {
        const prior = before.apiTotals[key];
        const current = after.apiTotals[key];
        apiSince[key] = {
          bytesRead: current.bytesRead - (prior?.bytesRead ?? 0),
          bytesWritten: current.bytesWritten - (prior?.bytesWritten ?? 0),
          readOperations: current.readOperations - (prior?.readOperations ?? 0),
          writeOperations:
            current.writeOperations - (prior?.writeOperations ?? 0),
        };
      }
      return {
        label,
        totals: totalsSince,
        apiTotals: apiSince,
        unclassifiedPaths: newUnclassified,
        unmeasuredApis: newUnmeasured,
        replacements: after.replacements.slice(before.replacements.length),
        openHandles: after.openHandles,
        complete: newUnclassified.length === 0 && newUnmeasured.length === 0,
      };
    },
    restore(): void {
      activeWindow = undefined;
      restoreStack.restore();
    },
  };
}

export function captureC38Rewrites(): C38RewriteCapture {
  const records: ChatTranscriptFullRewriteDiagnostic[] = [];
  let clock = Date.now();
  let restored = false;
  setChatTranscriptRewriteDiagnosticsForTests({
    now: () => {
      clock += 60_001;
      return clock;
    },
    sink: (record): void => {
      records.push(record);
    },
  });
  return {
    get records(): readonly ChatTranscriptFullRewriteDiagnostic[] {
      return records.slice();
    },
    restore(): void {
      if (restored) return;
      restored = true;
      setChatTranscriptRewriteDiagnosticsForTests();
    },
  };
}

export function installC38CheckpointObserver(): C38CheckpointObserver {
  const mutationInputs: C38MutationInputObservation[] = [];
  const writerInputs: C38WriterInputObservation[] = [];
  const requests: C38CheckpointRequestObservation[] = [];
  const boundaries: C38CheckpointBoundaryObservation[] = [];
  const restoreStack = makeRestoreStack();

  const spies: TrackedSpy[] = [];
  // Jest records each call's arguments, instance and result until restore;
  // this observer never reads them, and mutation inputs carry whole payloads.
  const forgetCalls = (): void => spies.forEach((spy) => spy.mockClear());
  const trackSpy = (spy: TrackedSpy): void => {
    spies.push(spy);
    restoreStack.add(() => spy.mockRestore());
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured before spying, then invoked with call(this).
  const backendTransact = ChatStateV2Backend.prototype.transact;
  const backendTransactSpy = jest.spyOn(
    ChatStateV2Backend.prototype,
    'transact',
  );
  backendTransactSpy.mockImplementation(function (
    this: ChatStateV2Backend,
    build,
    mutationOptions,
  ) {
    forgetCalls();
    mutationInputs.push({
      checkpointRequested: mutationOptions.checkpoint === true,
    });
    return backendTransact.call(this, build, mutationOptions);
  });
  trackSpy(backendTransactSpy);

  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured before spying, then invoked with call(this).
  const backendAdmit = ChatStateV2Backend.prototype.admit;
  const backendAdmitSpy = jest.spyOn(ChatStateV2Backend.prototype, 'admit');
  backendAdmitSpy.mockImplementation(function (
    this: ChatStateV2Backend,
    build,
    mutationOptions,
  ) {
    forgetCalls();
    mutationInputs.push({
      checkpointRequested: mutationOptions.checkpoint === true,
    });
    return backendAdmit.call(this, build, mutationOptions);
  });
  trackSpy(backendAdmitSpy);

  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured before spying, then invoked with call(this).
  const writerCommit = ChatDeltaJournalWriter.prototype.commit;
  const writerCommitSpy = jest.spyOn(
    ChatDeltaJournalWriter.prototype,
    'commit',
  );
  writerCommitSpy.mockImplementation(function (
    this: ChatDeltaJournalWriter,
    input,
  ) {
    forgetCalls();
    writerInputs.push({ writeKinds: input.writes.map((write) => write.kind) });
    return writerCommit.call(this, input);
  });
  trackSpy(writerCommitSpy);

  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured before spying, then invoked with call(this).
  const writerAdmit = ChatDeltaJournalWriter.prototype.admit;
  const writerAdmitSpy = jest.spyOn(ChatDeltaJournalWriter.prototype, 'admit');
  writerAdmitSpy.mockImplementation(function (
    this: ChatDeltaJournalWriter,
    input,
  ) {
    forgetCalls();
    writerInputs.push({ writeKinds: input.writes.map((write) => write.kind) });
    return writerAdmit.call(this, input);
  });
  trackSpy(writerAdmitSpy);

  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured before spying, then invoked with call(this).
  const writerCheckpoint = ChatDeltaJournalWriter.prototype.checkpoint;
  const writerCheckpointSpy = jest.spyOn(
    ChatDeltaJournalWriter.prototype,
    'checkpoint',
  );
  writerCheckpointSpy.mockImplementation(async function (
    this: ChatDeltaJournalWriter,
  ) {
    forgetCalls();
    requests.push({ kind: 'writer-checkpoint' });
    try {
      const result = await writerCheckpoint.call(this);
      boundaries.push({ kind: 'writer-checkpoint', result: 'completed' });
      return result;
    } catch (error) {
      boundaries.push({ kind: 'writer-checkpoint', result: 'failed' });
      throw error;
    }
  });
  trackSpy(writerCheckpointSpy);

  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured before spying, then invoked with call(this).
  const backendFlush = ChatStateV2Backend.prototype.flush;
  const backendFlushSpy = jest.spyOn(ChatStateV2Backend.prototype, 'flush');
  backendFlushSpy.mockImplementation(async function (this: ChatStateV2Backend) {
    forgetCalls();
    requests.push({ kind: 'flush' });
    try {
      await backendFlush.call(this);
      boundaries.push({ kind: 'flush', result: 'completed' });
    } catch (error) {
      boundaries.push({ kind: 'flush', result: 'failed' });
      throw error;
    }
  });
  trackSpy(backendFlushSpy);

  /* eslint-disable @typescript-eslint/unbound-method -- Captured before spying, then invoked with call(this). */
  const pendingCheckpoint =
    ChatStateV2Backend.prototype.checkpointPendingJournal;
  /* eslint-enable @typescript-eslint/unbound-method */
  const pendingCheckpointSpy = jest.spyOn(
    ChatStateV2Backend.prototype,
    'checkpointPendingJournal',
  );
  pendingCheckpointSpy.mockImplementation(async function (
    this: ChatStateV2Backend,
    trigger,
  ) {
    forgetCalls();
    requests.push({
      kind: 'checkpointPendingJournal',
      ...(trigger === undefined ? {} : { trigger }),
    });
    try {
      const result = await pendingCheckpoint.call(this, trigger);
      boundaries.push({
        kind: 'checkpointPendingJournal',
        result: 'completed',
      });
      return result;
    } catch (error) {
      boundaries.push({ kind: 'checkpointPendingJournal', result: 'failed' });
      throw error;
    }
  });
  trackSpy(pendingCheckpointSpy);

  const snapshot = (): C38CheckpointSnapshot => ({
    mutationInputs: mutationInputs.slice(),
    writerInputs: writerInputs.slice(),
    requests: requests.slice(),
    boundaries: boundaries.slice(),
    workCounters: snapshotWorkCounters(),
  });

  return {
    snapshot,
    windowSince(before, after = snapshot()): C38CheckpointWindow {
      const mutationWindow = after.mutationInputs.slice(
        before.mutationInputs.length,
      );
      const writerWindow = after.writerInputs.slice(before.writerInputs.length);
      const requestWindow = after.requests.slice(before.requests.length);
      const boundaryWindow = after.boundaries.slice(before.boundaries.length);
      const workCounterDelta = deltaC38WorkCounters(
        before.workCounters,
        after.workCounters,
      );
      const sameCounterGeneration = !workCounterDelta.generationChanged;
      const completedCheckpoints = sameCounterGeneration
        ? (workCounterDelta.chatStorage['deltaJournal.checkpoints'] ?? 0)
        : undefined;
      const observedCauses = [
        ...mutationWindow
          .filter((input) => input.checkpointRequested)
          .map(() => 'commit-checkpoint-flag'),
        ...requestWindow.map((request) =>
          request.trigger === undefined
            ? request.kind
            : `${request.kind}:${request.trigger}`,
        ),
      ];
      const requestCauses = [...new Set(observedCauses)];
      return {
        mutationInputs: mutationWindow,
        writerInputs: writerWindow,
        requests: requestWindow,
        boundaries: boundaryWindow,
        completedCheckpoints,
        requestCauses,
        workCounterDelta,
      };
    },
    restore(): void {
      restoreStack.restore();
    },
  };
}

export function installC38Observation(
  options: C38ObservationOptions,
): C38Observation {
  const io = installC38IoObserver(options);
  let rewrites: C38RewriteCapture | undefined;
  let checkpoints: C38CheckpointObserver | undefined;
  try {
    rewrites = captureC38Rewrites();
    checkpoints = installC38CheckpointObserver();
  } catch (error) {
    checkpoints?.restore();
    rewrites?.restore();
    io.restore();
    throw error;
  }
  const capturedRewrites = rewrites;
  const capturedCheckpoints = checkpoints;
  let lastWindow: C38ObservationWindow | undefined;
  let restored = false;

  return {
    io,
    checkpoints: capturedCheckpoints,
    rewrites: capturedRewrites,
    get lastWindow(): C38ObservationWindow | undefined {
      return lastWindow;
    },
    async withDrainedWindow<T>(
      label: string,
      drainBefore: () => Promise<void>,
      operation: () => Promise<T>,
      drainAfter: () => Promise<void>,
    ): Promise<C38ObservedWindowResult<T>> {
      if (restored) throw new Error('Observation already restored');
      await drainBefore();
      const ioBefore = io.snapshot();
      const checkpointBefore = capturedCheckpoints.snapshot();
      const rewriteBefore = capturedRewrites.records.length;
      io.setActiveWindow(label);
      let outcome:
        | { readonly ok: true; readonly value: T }
        | {
            readonly ok: false;
            readonly error: unknown;
          };
      try {
        outcome = { ok: true, value: await operation() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        await drainAfter();
      } catch (error) {
        if (outcome.ok) outcome = { ok: false, error };
      } finally {
        io.setActiveWindow(undefined);
      }
      const ioAfter = io.snapshot();
      const checkpointAfter = capturedCheckpoints.snapshot();
      const rewriteRecords = capturedRewrites.records.slice(rewriteBefore);
      const window: C38ObservationWindow = {
        label,
        io: io.windowSince(label, ioBefore, ioAfter),
        rewrites: rewriteRecords,
        checkpoints: capturedCheckpoints.windowSince(
          checkpointBefore,
          checkpointAfter,
        ),
      };
      lastWindow = window;
      if (!outcome.ok) throw outcome.error;
      return { value: outcome.value, window };
    },
    restore(): void {
      if (restored) return;
      restored = true;
      let failure: unknown;
      for (const restore of [
        (): void => capturedCheckpoints.restore(),
        (): void => capturedRewrites.restore(),
        (): void => io.restore(),
      ]) {
        try {
          restore();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined)
        throw failure instanceof Error
          ? failure
          : new Error('Observer restoration failed');
    },
  };
}

export function evaluateC38StatusWindow(
  window: C38ObservationWindow,
  oracles: C38StatusOracles = {},
): C38StatusEvaluation {
  const violations: string[] = [];
  if (oracles.rawParentRowsUnchanged === false) {
    violations.push('Raw parent rows changed during the observation');
  }
  if (oracles.rawReferenceUnchanged === false) {
    violations.push('Raw parent reference changed during the observation');
  }
  if (window.rewrites.length > 0) {
    violations.push(`Observed ${window.rewrites.length} rewrite diagnostic(s)`);
  }
  const parentJsonl = window.io.totals['parent-jsonl'];
  if (parentJsonl.bytesWritten > 0) {
    violations.push(
      `Parent JSONL wrote ${parentJsonl.bytesWritten} application-level byte(s)`,
    );
  }
  if (parentJsonl.bytesRead > 2 * 1024 * 1024) {
    violations.push(
      `Parent JSONL read ${parentJsonl.bytesRead} byte(s), over the 2 MiB operation cap`,
    );
  }
  if (window.checkpoints.completedCheckpoints === undefined) {
    violations.push('Checkpoint work-counter delta is unavailable');
  } else if (window.checkpoints.completedCheckpoints > 0) {
    violations.push(
      `Completed ${window.checkpoints.completedCheckpoints} physical checkpoint(s)`,
    );
  }
  if (window.checkpoints.requestCauses.length > 0) {
    violations.push(
      `Observed checkpoint cause(s): ${window.checkpoints.requestCauses.join(', ')}`,
    );
  }
  if (!window.io.complete) {
    violations.push(
      `I/O inventory incomplete: ${[
        ...window.io.unclassifiedPaths,
        ...window.io.unmeasuredApis,
      ].join(', ')}`,
    );
  }
  return { passed: violations.length === 0, violations };
}

export function measureC38SerializedSizes(
  values: readonly unknown[],
): C38SerializedSizeSummary {
  const sizes = values.map((value) => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error('Cannot measure a value without a JSON representation');
    }
    return Buffer.byteLength(serialized, 'utf8');
  });
  const sorted = sizes.slice().sort((left, right) => left - right);
  const atPercentile = (percentile: number): number | null => {
    if (sorted.length === 0) return null;
    const index = Math.ceil(sorted.length * percentile) - 1;
    return sorted[index] ?? null;
  };
  return {
    count: sizes.length,
    minBytes: sorted[0] ?? null,
    p50Bytes: atPercentile(0.5),
    p95Bytes: atPercentile(0.95),
    maxBytes: sorted[sorted.length - 1] ?? null,
    sumBytes: sorted.reduce((sum, size) => sum + size, 0),
    sizesBytes: sizes,
  };
}

export function sampleC38Memory(gc?: C38GarbageCollector): C38MemorySample {
  const before = process.memoryUsage();
  if (gc === undefined || !gc.verified) {
    return {
      gcAvailable: false,
      gcMethod: gc?.method ?? null,
      rawHeapUsedBytes: before.heapUsed,
      rawRssBytes: before.rss,
      postGcHeapUsedBytes: null,
      postGcRssBytes: null,
    };
  }
  // This records an available explicit collector, not isolated-process proof.
  // A memory acceptance claim still requires an external isolated-run check.
  gc.collect();
  const after = process.memoryUsage();
  return {
    gcAvailable: true,
    gcMethod: gc.method,
    rawHeapUsedBytes: before.heapUsed,
    rawRssBytes: before.rss,
    postGcHeapUsedBytes: after.heapUsed,
    postGcRssBytes: after.rss,
  };
}
