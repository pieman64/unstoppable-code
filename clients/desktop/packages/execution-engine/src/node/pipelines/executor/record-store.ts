import { createWriteStream, type WriteStream } from 'node:fs';
import { rm, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import { openScratchFile } from './private-scratch-file';
import { SurrogatePairGuard } from './surrogate-safe-text';

/**
 * One record-assembly store with two backings.
 *
 * Below the spill threshold a record lives in memory; above it the same store
 * keeps writing to a private file. Callers see one interface and one set of
 * semantics either way, so the backing choice can never change which input is
 * accepted or what is emitted — only where the bytes sit.
 *
 * Flow control waits on the STORE's write queue, which drains on its own.
 * Pausing a child because its own unfinished line is large is a circular wait:
 * the line shrinks only when it ends, and it ends only if the child writes
 * more.
 */
export interface RecordStore {
  /** Appends to the record. `false` means the write queue is saturated. */
  append(text: string): boolean;
  /** Resolves when a saturated write queue has drained. */
  whenDrained(): Promise<void>;
  /** Characters appended so far. */
  readonly length: number;
  /** True once the record is file-backed. */
  readonly spilled: boolean;
  /**
   * Characters still held in memory rather than written out.
   *
   * Exposed because the resident term a caller reports has to include it: a
   * store that is still waiting for its file holds the whole record, and an
   * accounting that leaves it out reports a bound it is not measuring.
   */
  readonly residentLength: number;
  /**
   * Resolves while the backing file is still being created, or `undefined`
   * once there is nothing to wait for.
   *
   * Creating the file is asynchronous, and until it exists appends keep
   * landing in memory. A caller that cannot wait for this has no bound at all
   * — the threshold only means something if somebody pauses on it.
   */
  settling(): Promise<void> | undefined;
  /**
   * The private directory the record's file was created in, once it is
   * file-backed.
   *
   * Exposed so a storage failure can name the path it failed on, and so
   * disposal can be checked against the directory that was actually created
   * rather than against whatever else happens to be in the temp directory.
   * The file itself is unlinked before its first write, so normally neither
   * exists by the time a caller reads this.
   */
  readonly location: string | undefined;
  /**
   * Replays the record in bounded chunks. May be called more than once.
   *
   * Deliberately NOT a `read(): Promise<string>` — returning the whole record
   * as one string reintroduces exactly the resident term the store exists to
   * remove.
   */
  replay(): AsyncIterable<string>;
  /** Closes and removes any file. Idempotent, safe after an error or close. */
  dispose(): Promise<void>;
}

/** Bytes handed to the filesystem per write. */
const REPLAY_CHUNK_CHARS = 64 * 1024;

class FileRecordStore implements RecordStore {
  /**
   * Written text is encoded per call, so a surrogate pair split across two
   * appends would reach the file as two replacement characters and come back
   * corrupt from `replay`. A token block boundary lands mid-character often
   * enough for this to be ordinary.
   */
  private readonly pairs = new SurrogatePairGuard();
  private stream: WriteStream | undefined;
  private draining: Promise<void> | undefined;
  private failure: Error | undefined;
  private total = 0;
  private closed = false;

  constructor(
    private readonly directory: string,
    file: string,
    /**
     * The only way to reach the record: it is unlinked before its first write
     * (see `openScratchFile`). The write stream borrows its descriptor and
     * never closes it; disposal does, which is also when the kernel frees the
     * file. The stream is given the bare descriptor, not the handle: a stream
     * built on a `FileHandle` holds a reference that makes `close()` wait
     * until the stream is destroyed, and this one never is.
     */
    private readonly handle: FileHandle,
    seed: readonly string[],
    private readonly encoding: RecordEncoding = 'utf8',
  ) {
    this.stream = createWriteStream(file, {
      fd: handle.fd,
      autoClose: false,
    });
    this.stream.on('error', (error: Error) => {
      // Recorded rather than thrown: an 'error' event with no handler takes the
      // whole host down, and this must fail only the step that owns it.
      this.failure = error;
    });
    for (const part of seed) this.append(part);
  }

  get length(): number {
    return this.total;
  }
  get spilled(): boolean {
    return true;
  }
  get location(): string {
    return this.directory;
  }
  get residentLength(): number {
    // The held half-character plus whatever the stream has queued but not yet
    // handed to the filesystem. Both are memory this store is responsible for.
    return this.pairs.heldLength + (this.stream?.writableLength ?? 0);
  }

  settling(): undefined {
    return undefined;
  }

  append(text: string): boolean {
    if (this.failure) throw this.failure;
    const stream = this.stream;
    if (!stream) throw new Error('Record store is closed');
    this.total += text.length;
    // UTF-16LE stores each code unit as-is, lone surrogates included, so only
    // UTF-8 needs a split pair held together.
    const safe = this.encoding === 'utf8' ? this.pairs.take(text) : text;
    if (safe.length === 0) return !stream.writableNeedDrain;
    return stream.write(safe, this.encoding);
  }

  whenDrained(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const stream = this.stream;
    if (!stream) return Promise.resolve();
    // Nothing is waiting to drain, so no 'drain' event is coming. Waiting for
    // one anyway hangs forever, which is exactly what an unsaturated caller
    // asking "are you drained?" would get.
    if (!stream.writableNeedDrain) return Promise.resolve();
    // One shared wait, not one per caller: several callers can be waiting on
    // the same saturated stream, and attaching a listener pair each produced a
    // MaxListenersExceededWarning — a real accumulation, benign only because
    // the events eventually fire.
    const waiting = this.draining;
    if (waiting) return waiting;
    const created = new Promise<void>((resolve, reject) => {
      const done = (): void => {
        stream.off('drain', onDrain);
        stream.off('close', done);
        stream.off('finish', done);
        stream.off('error', onError);
        resolve();
      };
      const onDrain = (): void => {
        done();
      };
      const onError = (error: Error): void => {
        stream.off('drain', onDrain);
        stream.off('close', done);
        stream.off('finish', done);
        reject(error);
      };
      // 'close' and 'finish' as well as 'drain'. A stream that is ending will
      // never emit 'drain' again, so waiting only for that never settles —
      // and the finalizer awaits these, so one unsettled wait hangs the step
      // past its own timeout. A closing store is drained as far as flow
      // control is concerned.
      stream.once('drain', onDrain);
      stream.once('close', done);
      stream.once('finish', done);
      stream.once('error', onError);
    }).finally(() => {
      this.draining = undefined;
    });
    this.draining = created;
    return created;
  }

  private async closeForReading(): Promise<void> {
    if (this.failure) throw this.failure;
    const stream = this.stream;
    if (!stream) return;
    this.stream = undefined;
    // A lone high surrogate at the very end of the record is genuinely lone.
    const trailing = this.pairs.flush();
    if (trailing.length > 0) stream.write(trailing, 'utf8');
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      stream.end(() => {
        resolve();
      });
    });
    // Read through a call, not as `this.failure`: the guard at the top of this
    // method narrows the property, and that narrowing survives the `await` even
    // though the stream's error handler can assign during it. Reading the field
    // directly here makes the re-check look dead to the compiler when it is the
    // only thing that catches a failure raised while the stream was closing.
    const late = this.recordedFailure();
    if (late) throw late;
  }

  private recordedFailure(): Error | undefined {
    return this.failure;
  }

  async *replay(): AsyncIterable<string> {
    await this.closeForReading();
    // Positional reads from the start, through the handle the record was
    // written with: the file has no name to open again. Read directly rather
    // than through a read stream, which closes a borrowed descriptor when it
    // is destroyed and so would end every later replay. The decoder is what a
    // read stream with an encoding uses, so a character split across two
    // reads is joined exactly as before.
    const decoder = new StringDecoder(this.encoding);
    const block = Buffer.allocUnsafe(REPLAY_CHUNK_CHARS);
    let position = 0;
    for (;;) {
      const { bytesRead } = await this.handle.read(
        block,
        0,
        block.length,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = decoder.write(block.subarray(0, bytesRead));
      if (text.length > 0) yield text;
    }
    const rest = decoder.end();
    if (rest.length > 0) yield rest;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pairs.flush();
    const stream = this.stream;
    this.stream = undefined;
    if (stream)
      await new Promise<void>((resolve) => {
        stream.end(() => {
          resolve();
        });
      }).catch(() => undefined);
    await this.handle.close().catch(() => undefined);
    // Normally already gone (see `openScratchFile`); removed here for the
    // platforms that keep an open file's entry until its handle closes.
    await rm(this.directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * A store that starts in memory and spills to a private file past a threshold.
 *
 * Spilling is asynchronous, so appends keep landing in memory until the file
 * exists. That window is bounded only if the caller WAITS for it, which is
 * what `settling()` is for — the claim used to be that one `mkdtemp` bounded
 * it regardless, and that was only true of the caller that happened to await.
 * An asynchronous filesystem completion can be delayed across many event-loop
 * turns, and a store that keeps accepting text through them has no bound at
 * all; `residentLength` reports what is actually held meanwhile.
 */
/**
 * How a file-backed store encodes its text.
 *
 * UTF-8 is compact and what every ordinary record uses. It cannot represent a
 * lone surrogate, which it replaces with U+FFFD — harmless for output the host
 * decoded from bytes, which never contains one, but not for DECODED JSON: an
 * escape such as `\ud800` decodes to exactly that. Text whose identity must
 * survive storage exactly uses UTF-16LE, which stores every code unit as-is.
 */
export type RecordEncoding = 'utf8' | 'utf16le';

export class SpillingRecordStore implements RecordStore {
  /** The in-memory backing IS this array, so nothing is stored twice. */
  private held: string[] = [];
  private heldLength = 0;
  private file: RecordStore | undefined;
  private pendingSpill: Promise<void> | undefined;
  private spillFailure: Error | undefined;

  constructor(
    private readonly spillAfterChars: number,
    private readonly label: string,
    private readonly encoding: RecordEncoding = 'utf8',
  ) {}

  get length(): number {
    return this.file ? this.file.length : this.heldLength;
  }
  get spilled(): boolean {
    return this.file !== undefined;
  }
  get location(): string | undefined {
    return this.file?.location;
  }
  get residentLength(): number {
    // Before the file exists the whole record is resident; after it, only
    // what the file store has not handed over yet.
    return this.file ? this.file.residentLength : this.heldLength;
  }
  /** Surfaced so a failure to spill fails the step rather than being swallowed. */
  get failure(): Error | undefined {
    return this.spillFailure;
  }

  /**
   * Resolves while a spill is still in flight.
   *
   * A caller whose source never yields to the event loop — an async generator
   * over an in-memory string, for instance — would otherwise keep appending
   * forever while `mkdtemp` sat in the I/O queue, and the whole point of the
   * threshold would be lost. Awaiting this is how a caller that CAN wait keeps
   * the resident window at the threshold instead of at the token's size.
   */
  settling(): Promise<void> | undefined {
    if (this.file) return undefined;
    return this.pendingSpill;
  }

  append(text: string): boolean {
    if (this.spillFailure) throw this.spillFailure;
    const file = this.file;
    if (file) return file.append(text);
    this.held.push(text);
    this.heldLength += text.length;
    if (this.heldLength >= this.spillAfterChars) this.beginSpill();
    return true;
  }

  private beginSpill(): void {
    if (this.pendingSpill) return;
    this.pendingSpill = createFileRecordStore(
      this.label,
      this.held,
      this.encoding,
    )
      .then((file) => {
        this.file = file;
        this.held = [];
      })
      .catch((error: unknown) => {
        this.spillFailure =
          error instanceof Error ? error : new Error(String(error));
      });
  }

  async whenDrained(): Promise<void> {
    if (this.pendingSpill) await this.pendingSpill;
    if (this.spillFailure) throw this.spillFailure;
    await (this.file?.whenDrained() ?? Promise.resolve());
  }

  async *replay(): AsyncIterable<string> {
    if (this.pendingSpill) await this.pendingSpill;
    if (this.spillFailure) throw this.spillFailure;
    const file = this.file;
    if (file) {
      yield* file.replay();
      return;
    }
    // Chunked even in memory, so both backings drive consumers identically.
    for (const part of this.held)
      for (let at = 0; at < part.length; at += REPLAY_CHUNK_CHARS)
        yield part.slice(at, at + REPLAY_CHUNK_CHARS);
  }

  async dispose(): Promise<void> {
    // Await an in-flight spill first, or its file would outlive this call.
    if (this.pendingSpill) await this.pendingSpill.catch(() => undefined);
    this.held = [];
    this.heldLength = 0;
    const file = this.file;
    this.file = undefined;
    if (file) await file.dispose();
  }
}

/**
 * Creates a file-backed store whose file has no name from before its first
 * write, so no ending — SIGKILL included — can leave the record on disk.
 */
export async function createFileRecordStore(
  label: string,
  seed: readonly string[] = [],
  encoding: RecordEncoding = 'utf8',
): Promise<RecordStore> {
  const { handle, directory, path } = await openScratchFile(
    `canopy-record-${label}-`,
    'record',
  );
  return new FileRecordStore(directory, path, handle, seed, encoding);
}

/**
 * Storage cleanup still running after the step that owned it has settled.
 *
 * A cancelled or timed-out step must settle promptly, but the filesystem work
 * it started — a `mkdtemp` that has not returned, a replay still reading —
 * cannot be interrupted. Settling the caller does not abandon that work: it is
 * registered here, its failures are observed rather than left unhandled, and
 * the private directory is removed when it finally appears.
 */
const lateCleanups = new Set<Promise<void>>();

export function trackLateStorageCleanup(work: Promise<unknown>): void {
  const tracked: Promise<void> = work
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      lateCleanups.delete(tracked);
    });
  lateCleanups.add(tracked);
}

/** Resolves once every late cleanup — including ones it started — has run. */
export async function settleLateStorageCleanups(): Promise<void> {
  while (lateCleanups.size > 0) await Promise.all(Array.from(lateCleanups));
}
