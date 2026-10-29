import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORCE_KILL_DELAY_MS,
  MAX_UNDECIDED_WHITESPACE_CHARS,
  runSpawnedProcessLocally,
  SecretValueRedactor,
  spawnedProcessWorkCounters,
} from '../spawned-process';
import { SpillingRecordStore } from '../record-store';
import {
  redactionWorkCounters,
  redactSerializedJsonLine,
} from '../../../../lib/redaction';

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
}

/**
 * Characters `String.prototype.indexOf` examines while `run` executes.
 *
 * Counted rather than timed, so the bound holds on any machine: the matchers
 * find every occurrence with `indexOf`, and the regression these tests guard
 * rescanned the remaining text for every value on every match.
 */
function indexOfWork(run: () => void): number {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = String.prototype.indexOf;
  let work = 0;
  const spy = jest
    .spyOn(String.prototype, 'indexOf')
    .mockImplementation(function (
      this: string,
      search: string,
      from?: number,
    ): number {
      const start = Math.max(0, from ?? 0);
      const at = original.call(this, search, from);
      work += (at === -1 ? this.length : at) - start;
      return at;
    });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return work;
}

describe('SecretValueRedactor', () => {
  it.each([1, 2, 4, 8])(
    'retains no more than the line it is holding (%i MB)',
    (megabytes) => {
      // Retention is O(the line being held), by design: deciding a line needs the
      // whole line. What must NOT happen is retention growing with the child's
      // TOTAL output, so this feeds many complete lines and checks that what is
      // held tracks one line, not the stream.
      const redactor = new SecretValueRedactor(['PREFIXX\nSUFFIXY']);
      const line = `{"a":"${'z'.repeat(100_000)}"}\n`;
      let peak = 0;
      for (let index = 0; index < megabytes * 10; index += 1) {
        redactor.redactChunk(line);
        peak = Math.max(peak, redactor.bufferedCharacterLength);
      }
      redactor.flush();
      expect(peak).toBeLessThanOrEqual(line.length * 2);
    },
  );

  it.each([
    [
      'starting at a JSON line terminator',
      '\nSECRETLINE1\nSECRETLINE2',
      '{"type":"text"}\nSECRETLINE1\nSECRETLINE2\ndone\n',
    ],
    [
      'starting inside a JSON line body and ending in the next raw line',
      '"}\nMYSECRETTAIL',
      '{"a":"b"}\nMYSECRETTAIL rest\n',
    ],
  ])('masks a configured value %s', (_name, secret, text) => {
    // Controller-confirmed leaks in the reverse direction: a valid JSON line
    // was emitted structurally and its terminator appended OUTSIDE the raw
    // matcher, so a value whose occurrence begins at or inside that line and
    // continues past it was never seen at all.
    const redactor = new SecretValueRedactor([secret]);
    const output = redactor.redactChunk(text) + redactor.flush();
    expect(output).not.toContain(secret);
  });

  it.each([1, 2, 3, 7, 64])(
    'masks a value spanning a JSON line boundary at chunk size %i',
    (size) => {
      const secret = '\nSECRETLINE1\nSECRETLINE2';
      const text = `{"type":"text"}\nSECRETLINE1\nSECRETLINE2\ndone\n`;
      const redactor = new SecretValueRedactor([secret]);
      let output = '';
      for (let index = 0; index < text.length; index += size) {
        output += redactor.redactChunk(text.slice(index, index + size));
      }
      output += redactor.flush();
      expect(output).not.toContain(secret);
    },
  );

  it('masks a value spanning several lines including JSON-shaped ones', () => {
    const secret = 'HEAD\n{"mid":"dle"}\nTAILVALUE';
    const text = `prefix HEAD\n{"mid":"dle"}\nTAILVALUE suffix\n`;
    const redactor = new SecretValueRedactor([secret]);
    const output = redactor.redactChunk(text) + redactor.flush();
    expect(output).not.toContain(secret);
    expect(output).not.toContain('TAILVALUE');
  });

  it('leaves an unrelated JSON line untouched when no value spans its boundary', () => {
    // The protection must not come back as "route everything raw": the escape
    // collision that started this whole series must stay unmasked.
    const record = JSON.stringify({ type: 'result', result: '\nABCDE' });
    const redactor = new SecretValueRedactor(['nABCDE', '\nSECRETLINE1']);
    const output =
      redactor.redactChunk(`${record}\nplain tail\n`) + redactor.flush();
    expect(output).toBe(`${record}\nplain tail\n`);
  });

  // The intersection the previous rounds missed: the same properties, but with a
  // record spanning many chunks. Fixing the single-chunk case and asserting the
  // large-record case separately never exercised their combination, which is
  // where all three controller failures lived.
  //
  // The padding used to be 1,050,000 characters to clear a 1,000,000-character
  // structured-line cap that selected a different code path. There is no such
  // cap any more — one line is handled one way whatever its size — so the extra
  // megabyte only bought runtime. 122,880 still spans 30 chunks at the 4,096
  // default, which is what these properties are actually about. Every assertion
  // below is unchanged.
  describe('multi-chunk records keep every property a single-chunk one has', () => {
    const LARGE_PADDING = 'z'.repeat(122_880);

    const throughRedactor = (
      values: readonly string[],
      text: string,
      size = 4096,
    ): string => {
      const redactor = new SecretValueRedactor(values);
      let output = '';
      for (let index = 0; index < text.length; index += size) {
        output += redactor.redactChunk(text.slice(index, index + size));
      }
      return output + redactor.flush();
    };

    it('keeps all three distinct fields when a masked key precedes an ordinary mask-shaped key', () => {
      // Controller case 1. The ORIGINAL record is unambiguous: three distinct
      // keys. Masking must not introduce an ambiguity the record did not have.
      const record = `{"SECRETVALUE":"sensitive-key-value","filler":${JSON.stringify(LARGE_PADDING)},"***":"ordinary-key-value"}\n`;
      const output = throughRedactor(['SECRETVALUE'], record);
      expect(output).not.toContain('SECRETVALUE');
      const parsed: unknown = JSON.parse(output.trim());
      const fields = parsed as Record<string, unknown>;
      expect(Object.keys(fields)).toHaveLength(3);
      expect(Object.values(fields)).toContain('sensitive-key-value');
      expect(Object.values(fields)).toContain('ordinary-key-value');
    });

    it('keeps all three fields when the ordinary mask-shaped key comes first', () => {
      const record = `{"***":"ordinary-key-value","filler":${JSON.stringify(LARGE_PADDING)},"SECRETVALUE":"sensitive-key-value"}\n`;
      const output = throughRedactor(['SECRETVALUE'], record);
      expect(output).not.toContain('SECRETVALUE');
      const fields = JSON.parse(output.trim()) as Record<string, unknown>;
      expect(Object.keys(fields)).toHaveLength(3);
      expect(Object.values(fields)).toContain('sensitive-key-value');
      expect(Object.values(fields)).toContain('ordinary-key-value');
    });

    it('recognises a Unicode-escaped mask-shaped key in an over-cap record', () => {
      const record = `{"\\u002a\\u002a\\u002a":"ordinary-key-value","filler":${JSON.stringify(LARGE_PADDING)},"SECRETVALUE":"sensitive-key-value"}\n`;
      const output = throughRedactor(['SECRETVALUE'], record);
      expect(output).not.toContain('SECRETVALUE');
      const fields = JSON.parse(output.trim()) as Record<string, unknown>;
      expect(Object.keys(fields)).toHaveLength(3);
      expect(Object.values(fields)).toContain('sensitive-key-value');
    });

    it('leaves a pre-existing duplicate key in an over-cap record exactly as it arrived', () => {
      const record = `{"dup":"plain a","filler":${JSON.stringify(LARGE_PADDING)},"dup":"plain b"}\n`;
      expect(throughRedactor(['SUPERSECRETVALUE'], record)).toBe(record);
    });

    it('masks a value that starts at an over-cap JSON line terminator', () => {
      // Controller case 2.
      const secret = '\nSECRETLINE1\nSECRETLINE2';
      const text = `${JSON.stringify({ type: 'text', filler: LARGE_PADDING })}\nSECRETLINE1\nSECRETLINE2\ndone\n`;
      expect(throughRedactor([secret], text)).not.toContain(secret);
    });

    it('masks a value that starts in an over-cap JSON body and ends in the next raw line', () => {
      // Controller case 3.
      const secret = '"}\nMYSECRETTAIL';
      const text = `${JSON.stringify({ filler: LARGE_PADDING, a: 'b' })}\nMYSECRETTAIL rest\n`;
      expect(throughRedactor([secret], text)).not.toContain(secret);
    });

    it.each([1, 7, 64, 4096, 65_536])(
      'holds those properties at chunk size %i',
      (size) => {
        const terminatorSecret = '\nSECRETLINE1\nSECRETLINE2';
        const terminatorText = `${JSON.stringify({ type: 'text', filler: LARGE_PADDING })}\nSECRETLINE1\nSECRETLINE2\ndone\n`;
        expect(
          throughRedactor([terminatorSecret], terminatorText, size),
        ).not.toContain(terminatorSecret);

        const record = `{"SECRETVALUE":"sensitive-key-value","filler":${JSON.stringify(LARGE_PADDING)},"***":"ordinary-key-value"}\n`;
        const keyed = throughRedactor(['SECRETVALUE'], record, size);
        expect(keyed).not.toContain('SECRETVALUE');
        expect(
          Object.keys(JSON.parse(keyed.trim()) as Record<string, unknown>),
        ).toHaveLength(3);
      },
    );

    it('preserves an over-cap record with no match byte-for-byte', () => {
      const record = `{"a":"${LARGE_PADDING}","n":1740000000123456789,"f":1.0,"u":"\\ud83d\\ude00"}\n`;
      expect(throughRedactor(['ABSENTVALUE'], record)).toBe(record);
    });

    it('still refuses to mask a value that only matches over-cap JSON syntax', () => {
      const record = `${JSON.stringify({ filler: LARGE_PADDING, result: '\nABCDE' })}\n`;
      expect(throughRedactor(['nABCDE'], record)).toBe(record);
    });
  });

  // Exact-bytes coverage. Absence of the whole configured value is too weak a
  // check: it passed while the output had been reordered and a readable fragment
  // released. Every case below compares the ENTIRE output against the input with
  // its one synthetic value replaced, so position, prefix, suffix, ordering and
  // the replacement marker are all pinned.
  describe('exact output bytes across size, boundary, keys and chunking', () => {
    // See the note above on why this is no longer a cap-crossing size.
    const LARGE_PADDING = 'z'.repeat(122_880);

    const run = (
      values: readonly string[],
      text: string,
      size = 4096,
    ): string => {
      const redactor = new SecretValueRedactor(values);
      let output = '';
      for (let index = 0; index < text.length; index += size) {
        output += redactor.redactChunk(text.slice(index, index + size));
      }
      return output + redactor.flush();
    };

    it.each([1, 7, 4096, 65_536])(
      'masks a value spanning an over-cap JSON terminator, exactly, at chunk size %i',
      (size) => {
        const secret = '\nSECRETLINE1\nSECRETLINE2';
        const text = `${JSON.stringify({ type: 'text', filler: LARGE_PADDING })}${secret}\ndone\n`;
        const expected = text.replace(secret, '***');
        expect(run([secret], text, size)).toBe(expected);
      },
    );

    it.each([1, 7, 4096, 65_536])(
      'masks a value spanning an over-cap JSON body into the next line, exactly, at chunk size %i',
      (size) => {
        const secret = '"}\nMYSECRETTAIL';
        const text = `${JSON.stringify({ filler: LARGE_PADDING, a: 'b' })}\nMYSECRETTAIL rest\n`;
        expect(text.includes(secret)).toBe(true);
        const expected = text.replace(secret, '***');
        const output = run([secret], text, size);
        expect(output).toBe(expected);
        // No fragment of the value may be released, in either half.
        expect(output).not.toContain('MYSECRETTAIL');
        expect(output).toContain('***');
      },
    );

    it('masks a configured value in over-cap output that only looks like JSON', () => {
      // A leading `{` is a guess. Python-style repr uses single quotes, so the
      // JSON tokenizer saw no string tokens at all and masked nothing.
      const secret = 'CONFIGURED_TEST_VALUE';
      const text = `{'filler': '${LARGE_PADDING}', 'token': '${secret}'}\n`;
      const output = run([secret], text);
      expect(output).not.toContain(secret);
      expect(output).toBe(text.replace(secret, '***'));
    });

    it("merges overlapping configured values instead of releasing the longer one's prefix", () => {
      // The contained shorter value finishes first, so a streaming emitter
      // released `PREFIXEXAMPLE` before deciding the longer span.
      const longer = 'PREFIXEXAMPLEPASSWORD_TOKEN_TRAILER';
      const shorter = 'PASSWORD_TOKEN';
      const text = `{"filler":"${LARGE_PADDING}","value":"<<${longer}>>"}\n`;
      const output = run([longer, shorter], text);
      expect(output).toBe(text.replace(longer, '***'));
      expect(output).toContain('<<***>>');
      expect(output).not.toContain('PREFIXEXAMPLE');
    });

    it('preserves every distinct field past the key bookkeeping boundary', () => {
      // 6,000 eleven-character ordinary keys exceed the old 65,536-character
      // bookkeeping cap, after which names stopped being recorded and a masked
      // key could be given a name that was already taken.
      const parts = ['"SECRETVALUE":"sensitive-key-value"'];
      parts.push(`"filler":${JSON.stringify(LARGE_PADDING)}`);
      for (let index = 0; index < 6_000; index += 1) {
        parts.push(`"key${String(index).padStart(8, '0')}":${index}`);
      }
      parts.push('"***":"ordinary-key-value"');
      const text = `{${parts.join(',')}}\n`;
      const expectedCount = Object.keys(
        JSON.parse(text) as Record<string, unknown>,
      ).length;
      const output = run(['SECRETVALUE'], text);
      expect(output).not.toContain('SECRETVALUE');
      const fields = JSON.parse(output.trim()) as Record<string, unknown>;
      expect(Object.keys(fields)).toHaveLength(expectedCount);
      expect(Object.values(fields)).toContain('sensitive-key-value');
      expect(Object.values(fields)).toContain('ordinary-key-value');
    });

    it('preserves every distinct field past the scope depth boundary', () => {
      // A depth-capped scope stack used to stop tracking past 64 while its
      // exit path kept popping, so the stack desynchronised and keys were
      // attributed to the wrong object. That cap is gone (scopes now come from
      // one whole-record walk); this pins the behaviour it was getting wrong.
      let inner = '{"SECRETVALUE":"deep-sensitive","***":"deep-ordinary"}';
      for (let depth = 0; depth < 74; depth += 1) {
        inner = `{"n${depth}":${inner}}`;
      }
      const text = `${inner}\n`;
      const output = run(['SECRETVALUE'], text);
      expect(output).not.toContain('SECRETVALUE');
      expect(() => {
        JSON.parse(output.trim());
      }).not.toThrow();
      let node = JSON.parse(output.trim()) as Record<string, unknown>;
      // Built inside-out, so `n73` is the outermost wrapper.
      for (let depth = 73; depth >= 0; depth -= 1) {
        node = node[`n${depth}`] as Record<string, unknown>;
      }
      expect(Object.keys(node)).toHaveLength(2);
      expect(Object.values(node)).toEqual(
        expect.arrayContaining(['deep-sensitive', 'deep-ordinary']),
      );
    });

    it('keeps a value split across a code point at an over-cap boundary', () => {
      const secret = 'SECRET\u{1F600}TAIL';
      const text = `{"filler":"${LARGE_PADDING}","v":"x${secret}y"}\n`;
      expect(run([secret], text, 1)).toBe(text.replace(secret, '***'));
    });
  });

  it('keeps a separate JSON document valid when a preceding prefix never continues', () => {
    // The controller's route probe. `PREFIXX\nSUFFIXY` is configured and the
    // previous line ends with `PREFIXX\n`, so a continuation is POSSIBLE — but
    // the line that follows is a different, complete JSON document that does
    // not continue it. Treating "possible" as "certain" routed that document
    // through the byte matcher, where a configured `nABCDE` spliced the `n` of
    // its `\n` escape and produced `"\***"` — invalid JSON. A possible prefix
    // must not poison every later JSON line.
    const redactor = new SecretValueRedactor(['PREFIXX\nSUFFIXY', 'nABCDE']);
    const record = JSON.stringify({ type: 'result', result: '\nABCDE' });
    const output =
      redactor.redactChunk('log ends with PREFIXX\n') +
      redactor.redactChunk(`${record}\n`) +
      redactor.flush();
    const jsonLine = output.split('\n').find((line) => line.startsWith('{'));
    expect(jsonLine).toBe(record);
    expect(() => {
      JSON.parse(jsonLine ?? '');
    }).not.toThrow();
  });

  it('still masks a multi-line value that really does span into a JSON-shaped line', () => {
    // The case the routing exists for, kept green: when the continuation is
    // REAL, masking outranks the shape of the output it appears in.
    const secret = 'prefix\n{"value":"classified"}';
    const redactor = new SecretValueRedactor([secret]);
    const output =
      redactor.redactChunk('prefix\n') +
      redactor.redactChunk('{"value":"classified"}\n') +
      redactor.flush();
    expect(output).not.toContain('classified');
    expect(output).not.toContain(secret);
  });

  it.each([2_600, 8_000, 20_000])(
    'does no boundary scanning for ordinary lines with a %i-character multi-line value configured',
    (secretLength) => {
      // The regression this replaces was measured as wall-clock (a 2,661-char
      // PEM made ordinary output 20-430x slower) and the previous test asserted
      // a timing RATIO, which flaked and was then relaxed from 4 to 8. A ratio
      // is a diagnostic, not a bound. What actually went wrong is countable: the
      // multi-line continuation scan ran for every emitted line. Plain text goes
      // to the raw matcher regardless, so the correct bound is ZERO scans.
      const multiLine = `-----BEGIN KEY-----\n${'k'.repeat(secretLength - 40)}\n-----END KEY-----`;
      const text =
        `${'ordinary log line with no secret in it'.repeat(2)}\n`.repeat(
          20_000,
        );
      const redactor = new SecretValueRedactor([multiLine]);
      spawnedProcessWorkCounters.reset();
      redactor.redactChunk(text);
      redactor.flush();
      expect(spawnedProcessWorkCounters.boundaryProbes).toBe(0);
    },
  );

  it('scans a bounded number of times for JSON lines, independent of line count', () => {
    // JSON-shaped lines do consult the boundary, so the bound here is "per
    // line", not "zero" — and it must not grow faster than the line count.
    const multiLine = 'HEAD\nTAILVALUE';
    const record = `${JSON.stringify({ type: 'result', n: 1 })}\n`;
    const probesFor = (lines: number): number => {
      const redactor = new SecretValueRedactor([multiLine]);
      spawnedProcessWorkCounters.reset();
      redactor.redactChunk(record.repeat(lines));
      redactor.flush();
      return spawnedProcessWorkCounters.boundaryProbes;
    };
    const small = probesFor(500);
    const large = probesFor(2_000);
    expect(small).toBeLessThanOrEqual(500 * 3);
    expect(large).toBeLessThanOrEqual(2_000 * 3);
    // Four times the lines, no more than four times the scans (plus slack).
    expect(large).toBeLessThanOrEqual(small * 5);
  });

  it('builds no offset map and no scope scan for a large record with no match', () => {
    // The structural pass was building one array entry per decoded code unit
    // for every token before anything checked whether a value could match, and
    // walking the whole record to assign object scopes. Neither is needed when
    // nothing matches, which is the ordinary case. The positive control below
    // is what makes these zeroes mean something.
    const record = `{"a":"${'x'.repeat(200_000)}","b":"${'y'.repeat(200_000)}"}`;
    redactionWorkCounters.reset();
    expect(redactSerializedJsonLine(record, ['ABSENTVALUE'])).toBe(record);
    expect(redactionWorkCounters.offsetMapsBuilt).toBe(0);
    expect(redactionWorkCounters.scopeScans).toBe(0);
  });

  it('positive control: both counters rise when the work is actually needed', () => {
    // Without this, the zero assertions above are unfalsifiable — `scopeScans`
    // was in fact never incremented at all, so every assertion against it
    // passed no matter what the code did.
    redactionWorkCounters.reset();
    // A matched KEY forces the whole-record scope walk; an escape sequence in
    // the matched token forces a real offset map (escape-free tokens resolve
    // offsets arithmetically).
    const record = '{"SECRETVALUE":"v","b":"pre \\u0041 SECRETVALUE post"}';
    const output = redactSerializedJsonLine(record, ['SECRETVALUE']);
    expect(output).not.toContain('SECRETVALUE');
    expect(JSON.parse(output)).toBeDefined();
    expect(redactionWorkCounters.scopeScans).toBeGreaterThan(0);
    expect(redactionWorkCounters.offsetMapsBuilt).toBeGreaterThan(0);
  });

  it('still builds only what a match needs', () => {
    const record = '{"a":"has SECRETVALUE inside","b":"none"}';
    redactionWorkCounters.reset();
    const output = redactSerializedJsonLine(record, ['SECRETVALUE']);
    expect(output).not.toContain('SECRETVALUE');
    // No key matched, so no scope scan; the matching token is escape-free, so
    // its offsets are arithmetic rather than an allocated map.
    expect(redactionWorkCounters.scopeScans).toBe(0);
    expect(redactionWorkCounters.offsetMapsBuilt).toBe(0);
  });

  it('controller followup9: bounds undecided whitespace without waiting for a newline', () => {
    const redactor = new SecretValueRedactor(['abcdef']);
    for (let index = 0; index < 32; index += 1)
      redactor.redactChunk(' '.repeat(65536));
    expect(redactor.bufferedCharacterLength).toBeLessThanOrEqual(
      MAX_UNDECIDED_WHITESPACE_CHARS,
    );
  });

  it('redacts a secret split across a chunk boundary that falls in the middle of a multi-byte UTF-8 character', () => {
    // Independent-review finding: `redactChunk` decoded each incoming Buffer
    // to a string independently (`chunk.toString('utf8')`). A raw child
    // process `stdout` 'data' Buffer boundary is not guaranteed to align
    // with a UTF-8 character boundary, so a multi-byte character split
    // across two chunks decodes to a replacement character (U+FFFD) on
    // each side instead of the original character, breaking the exact
    // string match and leaking the rest of the secret as raw text.
    const secret = 'café-secret-token-123';
    const full = Buffer.from(`prefix ${secret} suffix`, 'utf8');
    const splitIndex = full.indexOf(Buffer.from('é', 'utf8')) + 1;
    const redactor = new SecretValueRedactor([secret]);
    const output =
      redactor.redactChunk(full.subarray(0, splitIndex)) +
      redactor.redactChunk(full.subarray(splitIndex)) +
      redactor.flush();
    expect(output).toBe('prefix *** suffix');
  });

  it('never splits a surrogate pair across two separately-emitted output pieces', () => {
    // Controller finding: `redactChunk`/`flush` decide how much of the raw
    // buffer to release using a plain character-count cut (holdback size,
    // or a deferred-match boundary). That cut is a UTF-16 code-unit index
    // and is not guaranteed to fall between two complete characters — an
    // astral character (e.g. an emoji) is stored as a surrogate PAIR (two
    // UTF-16 code units), and a cut landing between them produces two
    // pieces that each look fine as isolated JS strings but that neither
    // piece can be independently re-encoded to UTF-8 without corrupting the
    // character (a lone surrogate encodes to U+FFFD). Each piece is written
    // to a separate sink (log file append, IPC `onOutput` call) rather than
    // concatenated first, so this corrupts real output even though the
    // concatenated JS string looks intact.
    const redactor = new SecretValueRedactor(['abcdef']);
    const pieces = [
      redactor.redactChunk(Buffer.from('😀abcd')),
      redactor.flush(),
    ];
    for (const piece of pieces) {
      for (let i = 0; i < piece.length; i++) {
        const unit = piece.charCodeAt(i);
        const isHighSurrogate = unit >= 0xd800 && unit <= 0xdbff;
        const isLowSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
        // A high surrogate must be immediately followed, WITHIN THE SAME
        // PIECE, by its low surrogate — never left dangling at the end of
        // a piece with its pair arriving in a later, separately-written one.
        if (isHighSurrogate) {
          expect(i + 1).toBeLessThan(piece.length);
          const next = piece.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        }
        // Symmetrically, a low surrogate must never appear without its high
        // surrogate immediately before it in the SAME piece.
        if (isLowSurrogate) {
          expect(i).toBeGreaterThan(0);
          const previous = piece.charCodeAt(i - 1);
          expect(previous >= 0xd800 && previous <= 0xdbff).toBe(true);
        }
      }
    }
    // Each piece must independently survive a real UTF-8 round trip (what
    // actually happens when each is written to a file or sent over IPC).
    const reencoded = Buffer.concat(
      pieces.map((piece) => Buffer.from(piece, 'utf8')),
    ).toString('utf8');
    expect(reencoded).toBe('😀abcd');
  });

  it('keeps deterministically bounded retained state across many single-character chunks of colliding periodic values', () => {
    // Controller finding: a configured value that self-overlaps (periodic)
    // and shares a character with ANOTHER configured value ('a\na\na\n' and
    // 'aSECRET' both contain 'a') used to defer the ENTIRE growing span
    // rather than retain a small suffix — retained state and per-chunk work
    // both grew with the length of the stream (measured quadratic: 52ms at
    // 2,000 chars, 187ms at 4,000, 747ms at 8,000). A correct incremental
    // design never needs more than a small, FIXED window (bounded by the
    // longest configured value) to recognize a still-arriving overlapping
    // match, regardless of how long the stream has been. Assert the bound
    // directly on retained state (deterministic, not wall-clock) across
    // increasing stream lengths fed one character at a time.
    const values = ['a\na\na\n', 'aSECRET'];
    const bufferedAt: number[] = [];
    for (const n of [2_000, 4_000, 8_000, 20_000]) {
      const redactor = new SecretValueRedactor(values);
      for (let i = 0; i < n; i++) redactor.redactChunk(i % 2 ? '\n' : 'a');
      bufferedAt.push(redactor.bufferedCharacterLength);
    }
    // Retained state must stay under a small, fixed bound — NOT grow with n.
    for (const buffered of bufferedAt) {
      expect(buffered).toBeLessThan(100);
    }
  });

  it('redacts a multi-line secret value split across redactChunk and flush, not just a single-line one', () => {
    // Controller repro: a configured secret containing an embedded newline.
    // The old line-buffered design released each of its lines the instant it
    // saw a "complete" line — checked in isolation, never matching the full
    // multi-line value — before the rest of the value had even arrived.
    const secret = 'synthetic-top\nsynthetic-bottom';
    const redactor = new SecretValueRedactor([secret]);
    const chunkOutput = redactor.redactChunk(secret);
    const flushOutput = redactor.flush();
    expect(chunkOutput + flushOutput).toBe('***');
  });

  it('redacts a multi-line secret even when the chunk boundary falls in the middle of it', () => {
    const secret = 'synthetic-top\nsynthetic-bottom';
    const redactor = new SecretValueRedactor([secret]);
    // Split well before the newline, so under the old design the first line
    // would already be "complete" and released before the second chunk with
    // the rest of the secret ever arrives.
    const first = redactor.redactChunk('synthetic-t');
    const second = redactor.redactChunk('op\nsynthetic-bottom');
    expect(first + second + redactor.flush()).toBe('***');
  });

  it('redacts a single-line secret split at an arbitrary (non-newline) byte offset across chunks', () => {
    const secret = 'sekret-single-line-value';
    const redactor = new SecretValueRedactor([secret]);
    const first = redactor.redactChunk(`before ${secret.slice(0, 10)}`);
    const second = redactor.redactChunk(`${secret.slice(10)} after`);
    expect(first + second + redactor.flush()).toBe('before *** after');
  });

  it('preserves non-secret content and newlines around a redacted multi-line value', () => {
    const secret = 'synthetic-top\nsynthetic-bottom';
    const redactor = new SecretValueRedactor([secret]);
    const output =
      redactor.redactChunk(`before\n${secret}\nafter\n`) + redactor.flush();
    expect(output).toBe('before\n***\nafter\n');
  });

  it('redacts a multi-line secret from stdout that is itself JSON-serialized (log_format_hint: agent custom actions)', () => {
    // Controller-followup6 sweep: a custom pipeline action with
    // `log_format_hint: agent` (like the `project/e2e-agent-stream` fixture
    // exercised by pipeline-live-output.spec.mjs) writes agent-shaped NDJSON
    // to stdout via `console.log(JSON.stringify(...))`. `JSON.stringify`
    // turns a secret's real embedded newline into the two literal characters
    // `\` + `n` before the child process ever emits a byte — this redactor
    // only matches the raw (real-newline) configured value against the raw
    // stdout stream, which is the JSON-escaped, two-character form, so the
    // exact match never fires and the secret survives verbatim in both the
    // live UI stream and the persisted log.
    const secret = 'synthetic-top\nsynthetic-bottom';
    const line = `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `found: ${secret}` }] },
    })}\n`;
    const redactor = new SecretValueRedactor([secret]);
    const output = redactor.redactChunk(line) + redactor.flush();
    expect(output).not.toContain('synthetic-top');
    expect(output).not.toContain('synthetic-bottom');
    const parsed: unknown = JSON.parse(output);
    expect(
      (parsed as { message: { content: [{ text: string }] } }).message
        .content[0].text,
    ).toBe('found: ***');
  });

  it('redacts the longest overlapping match when one configured value is a prefix of another, across a chunk split', () => {
    const shorter = 'sekret-abc123';
    const longer = 'sekret-abc123-extra-suffix';
    const redactor = new SecretValueRedactor([shorter, longer]);
    const first = redactor.redactChunk(`x ${longer.slice(0, 15)}`);
    const second = redactor.redactChunk(`${longer.slice(15)} y`);
    // The longer value must win outright (single '***'), not leave a
    // residual unredacted suffix or double-redact via the shorter prefix.
    expect(first + second + redactor.flush()).toBe('x *** y');
  });

  it('fully redacts two configured values with different, staggered start positions whose spans overlap', () => {
    // Independent-review regression: an earlier fix picked whichever
    // configured value started earliest, even when a DIFFERENT value with a
    // later start overlapped it and extended further. Finalizing only the
    // earliest-starting match left the longer value's non-overlapping tail
    // as untouched raw text once the earliest match's end became the new
    // cursor — a real partial-secret leak, not just a cosmetic difference.
    const shorter = 'abcdef';
    const longer = 'cdefghijklmnopqrst';
    const redactor = new SecretValueRedactor([shorter, longer]);
    const output =
      redactor.redactChunk('xxabcdefghijklmnopqrstyy') + redactor.flush();
    expect(output).not.toContain('ghijklmnopqrst');
    expect(output).not.toContain('abcdef');
    expect(output).toBe('xx***yy');
  });

  it('fully redacts the same staggered-overlap values even when streamed in small chunks that arrive well before the longer value is complete', () => {
    // Second independent-review regression on the SAME overlap fix above: a
    // single-call `redactChunk` was not enough evidence. The shorter value
    // ('abcdef') becomes individually "safe" (its own full span has
    // arrived) well before the longer, overlapping value ('cdefghijklmnopqrst',
    // starting a few characters later) has fully streamed in, since
    // `indexOf` cannot find a value that has not fully arrived yet — no
    // extension fires, the shorter match gets finalized alone, and the
    // longer value's un-overlapping tail streams out afterward as
    // untouched raw text. Every chunk size below reproduced the leak before
    // the fix that defers finalizing a match whose merge-extended span
    // still reaches the buffer's unsafe tail.
    const text = 'xxabcdefghijklmnopqrstyy';
    const values = ['abcdef', 'cdefghijklmnopqrst'];
    for (const chunkSize of [1, 3, 5, 8, text.length]) {
      const redactor = new SecretValueRedactor(values);
      let output = '';
      for (let i = 0; i < text.length; i += chunkSize) {
        output += redactor.redactChunk(text.slice(i, i + chunkSize));
      }
      output += redactor.flush();
      expect(output).not.toContain('ghijklmnopqrst');
      expect(output).not.toContain('abcdef');
      expect(output).toBe('xx***yy');
    }
  });

  it('fully redacts a daisy chain of three overlapping values, staggered starts, across every chunk size', () => {
    // Generalizes the two-value overlap/deferral fixes above to a chain:
    // each value overlaps the next (not the first), so a naive fix that
    // only merges one extra step, or that stops deferring after a single
    // hop, would still leak the final value's non-overlapping tail.
    const text = 'wwAAAABBBBCCCCDDDDEEEEFFFFGGGGww';
    const values = ['AAAABBBBCCCC', 'CCCCDDDDEEEE', 'EEEEFFFFGGGG'];
    for (const chunkSize of [1, 2, 3, 7, text.length]) {
      const redactor = new SecretValueRedactor(values);
      let output = '';
      for (let i = 0; i < text.length; i += chunkSize) {
        output += redactor.redactChunk(text.slice(i, i + chunkSize));
      }
      output += redactor.flush();
      for (const value of values) expect(output).not.toContain(value);
      expect(output).toBe('ww***ww');
    }
  });

  it('holds back only as much as the longest configured value, releasing shorter safe prefixes immediately', () => {
    const redactor = new SecretValueRedactor(['sekret-123456']);
    const output = redactor.redactChunk('a'.repeat(500));
    // None of this text can possibly be part of a 13-character secret once
    // it's more than 12 characters from the end, so it must stream out
    // immediately rather than being held for an unbounded stream.
    expect(output.length).toBeGreaterThan(0);
  });

  it('stays roughly linear, not quadratic, on a large chunk with several configured values that never occur', () => {
    // Independent-review regression: rescanning every configured value from
    // scratch on every match (including values that never occur at all,
    // whose `indexOf` scans the remaining text down to -1 every time) made
    // this super-linear — a multi-hundred-KB Codex/Cursor transcript line
    // (a Read/Grep tool result) with a densely-recurring match could stall
    // the caller for hundreds of milliseconds to seconds. Assert a ~1.4MB
    // input with a match roughly every 73 characters (~20,000 matches)
    // against 10 configured values (9 of which never occur) completes well
    // under what an O(values x length x matches) implementation would take
    // (which was ~1s on a ~150KB input with 1/10th as many matches in
    // manual measurement before this fix).
    const values = Array.from(
      { length: 10 },
      (_, i) => `sekret-${String(i).padStart(6, '0')}`,
    );
    const chunk = `${'x'.repeat(50)}${values[0]}${'y'.repeat(10)}`.repeat(
      20_000,
    );
    const redactor = new SecretValueRedactor(values);
    let output = '';
    const work = indexOfWork(() => {
      output = redactor.redactChunk(chunk) + redactor.flush();
    });
    expect(output).not.toContain(values[0]);
    // Each value scanned about once, not once per match found elsewhere.
    expect(work).toBeLessThanOrEqual((values.length + 2) * chunk.length);
  });

  it('stays roughly linear, not quadratic, on a long run of a self-overlapping (periodic) configured value', () => {
    // Independent-review regression: extendToFurthestOverlap used to
    // re-slice and re-scan the whole growing merged span from scratch on
    // every pass, which is quadratic in the span's size.
    const redactor = new SecretValueRedactor(['abcabc']);
    const text = 'abc'.repeat(40_000);
    let output = '';
    const work = indexOfWork(() => {
      output = redactor.redactChunk(text) + redactor.flush();
    });
    expect(output).not.toContain('abcabc');
    expect(work).toBeLessThanOrEqual(3 * text.length);
  });

  it('keeps the internal buffer bounded even for an enormous run of a self-overlapping configured value', () => {
    // Independent-review regression: fixing the quadratic TIME cost above
    // was not enough on its own — deferring finalization whenever the
    // merged span still reaches the buffer's unsafe tail (the fix for the
    // small-chunk streaming leak) meant an unboundedly long overlapping run
    // never finalized at all, accumulating the entire run in `this.buffer`
    // and contradicting this class's own bounded-memory guarantee.
    // `inOpenMatch` is what caps it now: once a match has opened, the matched
    // characters are `***` already and only the small unsafe tail has to be
    // kept, so the buffer never grows past a small fixed bound regardless of
    // how long the run gets. (An earlier revision used a `MAX_DEFERRED_MATCH_SPAN`
    // constant; it no longer exists, and this comment used to name it.)
    const redactor = new SecretValueRedactor(['AAAAAAAAAAAAAAAA']);
    const text = `${'A'.repeat(200_000)}END`;
    let maxBufferLength = 0;
    let output = '';
    for (let i = 0; i < text.length; i += 997) {
      output += redactor.redactChunk(text.slice(i, i + 997));
      maxBufferLength = Math.max(
        maxBufferLength,
        redactor.bufferedCharacterLength,
      );
    }
    output += redactor.flush();
    expect(maxBufferLength).toBeLessThan(100_000);
    expect(output).not.toContain('AAAAAAAAAAAAAAAA');
    expect(output.trimEnd().endsWith('END')).toBe(true);
  });

  it('fully redacts a second configured value whose prefix falls exactly at the memory cap boundary', () => {
    // Independent-review regression: a span cap used to force a merged
    // self-overlap match to finalize outright the instant its span reached the
    // cap, with no regard for whether a DIFFERENT configured value's prefix
    // ('aaa' of 'aaaSECRET') was sitting right at that cut point. Once forced
    // through, those already-emitted '***' characters can never be
    // un-redacted, so when 'SECRET' streams in afterward it has lost the 'aaa'
    // prefix it needs to be recognized — it leaks as raw text. The cap is gone
    // and this stays as its regression: it only reproduced at that exact
    // boundary (65,536 'a's — coarser chunk sizes miss it), which is why the
    // run is fed one character at a time
    // through the critical zone rather than in bulk chunks.
    const redactor = new SecretValueRedactor(['aaaaaaaa', 'aaaSECRET']);
    const aCount = 65536;
    let output = '';
    output += redactor.redactChunk('a'.repeat(aCount - 20));
    for (let i = 0; i < 20; i++) output += redactor.redactChunk('a');
    for (const char of 'SECRET') output += redactor.redactChunk(char);
    output += redactor.flush();
    expect(output).not.toContain('SECRET');
  });

  it('fully redacts a colliding value even when a fresh, later occurrence of the dominant value follows a non-matching gap', () => {
    // Independent-review regression: the cap decision's runtime check asked
    // the shared `nextIndexAtOrAfter` cache "does any OTHER configured value
    // occur inside this span" by querying with `from = match.start` — but
    // `extendMatchToFurthestOverlap`'s own internal retiring loop had
    // already advanced that same cache's entry for the dominant value
    // FORWARD past `match.start` while searching for a further, later
    // occurrence across the non-matching gap below. Querying backward from
    // a position before what was actually searched violates the cache's own
    // documented soundness precondition ("`from` never decreases"), so it
    // wrongly reported the dominant value as NOT occurring in the span,
    // making the `.every(...)` check vacuously true and force-finalizing a
    // span that collides with a different configured value.
    const redactor = new SecretValueRedactor(['aaaaaa', 'a\naaaaaaSECRET']);
    let output = redactor.redactChunk('a'.repeat(70_000));
    output += redactor.redactChunk('\naaaaaa');
    output += redactor.redactChunk('SECRET');
    output += redactor.flush();
    expect(output).not.toContain('SECRET');
  });

  it('flush returns whatever was held back when the stream ends mid-buffer', () => {
    const redactor = new SecretValueRedactor(['sekret-123456']);
    const chunkOutput = redactor.redactChunk('no secret here');
    const flushOutput = redactor.flush();
    expect(chunkOutput + flushOutput).toBe('no secret here');
  });

  it('leaves output completely unchanged when no secret values are configured', () => {
    const redactor = new SecretValueRedactor([]);
    expect(redactor.redactChunk('anything at all\nmulti\nline')).toBe(
      'anything at all\nmulti\nline',
    );
    expect(redactor.flush()).toBe('');
  });
});

