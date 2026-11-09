/**
 * Delivery of a growing output as appends instead of full resends.
 *
 * A producer keeps re-sending one value as it grows: a Codex command's
 * aggregated output, or a delegated child's cumulative transcript. An
 * {@link AppendEncoder} turns each value into either the whole value or a
 * step against the value it sent before; an {@link AppendReassembler} turns
 * them back into exactly the values the producer sent. Both sides use the
 * same {@link AppendCodec}, whose `find` only returns a step that its `apply`
 * turns into the next value, so a reassembled value never differs from a
 * full resend. Two codecs exist: growing text, possibly clamped behind a
 * notice ({@link outputAppendCodec}), and item lists whose tail changes
 * ({@link listAppendCodec}).
 *
 * Revisions come from one counter per encoding process, so a step names the
 * exact value it extends. The reassembler applies a step only to that value:
 * a step for any other base (unknown, out of order, or after a full value
 * without a revision) is a gap, never a guess, and a step it already applied
 * is a duplicate. Out-of-order steps are not buffered: every caller delivers
 * on an ordered channel, where holding one back would reorder it against the
 * channel's other messages; a gap asks the encoder to start over with full
 * values instead.
 *
 * Browser-safe: used by Electron main (encoding) and the preload (decoding).
 */

/** One step of growing text from a base value to the next. */
export interface OutputAppendStep {
  /** Length of the value it extends, checked before applying. */
  readonly baseLength: number;
  /** Leading characters of the base kept as they are (a truncation notice). */
  readonly keep: number;
  /** Where the kept rest of the base starts; equals `keep` unless a prefix is dropped. */
  readonly from: number;
  /** Characters added at the end. */
  readonly text: string;
}

/** A text step with the revisions of the value it produces and extends. */
export type OutputAppend = OutputAppendStep & AppendRevisions;

/** The whole value, or an append to the previous one. */
export type OutputEncoding = AppendEncoding<OutputAppendStep>;

export type OutputReassembly = AppendReassembly<string>;

/** Tail anchor searched for when a clamp dropped a prefix. */
const SLIDE_ANCHOR_CHARS = 64;
/** Anchor occurrences tried before falling back to a full value. */
const SLIDE_ANCHOR_ATTEMPTS = 4;
const DEFAULT_MAX_KEYS = 256;

/**
 * Keep the newest `maxChars` characters behind `notice` once an output grows
 * past them. Clamping a clamped value with more text equals clamping the
 * whole raw output, so an output clamped after every delta is the clamp of
 * everything it received.
 */
export function clampOutputTail(
  output: string,
  maxChars: number,
  notice: string,
): string {
  if (output.length <= maxChars) return output;
  return `${notice}${output.slice(-maxChars)}`;
}

/**
 * The value an append produces from `base`: its first `keep` characters, the
 * rest from `from`, then `text`. `undefined` when the append does not fit
 * this base.
 */
export function applyOutputAppend(
  base: string,
  append: OutputAppendStep,
): string | undefined {
  const { baseLength, keep, from, text } = append;
  if (
    base.length !== baseLength ||
    !Number.isSafeInteger(keep) ||
    !Number.isSafeInteger(from) ||
    keep < 0 ||
    from < keep ||
    from > base.length
  ) {
    return undefined;
  }
  return `${base.slice(0, keep)}${base.slice(from)}${text}`;
}

function verified(
  previous: string,
  next: string,
  step: Omit<OutputAppendStep, 'baseLength'>,
): Omit<OutputAppendStep, 'baseLength'> | undefined {
  return applyOutputAppend(previous, {
    ...step,
    baseLength: previous.length,
  }) === next
    ? step
    : undefined;
}

/**
 * With both values behind `head`, a step that keeps the head, drops a prefix
 * of the previous body and adds text: the previous body's tail is found in
 * the next body by an anchor, and each candidate is verified.
 */
