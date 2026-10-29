import { OverlapMatcher } from '../../../lib/overlap-matcher';
import { withJsonEscapedVariants } from '../../../lib/redaction';
import {
  FrameStack,
  IdentityText,
  KeyIdentityIndex,
  TokenBuffer,
  digestPush,
  digestStart,
  type DigestState,
} from './bounded-json-state';

/**
 * Masks one serialized JSON record by streaming it, for records too large to
 * hold in memory.
 *
 * Same contract as `redactSerializedJsonLine`, reached by a different route.
 * It is NOT a weaker path: the differential tests assert byte-identical output
 * against that function, and a divergence is a defect here rather than a
 * difference to accept.
 *
 * Two passes. The first validates the WHOLE record and reserves every key
 * identity; nothing is emitted until validity is known, so a malformed record
 * can still take the established raw exact-value path without a partial
 * structural transform having already been published. The second emits.
 *
 * Every dimension the child controls is bounded, not just values: string
 * values are written through, keys and numeric tokens are assembled in
 * `TokenBuffer`s that spill, key identities live in a `KeyIdentityIndex` that
 * falls back to file-backed digests, and nesting lives in a windowed
 * `FrameStack`. Bounding one of four and calling the rest a residual is not a
 * bound — it is the same term with a different letter on it.
 */

/**
 * Work counters, so "bounded" is measured rather than asserted.
 *
 * `maxWindowChars` and `maxWindowParts` are the ones that matter: they are the
 * largest the matcher's retained window ever got, which is the term that was
 * O(record) before it was bounded. A test that never moves them is not
 * exercising the path it claims to.
 *
 * These are PROCESS-GLOBAL and monotonic. Two executions sharing a process
 * share them, so a delta measured around one run is only that run's work when
 * nothing else is running — which is true of the tests that read them and is
 * NOT true in general. They measure the specific terms named below and nothing
 * else: a counter that has not moved says that term did no work, never that
 * the work or the memory was bounded.
 */
export const streamingRedactionWorkCounters = {
  charsScanned: 0,
  windowCompactions: 0,
  maxWindowChars: 0,
  maxWindowParts: 0,
  tokenChars: 0,
  replayedChars: 0,
};

/**
 * Times the key index gave up holding identities as text.
 *
 * A positive control for the budget: a record designed to exhaust it has to be
 * observed reaching the file-backed path, not merely observed finishing. It
 * lives on the bounded-state counters because that is where the decision is
 * made; re-exported here so a caller reads one surface.
 */
export { boundedJsonStateCounters } from './bounded-json-state';

/** Streams the record in order. Called once per pass, so it must replay. */
export interface RecordSource {
  chunks(): AsyncIterable<string>;
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

type Expect =
  | 'value'
  | 'afterValue'
  | 'key'
  | 'colon'
  | 'firstKeyOrEnd'
  | 'firstValueOrEnd';

/**
 * Validates a number or literal token one character at a time.
 *
 * Accumulating the token text would make a single numeric literal an unbounded
 * resident term, and a number is exactly as child-controlled as a string
 * value. `01`, `1.`, `1e`, `-` and `tru` are all rejected here without the
 * token ever existing as a string.
 */
class ScalarTokenValidator {
  /** Number states: see `push`. Negative means "matching a literal". */
  private state = 0;
  private literal = '';

  reset(): void {
    this.state = 0;
    this.literal = '';
  }