describe('a spilled record keeps its document shape', () => {
  // Shape is a property of the whole stream, decided by its first
  // non-whitespace character. It must not depend on how many whitespace
  // characters happen to precede it, on the chunking, or on whether the record
  // spilled — and deciding it must not rescan what was already examined.
  const text =
    `${' '.repeat(40)}` +
    JSON.stringify({ pad: 'z'.repeat(20_000), a: '\nABCDEFGHIJKL' }) +
    '\n';

  const drive = async (
    input: string,
    chunk: number,
    spill: number,
  ): Promise<string> => {
    const redactor = new SecretValueRedactor(['nABCDEFGHIJKL'], spill);
    let out = '';
    const take = async (): Promise<void> => {
      for (;;) {
        const pending = redactor.takePendingCompletion();
        if (!pending) return;
        await pending((piece) => {
          out += piece;
        });
      }
    };
    for (let at = 0; at < input.length; at += chunk) {
      out += redactor.redactChunk(input.slice(at, at + chunk));
      await take();
    }
    out += redactor.flush();
    await take();
    await redactor.disposeStorage();
    return out;
  };

  it.each([1, 3, 7, 64, 4096])(
    'is byte-identical whatever the chunking (%i)',
    async (chunk) => {
      for (const spill of [16, 1_024, 10_000_000]) {
        expect(await drive(text, chunk, spill)).toBe(text);
        expect(await drive(text.replace(/\n$/, ''), chunk, spill)).toBe(
          text.replace(/\n$/, ''),
        );
      }
    },
    120_000,
  );

  it('classifies a long whitespace head in work linear in the head', async () => {
    const before = spawnedProcessWorkCounters.shapeCharsClassified;
    const head = ' '.repeat(200_000);
    await drive(`${head}{"a":1}\n`, 1, 1_024);
    const examined = spawnedProcessWorkCounters.shapeCharsClassified - before;
    // Every whitespace character examined at most a small constant number of
    // times — never once per arriving chunk.
    expect(examined).toBeLessThan(head.length * 3);
  }, 120_000);
});