function findSlide(
  previous: string,
  next: string,
  head: string,
): Omit<OutputAppendStep, 'baseLength'> | undefined {
  const keep = head.length;
  const previousBody = previous.slice(keep);
  const nextBody = next.slice(keep);
  // The anchor must survive the dropped prefix: at most a quarter of it.
  const anchorLength = Math.min(
    SLIDE_ANCHOR_CHARS,
    Math.ceil(previousBody.length / 4),
  );
  if (anchorLength === 0) {
    return verified(previous, next, {
      keep,
      from: previous.length,
      text: nextBody,
    });
  }
  const anchor = previousBody.slice(-anchorLength);
  let position = nextBody.lastIndexOf(anchor);
  for (
    let attempt = 0;
    attempt < SLIDE_ANCHOR_ATTEMPTS && position >= 0;
    attempt += 1
  ) {
    // `nextBody` up to `end` is the kept tail of `previousBody`.
    const end = position + anchorLength;
    const from = previous.length - end;
    const step =
      from >= keep
        ? verified(previous, next, { keep, from, text: nextBody.slice(end) })
        : undefined;
    if (step) return step;
    position = position > 0 ? nextBody.lastIndexOf(anchor, position - 1) : -1;
  }
  return undefined;
}

/**
 * An append that turns `previous` into `next`, or `undefined` when only the
 * full value can. `next` either extends `previous`, or both start with one of
 * `heads` (a truncation notice) and `next` drops a prefix of what follows it
 * and adds text. Every returned append reproduces `next` exactly.
 */
export function findOutputAppend(
  previous: string,
  next: string,
  heads: readonly string[],
): Omit<OutputAppendStep, 'baseLength'> | undefined {
  if (next.startsWith(previous)) {
    return { keep: 0, from: 0, text: next.slice(previous.length) };
  }
  for (const head of heads) {
    if (!head || !previous.startsWith(head) || !next.startsWith(head)) {
      continue;
    }
    const step = findSlide(previous, next, head);
    if (step) return step;
  }
  return undefined;
}

/**
 * How one kind of value is sent as steps. `apply(previous, find(previous,
 * next))` must equal `next` exactly; `find` returns `undefined` when only the
 * full value can carry `next`.
 */
export interface AppendCodec<Value, Step> {
  find(previous: Value, next: Value): Step | undefined;
  apply(base: Value, step: Step): Value | undefined;
}

/** The revisions that tie a step to the exact value it extends. */
export interface AppendRevisions {
  readonly rev: number;
  readonly baseRev: number;
}

export type AppendEncoding<Step> =
  | { readonly kind: 'full'; readonly rev: number }
  | { readonly kind: 'append'; readonly append: Step & AppendRevisions };

export type AppendReassembly<Value> =
  | { readonly status: 'applied'; readonly value: Value }
  | { readonly status: 'duplicate' }
  | { readonly status: 'gap' };

interface AppendEncoderOptions {
  /** Revision source; share one between encoders feeding one process. */
  nextRev(): number;
  /** Values remembered; the least recently sent is forgotten first. */
  maxKeys?: number;
}

/** A map that forgets its least recently set key past `maxKeys`. */
class RecentMap<Key, Entry> {
  private readonly entries = new Map<Key, Entry>();

  constructor(private readonly maxKeys: number) {}

  get(key: Key): Entry | undefined {
    return this.entries.get(key);
  }

  set(key: Key, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: Key): void {
    this.entries.delete(key);
  }

