import { randomUUID } from 'node:crypto';
import { open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

/** Code units staged or transcoded per step; keeps every buffer bounded. */
const SLICE_CODE_UNITS = 16_384;
/**
 * Longest string {@link FieldSpool.strings} yields: one read slice plus a
 * high surrogate carried from the previous slice. A UTF-8 encoder needs at
 * most three bytes per code unit.
 */
export const SPOOL_MAX_STRING_CODE_UNITS = SLICE_CODE_UNITS + 1;
/** Encoded bytes processed between cooperative yields. */
export const SPOOL_YIELD_BYTES = 1024 * 1024;

export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Decides, across arbitrary chunk boundaries, whether a UTF-16 code unit
 * sequence holds an unpaired surrogate. A high surrogate at the end of one
 * chunk pairs with a low surrogate at the start of the next non-empty chunk.
 * The result equals the whole-string test the artifact codec applies.
 */
export class SurrogateTracker {
  private pendingHigh = false;
  private unpaired = false;

  public accept(chunk: string): void {
    if (this.unpaired || chunk.length === 0) return;
    if (!this.pendingHigh && !/[\uD800-\uDFFF]/.test(chunk)) return;
    for (let index = 0; index < chunk.length; index += 1) {
      const unit = chunk.charCodeAt(index);
      if (this.pendingHigh) {
        this.pendingHigh = false;
        if (isLowSurrogate(unit)) continue;
        this.unpaired = true;
        return;
      }
      if (isHighSurrogate(unit)) this.pendingHigh = true;
      else if (isLowSurrogate(unit)) {
        this.unpaired = true;
        return;
      }
    }
  }

  /** True when the complete sequence holds an unpaired surrogate. */
  public finish(): boolean {
    return this.unpaired || this.pendingHigh;
  }
}

/**
 * A same-directory staging file holding the exact UTF-16LE code units of a
 * body that arrives in chunks. It never holds the whole body in memory and
 * never converts a code unit, so finalization can choose the encoding the
 * whole-string codec would choose.
 */
export class FieldSpool {
  private readonly tracker = new SurrogateTracker();
  /** Appends accumulate here, so many small deltas cost few writes. */
  private readonly buffer = Buffer.allocUnsafe(SLICE_CODE_UNITS * 2);
  private pending = 0;
  private bytes = 0;
  private bytesSinceYield = 0;
  private finished = false;
  private closed = false;

  private constructor(
    public readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  /** Create the staging file; capture already ignores `.<uuid>.tmp` names. */
  public static async create(directory: string): Promise<FieldSpool> {
    const path = join(directory, `.${randomUUID()}.tmp`);
    return new FieldSpool(path, await open(path, 'wx+', 0o600));
  }

  public async append(chunk: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.finished) throw new Error('Staged transcript field is finished');
    for (let start = 0; start < chunk.length; ) {
      const room = (this.buffer.length - this.pending) / 2;
      const slice = chunk.slice(start, start + room);
      this.tracker.accept(slice);
      this.pending += this.buffer.write(
        slice,
        this.pending,
        this.buffer.length - this.pending,
        'utf16le',
      );
      start += slice.length;
      if (this.pending === this.buffer.length) await this.flush(signal);
    }
  }

  private async flush(signal?: AbortSignal): Promise<void> {
    let offset = 0;
    while (offset < this.pending) {
      const result = await this.handle.write(
        this.buffer,
        offset,
        this.pending - offset,
        this.bytes,
      );
      offset += result.bytesWritten;
      this.bytes += result.bytesWritten;
    }
    this.bytesSinceYield += this.pending;
    this.pending = 0;
    if (this.bytesSinceYield >= SPOOL_YIELD_BYTES) {
      this.bytesSinceYield = 0;
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
  }

  /**
   * Write any buffered code units and return the encoding the whole-string
   * codec selects for the staged body: UTF-8 unless it holds an unpaired
   * surrogate. No append is accepted afterwards.
   */
  public async finish(signal?: AbortSignal): Promise<'utf-8' | 'utf-16le'> {
    if (!this.finished) {
      await this.flush(signal);
      this.finished = true;
    }
    return this.tracker.finish() ? 'utf-16le' : 'utf-8';
  }

  /**
   * Staged code units in bounded, surrogate-safe strings of at most
   * {@link SPOOL_MAX_STRING_CODE_UNITS}: a well-formed pair is never split
   * between two yielded strings.
   */
  public async *strings(signal?: AbortSignal): AsyncGenerator<string> {
    if (!this.finished) throw new Error('Staged transcript field is open');
    const raw = Buffer.allocUnsafe(SLICE_CODE_UNITS * 2);
    let position = 0;
    let carry = '';
    while (position < this.bytes) {
      signal?.throwIfAborted();
      const length = Math.min(raw.length, this.bytes - position);
      let read = 0;
      while (read < length) {
        const result = await this.handle.read(
          raw,
          read,
          length - read,
          position + read,
        );
        if (result.bytesRead === 0)
          throw new Error('Unexpected end of staged transcript field');
        read += result.bytesRead;
      }
      position += read;
      let text = carry + raw.toString('utf16le', 0, read);
      carry = '';
      if (
        position < this.bytes &&
        text.length > 0 &&
        isHighSurrogate(text.charCodeAt(text.length - 1))
      ) {
        carry = text.slice(-1);
        text = text.slice(0, -1);
      }
      if (text.length > 0) yield text;
    }
    if (carry.length > 0) yield carry;
  }

  /** Staged bytes as stored, for a body whose artifact is UTF-16LE. */
  public async *rawChunks(signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (!this.finished) throw new Error('Staged transcript field is open');
    const raw = Buffer.allocUnsafe(SLICE_CODE_UNITS * 4);
    let position = 0;
    while (position < this.bytes) {
      signal?.throwIfAborted();
      const result = await this.handle.read(
        raw,
        0,
        Math.min(raw.length, this.bytes - position),
        position,
      );
      if (result.bytesRead === 0)
        throw new Error('Unexpected end of staged transcript field');
      position += result.bytesRead;
      // The caller consumes each view before the next read overwrites it.
      yield raw.subarray(0, result.bytesRead);
    }
  }

  /** Sync the staged file so it can be renamed into place as an artifact. */
  public async sync(): Promise<void> {
    await this.handle.sync();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  /** Close and remove the staging file; safe after any failure. */
  public async discard(): Promise<void> {
    try {
      await this.close();
    } finally {
      await rm(this.path, { force: true });
    }
  }
}
