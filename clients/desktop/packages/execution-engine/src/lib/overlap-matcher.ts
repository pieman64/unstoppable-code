/**
 * Work counters a caller can observe. The streaming record redactor shares its
 * own so its tests can assert bounded retention; other callers get a private
 * set.
 */
export interface OverlapMatcherCounters {
  charsScanned: number;
  windowCompactions: number;
  maxWindowChars: number;
  maxWindowParts: number;
}

/**
 * Search work every matcher in this process has done: one step per prefix
 * transition and per recorded occurrence visited or moved.
 *
 * PROCESS-GLOBAL and monotonic, like the other work counters here, so a delta
 * taken around one run is that run's work only when nothing else is running —
 * true of the tests that read it and not in general. It exists so "linear" is
 * measured: the work it counts is proportional to pushed characters times
 * values in progress, never to how many characters are held back.
 */
export const overlapMatcherWorkCounters = { searchSteps: 0 };

/**
 * Bounded streaming matcher with the same overlap-union semantics as
 * `extendMatchToFurthestOverlap`.
 *
 * Emitting a match as soon as it is found and moving on forgets that a LATER
 * occurrence — of another value or of the same periodic one — can start inside
 * the current span and extend it. `ABCDEF` + `CDEFGH` over `ABCDEFGH` is one
 * span, not `***GH`; `ABABAB` over `ABABABABAB` is one span, not `***ABAB`.
 *
 * Retention is bounded even for an arbitrarily long periodic run: once a match
 * has started its characters are never emitted, so everything before
 * `matchEnd - maxLength + 1` is dropped as it can no longer begin an extension.
 */
export class OverlapMatcher {
  /**
   * Decoded characters, with `head` marking how many have been released.
   *
   * An offset rather than a slice per character: `serialized.slice(1)` on
   * every push allocated a fresh array per character of every token, which is
   * per-character work proportional to the window and was the dominant
   * allocation on a large key. Compaction happens once per `COMPACT_AFTER`
   * released characters instead, which is amortized O(1).
   */
  private buffer = '';
  /** Serialized text for each decoded character, same indexing as `buffer`. */
  private parts: string[] = [];
  private head = 0;
  private inMatch = false;
  /** True once any span has been replaced. */
  matchedAny = false;
  /** Index, relative to `head`, where the current match ends. */
  private matchEnd = 0;
  private readonly maxLength: number;
  /** Characters kept back when nothing matches: one short of the longest value. */
  private readonly holdBack: number;
  /**
   * For each value, how many of its leading characters the stream currently
   * ends with (a KMP state). A completed shorter match is not committed while
   * a value that started earlier can still complete: whole-text masking would
   * mask from that earlier start, and once the text before a committed mask
   * is released the longer value can no longer be masked at all.
   */
  private readonly prefixMatched: Int32Array;
  /** Each value's UTF-16 code units, and its KMP failure table. */
  private readonly codes: Uint16Array[];
  private readonly failure: Int32Array[];
  /** Code units some value begins with; with no value in progress, nothing
   * else can change a state. */
  private readonly startsValue = new Uint8Array(65_536);
  /** How many values are partly matched right now. */
  private inProgress = 0;
  /** Absolute position of `buffer[0]`: characters compacted away before it. */
  private offset = 0;
  /**
   * Every complete occurrence the prefix states have found that could still
   * matter, as absolute `[start, end)` pairs sorted by start and then by
   * longest end. Entries before `pendingHead` are spent: they start before
   * `head`, or inside a match that already absorbed them.
   *
   * Occurrences used to be rediscovered by searching the whole held window
   * for every value on every pushed character — one character less than the
   * longest value, so a PEM key made each character cost thousands of
   * comparisons. The prefix states already see every occurrence complete, in
   * O(1) amortized per value, so they are recorded once, where they end.
   */
  private pendingStart: number[] = [];
  private pendingEnd: number[] = [];
  private pendingHead = 0;