describe('output arriving while a stored record is still being emitted', () => {
  // A record that spilled is emitted later, from storage, through the same
  // raw matcher the redactor uses for new lines. If a new line is emitted
  // while that replay is part way through, it releases whatever the replay
  // was holding back — the start of a configured value — and the rest of the
  // value is emitted separately afterwards, so it is never masked.
  const SECRET = 'SECRET-TOKEN-123456';

  it.each([
    ['a malformed JSON-shaped record', '{'],
    ['a plain-text record', 'x'],
  ])(
    'keeps %s whole when a later line arrives mid-replay',
    async (_name, head) => {
      let releaseReplay: () => void = () => undefined;
      const replayHeld = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      let reachedPrefix: () => void = () => undefined;
      const prefixReached = new Promise<void>((resolve) => {
        reachedPrefix = resolve;
      });
      const record = `${head}${'a'.repeat(2_000)}${SECRET}${'b'.repeat(50)}`;
      const redactor = new SecretValueRedactor(
        [SECRET],
        1_024,
        (after, label) => {
          const inner = new SpillingRecordStore(after, label);
          return {
            get length(): number {
              return inner.length;
            },
            get spilled(): boolean {
              return inner.spilled;
            },
            get residentLength(): number {
              return inner.residentLength;
            },
            get location(): string | undefined {
              return inner.location;
            },
            settling: (): Promise<void> | undefined => inner.settling(),
            append: (text: string): boolean => inner.append(text),
            whenDrained: (): Promise<void> => inner.whenDrained(),
            // Replays in two pieces cut inside the configured value, and holds
            // the second until the test releases it.
            replay: async function* (): AsyncIterable<string> {
              let whole = '';
              for await (const piece of inner.replay()) whole += piece;
              const cut = whole.indexOf(SECRET) + 8;
              yield whole.slice(0, cut);
              reachedPrefix();
              await replayHeld;
              yield whole.slice(cut);
            },
            dispose: (): Promise<void> => inner.dispose(),
          };
        },
      );
      let out = '';
      try {
        out += redactor.redactChunk(record);
        out += redactor.redactChunk('\n');
        const completion = redactor.takePendingCompletion();
        expect(completion).toBeDefined();
        const running = completion?.((text) => {
          out += text;
        });
        await prefixReached;
        // A later line arrives while the replay is holding the value's start.
        out += redactor.redactChunk('late output line\n');
        releaseReplay();
        await running;
        out += redactor.flush();
        const next = redactor.takePendingCompletion();
        if (next)
          await next((text) => {
            out += text;
          });
      } finally {
        releaseReplay();
        await redactor.disposeStorage();
      }
      expect(out).toBe(
        `${head}${'a'.repeat(2_000)}***${'b'.repeat(50)}\nlate output line\n`,
      );
    },
  );
});