  push(character: string): void {
    if (this.state === -1) return;
    if (this.state === -2) {
      this.literal += character;
      if (this.literal.length > 5) this.state = -1;
      return;
    }
    switch (this.state) {
      case 0:
        if (character === '-') this.state = 1;
        else if (character === '0') this.state = 2;
        else if (character >= '1' && character <= '9') this.state = 3;
        else if (character === 't' || character === 'f' || character === 'n') {
          this.state = -2;
          this.literal = character;
        } else this.state = -1;
        return;
      case 1:
        if (character === '0') this.state = 2;
        else if (character >= '1' && character <= '9') this.state = 3;
        else this.state = -1;
        return;
      case 2:
      case 3:
        if (this.state === 3 && character >= '0' && character <= '9') return;
        if (character === '.') this.state = 4;
        else if (character === 'e' || character === 'E') this.state = 6;
        else this.state = -1;
        return;
      case 4:
        if (character >= '0' && character <= '9') this.state = 5;
        else this.state = -1;
        return;
      case 5:
        if (character >= '0' && character <= '9') return;
        if (character === 'e' || character === 'E') this.state = 6;
        else this.state = -1;
        return;
      case 6:
        if (character === '+' || character === '-') this.state = 7;
        else if (character >= '0' && character <= '9') this.state = 8;
        else this.state = -1;
        return;
      case 7:
        if (character >= '0' && character <= '9') this.state = 8;
        else this.state = -1;
        return;
      case 8:
        if (character >= '0' && character <= '9') return;
        this.state = -1;
        return;
      default:
        this.state = -1;
    }
  }

  /** True when what was pushed forms a complete number or literal. */
  end(): boolean {
    if (this.state === -2)
      return (
        this.literal === 'true' ||
        this.literal === 'false' ||
        this.literal === 'null'
      );
    return (
      this.state === 2 ||
      this.state === 3 ||
      this.state === 5 ||
      this.state === 8
    );
  }
}

/**
 * A streaming JSON validator.
 *
 * A bracket-balance check is not validation: `{"v": EXAMPLEVALUE}` balances,
 * and accepting it skipped the raw matcher and left a configured value in the
 * output. Numbers (`01` is invalid), escapes (`\q` is invalid), raw control
 * characters, punctuation placement, bracket kinds and trailing content are all
 * checked here.
 */
class JsonGrammar {
  private expect: Expect = 'value';
  /**
   * Open containers, with the scope id per open object so key collisions are
   * resolved per object. A windowed, file-backed stack rather than two JS
   * arrays: nesting is child-controlled, so `Array<'object' | 'array'>` plus a
   * parallel number array is the record's own size in a different shape.
   */
  private readonly frames = new FrameStack();
  /** The literal/number token in progress, validated without being held. */
  private readonly scalar = new ScalarTokenValidator();
  private inScalar = false;
  private done = false;
  valid = true;

  private nextScopeId = 0;

  get scopeId(): number {
    return this.frames.topScope;
  }

  /** Releases any file the nesting window spilled to. Idempotent. */
  dispose(): Promise<void> {
    return this.frames.dispose();
  }
  get expectingKey(): boolean {
    return this.expect === 'key' || this.expect === 'firstKeyOrEnd';
  }
  get inValuePosition(): boolean {
    return this.expect === 'value' || this.expect === 'firstValueOrEnd';
  }

  private fail(): void {
    this.valid = false;
  }

  /** Closes an accumulated literal or number token. */
  private endToken(): void {
    if (!this.inScalar) return;
    this.inScalar = false;
    if (!this.scalar.end()) {
      this.fail();
      return;
    }
    this.afterValue();
  }

  private afterValue(): void {
    if (this.frames.size === 0) {
      this.expect = 'afterValue';
      this.done = true;
      return;
    }
    this.expect = 'afterValue';
  }

