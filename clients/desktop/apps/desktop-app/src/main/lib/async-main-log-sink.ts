import {
  appendFile,
  mkdir,
  open,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { EOL } from 'node:os';
import { dirname, extname, basename, join } from 'node:path';

export interface MainLogFlushResult {
  /** All counters are cumulative through this fence, not a durability/fsync claim. */
  throughSequence: number;
  writtenRecords: number;
  failedRecords: number;
  droppedRecords: number;
  failedGapNotices: number;
}

/** One file operation at a time; logging admission never performs file I/O. */
export class AsyncMainLogSink {
  private tail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private size: number | null = null;
  private nextRotationAttemptAt = 0;
  private sequence = 0;
  private written = 0;
  private failed = 0;
  private dropped = 0;
  private gap = 0;
  private gapQueued = false;
  private failedGaps = 0;
  private closed = false;
  private terminalFence: Promise<MainLogFlushResult> | null = null;

  constructor(
    private readonly options: {
      path: string;
      maxSize: number;
      maxPendingBytes: number;
      fallback: (message: string, context?: unknown) => void;
    },
  ) {}

  public append(content: string): void {
    const text = content + EOL;
    const bytes = Buffer.byteLength(text);
    if (
      this.closed ||
      bytes > this.options.maxPendingBytes - this.pendingBytes
    ) {
      this.dropped += 1;
      this.gap += 1;
      // Report once per pending gap, never through the forwarded console.
      if (this.gap === 1)
        this.report('Main log admission lost records', { closed: this.closed });
      return;
    }
    this.queueGap();
    this.sequence += 1;
    this.pendingBytes += bytes;
    this.tail = this.tail.then(async (): Promise<void> => {
      try {
        await this.write(text);
        this.written += 1;
      } catch (error) {
        this.failed += 1;
        this.size = null; // Re-stat before attempting a later entry.
        this.report('Main log append failed', error);
      } finally {
        this.pendingBytes -= bytes;
      }
    });
  }

  public rejectRecord(): void {
    this.dropped += 1;
    this.gap += 1;
    if (this.gap === 1) this.report('Main log admission lost records');
  }

  private report(message: string, context?: unknown): void {
    try {
      this.options.fallback(message, context);
    } catch {
      /* Diagnostics cannot break admission. */
    }
  }

  private queueGap(): void {
    if (this.gap === 0 || this.gapQueued) return;
    this.gapQueued = true;
    // Small counted notice, not the lost payloads. All accepted payloads are capped.
    this.tail = this.tail.then(async (): Promise<void> => {
      const count = this.gap;
      this.gap = 0;
      this.gapQueued = false;
      try {
        await this.write(`[main log gap: ${count} records not admitted]${EOL}`);
      } catch (error) {
        this.failedGaps += 1;
        this.size = null;
        this.report('Main log gap notice failed', error);
      }
    });
  }

  private async write(text: string): Promise<void> {
    if (this.size === null) {
      await mkdir(dirname(this.options.path), { recursive: true });
      try {
        this.size = (await stat(this.options.path)).size;
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
        this.size = 0;
      }
    }
    if (
      this.options.maxSize > 0 &&
      this.size > this.options.maxSize &&
      performance.now() >= this.nextRotationAttemptAt
    ) {
      const extension = extname(this.options.path);
      const archive = join(
        dirname(this.options.path),
        `${basename(this.options.path, extension)}.old${extension}`,
      );
      try {
        await rename(this.options.path, archive);
        this.size = 0;
        this.nextRotationAttemptAt = 0;
      } catch (error) {
        this.report('Could not rotate main log; cropping', error);
        try {
          const handle = await open(this.options.path, 'r');
          let tail: Buffer;
          try {
            const size = (await handle.stat()).size;
            const length = Math.min(
              size,
              Math.round(this.options.maxSize / 4),
              256 * 1024,
            );
            const buffer = Buffer.alloc(length);
            const read = await handle.read(buffer, 0, length, size - length);
            tail = buffer.subarray(0, read.bytesRead);
          } finally {
            await handle.close();
          }
          const cropped = `[log cropped]${EOL}${tail.toString('utf8')}${EOL}`;
          await writeFile(this.options.path, cropped, {
            mode: 0o666,
            encoding: 'utf8',
          });
          this.size = Buffer.byteLength(cropped);
          this.nextRotationAttemptAt = 0;
        } catch (cropError) {
          // Rotation is ancillary: the library still appends after crop failure.
          // A partial crop may have changed the file even when it rejected.
          this.size = null;
          this.nextRotationAttemptAt = performance.now() + 5000;
          this.report('Could not crop main log; continuing append', cropError);
        }
      }
    }
    await appendFile(this.options.path, text, {
      mode: 0o666,
      encoding: 'utf8',
    });
    if (this.size !== null) {
      this.size += Buffer.byteLength(text);
    } else {
      try {
        this.size = (await stat(this.options.path)).size;
      } catch {
        // The append succeeded; an unknown size must not mark its record failed.
        // Keep null so the next entry re-stats before considering rotation.
      }
    }
  }

  public flush(): Promise<MainLogFlushResult> {
    if (this.terminalFence) return this.terminalFence;
    this.queueGap();
    const throughSequence = this.sequence;
    const droppedRecords = this.dropped;
    return this.tail.then(
      (): MainLogFlushResult => ({
        throughSequence,
        droppedRecords,
        writtenRecords: this.written,
        failedRecords: this.failed,
        failedGapNotices: this.failedGaps,
      }),
    );
  }

  public drain(): Promise<MainLogFlushResult> {
    if (this.terminalFence) return this.terminalFence;
    this.closed = true;
    this.terminalFence = this.flush();
    return this.terminalFence;
  }
}