  deleteWhere(predicate: (key: Key) => boolean): void {
    for (const key of Array.from(this.entries.keys())) {
      if (predicate(key)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Remembers the last value sent per key and encodes the next one against it. */
export class AppendEncoder<Key, Value, Step> {
  private readonly values: RecentMap<Key, { rev: number; value: Value }>;

  constructor(
    private readonly codec: AppendCodec<Value, Step>,
    private readonly options: AppendEncoderOptions,
  ) {
    this.values = new RecentMap(
      Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS),
    );
  }

  /** Encode `value` for `key` and remember it as the base of the next one. */
  encode(key: Key, value: Value): AppendEncoding<Step> {
    const previous = this.values.get(key);
    const rev = this.options.nextRev();
    const step =
      previous === undefined
        ? undefined
        : this.codec.find(previous.value, value);
    this.values.set(key, { rev, value });
    if (previous === undefined || step === undefined) {
      return { kind: 'full', rev };
    }
    return { kind: 'append', append: { ...step, rev, baseRev: previous.rev } };
  }

  /** The next value for `key` is sent in full. */
  forget(key: Key): void {
    this.values.delete(key);
  }

  forgetWhere(predicate: (key: Key) => boolean): void {
    this.values.deleteWhere(predicate);
  }

  clear(): void {
    this.values.clear();
  }
}

/** The receiving side: rebuilds each key's value from full values and steps. */
export class AppendReassembler<Key, Value, Step> {
  /** A `rev` of `undefined` marks a full value no step applies to. */
  private readonly values: RecentMap<
    Key,
    { rev: number | undefined; value: Value }
  >;

  constructor(
    private readonly codec: AppendCodec<Value, Step>,
    options: { maxKeys?: number } = {},
  ) {
    this.values = new RecentMap(
      Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS),
    );
  }

  /**
   * A full value replaces whatever the key held. Without a revision it ends
   * the key's chain: later steps are gaps until a revisioned full value.
   */
  full(key: Key, value: Value, rev?: number): void {
    this.values.set(key, { rev, value });
  }

  apply(key: Key, append: Step & AppendRevisions): AppendReassembly<Value> {
    const current = this.values.get(key);
    if (current === undefined || current.rev === undefined) {
      return { status: 'gap' };
    }
    if (append.rev <= current.rev) return { status: 'duplicate' };
    if (append.baseRev !== current.rev) return { status: 'gap' };
    const value = this.codec.apply(current.value, append);
    if (value === undefined) return { status: 'gap' };
    this.values.set(key, { rev: append.rev, value });
    return { status: 'applied', value };
  }

  value(key: Key): Value | undefined {
    return this.values.get(key)?.value;
  }

  forget(key: Key): void {
    this.values.delete(key);
  }

  forgetWhere(predicate: (key: Key) => boolean): void {
    this.values.deleteWhere(predicate);
  }
}

/** Text that grows at its end, possibly behind a clamp's notice. */
export function outputAppendCodec(
  heads: readonly string[] = [],
): AppendCodec<string, OutputAppendStep> {
  return {
    find: (previous, next): OutputAppendStep | undefined => {
      const step = findOutputAppend(previous, next, heads);
      return step === undefined
        ? undefined
        : { ...step, baseLength: previous.length };
    },
    apply: applyOutputAppend,
  };
}

/** Growing text: {@link AppendEncoder} over {@link outputAppendCodec}. */
export class OutputAppendEncoder<Key> extends AppendEncoder<
  Key,
  string,
  OutputAppendStep
> {
  constructor(options: AppendEncoderOptions & { heads?: readonly string[] }) {
    super(outputAppendCodec(options.heads), options);
  }
}

/** Growing text: {@link AppendReassembler} over {@link outputAppendCodec}. */
export class OutputReassembler<Key> extends AppendReassembler<
  Key,
  string,
  OutputAppendStep
> {
  constructor(options: { maxKeys?: number } = {}) {
    super(outputAppendCodec(), options);
  }
}

/** A list whose leading items stay and whose tail changes or grows. */
export interface ListAppendStep<Item> {
  /** Items in the base, checked before applying. */
  readonly baseLength: number;
  /** Leading base items kept. */
  readonly keep: number;
  /** Items that follow them. */
  readonly items: readonly Item[];
}

/**
 * Lists of items compared with `same`, which must be exact (as the full list
 * would be delivered): the step keeps the longest equal prefix and carries
 * the rest. Kept items are copied by `copy`, so a rebuilt list never shares
 * an object with an earlier one, as a structured clone would not.
 */
export function listAppendCodec<Item>(
  same: (left: Item, right: Item) => boolean,
  copy: (item: Item) => Item,
): AppendCodec<readonly Item[], ListAppendStep<Item>> {
  return {
    find: (previous, next): ListAppendStep<Item> | undefined => {
      let keep = 0;
      const limit = Math.min(previous.length, next.length);
      while (keep < limit) {
        const left = previous[keep];
        const right = next[keep];
        if (left === undefined || right === undefined || !same(left, right))
          break;
        keep += 1;
      }
      if (keep === 0) return undefined;
      return { baseLength: previous.length, keep, items: next.slice(keep) };
    },
    apply: (base, step): readonly Item[] | undefined => {
      const { baseLength, keep, items } = step;
      if (
        base.length !== baseLength ||
        !Number.isSafeInteger(keep) ||
        keep < 0 ||
        keep > base.length
      ) {
        return undefined;
      }
      return [...base.slice(0, keep).map(copy), ...items];
    },
  };
}
