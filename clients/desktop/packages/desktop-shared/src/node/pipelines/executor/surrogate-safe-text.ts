/**
 * Keeps a surrogate pair inside ONE write.
 *
 * Every write is encoded to UTF-8 independently. A high surrogate at the end
 * of one write and its low surrogate at the start of the next each encode to
 * U+FFFD, so the bytes on disk are corrupt even though concatenating the two
 * strings reconstructs the character perfectly. That is why the corruption
 * survived tests that compared reconstructed text: only the encoded bytes show
 * it.
 *
 * Text is produced here in code units — the raw matcher's holdback, a replay
 * chunk, a token block — so a cut between the halves of an astral character is
 * ordinary, not exotic. Holding a trailing lone high surrogate back until the
 * next write makes every write a complete sequence.
 */
export class SurrogatePairGuard {
  private held = '';

  /** Characters retained, so a caller's memory accounting can include them. */
  get heldLength(): number {
    return this.held.length;
  }

  /**
   * Returns the text that is safe to write now, carrying forward anything held
   * from the previous call.
   */
  take(text: string): string {
    const combined = this.held.length === 0 ? text : this.held + text;
    this.held = '';
    if (combined.length === 0) return '';
    const last = combined.charCodeAt(combined.length - 1);
    // A high surrogate on its own is only half a character; its partner is in
    // the next write, if there is one.
    if (last >= 0xd800 && last <= 0xdbff) {
      this.held = combined.charAt(combined.length - 1);
      return combined.slice(0, -1);
    }
    return combined;
  }

  /**
   * Releases anything still held, for the last write.
   *
   * A lone high surrogate at the very end of the stream is genuinely lone —
   * the child wrote unpaired text — so emitting it is faithful to the input
   * rather than a loss.
   */
  flush(): string {
    const held = this.held;
    this.held = '';
    return held;
  }
}