  /**
   * @param emit Receives released text in order, with how many pushed
   *   characters it covers; the `***` for a match covers none.
   * @param onDrop Told how many pushed characters a match consumed, after its
   *   `***` was emitted. A caller that tracks where each character came from
   *   uses the two counts to keep that bookkeeping aligned.
   */
  constructor(
    private readonly values: readonly string[],
    private readonly emit: (text: string, consumed: number) => void,
    private readonly counters: OverlapMatcherCounters = {
      charsScanned: 0,
      windowCompactions: 0,
      maxWindowChars: 0,
      maxWindowParts: 0,
    },
    private readonly onDrop?: (consumed: number) => void,
  ) {
    this.maxLength = values.reduce(
      (longest, value) => Math.max(longest, value.length),
      0,
    );
    this.holdBack = Math.max(0, this.maxLength - 1);
    this.prefixMatched = new Int32Array(values.length);
    this.codes = values.map((value) => {
      const codes = new Uint16Array(value.length);
      for (let at = 0; at < value.length; at += 1)
        codes[at] = value.charCodeAt(at);
      return codes;
    });
    for (const codes of this.codes)
      if (codes.length > 0) this.startsValue[codes[0] ?? 0] = 1;
    this.failure = this.codes.map((codes) => {
      const table = new Int32Array(codes.length);
      let matched = 0;
      for (let at = 1; at < codes.length; at += 1) {
        while (matched > 0 && codes[at] !== codes[matched])
          matched = table[matched - 1] ?? 0;
        if (codes[at] === codes[matched]) matched += 1;
        table[at] = matched;
      }
      return table;
    });
  }

  /** Advances every value's prefix state by one decoded character. */
  private advancePrefixes(character: string): void {
    const code = character.charCodeAt(0);
    if (this.inProgress === 0 && this.startsValue[code] !== 1) return;
    const states = this.prefixMatched;
    let inProgress = 0;
    for (let index = 0; index < states.length; index += 1) {
      const codes = this.codes[index];
      const table = this.failure[index];
      if (codes === undefined || table === undefined || codes.length === 0)
        continue;
      let matched = states[index] ?? 0;
      if (matched === codes.length) matched = table[matched - 1] ?? 0;
      while (matched > 0 && codes[matched] !== code)
        matched = table[matched - 1] ?? 0;
      if (codes[matched] === code) matched += 1;
      states[index] = matched;
      if (matched > 0) inProgress += 1;
      if (matched === codes.length) this.record(codes.length);
    }
    overlapMatcherWorkCounters.searchSteps += states.length;
    this.inProgress = inProgress;
  }

  /**
   * Records an occurrence of a `length`-character value ending at the newest
   * pushed character, keeping the pending list sorted.
   */
  private record(length: number): void {
    const end = this.offset + this.buffer.length;
    const start = end - length;
    // Its first characters were already released or consumed: whole-text
    // masking from `head` would not find it either.
    if (start < this.offset + this.head) return;
    const starts = this.pendingStart;
    const ends = this.pendingEnd;
    // Occurrences arrive in end order, so a new one belongs at or near the
    // tail; walk back past any that start later, or at the same place but
    // end sooner.
    let at = starts.length;
    while (
      at > this.pendingHead &&
      ((starts[at - 1] ?? 0) > start ||
        ((starts[at - 1] ?? 0) === start && (ends[at - 1] ?? 0) < end))
    ) {
      at -= 1;
      overlapMatcherWorkCounters.searchSteps += 1;
    }
    starts.splice(at, 0, start);
    ends.splice(at, 0, end);
  }

  /** Marks pending occurrences that start before `head` as spent. */
  private skipReleased(): void {
    const head = this.offset + this.head;
    while (
      this.pendingHead < this.pendingStart.length &&
      (this.pendingStart[this.pendingHead] ?? 0) < head
    ) {
      this.pendingHead += 1;
      overlapMatcherWorkCounters.searchSteps += 1;
    }
    this.compactPending();
  }

  /** Drops spent entries once they are the bulk of the list. */
  private compactPending(): void {
    if (this.pendingHead === 0) return;
    if (this.pendingHead === this.pendingStart.length) {
      this.pendingStart = [];
      this.pendingEnd = [];
      this.pendingHead = 0;
      return;
    }
    if (
      this.pendingHead < 1024 ||
      this.pendingHead * 2 < this.pendingStart.length
    )
      return;
    this.pendingStart = this.pendingStart.slice(this.pendingHead);
    this.pendingEnd = this.pendingEnd.slice(this.pendingHead);
    this.pendingHead = 0;
  }

  /**
   * Where, relative to `head`, the earliest value that could still complete
   * begins; `held` when none is in progress.
   */
  private earliestUnfinished(): number {
    let earliest = this.held;
    for (let index = 0; index < this.values.length; index += 1) {
      const matched = this.prefixMatched[index] ?? 0;
      if (matched > 0 && matched < (this.codes[index]?.length ?? 0))
        earliest = Math.min(earliest, this.held - matched);
    }
    return Math.max(0, earliest);
  }

  /** Characters still held. */
  private get held(): number {
    return this.buffer.length - this.head;
  }