  /** Feeds one character. Returns false once the record is known invalid. */
  push(character: string): boolean {
    if (!this.valid) return false;
    const isWhitespace =
      character === ' ' ||
      character === '\t' ||
      character === '\n' ||
      character === '\r';
    if (this.inScalar) {
      if (/[-+.eE0-9a-z]/.test(character)) {
        this.scalar.push(character);
        return true;
      }
      this.endToken();
      if (!this.valid) return false;
    }
    if (isWhitespace) return true;
    if (this.done && this.frames.size === 0) {
      // Trailing content after a complete top-level value.
      this.fail();
      return false;
    }
    switch (this.expect) {
      case 'value':
      case 'firstValueOrEnd': {
        if (character === '{') {
          this.nextScopeId += 1;
          this.frames.push('object', this.nextScopeId);
          this.expect = 'firstKeyOrEnd';
          return true;
        }
        if (character === '[') {
          this.frames.push('array', this.scopeId);
          this.expect = 'firstValueOrEnd';
          return true;
        }
        if (character === ']') {
          if (this.expect !== 'firstValueOrEnd') {
            this.fail();
            return false;
          }
          return this.closeBracket('array');
        }
        if (character === '"') return true; // the string scanner takes over
        if (/[-0-9tfn]/.test(character)) {
          this.scalar.reset();
          this.scalar.push(character);
          this.inScalar = true;
          return true;
        }
        this.fail();
        return false;
      }
      case 'key':
      case 'firstKeyOrEnd': {
        if (character === '}') {
          if (this.expect !== 'firstKeyOrEnd') {
            this.fail();
            return false;
          }
          return this.closeBracket('object');
        }
        if (character === '"') return true;
        this.fail();
        return false;
      }
      case 'colon': {
        if (character !== ':') {
          this.fail();
          return false;
        }
        this.expect = 'value';
        return true;
      }
      case 'afterValue': {
        if (character === ',') {
          const top = this.frames.topKind;
          if (top === undefined) {
            this.fail();
            return false;
          }
          this.expect = top === 'object' ? 'key' : 'value';
          return true;
        }
        if (character === '}') return this.closeBracket('object');
        if (character === ']') return this.closeBracket('array');
        this.fail();
        return false;
      }
      default:
        this.fail();
        return false;
    }
  }

  private closeBracket(kind: 'object' | 'array'): boolean {
    const top = this.frames.topKind;
    this.frames.pop();
    if (top !== kind) {
      this.fail();
      return false;
    }
    this.afterValue();
    return true;
  }

  /** Called when a string token closes, so the grammar can advance. */
  stringClosed(wasKey: boolean): void {
    if (!this.valid) return;
    if (wasKey) this.expect = 'colon';
    else this.afterValue();
  }

  /** Called at end of input. */
  end(): boolean {
    this.endToken();
    if (!this.valid) return false;
    if (this.frames.size !== 0) this.fail();
    if (!this.done) this.fail();
    return this.valid;
  }
}

/** Validates a JSON string token's escapes and control characters. */
class StringTokenGrammar {
  private escape = '';
  valid = true;

  push(character: string): void {
    if (!this.valid) return;
    if (this.escape !== '') {
      if (this.escape === '\\') {
        if ('"\\/bfnrt'.includes(character)) {
          this.escape = '';
          return;
        }
        if (character === 'u') {
          this.escape = '\\u';
          return;
        }
        this.valid = false;
        return;
      }
      // Collecting the four hex digits of \uXXXX.
      if (!/[0-9a-fA-F]/.test(character)) {
        this.valid = false;
        return;
      }
      this.escape += character;
      if (this.escape.length === 6) this.escape = '';
      return;
    }
    if (character === '\\') {
      this.escape = '\\';
      return;
    }
    // Raw control characters are not legal inside a JSON string.
    if (character < ' ') this.valid = false;
  }