describe('a surrogate pair split between two string chunks', () => {
  // The host feeds Buffers through a StringDecoder, which never ends a chunk
  // between the halves of a pair. A caller feeding strings can, and the half
  // that stays resident and the half that reaches storage were then encoded
  // separately: the stored half read back as U+FFFD. Whichever path a pair's
  // first half takes, its second half must take too.
  const astral = '\u{10000}\u{1F600}';
  const inputs: Record<string, string> = {
    raw: `,}\r\\ ${astral}}1${astral}:b\r\rz${astral}1b[:${astral.repeat(40)}\nafter${astral}\n`,
    json: `${JSON.stringify({ a: astral.repeat(60), b: [astral, 'x'] })}\n`,
    malformed: `{"a":"${astral.repeat(50)}",\n`,
    eof: `${astral}x${astral.repeat(70)}`,
    opus: '9,Z}z1\n\u00e9,990{\n:\u00e9:91,{\t":[\n,}\r\\ \u{10000}\u{1F600}}1\u{1F600}:b\r\rz\u{1F600}1b[:',
  };

  const drive = async (
    pieces: readonly (string | Buffer)[],
    values: string[],
    spill: number,
  ): Promise<string> => {
    const redactor = new SecretValueRedactor(values, spill);
    let out = '';
    const take = async (): Promise<void> => {
      for (;;) {
        const drain = redactor.takePendingDrain();
        if (drain) await drain;
        const pending = redactor.takePendingCompletion();
        if (!pending && !drain) return;
        if (pending)
          await pending((piece) => {
            out += piece;
          });
      }
    };
    for (const piece of pieces) {
      out += redactor.redactChunk(piece);
      await take();
    }
    out += redactor.flush();
    await take();
    await redactor.disposeStorage();
    return out;
  };

  const strings = (text: string, size: number): string[] => {
    const pieces: string[] = [];
    for (let at = 0; at < text.length; at += size)
      pieces.push(text.slice(at, at + size));
    return pieces;
  };
  const buffers = (text: string, size: number): Buffer[] => {
    const bytes = Buffer.from(text, 'utf8');
    const pieces: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += size)
      pieces.push(bytes.subarray(at, at + size));
    return pieces;
  };

  it.each(Object.keys(inputs))(
    '%s: string chunks keep every pair whatever the chunking and spill',
    async (name) => {
      const text = inputs[name] ?? '';
      for (const size of [1, 2, 3, 5, 7, 16, 17, 31])
        for (const spill of [16, 64, 10_000_000])
          expect(await drive(strings(text, size), ['QQQQQQQQ'], spill)).toBe(
            text,
          );
    },
    120_000,
  );

  it.each(Object.keys(inputs))(
    '%s: Buffer chunks at every byte offset stay faithful (control)',
    async (name) => {
      const text = inputs[name] ?? '';
      for (const size of [1, 2, 3, 5, 7, 16, 17, 31])
        for (const spill of [16, 64, 10_000_000])
          expect(await drive(buffers(text, size), ['QQQQQQQQ'], spill)).toBe(
            text,
          );
    },
    120_000,
  );

  it('masks a configured value next to split pairs exactly as one chunk would', async () => {
    const text = `${'\u{1F600}'.repeat(20)}SECRETVALUE${'\u{1F600}'.repeat(20)}\n`;
    const expected = await drive([text], ['SECRETVALUE'], 10_000_000);
    expect(expected).not.toContain('SECRETVALUE');
    for (const size of [1, 3, 7, 16])
      for (const spill of [16, 64])
        expect(await drive(strings(text, size), ['SECRETVALUE'], spill)).toBe(
          expected,
        );
  }, 120_000);

  it('still releases a genuinely lone high surrogate at the end', async () => {
    const text = 'abc\ud800';
    for (const spill of [2, 10_000_000])
      expect(await drive(strings(text, 1), ['QQQQQQQQ'], spill)).toBe(text);
    // A lone high followed by an ordinary character is left as written while
    // the record is resident. Once it is in a spilled record it is encoded to
    // UTF-8, which cannot represent it, and it reads back as U+FFFD — true
    // before this change too at every chunking but one. A decoded Buffer
    // never contains a lone surrogate, so the host cannot produce one.
    const mid = 'ab\ud800cd\n';
    for (const size of [1, 2, 3])
      expect(await drive(strings(mid, size), ['QQQQQQQQ'], 10_000_000)).toBe(
        mid,
      );
  });
});