  push(decodedChar: string, serializedText: string): void {
    this.buffer += decodedChar;
    this.parts.push(serializedText);
    this.advancePrefixes(decodedChar);
    this.counters.charsScanned += 1;
    if (this.parts.length > this.counters.maxWindowParts)
      this.counters.maxWindowParts = this.parts.length;
    if (this.held > this.counters.maxWindowChars)
      this.counters.maxWindowChars = this.held;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
  }

  /**
   * Appends serialized text to the character pushed last, without adding a
   * decoded character: a caller collapsing a whitespace run into one matched
   * space keeps the rest of the run with it. Returns `false`, leaving the text
   * to the caller, once that character has already been released.
   */
  extendLast(serializedText: string): boolean {
    const last = this.parts.length - 1;
    if (last < this.head) return false;
    this.parts[last] += serializedText;
    return true;
  }

  /** Released characters tolerated before the window is compacted. */
  private static readonly COMPACT_AFTER = 4096;

  private compact(): void {
    if (this.head < OverlapMatcher.COMPACT_AFTER) return;
    this.counters.windowCompactions += 1;
    this.offset += this.head;
    this.buffer = this.buffer.slice(this.head);
    this.parts = this.parts.slice(this.head);
    this.head = 0;
  }

  /** Drops `count` leading characters, returning their serialized text. */
  private take(count: number): string {
    let text = '';
    const until = this.head + count;
    for (let at = this.head; at < until; at += 1) text += this.parts[at] ?? '';
    this.head = until;
    this.compact();
    return text;
  }

  /**
   * Earliest occurrence of any value at or after `head`, relative to `head`:
   * the leftmost start, and the longest value at that start. The same answer
   * searching the held window for every value gave, read off the sorted
   * pending list instead.
   */
  private earliest(): { start: number; end: number } | undefined {
    this.skipReleased();
    if (this.pendingHead >= this.pendingStart.length) return undefined;
    const base = this.offset + this.head;
    return {
      start: (this.pendingStart[this.pendingHead] ?? 0) - base,
      end: (this.pendingEnd[this.pendingHead] ?? 0) - base,
    };
  }

  private drain(final: boolean): void {
    for (;;) {
      if (!this.inMatch) {
        const found = this.earliest();
        if (!found) {
          // Nothing matches yet; hold back what could still begin one.
          const releasable = final ? this.held : this.held - this.holdBack;
          if (releasable <= 0) return;
          this.emit(this.take(releasable), releasable);
          if (final) return;
          continue;
        }
        if (!final) {
          // A longer value that began earlier may still complete and would
          // then own this span. Release only what precedes it, and wait.
          const unfinished = this.earliestUnfinished();
          if (unfinished < found.start) {
            if (unfinished > 0) this.emit(this.take(unfinished), unfinished);
            return;
          }
        }
        if (found.start > 0) this.emit(this.take(found.start), found.start);
        this.emit('***', 0);
        this.matchedAny = true;
        this.inMatch = true;
        this.matchEnd = found.end - found.start;
        continue;
      }
      // Extend while any occurrence STARTS before the current end and reaches
      // past it — the union rule, not "first match wins". Pending entries are
      // sorted by start and the end only grows, so one forward pass reaches
      // the fixed point; every entry it passes ends inside the match and can
      // never matter again, so it is spent. The first matched entry is the
      // earliest one itself, so this pass also consumes it.
      const base = this.offset + this.head;
      while (
        this.pendingHead < this.pendingStart.length &&
        (this.pendingStart[this.pendingHead] ?? 0) - base < this.matchEnd
      ) {
        const end = (this.pendingEnd[this.pendingHead] ?? 0) - base;
        if (end > this.matchEnd) this.matchEnd = end;
        this.pendingHead += 1;
        overlapMatcherWorkCounters.searchSteps += 1;
      }
      this.compactPending();
      // The match is settled only once nothing further back than `maxLength`
      // could still start inside it.
      if (!final && this.held < this.matchEnd + this.maxLength - 1) {
        this.prune();
        return;
      }
      // Discard the matched characters; `***` was already emitted for them.
      this.onDrop?.(this.matchEnd);
      this.head += this.matchEnd;
      this.compact();
      this.matchEnd = 0;
      this.inMatch = false;
      if (final) continue;
      if (this.held === 0) return;
    }
  }

  /**
   * Bounds retention during a long match: characters before
   * `matchEnd - maxLength + 1` can no longer begin an extension.
   */
  private prune(): void {
    const keepFrom = this.matchEnd - this.maxLength + 1;
    if (keepFrom <= 0) return;
    this.onDrop?.(keepFrom);
    this.head += keepFrom;
    this.matchEnd -= keepFrom;
    this.compact();
  }
}