  end(): boolean {
    if (this.escape !== '') this.valid = false;
    return this.valid;
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Incrementally decodes a JSON string token, pairing decoded and serialized. */
class TokenDecoder {
  private pending = '';

  constructor(
    private readonly onUnit: (decoded: string, serialized: string) => void,
  ) {}

  push(character: string): void {
    if (this.pending === '') {
      if (character === '\\') {
        this.pending = '\\';
        return;
      }
      this.onUnit(character, character);
      return;
    }
    this.pending += character;
    if (this.pending === '\\u') return;
    if (this.pending.startsWith('\\u')) {
      if (this.pending.length < 6) return;
      this.onUnit(
        String.fromCharCode(Number.parseInt(this.pending.slice(2), 16)),
        this.pending,
      );
      this.pending = '';
      return;
    }
    const simple: Record<string, string> = {
      '\\"': '"',
      '\\\\': '\\',
      '\\/': '/',
      '\\b': '\b',
      '\\f': '\f',
      '\\n': '\n',
      '\\r': '\r',
      '\\t': '\t',
    };
    this.onUnit(simple[this.pending] ?? this.pending.slice(1), this.pending);
    this.pending = '';
  }
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

/**
 * Decoded characters of ONE key held as text before that key is carried by
 * digest alone. A key is as child-controlled as a value, so there is no size
 * at which holding it is safe; past this the identity is still exact for
 * reservation purposes, it is simply not resident.
 */
const MAX_EXACT_KEY_CHARS = 1024 * 1024;

/** Total key text the identity set holds before it switches to digests. */
export const DEFAULT_EXACT_KEY_SET_CHARS = 8 * 1024 * 1024;

/** One token's resident size before it continues into a private file. */
export const DEFAULT_TOKEN_SPILL_CHARS = 1024 * 1024;

/** The most masked output held before it is handed on, in UTF-16 units. */
const OUTPUT_RUN_CHARS = 64 * 1024;

/** Thresholds, exposed so a test can force each backing at a small size. */
export interface RecordRedactionLimits {
  /** Key text held exactly before the identity set moves to digests. */
  exactKeySetChars?: number;
  /** A key or number token's resident size before it spills to a file. */
  tokenSpillChars?: number;
  /**
   * TEST SEAM: makes every key identity share one digest, so a test can prove
   * that nothing depends on digest uniqueness — identity is always decided by
   * exact comparison. Never set in production.
   */
  forceDigestCollisions?: boolean;
}

/**
 * Pass one: validate the whole record and reserve every key identity.
 *
 * Value tokens are validated but never accumulated, and a key is streamed into
 * its digest rather than held, so neither dimension costs the record's size.
 */
async function inspect(
  source: RecordSource,
  index: KeyIdentityIndex,
  tokenSpill: number,
): Promise<boolean> {
  const grammar = new JsonGrammar();
  // Declared outside the `try` so `finally` owns them. The current key's text
  // can have spilled to a private file — decoded child output, possibly a
  // configured value — and every early `return false`, a failed read and a
  // failed reserve all leave that key unfinished.
  let keyText: IdentityText | undefined;
  /** A key's spill file still being created; awaited before reading on. */
  let keySettling: Promise<void> | undefined;
  try {
    let inString = false;
    let stringGrammar: StringTokenGrammar | undefined;
    let escape = false;
    let keyDecoder: TokenDecoder | undefined;
    let keyDigest: DigestState | undefined;
    let keyScope = 0;

    for await (const chunk of source.chunks()) {
      // Iterated by UTF-16 CODE UNIT, not code point: the in-memory oracle
      // indexes in code units, and `for...of` yields an astral character as
      // one two-unit string, which desynchronises decoded offsets from
      // serialized ones and shifted every match after the first emoji.
      for (let at = 0; at < chunk.length; at += 1) {
        const character = chunk.charAt(at);
        if (inString) {
          if (escape) {
            escape = false;
            stringGrammar?.push(character);
            keyDecoder?.push(character);
            continue;
          }
          if (character === '\\') {
            escape = true;
            stringGrammar?.push(character);
            keyDecoder?.push(character);
            continue;
          }
          if (character === '"') {
            inString = false;
            if (stringGrammar && !stringGrammar.end()) return false;
            const wasKey = keyDecoder !== undefined;
            if (wasKey && keyDigest && keyText) {
              if (keySettling) await keySettling;
              keySettling = undefined;
              const closing = keyText;
              keyText = undefined;
              try {
                const settled = index.reserve(
                  keyScope,
                  keyDigest,
                  closing.text(),
                  closing.source(),
                );
                if (settled) await settled;
              } finally {
                await closing.dispose();
              }
            }
            keyDecoder = undefined;
            keyDigest = undefined;
            keyText = undefined;
            stringGrammar = undefined;
            grammar.stringClosed(wasKey);
            if (!grammar.valid) return false;
            continue;
          }
          stringGrammar?.push(character);
          keyDecoder?.push(character);
          if (keySettling) {
            await keySettling;
            keySettling = undefined;
          }
          continue;
        }
        if (
          character === '"' &&
          (grammar.expectingKey || grammar.inValuePosition)
        ) {
          const isKey = grammar.expectingKey;
          if (!grammar.push(character)) return false;
          inString = true;
          stringGrammar = new StringTokenGrammar();
          if (!isKey) {
            keyDecoder = undefined;
            continue;
          }
          keyScope = grammar.scopeId;
          const digest = digestStart();
          keyDigest = digest;
          const text = new IdentityText(MAX_EXACT_KEY_CHARS, tokenSpill);
          keyText = text;
          keyDecoder = new TokenDecoder((decoded) => {
            for (let unit = 0; unit < decoded.length; unit += 1)
              digestPush(digest, decoded.charCodeAt(unit));
            keySettling = text.push(decoded) ?? keySettling;
          });
          continue;
        }
        if (!grammar.push(character)) return false;
      }
    }
    if (inString) return false;
    return grammar.end();
  } finally {
    const unfinished = keyText;
    const creating = keySettling;
    keyText = undefined;
    keySettling = undefined;
    try {
      // A spill file still being created must exist before it can be
      // removed; its own failure is already this record's failure.
      if (creating) await creating.catch(() => undefined);
      if (unfinished) await unfinished.dispose();
    } finally {
      await grammar.dispose();
    }
  }
}

/**
 * Masks a record that lives in a store rather than in memory.
 *
 * Returns `false` when the record is not well-formed JSON, so the caller
 * applies the established raw exact-value matching contract — the same
 * decision `redactSerializedJsonLine` makes, not a new rejection rule. Nothing
 * is written in that case: validity is decided for the WHOLE record before any
 * transform is published.
 *
 * Every dimension a child controls — value length, key length, key count,
 * numeric token length, nesting depth — is bounded here by a resident window
 * with a private file behind it. There is no size, count or depth at which a
 * record is refused, no field is dropped and no key is globally renamed.
 */
export async function redactRecordFromSource(
  source: RecordSource,
  secretValues: readonly string[],
  emit: (text: string) => void,
  limits: RecordRedactionLimits = {},
): Promise<boolean> {
  // The same forms the resident path matches (`redactJsonPreservingFormat`):
  // each eligible value and its JSON-escaped forms, inside decoded tokens.
  const values = Array.from(
    new Set(
      withJsonEscapedVariants(
        secretValues.filter((value) => value.length >= 6),
      ),
    ),
  ).sort((left, right) => right.length - left.length);
  const tokenSpill = limits.tokenSpillChars ?? DEFAULT_TOKEN_SPILL_CHARS;
  const index = new KeyIdentityIndex(
    limits.exactKeySetChars ?? DEFAULT_EXACT_KEY_SET_CHARS,
    { forceDigestCollisions: limits.forceDigestCollisions ?? false },
  );
  const grammar = new JsonGrammar();
  const keyToken = new TokenBuffer('key', tokenSpill);
  const numberToken = new TokenBuffer('number', tokenSpill);

  // The matchers release text a character at a time. Handing each piece to
  // `emit` made a 9 MiB record into millions of host output calls, each doing
  // its own write and batch bookkeeping. Pieces are joined into bounded runs
  // instead, in order, and delivered at least once per source chunk, so a
  // record's output still flows as it is read. A trailing high surrogate
  // waits for its pair so no run ends inside a character.
  let pending: string[] = [];
  let pendingChars = 0;
  const flush = (final: boolean): void => {
    if (pendingChars === 0) return;
    let text = pending.join('');
    pending = [];
    pendingChars = 0;
    const last = text.charCodeAt(text.length - 1);
    if (!final && last >= 0xd800 && last <= 0xdbff) {
      pending = [text.slice(-1)];
      pendingChars = 1;
      text = text.slice(0, -1);
    }
    if (text.length > 0) emit(text);
  };
  const write = (text: string): void => {
    if (text.length === 0) return;
    pending.push(text);
    pendingChars += text.length;
    if (pendingChars >= OUTPUT_RUN_CHARS) flush(false);
  };

  try {
    if (!(await inspect(source, index, tokenSpill))) return false;
    if (values.length === 0) {
      for await (const chunk of source.chunks()) emit(chunk);
      return true;
    }

    let inString = false;
    let escape = false;
    let isKey = false;
    let keyScope = 0;
    let inNumber = false;
    let matcher: OverlapMatcher | undefined;
    let decoder: TokenDecoder | undefined;

    /**
     * Appends one character to a token buffer, returning the buffer's promise
     * only while its file is still being created; callers await exactly that.
     * Without that wait a source that never yields to the event loop — an
     * async generator over a string, say — keeps the whole token resident
     * while `mkdtemp` sits in the I/O queue. Every other character returns
     * nothing: an `async` wrapper allocated two settled promises per
     * character, which dominated the pass on a large key.
     */
    const pushKey = (character: string): Promise<void> | undefined => {
      streamingRedactionWorkCounters.tokenChars += 1;
      return keyToken.push(character);
    };
    const pushNumber = (character: string): Promise<void> | undefined => {
      streamingRedactionWorkCounters.tokenChars += 1;
      return numberToken.push(character);
    };

    /** Feeds the buffered token through a decoder, in bounded chunks. */
    const replayThrough = async (
      buffer: TokenBuffer,
      into: TokenDecoder,
    ): Promise<void> => {
      for await (const piece of buffer.replay()) {
        streamingRedactionWorkCounters.replayedChars += piece.length;
        for (let unit = 0; unit < piece.length; unit += 1)
          into.push(piece.charAt(unit));
      }
    };

    /**
     * A masked key's emitted name depends on its finished identity, so the key
     * is read twice rather than held: once to decide whether it masks and what
     * name that leaves it needing, once to emit.
     */
    const finishKey = async (): Promise<void> => {
      const digest = digestStart();
      // Any length, held or spilled: identity is compared exactly, so a key
      // too large to hold still needs its text available, not just a digest.
      const identity = new IdentityText(MAX_EXACT_KEY_CHARS, tokenSpill);
      let identitySettling: Promise<void> | undefined;
      const identityMatcher = new OverlapMatcher(
        values,
        (text) => {
          for (let unit = 0; unit < text.length; unit += 1)
            digestPush(digest, text.charCodeAt(unit));
          identitySettling = identity.push(text) ?? identitySettling;
        },
        streamingRedactionWorkCounters,
      );
      // Fed decoded-for-decoded, so what it produces IS the decoded identity
      // of the masked key — the same value `decodeJsonKeyIdentity` returns for
      // the spliced text, without that text ever being assembled.
      const identityDecoder = new TokenDecoder((decoded) => {
        identityMatcher.push(decoded, decoded);
      });
      for await (const piece of keyToken.replay()) {
        streamingRedactionWorkCounters.replayedChars += piece.length;
        for (let unit = 0; unit < piece.length; unit += 1)
          identityDecoder.push(piece.charAt(unit));
        if (identitySettling) {
          await identitySettling;
          identitySettling = undefined;
        }
      }
      identityMatcher.end();
      if (identitySettling) await identitySettling;

      if (!identityMatcher.matchedAny) {
        // A key this did not mask is never renamed.
        await identity.dispose();
        write('"');
        for await (const piece of keyToken.replay()) write(piece);
        write('"');
        await keyToken.clear();
        return;
      }
      let suffix: number;
      try {
        const allocated = index.allocate(
          keyScope,
          digest,
          identity.text(),
          identity.source(),
        );
        suffix = typeof allocated === 'number' ? allocated : await allocated;
      } finally {
        await identity.dispose();
      }
      write('"');
      const outMatcher = new OverlapMatcher(
        values,
        write,
        streamingRedactionWorkCounters,
      );
      await replayThrough(
        keyToken,
        new TokenDecoder((decoded, serialized) => {
          outMatcher.push(decoded, serialized);
        }),
      );
      outMatcher.end();
      if (suffix > 0) write(`__${suffix}`);
      write('"');
      await keyToken.clear();
    };

    /** A numeric token matches as a whole or not at all. */
    const finishNumber = async (): Promise<void> => {
      if (!inNumber) return;
      inNumber = false;
      const probe = new OverlapMatcher(
        values,
        () => undefined,
        streamingRedactionWorkCounters,
      );
      for await (const piece of numberToken.replay())
        for (let unit = 0; unit < piece.length; unit += 1)
          probe.push(piece.charAt(unit), piece.charAt(unit));
      probe.end();
      if (probe.matchedAny) write('"***"');
      else for await (const piece of numberToken.replay()) write(piece);
      await numberToken.clear();
    };

    for await (const chunk of source.chunks()) {
      for (let at = 0; at < chunk.length; at += 1) {
        const character = chunk.charAt(at);
        if (inString) {
          if (escape) {
            escape = false;
            if (isKey) {
              const settling = pushKey(character);
              if (settling) await settling;
            } else decoder?.push(character);
            continue;
          }
          if (character === '\\') {
            escape = true;
            if (isKey) {
              const settling = pushKey(character);
              if (settling) await settling;
            } else decoder?.push(character);
            continue;
          }
          if (character === '"') {
            inString = false;
            if (isKey) await finishKey();
            else {
              matcher?.end();
              matcher = undefined;
              write('"');
            }
            grammar.stringClosed(isKey);
            continue;
          }
          if (isKey) {
            const settling = pushKey(character);
            if (settling) await settling;
          } else decoder?.push(character);
          continue;
        }
        if (
          character === '"' &&
          (grammar.expectingKey || grammar.inValuePosition)
        ) {
          isKey = grammar.expectingKey;
          grammar.push(character);
          inString = true;
          if (isKey) {
            keyScope = grammar.scopeId;
          } else {
            // Written THROUGH, not accumulated: buffering the masked value
            // would reintroduce the resident term this path exists to remove.
            write('"');
            matcher = new OverlapMatcher(
              values,
              write,
              streamingRedactionWorkCounters,
            );
            decoder = new TokenDecoder((decodedUnit, serializedUnit) => {
              matcher?.push(decodedUnit, serializedUnit);
            });
          }
          continue;
        }
        if (grammar.inValuePosition && !inNumber && /[-0-9]/.test(character)) {
          inNumber = true;
          const settling = pushNumber(character);
          if (settling) await settling;
          grammar.push(character);
          continue;
        }
        if (inNumber && /[-+.eE0-9]/.test(character)) {
          const settling = pushNumber(character);
          if (settling) await settling;
          grammar.push(character);
          continue;
        }
        await finishNumber();
        write(character);
        grammar.push(character);
      }
      flush(false);
    }
    await finishNumber();
    flush(true);
    return true;
  } catch (error) {
    // What was already masked and released still goes out, as it did when
    // every piece was emitted at once; the failure then propagates unchanged.
    try {
      flush(true);
    } catch {
      /* The original failure is the one to report. */
    }
    throw error;
  } finally {
    await grammar.dispose();
    await keyToken.dispose();
    await numberToken.dispose();
    await index.dispose();
  }
}
