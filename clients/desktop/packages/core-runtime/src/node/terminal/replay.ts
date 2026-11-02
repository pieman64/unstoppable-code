/**
 * The most recent bytes of one terminal's output, addressed by byte offset.
 * The offset of a byte is its position in everything the terminal has
 * written since it started (or since its restored history began), so
 * `endOffset` is the `seq` the terminal reports for its last byte.
 */
export class TerminalReplayWindow {
  private bytes: Buffer;

  private end: number;

  public constructor(
    public readonly capacity: number,
    initial: Buffer = Buffer.alloc(0),
  ) {
    this.bytes = Buffer.alloc(0);
    this.end = 0;
    this.append(initial);
  }

  /** Offset just past the last byte held. */
  public get endOffset(): number {
    return this.end;
  }

  /** Offset of the oldest byte still held. */
  public get startOffset(): number {
    return this.end - this.bytes.length;
  }

  public append(chunk: Buffer): void {
    this.end += chunk.length;
    if (chunk.length >= this.capacity) {
      this.bytes = Buffer.from(chunk.subarray(chunk.length - this.capacity));
      return;
    }
    const combined = Buffer.concat([this.bytes, chunk]);
    this.bytes =
      combined.length <= this.capacity
        ? combined
        : combined.subarray(combined.length - this.capacity);
  }

  /** Every byte held. */
  public snapshot(): Buffer {
    return this.bytes;
  }

  /**
   * The bytes from `from` up to `to`, or null when `from` has already left
   * the window.
   */
  public slice(from: number, to: number): Buffer | null {
    const start = this.startOffset;
    if (from < start || to > this.end || to < from) return null;
    return this.bytes.subarray(from - start, to - start);
  }

  public text(): string {
    return this.bytes.toString('utf8');
  }
}