describe('runSpawnedProcessLocally', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pipeline-process-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('redacts logs and reads action output files in the host process', async () => {
    const logFile = join(directory, 'step.log');
    const outputFile = join(directory, 'output.txt');
    const envFile = join(directory, 'env.txt');
    const output = jest.fn();
    const secret = 'pipeline-secret-value';

    const result = await runSpawnedProcessLocally(
      {
        command: process.execPath,
        args: [
          '-e',
          [
            "const fs = require('node:fs');",
            'process.stdout.write(`visible ${process.env.TEST_SECRET}\\n`);',
            "fs.writeFileSync(process.env.OUTPUT_FILE, 'review=passed\\n');",
            "fs.writeFileSync(process.env.ENV_FILE, 'NEXT=value\\n');",
          ].join(''),
        ],
      },
      {
        cwd: directory,
        env: {
          ...definedEnvironment(process.env),
          TEST_SECRET: secret,
          OUTPUT_FILE: outputFile,
          ENV_FILE: envFile,
        },
        signal: new AbortController().signal,
        timeout_minutes: 1,
        logFile,
        outputFile,
        envFile,
        secretValues: [secret],
        onOutput: output,
      },
    );

    expect(result).toMatchObject({
      status: 'success',
      outputs: { review: 'passed' },
      dynamic_env: { NEXT: 'value' },
    });
    await expect(readFile(logFile, 'utf8')).resolves.toBe('visible ***\n');
    // Assert the reconstructed content, not the exact call chunking:
    // SecretValueRedactor holds back up to `longest configured value - 1`
    // characters to catch a match split across an arbitrary boundary
    // (including the process-close flush), so a short trailing fragment
    // like the final newline here can legitimately arrive as its own call.
    const stdoutCalls = output.mock.calls
      .filter(([stream]) => stream === 'stdout')
      .map(([, data]) => data as string);
    expect(stdoutCalls.join('')).toBe('visible ***\n');
  });

  /**
   * A single record larger than the retention high-water mark, delivered by a
   * real child that respects `drain`.
   *
   * Pausing BOTH read pipes when retained input crosses the mark is a circular
   * wait: retained input only shrinks when the line completes, the line only
   * completes when the rest of it arrives, and the child is paused. Nothing can
   * make progress. Backpressure has to wait on something that advances WITHOUT
   * more input.
   */
  describe('a record larger than the retention mark still completes', () => {
    /**
     * Writes a file's contents in 4,096-char chunks, honouring `drain`.
     *
     * The payload goes through a FILE, not argv: a multi-megabyte `-e` argument
     * fails with `spawn E2BIG` long before it reaches the code under test.
     */
    const pacedWriter = (
      stream: 'stdout' | 'stderr',
      inputFile: string,
    ): string =>
      `const s=require('node:fs').readFileSync(${JSON.stringify(inputFile)},'utf8');let i=0;` +
      `function send(){if(i===s.length)return;const c=s.slice(i,i+4096);i+=c.length;` +
      `if(process.${stream}.write(c))setImmediate(send);else process.${stream}.once('drain',send);}send();`;
    /** Stages a payload on disk and returns its path. */
    const stage = async (name: string, text: string): Promise<string> => {
      const file = join(directory, `${name}.input`);
      await writeFile(file, text, 'utf8');
      return file;
    };

    const record = (filler: number): string =>
      `${JSON.stringify({
        SECRETVALUE: 'masked key',
        filler: 'z'.repeat(filler),
        '***': 'ordinary',
      })}\n`;

    // 9 MiB of filler puts the record over the 8 MiB retention mark. The
    // existing large case is 1.05 MB and stays under it.
    const OVER_MARK = 9 * 1024 * 1024;

    it.each(['stdout', 'stderr'] as const)(
      'delivers the whole record byte-for-byte on %s',
      async (stream) => {
        const input = record(OVER_MARK);
        const expected = input.replace('SECRETVALUE', '***__1');
        const inputFile = await stage(`retention-${stream}`, input);
        const logFile = join(directory, `retention-${stream}.log`);
        const chunks: string[] = [];
        const result = await runSpawnedProcessLocally(
          {
            command: process.execPath,
            args: ['-e', pacedWriter(stream, inputFile)],
          },
          {
            cwd: directory,
            env: definedEnvironment(process.env),
            signal: new AbortController().signal,
            // Generous on purpose. A deadlock never completes, so no budget
            // hides one; a tight budget only lets machine load decide the
            // result when the whole suite runs in parallel.
            timeout_minutes: 4,
            logFile,
            outputFile: join(directory, `retention-${stream}.out`),
            envFile: join(directory, `retention-${stream}.env`),
            secretValues: ['SECRETVALUE'],
            onOutput: (_s, data) => {
              chunks.push(data);
            },
          },
        );
        // No timeout, no truncation, no lost tail.
        expect(result.status).toBe('success');
        expect(result.error).toBeUndefined();
        const persisted = await readFile(logFile, 'utf8');
        expect(persisted.length).toBe(expected.length);
        expect(persisted).toBe(expected);
        // Live output is the same bytes as the durable copy.
        expect(chunks.join('')).toBe(persisted);
        // And it is still one valid record with every field intact.
        const parsed: unknown = JSON.parse(persisted.trim());
        expect(parsed).toEqual({
          '***__1': 'masked key',
          filler: 'z'.repeat(OVER_MARK),
          '***': 'ordinary',
        });
      },
      300_000,
    );

    it('keeps an unrelated concurrent step healthy while one holds a large record', async () => {
      // The pause is per-child, but both children share the host. A step that
      // stalls its own pipes must not stall a sibling.
      const big = record(OVER_MARK);
      const bigExpected = big.replace('SECRETVALUE', '***__1');
      const smallInput = `${JSON.stringify({ small: 'SECRETVALUE here' })}\n`;
      const bigFile = await stage('concurrent-big', big);
      const smallFile = await stage('concurrent-small', smallInput);
      const run = (
        name: string,
        source: string,
        secrets: string[],
      ): Promise<{ status: string; persisted: Promise<string> }> =>
        runSpawnedProcessLocally(
          { command: process.execPath, args: ['-e', source] },
          {
            cwd: directory,
            env: definedEnvironment(process.env),
            signal: new AbortController().signal,
            timeout_minutes: 4,
            logFile: join(directory, `${name}.log`),
            outputFile: join(directory, `${name}.out`),
            envFile: join(directory, `${name}.env`),
            secretValues: secrets,
          },
        ).then((result) => ({
          status: result.status,
          persisted: readFile(join(directory, `${name}.log`), 'utf8'),
        }));

      const [bigResult, smallResult] = await Promise.all([
        run('concurrent-big', pacedWriter('stdout', bigFile), ['SECRETVALUE']),
        run('concurrent-small', pacedWriter('stdout', smallFile), [
          'SECRETVALUE',
        ]),
      ]);
      expect(smallResult.status).toBe('success');
      expect(await smallResult.persisted).toBe(
        smallInput.replace('SECRETVALUE', '***'),
      );
      expect(bigResult.status).toBe('success');
      expect(await bigResult.persisted).toBe(bigExpected);
    }, 300_000);

    it('interleaves a large held record with ordinary lines on the other pipe', async () => {
      // Output-sink backpressure (driven by emitted bytes) and input-retention
      // state are different pause reasons on the SAME pipes. A drain callback
      // for one must not resume a pipe the other still needs paused.
      const big = record(OVER_MARK);
      const bigFile = await stage('interleave', big);
      // Chatter is tied to the stdout CHUNKS, not a timer: a timer races the
      // child's exit and makes the interleaving non-deterministic.
      const source =
        `const s=require('node:fs').readFileSync(${JSON.stringify(bigFile)},'utf8');let i=0,n=0;` +
        `function send(){if(i===s.length)return;` +
        `const c=s.slice(i,i+4096);i+=c.length;` +
        `if(i%(4096*64)===0&&n<32)process.stderr.write('chatter line '+(++n)+'\\n');` +
        `if(process.stdout.write(c))setImmediate(send);else process.stdout.once('drain',send);}send();`;
      const logFile = join(directory, 'interleave.log');
      const live: Array<{ stream: 'stdout' | 'stderr'; data: string }> = [];
      const result = await runSpawnedProcessLocally(
        { command: process.execPath, args: ['-e', source] },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          timeout_minutes: 4,
          logFile,
          outputFile: join(directory, 'interleave.out'),
          envFile: join(directory, 'interleave.env'),
          secretValues: ['SECRETVALUE'],
          onOutput: (stream, data) => {
            live.push({ stream, data });
          },
        },
      );
      expect(result.status).toBe('success');
      const persisted = await readFile(logFile, 'utf8');
      const joined = (stream: 'stdout' | 'stderr'): string =>
        live
          .filter((entry) => entry.stream === stream)
          .map((entry) => entry.data)
          .join('');

      // Per stream, EXACTLY what the child wrote — no allowance for lost
      // trailing lines. All 32 chatter lines are emitted long before the child
      // exits (the last lands around 8.4 MB of a 9 MiB record), so a missing
      // one is a defect here, not stdio teardown.
      expect(joined('stderr')).toBe(
        Array.from(
          { length: 32 },
          (_, index) => `chatter line ${index + 1}\n`,
        ).join(''),
      );
      expect(joined('stdout')).toBe(big.replace('SECRETVALUE', '***__1'));

      // Combined, live output is the same bytes as the durable copy. Both
      // pipes share one log, so the two streams' writes can interleave in
      // either order — the assertion is on the multiset of writes, which is
      // what "live equals durable" means for a shared sink.
      expect(live.map((entry) => entry.data).join('').length).toBe(
        persisted.length,
      );
      expect(
        [...live.map((entry) => entry.data).join('')].sort().join(''),
      ).toBe([...persisted].sort().join(''));
      // The big record survived the other pipe's traffic intact.
      const start = persisted.indexOf('{"***__1"');
      expect(start).toBeGreaterThanOrEqual(0);
      const end = persisted.indexOf('\n', start);
      expect(end).toBeGreaterThan(start);
      expect(JSON.parse(persisted.slice(start, end))).toEqual({
        '***__1': 'masked key',
        filler: 'z'.repeat(OVER_MARK),
        '***': 'ordinary',
      });
    }, 300_000);
  });

  it.each(['escaped', 'numeric', 'unicode'] as const)(
    'controller followup9: retains real durable large-record protection for %s',
    async (scenario) => {
      const secret = scenario === 'numeric' ? '123456' : 'abcdef';
      const source =
        scenario === 'escaped'
          ? String.raw`const s=JSON.stringify({padding:'x'.repeat(1050000),value:'abcdef'}); process.stdout.write(s.replace('abcdef','\\u0061bcdef')+'\n');`
          : scenario === 'numeric'
            ? String.raw`process.stdout.write(JSON.stringify({padding:'x'.repeat(1050000),value:123456})+'\n');`
            : String.raw`process.stdout.write('{"padding":"'+'x'.repeat(1050000)+'","value":"'); setTimeout(() => { process.stdout.write('😀abcd'); setTimeout(() => process.stdout.write('"}\n'), 50); }, 50);`;
      const logFile = join(directory, 'followup9-' + scenario + '.log');
      const chunks: string[] = [];
      const result = await runSpawnedProcessLocally(
        { command: process.execPath, args: ['-e', source] },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          timeout_minutes: 1,
          logFile,
          outputFile: join(directory, 'output.txt'),
          envFile: join(directory, 'env.txt'),
          secretValues: [secret],
          onOutput: (_stream, data) => {
            chunks.push(data);
          },
        },
      );
      expect(result.status).toBe('success');
      const persisted = await readFile(logFile, 'utf8');
      const valueOf = (text: string): unknown => {
        const record: unknown = JSON.parse(text);
        if (
          typeof record !== 'object' ||
          record === null ||
          !('value' in record)
        )
          return undefined;
        return record.value;
      };
      if (scenario === 'unicode') {
        expect(valueOf(persisted)).toBe('😀abcd');
        // Independently UTF-8 encoded live pieces: a mask boundary that split
        // a surrogate pair survives JS string concatenation but not this.
        expect(
          valueOf(chunks.map((c) => Buffer.from(c).toString('utf8')).join('')),
        ).toBe('😀abcd');
      } else {
        expect(String(valueOf(persisted))).not.toContain(secret);
        expect(String(valueOf(chunks.join('')))).not.toContain(secret);
      }
    },
  );

  it('keeps a real durable record valid when an unmatched prefix precedes it', async () => {
    // The controller's route probe, through the real writer: a plain line that
    // ends with the first line of a configured multi-line value leaves a
    // POSSIBLE prefix in the holdback. The record that follows is a separate,
    // complete document that does not continue it, and must not be routed
    // through the byte matcher — where a configured `nABCDE` splices the `n`
    // out of its own `\n` escape and leaves `"\***"`.
    const record = JSON.stringify({ type: 'result', result: '\nABCDE' });
    const source = `process.stdout.write('log ends with PREFIXX\\n'); setTimeout(() => process.stdout.write(${JSON.stringify(record + '\n')}), 60);`;
    const logFile = join(directory, 'route-prefix.log');
    const chunks: string[] = [];
    const result = await runSpawnedProcessLocally(
      { command: process.execPath, args: ['-e', source] },
      {
        cwd: directory,
        env: definedEnvironment(process.env),
        signal: new AbortController().signal,
        timeout_minutes: 1,
        logFile,
        outputFile: join(directory, 'output.txt'),
        envFile: join(directory, 'env.txt'),
        secretValues: ['PREFIXX\nSUFFIXY', 'nABCDE'],
        onOutput: (_stream, data) => {
          chunks.push(data);
        },
      },
    );
    expect(result.status).toBe('success');
    const persisted = await readFile(logFile, 'utf8');
    expect(chunks.join('')).toBe(persisted);
    const jsonLine = persisted.split('\n').find((line) => line.startsWith('{'));
    expect(jsonLine).toBe(record);
  });

  it('masks a real multi-line value that spans a plain line into a JSON-shaped one', async () => {
    // The case the routing exists for, through the real writer.
    const secret = 'prefix\n{"value":"classified"}';
    const source = `process.stdout.write('prefix\\n'); setTimeout(() => process.stdout.write('{"value":"classified"}\\n'), 60);`;
    const logFile = join(directory, 'route-multiline.log');
    const chunks: string[] = [];
    const result = await runSpawnedProcessLocally(
      { command: process.execPath, args: ['-e', source] },
      {
        cwd: directory,
        env: definedEnvironment(process.env),
        signal: new AbortController().signal,
        timeout_minutes: 1,
        logFile,
        outputFile: join(directory, 'output2.txt'),
        envFile: join(directory, 'env2.txt'),
        secretValues: [secret],
        onOutput: (_stream, data) => {
          chunks.push(data);
        },
      },
    );
    expect(result.status).toBe('success');
    const persisted = await readFile(logFile, 'utf8');
    expect(chunks.join('')).toBe(persisted);
    expect(persisted).not.toContain('classified');
  });

  it('accepts a very large valid record the same way whether it arrives whole or split', () => {
    // Acceptance must not depend on delivery. A valid record with no configured
    // value was byte-faithful when it arrived with its newline in one call and
    // was rejected when split before its closing syntax — same bytes, same child,
    // different answer.
    const value = 'q'.repeat(2_000_000);
    const line = `${JSON.stringify({ a: value })}\n`;
    const whole = (): string => {
      const redactor = new SecretValueRedactor(['ABSENTVALUE']);
      return redactor.redactChunk(line) + redactor.flush();
    };
    const split = (): string => {
      const redactor = new SecretValueRedactor(['ABSENTVALUE']);
      let output = '';
      // Deliberately ends the first write before the closing quote/brace/newline.
      output += redactor.redactChunk(line.slice(0, line.length - 3));
      output += redactor.redactChunk(line.slice(line.length - 3));
      return output + redactor.flush();
    };
    expect(whole()).toBe(line);
    expect(split()).toBe(line);
  });

  /**
   * The newline counter below counts OFFSETS. It stayed linear while the real
   * cost was V8 re-flattening the accumulated rope on every `indexOf` — an O(n)
   * copy per chunk. These count characters actually copied and actually
   * classified, which is what was expensive, and each has a positive control so
   * a counter that simply never rises cannot pass.
   */
  describe('work that grows with the retained line, not with the line squared', () => {
    const materializedFor = (writes: number): number => {
      const redactor = new SecretValueRedactor(['ABSENTVALUE']);
      const chunk = 'z'.repeat(4_096);
      spawnedProcessWorkCounters.reset();
      redactor.redactChunk('{"a":"');
      for (let index = 0; index < writes; index += 1)
        redactor.redactChunk(chunk);
      return spawnedProcessWorkCounters.pendingCharsMaterialized;
    };

    it('copies nothing out of a JSON line that has not ended yet', () => {
      // 1/2/4/8 MiB of 4,096-char writes measured 14.6/46.8/185.2/782.5 ms
      // before this, quadrupling per doubling.
      expect(materializedFor(256)).toBe(0);
      expect(materializedFor(512)).toBe(0);
      expect(materializedFor(1_024)).toBe(0);
    });

    it('positive control: completing the line does copy it exactly once', () => {
      const redactor = new SecretValueRedactor(['ABSENTVALUE']);
      const chunk = 'z'.repeat(4_096);
      spawnedProcessWorkCounters.reset();
      let output = redactor.redactChunk('{"a":"');
      for (let index = 0; index < 256; index += 1)
        output += redactor.redactChunk(chunk);
      expect(spawnedProcessWorkCounters.pendingCharsMaterialized).toBe(0);
      output += redactor.redactChunk('"}\n') + redactor.flush();
      const copied = spawnedProcessWorkCounters.pendingCharsMaterialized;
      // The record is copied — once, not once per chunk.
      expect(copied).toBeGreaterThan(256 * 4_096);
      expect(copied).toBeLessThan(3 * 256 * 4_096);
      // And it is byte-exact.
      const parsed: unknown = JSON.parse(output.trim());
      expect(
        typeof parsed === 'object' && parsed !== null && 'a' in parsed
          ? String((parsed as { a: unknown }).a).length
          : -1,
      ).toBe(256 * 4_096);
    });

    const classifiedFor = (writes: number): number => {
      const redactor = new SecretValueRedactor(['ABSENTVALUE']);
      spawnedProcessWorkCounters.reset();
      for (let index = 0; index < writes; index += 1) redactor.redactChunk(' ');
      return spawnedProcessWorkCounters.shapeCharsClassified;
    };

    it('classifies each whitespace character at most a bounded number of times', () => {
      // `classifyJsonDocumentStart(pendingLine)` restarted at index 0 on every
      // chunk: 16k/32k/64k one-character writes measured 287.6/1,091.9/4,182.9 ms.
      const small = classifiedFor(16_000);
      const large = classifiedFor(64_000);
      expect(small).toBeLessThanOrEqual(16_000 * 2);
      expect(large).toBeLessThanOrEqual(64_000 * 2);
      // Four times the input, not sixteen times the work.
      expect(large).toBeLessThan(small * 6);
    });

    it('positive control: classification work does rise with real content', () => {
      const redactor = new SecretValueRedactor(['ABSENTVALUE']);
      spawnedProcessWorkCounters.reset();
      for (let index = 0; index < 1_000; index += 1) redactor.redactChunk(' ');
      const afterWhitespace = spawnedProcessWorkCounters.shapeCharsClassified;
      expect(afterWhitespace).toBeGreaterThan(0);
      // Once a non-whitespace character decides the shape, it stops climbing.
      redactor.redactChunk('plain text');
      const decided = spawnedProcessWorkCounters.shapeCharsClassified;
      redactor.redactChunk(' more plain text');
      expect(spawnedProcessWorkCounters.shapeCharsClassified).toBe(decided);
    });
  });

  it('searches each received character for a line break at most once', () => {
    // `assembleLines` appended the chunk and then searched from offset zero, so
    // the retained prefix was rescanned (and re-flattened) after every chunk:
    // 100/200/400 writes of 4,096 characters searched 21.1M/83.2M/330.1M
    // characters. Doubling the input quadrupled the work.
    const searchedFor = (writes: number): number => {
      const redactor = new SecretValueRedactor(['ABSENTVALUE']);
      const chunk = 'z'.repeat(4_096);
      // Captured deliberately to delegate to and restore afterwards; it is
      // always called with an explicit receiver below, never detached.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const original = String.prototype.indexOf;
      let searched = 0;
      // Counts only the newline searches this class performs.
      // `function` rather than an arrow: the spy needs the receiver string to
      // count how far each search scanned. It is installed as a prototype
      // method and never detached from its object, so the `this`-scoping rule
      // the linter guards against does not apply here.
      function indexOfSpy(this: string, search: string, from?: number): number {
        if (search === '\n') searched += this.length - (from ?? 0);
        return original.call(this, search, from);
      }

      Object.defineProperty(String.prototype, 'indexOf', {
        value: indexOfSpy,
        configurable: true,
        writable: true,
      });
      try {
        redactor.redactChunk('{"a":"');
        for (let index = 0; index < writes; index += 1) {
          redactor.redactChunk(chunk);
        }
      } finally {
        Object.defineProperty(String.prototype, 'indexOf', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
      return searched;
    };
    const small = searchedFor(100);
    const large = searchedFor(400);
    // Four times the input must cost about four times the scanning, not sixteen.
    expect(large / Math.max(small, 1)).toBeLessThan(6);
  });

  it('fails the step when the output map cannot be read for a real reason', () => {
    // Both finalizers returned from the `readOutputMap` catch BEFORE applying a
    // recorded output-processing failure, so an error there could yield success.
    // A non-ENOENT read failure must surface as this step's failure.
    return (async (): Promise<void> => {
      const outputDir = join(directory, 'output-as-directory');
      await mkdir(outputDir, { recursive: true });
      const result = await runSpawnedProcessLocally(
        {
          command: process.execPath,
          args: ['-e', "process.stdout.write('ok\\n')"],
        },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          timeout_minutes: 1,
          logFile: join(directory, 'outputmap.log'),
          // A directory cannot be read as an output map: EISDIR, not ENOENT.
          outputFile: outputDir,
          envFile: join(directory, 'outputmap.env'),
          secretValues: ['SECRETVALUE'],
        },
      );
      expect(result.status).not.toBe('success');
    })();
  }, 60_000);

  it('reports the masking failure, not the unreadable output map, when both fail', () => {
    // Precedence: the read-failure catch used to return first, so a step whose
    // output was never masked as promised could still report its own status. The
    // masking promise outranks the unreadable map because output may already
    // have been streamed to the caller.
    return (async (): Promise<void> => {
      const outputDir = join(directory, 'both-fail-output');
      await mkdir(outputDir, { recursive: true });
      const failure = new Error('masking blew up');
      const timeoutSpy = jest.spyOn(global, 'setTimeout');
      const flushSpy = jest
        .spyOn(SecretValueRedactor.prototype, 'flush')
        .mockImplementation(() => {
          throw failure;
        });
      const streamed: string[] = [];
      const CHILD_LINE = 'a line of ordinary child output';
      try {
        const result = await runSpawnedProcessLocally(
          {
            command: process.execPath,
            // The escaped `\\n` reaches `node -e` as `\n` inside the quotes.
            // A bare `\n` here became a real newline in a single-quoted string,
            // so the child died of a SyntaxError and never wrote anything.
            args: ['-e', `process.stdout.write('${CHILD_LINE}\\n')`],
          },
          {
            cwd: directory,
            env: definedEnvironment(process.env),
            signal: new AbortController().signal,
            timeout_minutes: 1,
            logFile: join(directory, 'both-fail.log'),
            outputFile: outputDir,
            envFile: join(directory, 'both-fail.env'),
            secretValues: ['SECRETVALUE'],
            onOutput: (_stream, data) => {
              streamed.push(data);
            },
          },
        );
        // The child ran normally: it exited cleanly and its line reached the
        // caller, so the failure below is the masking failure and nothing
        // else. Only the line's head arrives: the redactor holds back a
        // configured value's length until the final flush, and that flush is
        // the call failing here.
        const delivered = streamed.join('');
        expect(result.exit_code).toBe(0);
        expect(delivered.length).toBeGreaterThan(0);
        expect(`${CHILD_LINE}\n`.startsWith(delivered)).toBe(true);
        expect(result.status).toBe('failure');
        expect(result.error).toContain('masking blew up');
        // The final flush runs after the child has already closed. Escalating
        // there used to arm a five-second force-kill timer that nothing would
        // ever clear, then signal an exited process group. Assert that exact
        // regression rather than counting unrelated timers in the Jest worker.
        expect(timeoutSpy).not.toHaveBeenCalledWith(
          expect.any(Function),
          FORCE_KILL_DELAY_MS,
        );
      } finally {
        flushSpy.mockRestore();
        timeoutSpy.mockRestore();
      }
    })();
  }, 60_000);

  it('keeps a cancelled step cancelled when its output map cannot be read', () => {
    // Cancellation is not relabelled as a failure; the reason is carried
    // alongside it so the cancelled run is not silently clean either.
    return (async (): Promise<void> => {
      const outputDir = join(directory, 'cancelled-output');
      await mkdir(outputDir, { recursive: true });
      const controller = new AbortController();
      const pending = runSpawnedProcessLocally(
        {
          command: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 30000)'],
        },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: controller.signal,
          timeout_minutes: 1,
          logFile: join(directory, 'cancelled.log'),
          outputFile: outputDir,
          envFile: join(directory, 'cancelled.env'),
          secretValues: ['SECRETVALUE'],
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      controller.abort();
      const result = await pending;
      expect(result.status).toBe('cancelled');
      expect(result.error).toBeDefined();
    })();
  }, 60_000);

  it('applies every mask with a single pass over the record', () => {
    // Substitution used to split/join the WHOLE output once per masked key, so
    // doubling the keys quadrupled the characters scanned (100/200/400 keys
    // scanned 249k/1.0M/4.1M). Counting the passes states that property
    // directly: it does not vary with machine load, it needs no megabyte of
    // filler to become measurable, and it cannot be quietly relaxed the way a
    // wall-clock ratio can.
    const passesFor = (keys: number): number => {
      const parts: string[] = [];
      for (let index = 0; index < keys; index += 1) {
        parts.push(`"SECRETVALUE${index}":${index}`);
      }
      const text = `{${parts.join(',')}}\n`;
      const redactor = new SecretValueRedactor(['SECRETVALUE']);
      redactionWorkCounters.reset();
      const output = redactor.redactChunk(text) + redactor.flush();
      expect(output).not.toContain('SECRETVALUE');
      // Every key is still masked and the record still parses.
      expect(
        Object.keys(JSON.parse(output.trim()) as Record<string, unknown>),
      ).toHaveLength(keys);
      return redactionWorkCounters.recordPasses;
    };
    expect(passesFor(100)).toBe(1);
    expect(passesFor(400)).toBe(1);
  });

  it.each(['whitespace', 'oversized', 'multiline'] as const)(
    'controller followup8: preserves parent output protection for %s framing',
    async (scenario) => {
      const secret =
        scenario === 'multiline' ? 'prefix\n{"value":"classified"}' : 'nABCDE';
      const line = JSON.stringify({ type: 'result', result: '\nABCDE' }) + '\n';
      const source =
        scenario === 'whitespace'
          ? `process.stdout.write(' '); setTimeout(() => process.stdout.write(${JSON.stringify(line)}), 100);`
          : scenario === 'oversized'
            ? `process.stdout.write(JSON.stringify({type:'result',result:'x'.repeat(1050000)+'\\nABCDE'})+'\\n');`
            : `process.stdout.write(${JSON.stringify(secret + '\n')});`;
      const logFile = join(directory, 'followup8-' + scenario + '.log');
      const chunks: string[] = [];
      const result = await runSpawnedProcessLocally(
        { command: process.execPath, args: ['-e', source] },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          timeout_minutes: 1,
          logFile,
          outputFile: join(directory, 'output.txt'),
          envFile: join(directory, 'env.txt'),
          secretValues: [secret],
          onOutput: (_stream, data) => {
            chunks.push(data);
          },
        },
      );
      expect(result.status).toBe('success');
      const persisted = await readFile(logFile, 'utf8');
      expect(chunks.join('')).toBe(persisted);
      if (scenario === 'multiline') {
        expect(persisted.includes(secret)).toBe(false);
      } else {
        let parsed: unknown;
        let parseError: unknown;
        try {
          parsed = JSON.parse(persisted);
        } catch (error) {
          parseError = error;
        }
        expect(parseError).toBeUndefined();
        expect(parsed).toEqual({
          type: 'result',
          result:
            (scenario === 'oversized' ? 'x'.repeat(1050000) : '') + '\nABCDE',
        });
      }
    },
  );

  it.each([
    ['nABCDE', '\nABCDE'],
    ['","subtype":', 'ordinary response'],
  ])(
    'controller parent JSON regression: preserves valid durable and live records with secret %p',
    async (secret, text) => {
      const logFile = join(directory, 'parent-json.log');
      const chunks: string[] = [];
      const record = { type: 'result', subtype: 'success', result: text };
      const line = JSON.stringify(record) + '\n';
      const result = await runSpawnedProcessLocally(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write(process.argv[1])', line],
        },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          timeout_minutes: 1,
          logFile,
          outputFile: join(directory, 'output.txt'),
          envFile: join(directory, 'env.txt'),
          secretValues: [secret],
          onOutput: (_stream, data) => chunks.push(data),
        },
      );
      expect(result.status).toBe('success');
      const persisted = await readFile(logFile, 'utf8');
      expect(() => {
        JSON.parse(persisted.trim());
      }).not.toThrow();
      expect(JSON.parse(persisted.trim())).toEqual(record);
      expect(JSON.parse(chunks.join('').trim())).toEqual(record);
    },
  );

  it('preserves an ordinary emoji through the real durable log file and IPC output callback, not just the concatenated JS string', async () => {
    // Controller finding: a naive assertion on the JOINED JS string can look
    // correct even when the ACTUAL durable log file bytes and the actual
    // `onOutput` chunks are individually corrupted, because JS string
    // concatenation doesn't care that two pieces used to be split mid
    // surrogate-pair. Read the real log file's raw bytes and independently
    // re-encode each `onOutput` chunk to UTF-8 exactly as a real sink would.
    const logFile = join(directory, 'emoji-step.log');
    const outputFile = join(directory, 'emoji-output.txt');
    const envFile = join(directory, 'emoji-env.txt');
    const chunks: string[] = [];
    const result = await runSpawnedProcessLocally(
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('😀abcd')"],
      },
      {
        cwd: directory,
        env: definedEnvironment(process.env),
        signal: new AbortController().signal,
        timeout_minutes: 1,
        logFile,
        outputFile,
        envFile,
        secretValues: ['abcdef'],
        onOutput: (_stream, data) => chunks.push(data),
      },
    );
    expect(result.status).toBe('success');
    const logBytes = await readFile(logFile);
    expect(logBytes.toString('utf8')).not.toContain('�');
    expect(logBytes.toString('utf8')).toBe('😀abcd');
    const reencoded = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk, 'utf8')),
    ).toString('utf8');
    expect(reencoded).not.toContain('�');
    expect(reencoded).toBe('😀abcd');
  });

  it('terminates an action when its execution is aborted', async () => {
    const controller = new AbortController();
    const result = runSpawnedProcessLocally(
      {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1_000)'],
      },
      {
        cwd: directory,
        env: definedEnvironment(process.env),
        signal: controller.signal,
        timeout_minutes: 1,
        logFile: join(directory, 'cancelled.log'),
        outputFile: join(directory, 'output.txt'),
        envFile: join(directory, 'env.txt'),
        onSpawn: () => controller.abort(),
      },
    );

    await expect(result).resolves.toMatchObject({
      status: 'cancelled',
      conclusion: 'cancelled',
      outcome: 'cancelled',
    });
  });
});
