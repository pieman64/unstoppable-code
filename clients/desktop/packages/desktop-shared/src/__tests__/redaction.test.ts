import { createHook } from 'node:async_hooks';
import {
  OverlapMatcher,
  overlapMatcherWorkCounters,
} from '../lib/overlap-matcher';
import { createTranscriptCapture } from '../builtin-actions/_lib/agent-transcript';
import {
  redactNormalizedStructuredValue,
  redactNormalizedText,
} from '../builtin-actions/agent-prompt/logic';
import { redactRecordFromSource } from '../node/pipelines/executor/streaming-json-redactor';
import {
  MaskedKeyAllocator,
  classifyJsonDocumentStart,
  redactJsonPreservingFormat,
  redactSecrets,
  redactSerializedJsonLine,
  redactStructuredValue,
  redactValues,
  redactNormalizedPreservingFormat,
  redactValuesUnfiltered,
  redactionWorkCounters,
} from '../lib/redaction';

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

describe('redactSecrets', () => {
  it('returns empty input unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('masks key:value and key=value secret pairs', () => {
    expect(redactSecrets('api_key: "abc123XYZ"')).toContain('<redacted>');
    expect(redactSecrets('api_key: "abc123XYZ"')).not.toContain('abc123XYZ');
    expect(redactSecrets('password=hunter2longvalue')).toBe(
      'password=<redacted>',
    );
    expect(redactSecrets('token=ghx_should_be_masked_value')).toContain(
      '<redacted>',
    );
  });

  it('masks Authorization / Cookie / Bearer headers', () => {
    expect(redactSecrets('Authorization: Bearer abcdef.ghijkl')).toBe(
      'Authorization: <redacted>',
    );
    expect(redactSecrets('Cookie: session=deadbeefcafe')).toBe(
      'Cookie: <redacted>',
    );
    expect(redactSecrets('using Bearer abcDEF123456_token here')).toContain(
      'Bearer <redacted>',
    );
  });

  it('masks JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4';
    const out = redactSecrets(`token ${jwt} end`);
    expect(out).toContain('<redacted-jwt>');
    expect(out).not.toContain(jwt);
  });

  it('masks GitHub tokens (classic + fine-grained)', () => {
    const ghp = 'ghp_' + 'A'.repeat(36);
    const pat = 'github_pat_' + 'B'.repeat(40);
    expect(redactSecrets(ghp)).toBe('<redacted-token>');
    expect(redactSecrets(pat)).toBe('<redacted-token>');
  });

  it('masks AWS access keys and sk- style keys', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('<redacted-aws-key>');
    expect(redactSecrets('sk-ant-api03-' + 'c'.repeat(40))).toBe(
      '<redacted-token>',
    );
  });

  it('masks PEM private key blocks', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC\nabc\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(pem);
    expect(out).toBe('<redacted-private-key>');
    expect(out).not.toContain('MIIEpAIBAAKC');
  });

  it('masks PII (emails and IPv4 addresses)', () => {
    expect(
      redactSecrets('contact me at jane.doe@example.com please'),
    ).toContain('<redacted-email>');
    expect(redactSecrets('server at 192.168.1.42 responded')).toContain(
      '<redacted-ip>',
    );
  });

  it('masks the username in user home-directory paths, keeping structure', () => {
    expect(redactSecrets('opened /Users/alice/projects/app/src/x.ts')).toBe(
      'opened <user-home>/projects/app/src/x.ts',
    );
    expect(redactSecrets('cd /home/bob/work && ls')).toBe(
      'cd <user-home>/work && ls',
    );
    expect(redactSecrets('path C:\\Users\\carol\\dev\\repo')).toBe(
      'path <user-home>\\dev\\repo',
    );
    expect(redactSecrets('/Users/alice/notes')).not.toContain('alice');
  });

  it('leaves benign text intact', () => {
    expect(redactSecrets('Refactored the worktree summary service.')).toBe(
      'Refactored the worktree summary service.',
    );
  });
});

describe('redactValues', () => {
  it('masks every occurrence of a known secret value, longest first', () => {
    expect(
      redactValues('token=sekret-123, backup=sekret-123-extra', [
        'sekret-123',
        'sekret-123-extra',
      ]),
    ).toBe('token=***, backup=***');
  });

  it('ignores values shorter than 6 characters', () => {
    expect(redactValues('the code is abc', ['abc'])).toBe('the code is abc');
  });

  it('leaves text with no matching secret value untouched', () => {
    expect(redactValues('nothing to see here', ['sekret-123456'])).toBe(
      'nothing to see here',
    );
  });

  it('fully masks two DIFFERENT configured values with staggered, overlapping start positions', () => {
    // Independent-review regression: this exact overlap class was fixed in
    // the streaming SecretValueRedactor (spawned-process.ts) but the
    // separate, unhardened `split`/`join` implementation here — which is
    // what actually redacts the durable rawText/structured/proposedPlan/
    // agent-failure.json outputs, not just the live transcript stream —
    // still had it. `abcdef` alone would match and finalize before
    // `cdefghijklmnopqrst` (starting a few characters later, extending
    // much further) was considered, leaving its non-overlapping tail as
    // unredacted raw text.
    expect(
      redactValues('LOG kkSECRETkkkkkkkkkkkkSECRET TAIL', [
        'kkSECRETkkkkkkkkkkkkSE',
        'SECRET',
      ]),
    ).toBe('LOG *** TAIL');
  });

  it('fully masks a self-overlapping (periodic) configured value that matches itself twice', () => {
    const value = 'abcabcabca';
    expect(redactValues(`XXXXX${value}${value.slice(7)}`, [value])).toBe(
      'XXXXX***',
    );
  });

  it('stays roughly linear, not quadratic, on a large input with several configured values that never occur', () => {
    // Mirrors the identical regression in SecretValueRedactor
    // (spawned-process.ts): matching every configured value from scratch on
    // every occurrence found, without caching a value's "not found from X
    // onward" result, made this super-linear when several configured
    // values never occur in `text` at all — each one costs a full
    // remaining-text `indexOf` scan on every occurrence found elsewhere.
    const values = Array.from(
      { length: 10 },
      (_, i) => `sekret-${String(i).padStart(6, '0')}`,
    );
    const chunk = `${'x'.repeat(50)}${values[0]}${'y'.repeat(10)}`.repeat(
      20_000,
    );
    let output = '';
    const work = indexOfWork(() => {
      output = redactValues(chunk, values);
    });
    expect(output).not.toContain(values[0]);
    // Each value scanned about once, not once per match found elsewhere.
    expect(work).toBeLessThanOrEqual((values.length + 2) * chunk.length);
  });

  it('stays roughly linear, not quadratic, on a long run of a self-overlapping (periodic) configured value', () => {
    // Independent-review regression: extendMatchToFurthestOverlap used to
    // re-slice and re-scan the whole growing merged span from scratch on
    // every pass, which is quadratic in the span's size — a long run of a
    // self-overlapping value (the exact shape the overlap fix above exists
    // to catch) made a merely tens-of-KB input take seconds.
    const text = 'abc'.repeat(40_000);
    let output = '';
    const work = indexOfWork(() => {
      output = redactValues(text, ['abcabc']);
    });
    expect(output).not.toContain('abcabc');
    expect(work).toBeLessThanOrEqual(3 * text.length);
  });
});

describe('redactStructuredValue', () => {
  it('names colliding masked siblings with work linear in their count', () => {
    // The `__N` probe restarted at 1 for every colliding sibling, so k siblings
    // examined O(k^2) candidates — 500/1k/2k/4k/8k measured
    // 5.7/20.3/79.8/322.6/1365.5 ms, quadrupling per doubling. Counted rather
    // than timed: a wall-clock ratio varies with load and invites relaxing.
    const probesFor = (siblings: number): number => {
      const allocator = new MaskedKeyAllocator();
      redactionWorkCounters.reset();
      const names = new Set<string>();
      for (let index = 0; index < siblings; index += 1)
        names.add(allocator.allocateIn(1, '***', '***'));
      // Every sibling still gets its own distinct name.
      expect(names.size).toBe(siblings);
      return redactionWorkCounters.maskedKeyCandidatesProbed;
    };
    const small = probesFor(500);
    const large = probesFor(4_000);
    // One probe per sibling, not one per sibling per predecessor.
    expect(small).toBeLessThanOrEqual(500 * 2);
    expect(large).toBeLessThanOrEqual(4_000 * 2);
    // Eight times the siblings, not sixty-four times the work.
    expect(large).toBeLessThan(small * 16);
  });

  it('positive control: the candidate probe counter does rise, and skips taken names', () => {
    const allocator = new MaskedKeyAllocator();
    // A pre-existing ordinary key already holds `***__1`.
    allocator.reserveIn(1, '***');
    allocator.reserveIn(1, '***__1');
    redactionWorkCounters.reset();
    const name = allocator.allocateIn(1, '***', '***');
    // It had to step over the taken candidate, so it probed more than once.
    expect(redactionWorkCounters.maskedKeyCandidatesProbed).toBeGreaterThan(1);
    expect(name).toBe('***__2');
  });

  it('round-trips every JSON-derived shape a provider record can contain', () => {
    // The documented input contract is JSON-derived data. This pins the shapes
    // that ARE supported (a transcript record's realistic leaves) rather than
    // adding speculative Date/Buffer handling no current caller can produce.
    const record: unknown = JSON.parse(
      JSON.stringify({
        type: 'assistant',
        usage: { input_tokens: 12, cost: 0.0004, cached: null },
        ok: true,
        content: [
          { type: 'text', text: 'plain' },
          { type: 'tool_use', input: { nested: { deep: ['a', 1, false] } } },
        ],
        big: '1740000000123456789',
        unicode: 'é-日本-😀',
      }),
    );
    // Nothing matches, so the value must survive a pass unchanged.
    expect(redactStructuredValue(record, ['ABSENTVALUE'])).toEqual(record);
    expect(JSON.stringify(redactStructuredValue(record, ['ABSENTVALUE']))).toBe(
      JSON.stringify(record),
    );
  });

  it('never renames a key it did not mask, matching the serialized path', () => {
    // A masked key used to take a name a LATER ordinary key already held,
    // pushing that untouched key to `***__1__1`. All three paths must agree.
    const source = '{"***":1,"SECRETVALUE":2,"***__1":3}';
    const expected = { '***': 1, '***__2': 2, '***__1': 3 };
    expect(redactStructuredValue(JSON.parse(source), ['SECRETVALUE'])).toEqual(
      expected,
    );
    expect(redactSerializedJsonLine(source, ['SECRETVALUE'])).toBe(
      JSON.stringify(expected),
    );
  });

  it('masks a secret value nested in an object leaf', () => {
    expect(
      redactStructuredValue({ note: 'key is sekret-123456' }, [
        'sekret-123456',
      ]),
    ).toEqual({ note: 'key is ***' });
  });

  it('leaves a structured value with no matching secret untouched', () => {
    const value = { note: 'plain text', count: 3 };
    expect(redactStructuredValue(value, ['sekret-123456'])).toEqual(value);
  });

  it('does not fabricate a match for text that only exists as a JSON-serialization artifact, not as an actual leaf or key', () => {
    // This string (spanning "a"'s value, the `","b":"` structural separator,
    // and part of "b"'s value) only exists in the *serialized* form of the
    // object — it is not the value or key of any real leaf. A whole-string
    // approach over `JSON.stringify(value)` would still "find" it and could
    // corrupt JSON syntax by splicing over structural characters; the
    // structural walk below never serializes at all, so it correctly finds
    // nothing to redact here.
    const value = { a: 'AAAAAA', b: 'BBBBBB' };
    const serialized = JSON.stringify(value);
    const serializationArtifact = serialized.slice(6, -1);
    expect(redactStructuredValue(value, [serializationArtifact])).toEqual(
      value,
    );
  });

  it('redacts a numeric leaf value that exactly matches a configured secret', () => {
    expect(
      redactStructuredValue({ count: 123456, secret: '123456' }, ['123456']),
    ).toEqual({ count: '***', secret: '***' });
  });

  it('redacts an object key that exactly matches a configured secret', () => {
    expect(
      redactStructuredValue({ 123456: 'value', count: 123456 }, ['123456']),
    ).toEqual({ '***': 'value', count: '***' });
  });

  it('leaves a numeric leaf untouched when it does not match any configured secret', () => {
    expect(redactStructuredValue({ count: 42 }, ['sekret-123456'])).toEqual({
      count: 42,
    });
  });

  it('redacts a numeric leaf that contains a configured secret as a substring, matching string-leaf behavior', () => {
    expect(redactStructuredValue({ v: 12345678 }, ['123456'])).toEqual({
      v: '***78',
    });
    expect(redactStructuredValue({ v: '12345678' }, ['123456'])).toEqual({
      v: '***78',
    });
  });

  it('recurses into nested arrays and objects', () => {
    expect(
      redactStructuredValue(
        {
          items: [{ note: 'contains sekret-123456' }, [42, 'sekret-123456']],
        },
        ['sekret-123456'],
      ),
    ).toEqual({
      items: [{ note: 'contains ***' }, [42, '***']],
    });
  });

  it('disambiguates two distinct keys that would otherwise collide after redaction', () => {
    const result = redactStructuredValue(
      { 'sekret-one12': 'first', 'sekret-two34': 'second' },
      ['sekret-one12', 'sekret-two34'],
    );
    expect(Object.keys(result as Record<string, unknown>)).toHaveLength(2);
    expect(Object.values(result as Record<string, unknown>).sort()).toEqual([
      'first',
      'second',
    ]);
  });

  it('does not drop an unredacted key that collides with an already-emitted redacted key', () => {
    const result = redactStructuredValue({ aaaaaa: 'first', '***': 'second' }, [
      'aaaaaa',
    ]) as Record<string, unknown>;
    expect(Object.keys(result)).toHaveLength(2);
    expect(Object.values(result).sort()).toEqual(['first', 'second']);
  });

  it('treats an own "__proto__" property as ordinary data, without prototype pollution', () => {
    // A computed key bypasses the object-literal `__proto__` initializer's
    // special-cased prototype-setting behavior, giving a real own property
    // named "__proto__" — the shape an attacker-controlled key could take.
    const protoKey = '__proto__';
    const input: Record<string, string> = { [protoKey]: 'sekret-123456' };
    const result = redactStructuredValue(input, ['sekret-123456']) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(
      true,
    );
    expect(result.__proto__).toBe('***');
  });
});

describe('redactSerializedJsonLine', () => {
  it('leaves a record that contains no configured value byte-for-byte identical', () => {
    // Fidelity contract: transcript records are provider-owned data this
    // process only forwards. The previous parse-and-re-serialize
    // implementation silently rewrote EVERY record whenever any secret was
    // configured — an integer past 2^53 lost precision, `1.0` became `1`,
    // `1e5` became `100000`, and `\uXXXX` escapes re-emitted as raw
    // characters — even though none of them contained a secret.
    const line =
      '{"id":1740000000123456789,"ratio":1.0,"scale":1e5,"label":"caf\\u00e9"}';
    expect(redactSerializedJsonLine(line, ['sekret-value-123456'])).toBe(line);
  });

  it('does not corrupt a record when a configured value collides with JSON syntax', () => {
    // Controller repro: `","subtype":` occurs in the SERIALIZED form of any
    // ordinary two-field record but in no decoded leaf, so masking it would
    // splice `***` across a structural delimiter and destroy the record.
    const record = { type: 'result', subtype: 'success', result: 'ordinary' };
    const line = JSON.stringify(record);
    const output = redactSerializedJsonLine(line, ['","subtype":']);
    expect(JSON.parse(output)).toEqual(record);
  });

  it('does not corrupt a record when a configured value collides with an escape sequence', () => {
    // Controller repro: a configured `nABCDE` matches the `n` of a `\n`
    // escape followed by the text after it, producing `"\***"` — a bad
    // escaped character that no parser accepts.
    const record = { type: 'result', result: '\nABCDE' };
    const line = JSON.stringify(record);
    const output = redactSerializedJsonLine(line, ['nABCDE']);
    expect(JSON.parse(output)).toEqual(record);
  });

  it('masks a multi-line configured value whose newlines were serialized as escapes', () => {
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    const line = JSON.stringify({ text: `before ${secret} after` });
    const output = redactSerializedJsonLine(line, [secret]);
    expect(JSON.parse(output)).toEqual({ text: 'before *** after' });
    expect(output).not.toContain('line2-abcdef');
  });

  it('masks a configured value inside a numeric leaf without producing invalid JSON', () => {
    const line = JSON.stringify({ count: 12345678 });
    const output = redactSerializedJsonLine(line, ['234567']);
    expect(JSON.parse(output)).toEqual({ count: '***' });
  });

  it('does not let JSON escaping promote an ineligible short value into a match', () => {
    // Eligibility is decided from each value's ORIGINAL form: `ab"cd` is
    // five characters and deliberately below the floor, even though its
    // escaped form `ab\"cd` is six.
    const line = JSON.stringify({ text: 'ab"cd' });
    expect(redactSerializedJsonLine(line, ['ab"cd'])).toBe(line);
  });

  it('falls back to raw matching for output that is not valid JSON', () => {
    const secret = 'sekret-plain-value-123';
    expect(redactSerializedJsonLine(`plain ${secret} text`, [secret])).toBe(
      'plain *** text',
    );
  });
});

describe('classifyJsonDocumentStart', () => {
  it('reports whitespace-only input as undecided rather than as not-JSON', () => {
    // The whole point of the third state: a caller that reads " " as proof
    // the line is not a document commits the rest of that line to the raw
    // matcher and corrupts the record that follows it.
    expect(classifyJsonDocumentStart(' ')).toBe('undecided');
    expect(classifyJsonDocumentStart('')).toBe('undecided');
    expect(classifyJsonDocumentStart('\t\r\n ')).toBe('undecided');
  });

  it('reports a document once its first real character arrives', () => {
    expect(classifyJsonDocumentStart('  {"a":1}')).toBe('json');
    expect(classifyJsonDocumentStart('[1]')).toBe('json');
  });

  it('reports ordinary text as other', () => {
    expect(classifyJsonDocumentStart('  hello')).toBe('other');
    expect(classifyJsonDocumentStart('42')).toBe('other');
  });
});

describe('redactSerializedJsonLine key disambiguation', () => {
  it('does not collapse two sibling keys that mask to the same placeholder', () => {
    // Both keys became the literal `***`, so a
    // reparse kept only the last one and silently dropped a field — a data
    // loss that contradicts this path's "cannot corrupt the document" claim.
    const record = '{"SUPERSECRET1":"a","SUPERSECRET2":"b"}';
    const output = redactSerializedJsonLine(record, [
      'SUPERSECRET1',
      'SUPERSECRET2',
    ]);
    expect(output).not.toContain('SUPERSECRET');
    const parsed: unknown = JSON.parse(output);
    expect(Object.keys(parsed as Record<string, unknown>)).toHaveLength(2);
    expect(Object.values(parsed as Record<string, unknown>)).toEqual([
      'a',
      'b',
    ]);
  });

  it('leaves a masked key alone when it cannot collide', () => {
    expect(
      redactSerializedJsonLine('{"SUPERSECRET1":"a","other":"b"}', [
        'SUPERSECRET1',
      ]),
    ).toBe('{"***":"a","other":"b"}');
  });
});

describe('masked object-key collisions', () => {
  // Production routes every resident line through this function.
  const lineRedact = (values: readonly string[], text: string): string =>
    redactSerializedJsonLine(text, values);
  // A record too large to hold goes through the streaming redactor instead:
  // one character at a time, with every key and token forced to storage.
  const streamAll = async (
    values: readonly string[],
    text: string,
  ): Promise<string> => {
    let output = '';
    const accepted = await redactRecordFromSource(
      {
        chunks: async function* (): AsyncIterable<string> {
          for (let at = 0; at < text.length; at += 1)
            yield await Promise.resolve(text.charAt(at));
        },
      },
      values,
      (piece) => {
        output += piece;
      },
      { exactKeySetChars: 1, tokenSpillChars: 1 },
    );
    expect(accepted).toBe(true);
    return output;
  };
  const keyCount = (text: string): number => {
    const parsed: unknown = JSON.parse(text);
    return Object.keys(parsed as Record<string, unknown>).length;
  };

  // Disambiguation only registered keys it had
  // masked, so a key already named like a mask collided with one and the
  // reparse dropped a field — the exact corruption the function promises not
  // to cause.
  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly doc: string;
    readonly values: readonly string[];
  }> = [
    {
      name: 'ordinary mask-shaped key before the masked one',
      doc: '{"***":1,"SECRETVALUE":2}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'ordinary mask-shaped key after the masked one',
      doc: '{"SECRETVALUE":1,"***":2}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'ordinary suffix-shaped key',
      doc: '{"***__1":1,"SECRETVALUE":2,"SECRETVALUEB":3}',
      values: ['SECRETVALUE', 'SECRETVALUEB'],
    },
    {
      name: 'same-scope siblings',
      doc: '{"SECRETVALUE1":1,"SECRETVALUE2":2}',
      values: ['SECRETVALUE1', 'SECRETVALUE2'],
    },
  ];

  it.each(CASES)(
    'keeps every field for $name (parsed path)',
    ({ doc, values }) => {
      const output = redactJsonPreservingFormat(doc, values) ?? doc;
      expect(keyCount(output)).toBe(keyCount(doc));
      expect(output).not.toContain('SECRETVALUE');
    },
  );

  it.each(CASES)(
    'keeps every field for $name (line path)',
    ({ doc, values }) => {
      const output = lineRedact(values, doc);
      expect(keyCount(output)).toBe(keyCount(doc));
      expect(output).not.toContain('SECRETVALUE');
    },
  );

  it.each(CASES)(
    'keeps every field for $name (streamed path)',
    async ({ doc, values }) => {
      const output = await streamAll(values, doc);
      expect(keyCount(output)).toBe(keyCount(doc));
      expect(output).not.toContain('SECRETVALUE');
    },
  );

  it('keeps both fields when a masked key precedes an ordinary mask-shaped key', async () => {
    // The record is unambiguous — two DISTINCT keys — so masking must not make
    // it ambiguous. An earlier version of this file asserted the field loss and
    // called the result JSON's own ambiguity; that misdescribed the input. Both
    // paths now keep both fields, and the key the user wrote keeps its name.
    const doc = '{"SECRETVALUE":1,"***":2}';
    for (const output of [
      lineRedact(['SECRETVALUE'], doc),
      await streamAll(['SECRETVALUE'], doc),
      redactJsonPreservingFormat(doc, ['SECRETVALUE']) ?? doc,
    ]) {
      expect(output).not.toContain('SECRETVALUE');
      const fields = JSON.parse(output) as Record<string, unknown>;
      expect(Object.keys(fields)).toHaveLength(2);
      expect(Object.values(fields)).toEqual(expect.arrayContaining([1, 2]));
    }
  });

  it.each(CASES)(
    'line, streamed and parsed agree for $name',
    async ({ doc, values }) => {
      const parsed = redactJsonPreservingFormat(doc, values) ?? doc;
      expect(lineRedact(values, doc)).toBe(parsed);
      expect(await streamAll(values, doc)).toBe(parsed);
    },
  );

  it('does not rename a key in an unrelated nested object', async () => {
    // Duplicate keys only matter inside ONE object. Disambiguating across
    // sibling objects renames a key that had no collision to avoid.
    const doc = '{"a":{"SECRETVALUE":1},"b":{"SECRETVALUE":2}}';
    const expected = '{"a":{"***":1},"b":{"***":2}}';
    expect(redactJsonPreservingFormat(doc, ['SECRETVALUE'])).toBe(expected);
    expect(lineRedact(['SECRETVALUE'], doc)).toBe(expected);
    expect(await streamAll(['SECRETVALUE'], doc)).toBe(expected);
  });

  it('never renames an ordinary key that was not masked', () => {
    const doc = '{"***":1,"plain":2}';
    expect(redactJsonPreservingFormat(doc, ['ABSENTVALUE'])).toBe(doc);
    expect(lineRedact(['ABSENTVALUE'], doc)).toBe(doc);
  });

  it.each([5_000, 20_000, 80_000])(
    'resolves %i masked keys to distinct names with no bookkeeping cap',
    (keys) => {
      // The old streaming path stopped recording key names past a character cap
      // and could then reuse a name that was already taken, losing a field. The
      // path production uses has no such cap: every masked key gets a distinct
      // name and every field survives a reparse.
      const pairs = Array.from(
        { length: keys },
        (_unused, index) => `"SECRETVALUE${index}":${index}`,
      ).join(',');
      const text = `{${pairs}}`;
      const output = redactSerializedJsonLine(text, ['SECRETVALUE']);
      expect(output).not.toContain('SECRETVALUE');
      const fields = JSON.parse(output) as Record<string, unknown>;
      expect(Object.keys(fields)).toHaveLength(keys);
    },
  );
});

describe('object-key identity and duplicate preservation', () => {
  const lineRedact = (values: readonly string[], text: string): string =>
    redactSerializedJsonLine(text, values);
  const keyCount = (text: string): number => {
    const parsed: unknown = JSON.parse(text);
    return Object.keys(parsed as Record<string, unknown>).length;
  };

  it('keeps every field when more keys exist than the tracker can hold', () => {
    // Controller case: forgetting committed names past a cap lets the generated
    // `__1` land on a key that is already there. 257 keys in, 257 keys out.
    const entries = ['"***__1":999'];
    for (let index = 0; index < 255; index += 1) {
      entries.push(`"k${index}":${index}`);
    }
    entries.push('"SECRETVALUE":1');
    const doc = `{${entries.join(',')}}`;
    expect(keyCount(doc)).toBe(257);
    for (const output of [
      redactJsonPreservingFormat(doc, ['SECRETVALUE']) ?? doc,
      lineRedact(['SECRETVALUE'], doc),
    ]) {
      expect(output).not.toContain('SECRETVALUE');
      expect(keyCount(output)).toBe(257);
    }
  });

  it('recognises a key whose spelling is escaped but whose identity is a mask', () => {
    // Controller case: `"\u002a\u002a\u002a"` IS the key `***`. Comparing
    // serialized spelling missed the collision and one of two fields was lost.
    const doc = '{"\\u002a\\u002a\\u002a":1,"SECRETVALUE":2}';
    expect(keyCount(doc)).toBe(2);
    for (const output of [
      redactJsonPreservingFormat(doc, ['SECRETVALUE']) ?? doc,
      lineRedact(['SECRETVALUE'], doc),
    ]) {
      expect(output).not.toContain('SECRETVALUE');
      expect(keyCount(output)).toBe(2);
    }
  });

  it('leaves a pre-existing duplicate key exactly as it arrived', () => {
    // Controller case: an ordinary duplicate became an invented `dup__1`.
    // Masking did not apply to it, so nothing about it may change.
    const doc = '{"dup":"plain a","filler":"x","dup":"plain b"}';
    expect(redactJsonPreservingFormat(doc, ['SECRETVALUE']) ?? doc).toBe(doc);
    expect(lineRedact(['SECRETVALUE'], doc)).toBe(doc);
  });

  it('leaves ordinary sibling objects untouched however many there are', () => {
    // Controller case: 4,937 of 5,000 rows lost fields because the scope stack
    // leaked one entry per object whose last member is a string value, and the
    // leak eventually renamed ordinary keys.
    const rows = Array.from({ length: 300 }, (_unused, index) => ({
      id: index,
      name: `row-${index}`,
      note: 'z'.repeat(20),
    }));
    const doc = JSON.stringify({ results: rows });
    expect(lineRedact(['SUPERSECRETVALUE'], doc)).toBe(doc);
    expect(redactJsonPreservingFormat(doc, ['SUPERSECRETVALUE']) ?? doc).toBe(
      doc,
    );
  });

  it('pairs scope exit for an object whose last member is a string value', () => {
    // The shape a paired enter/leave scope stack got wrong: `}` always arrived
    // while the string token was still withheld for the key decision. Scope ids
    // now come from one whole-record walk, so this pins the outcome rather than
    // that mechanism.
    const doc = '{"a":{"b":"v"},"b":{"c":"v"}}';
    expect(lineRedact(['SECRETVALUE'], doc)).toBe(doc);
    const nested = '{"x":{"type":"t"},"type":"outer"}';
    expect(lineRedact(['SECRETVALUE'], nested)).toBe(nested);
  });
});

describe('streamed token work', () => {
  // The stored-record pass appends a key or number one character at a time.
  // It used to allocate settled promises for every character — about two per
  // character even when no storage was pending — which made a 1.2M-character
  // key several times slower than the rest of the pass. The pass must still
  // wait whenever storage really is being created, so both default and forced
  // spill limits are exercised, and the output must stay exact.
  const MARKER = 'SYNTHETIC_REDACTION_MARKER';

  /** Promises created while one record is masked, plus what it wrote. */
  const measure = async (
    text: string,
    limits: { tokenSpillChars?: number },
  ): Promise<{ promises: number; output: string }> => {
    let promises = 0;
    let output = '';
    const hook = createHook({
      init(_id, type): void {
        if (type === 'PROMISE') promises += 1;
      },
    });
    hook.enable();
    try {
      const accepted = await redactRecordFromSource(
        {
          chunks: async function* (): AsyncIterable<string> {
            for (let at = 0; at < text.length; at += 65_536)
              yield await Promise.resolve(text.slice(at, at + 65_536));
          },
        },
        [MARKER, '987654321'],
        (piece) => {
          output += piece;
        },
        limits,
      );
      expect(accepted).toBe(true);
    } finally {
      hook.disable();
    }
    return { promises, output };
  };

  const SMALL = 65_536;
  const LARGE = 4 * SMALL;
  const shapes: ReadonlyArray<readonly [string, (length: number) => string]> = [
    [
      'a masked key',
      (length): string => `{"${MARKER}${'k'.repeat(length)}":1}`,
    ],
    ['an ordinary key', (length): string => `{"${'k'.repeat(length)}":1}`],
    ['a number', (length): string => `{"n":${'1'.repeat(length)}}`],
  ];
  const spills: ReadonlyArray<readonly [string, { tokenSpillChars?: number }]> =
    [
      ['default limits', {}],
      ['a forced spill', { tokenSpillChars: 1_024 }],
    ];

  describe.each(spills)('with %s', (_limitName, limits) => {
    it.each(shapes)(
      'does not create a promise per character of %s',
      async (_shapeName, record) => {
        const small = await measure(record(SMALL), limits);
        const large = await measure(record(LARGE), limits);
        expect(small.output).toBe(
          redactSerializedJsonLine(record(SMALL), [MARKER, '987654321']),
        );
        expect(large.output).toBe(
          redactSerializedJsonLine(record(LARGE), [MARKER, '987654321']),
        );
        // Chunks, storage blocks and replays still cost promises, but only
        // per 64 KiB block — never per character.
        expect(large.promises - small.promises).toBeLessThan(
          (LARGE - SMALL) / 64,
        );
      },
    );
  });
});

describe('a longer value that starts before a shorter one it contains', () => {
  // Whole-text masking finds the leftmost occurrence first, so a configured
  // URL masks as one span even when its password is configured too. A
  // streaming matcher that commits the password as soon as it completes has
  // already released the URL's head and can never mask the rest of it.
  const URL = 'postgres://admin:S3cretPass@db.internal:5432/app';
  const PASSWORD = 'S3cretPass';

  /** Masks `text` one character at a time, the way streams arrive. */
  const streamed = (text: string, values: readonly string[]): string => {
    let output = '';
    const matcher = new OverlapMatcher(
      [...values].sort((left, right) => right.length - left.length),
      (piece) => {
        output += piece;
      },
    );
    for (const character of Array.from(text))
      matcher.push(character, character);
    matcher.end();
    return output;
  };
  /** The record streamed through the stored-record redactor. */
  const stored = async (
    text: string,
    values: readonly string[],
  ): Promise<string> => {
    let output = '';
    const accepted = await redactRecordFromSource(
      {
        chunks: async function* (): AsyncIterable<string> {
          for (let at = 0; at < text.length; at += 7)
            yield await Promise.resolve(text.slice(at, at + 7));
        },
      },
      values,
      (piece) => {
        output += piece;
      },
      { exactKeySetChars: 1, tokenSpillChars: 1 },
    );
    expect(accepted).toBe(true);
    return output;
  };

  it.each([
    ['URL first', [URL, PASSWORD]],
    ['password first', [PASSWORD, URL]],
  ])('masks the whole URL in streamed text (%s)', (_order, values) => {
    expect(streamed(`DB is ${URL} ok`, values)).toBe('DB is *** ok');
  });

  it.each([
    ['URL first', [URL, PASSWORD]],
    ['password first', [PASSWORD, URL]],
  ])(
    'masks the whole URL in a stored value and key, as the resident path does (%s)',
    async (_order, values) => {
      const record = JSON.stringify({
        note: `DB is ${URL} ok`,
        [URL]: 17,
        tail: 'kept',
      });
      const resident = redactSerializedJsonLine(record, values);
      expect(JSON.parse(resident)).toEqual({
        note: 'DB is *** ok',
        '***': 17,
        tail: 'kept',
      });
      expect(await stored(record, values)).toBe(resident);
    },
  );

  it('still masks the password when the URL never completes', () => {
    expect(
      streamed('DB is postgres://admin:S3cretPass@elsewhere ok', [
        URL,
        PASSWORD,
      ]),
    ).toBe('DB is postgres://admin:***@elsewhere ok');
  });

  it('agrees with whole-text masking on generated text', () => {
    // A small alphabet makes contained, overlapping, adjacent, repeated and
    // transitive occurrences common; the whole-text result is the oracle.
    let seed = 20_260_922;
    const next = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    const word = (length: number): string =>
      Array.from({ length }, () => 'abc'[next(3)]).join('');
    const mismatches: string[] = [];
    for (let trial = 0; trial < 2_000; trial += 1) {
      const values = Array.from({ length: 1 + next(3) }, () =>
        word(2 + next(5)),
      );
      const text = word(next(40));
      const expected = redactValuesUnfiltered(
        text,
        Array.from(new Set(values)).sort(
          (left, right) => right.length - left.length,
        ),
      );
      const actual = streamed(text, values);
      if (actual !== expected)
        mismatches.push(`${JSON.stringify(values)} ${text}: ${actual}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

describe('streamed matching does not rescan what it holds back', () => {
  // The matcher holds back one character less than the longest value. It
  // used to search that whole held window for every value on every pushed
  // character, so work grew with text length times value length. Each shape
  // below is checked against whole-text masking, so a bound is never bought
  // with different output.
  const pushAll = (text: string, values: readonly string[]): string => {
    let output = '';
    const matcher = new OverlapMatcher(
      [...values].sort((left, right) => right.length - left.length),
      (piece) => {
        output += piece;
      },
    );
    for (const character of text) matcher.push(character, character);
    matcher.end();
    return output;
  };
  const oracle = (text: string, values: readonly string[]): string =>
    redactValuesUnfiltered(
      text,
      Array.from(new Set(values)).sort(
        (left, right) => right.length - left.length,
      ),
    );
  const long = (seed: string, length: number): string =>
    seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

  it.each([
    [
      'a long value that never matches',
      [
        long('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC', 2_653),
        'synthetic-short',
      ],
      long('lorem ipsum dolor sit amet, ', 60_000),
    ],
    [
      "text full of a long value's first character",
      [`a${long('bcdefghij', 1_999)}`, 'azzzzz'],
      long('abababab ', 60_000),
    ],
    [
      'a periodic value over a long periodic run',
      [long('AB', 1_000), long('BA', 600)],
      `x${long('AB', 60_000)}y`,
    ],
    [
      'a periodic value over a run that keeps almost matching',
      [`${long('AB', 998)}C`],
      long('AB', 60_000),
    ],
    [
      'many long values present among the text',
      Array.from(
        { length: 32 },
        (_, index) =>
          `${String(index).padStart(3, '0')}${long('qwertyuiop', 400)}`,
      ),
      Array.from({ length: 150 }, (_, index) =>
        index % 5 === 0
          ? `${String(index % 32).padStart(3, '0')}${long('qwertyuiop', 400)} `
          : 'plain words between them ',
      ).join(''),
    ],
  ])('stays linear for %s', (_name, values, text) => {
    let output = '';
    const steps = overlapMatcherWorkCounters.searchSteps;
    const scanned = indexOfWork(() => {
      output = pushAll(text, values);
    });
    expect(output).toBe(oracle(text, values));
    expect(scanned).toBeLessThanOrEqual(4 * text.length);
    // The matcher's own search work: per character and per value, never per
    // held-back character.
    expect(overlapMatcherWorkCounters.searchSteps - steps).toBeLessThanOrEqual(
      4 * text.length * values.length,
    );
  });

  it('agrees with whole-text masking on generated overlapping text', () => {
    // Two letters and values from one to eight long make contained,
    // overlapping, periodic, repeated, duplicate and single-character values
    // common; whole-text masking is the oracle.
    let seed = 7_331_2026;
    const next = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    const word = (length: number): string =>
      Array.from({ length }, () => 'ab'[next(2)]).join('');
    const mismatches: string[] = [];
    for (let trial = 0; trial < 5_000; trial += 1) {
      const values = Array.from({ length: 1 + next(5) }, () =>
        word(1 + next(8)),
      );
      const text = word(next(120));
      const expected = oracle(text, values);
      const actual = pushAll(text, values);
      if (actual !== expected)
        mismatches.push(`${JSON.stringify(values)} ${text}: ${actual}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it.each([1, 8, 32])(
    'does work independent of held-back length with %i values',
    (count) => {
      // Negative control on scaling: the same text with ten-times-longer
      // values must not cost ten times as much.
      const text = long('the quick brown fox jumps over the lazy dog ', 40_000);
      const values = (length: number): string[] =>
        Array.from(
          { length: count },
          (_, index) => `${String(index).padStart(2, '0')}${long('Z', length)}`,
        );
      let shortOutput = '';
      let longOutput = '';
      const shortWork = indexOfWork(() => {
        shortOutput = pushAll(text, values(200));
      });
      const longWork = indexOfWork(() => {
        longOutput = pushAll(text, values(2_000));
      });
      expect(shortOutput).toBe(text);
      expect(longOutput).toBe(text);
      expect(longWork).toBeLessThanOrEqual(2 * shortWork + 4 * text.length);
      const steps = overlapMatcherWorkCounters.searchSteps;
      pushAll(text, values(2_000));
      expect(
        overlapMatcherWorkCounters.searchSteps - steps,
      ).toBeLessThanOrEqual(4 * text.length * count);
    },
  );
});

describe('configured values that reach output JSON-escaped', () => {
  // A value holding a newline, quote or backslash reaches output escaped when
  // anything JSON-encodes it before it is printed: a tool piping it through
  // a JSON encoder, or an echo of a JSON list of values. After the record is
  // decoded, the text holds the ESCAPED form, which is not the configured
  // value and was not matched. The escaped forms are matched inside decoded
  // text only; JSON syntax itself is never searched.
  const VALUES = [
    'SYNTHETIC-KEY\nCANARY-AGGREGATE-91827\nEND',
    'SYNTHETIC-KEY-"CANARY-QUOTED-91827"',
    'SYNTHETIC\\CANARY-BACKSLASH-91827',
    'SYNTHETIC-PLAIN-91827',
  ];
  const CANARIES = [
    'CANARY-AGGREGATE-91827',
    'CANARY-QUOTED-91827',
    'CANARY-BACKSLASH-91827',
    'SYNTHETIC-PLAIN-91827',
  ];
  const leaked = (text: string): string[] =>
    CANARIES.filter((canary) => text.includes(canary));
  const once = `VALUES=${JSON.stringify(VALUES)}`;
  const twice = `NESTED=${JSON.stringify(JSON.stringify(VALUES))}`;
  const record = {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't', content: `${once} ${twice}` },
      ],
    },
  };
  const stored = async (text: string): Promise<string> => {
    let output = '';
    const accepted = await redactRecordFromSource(
      {
        chunks: async function* (): AsyncIterable<string> {
          for (let at = 0; at < text.length; at += 5)
            yield await Promise.resolve(text.slice(at, at + 5));
        },
      },
      VALUES,
      (piece) => {
        output += piece;
      },
      { exactKeySetChars: 1, tokenSpillChars: 1 },
    );
    expect(accepted).toBe(true);
    return output;
  };

  it('masks them in text, structured values and serialized records', () => {
    expect(leaked(redactValues(`${once} ${twice}`, VALUES))).toEqual([]);
    expect(leaked(redactNormalizedText(`${once} ${twice}`, VALUES))).toEqual(
      [],
    );
    expect(
      leaked(redactNormalizedPreservingFormat(`${once}\n${twice}`, VALUES)),
    ).toEqual([]);
    expect(
      leaked(
        JSON.stringify(
          redactNormalizedStructuredValue({ note: `${once} ${twice}` }, VALUES),
        ),
      ),
    ).toEqual([]);
    expect(
      leaked(JSON.stringify(redactStructuredValue(record, VALUES))),
    ).toEqual([]);
    const line = redactSerializedJsonLine(JSON.stringify(record), VALUES);
    expect(leaked(line)).toEqual([]);
    // Still a record: only decoded text changed.
    expect(JSON.parse(line)).toMatchObject({ type: 'user' });
  });

  it('masks them in an agent transcript capture', () => {
    const capture = createTranscriptCapture(VALUES);
    capture.emitRecord(record);
    expect(leaked(capture.serialize())).toEqual([]);
  });

  it('masks them the same way on the stored path as on the resident path', async () => {
    const line = JSON.stringify({ ...record, [once]: 1 });
    const resident = redactSerializedJsonLine(line, VALUES);
    expect(leaked(resident)).toEqual([]);
    expect(await stored(line)).toBe(resident);
  });

  it('leaves escape sequences that belong to no configured value alone', () => {
    const ordinary = JSON.stringify({
      note: 'a "quoted" word, a \\ path and a\nnew line',
      list: JSON.stringify(['x\ny', 'q"r']),
    });
    expect(redactSerializedJsonLine(ordinary, VALUES)).toBe(ordinary);
    expect(redactValues('C:\\temp and \\n', VALUES)).toBe('C:\\temp and \\n');
  });

  it('does not let escaping promote a value too short to qualify', () => {
    // `ab"cd` is five characters; its escaped form is six.
    expect(redactValues('say ab\\"cd', ['ab"cd'])).toBe('say ab\\"cd');
  });
});

describe('stored-record output is delivered in bounded runs', () => {
  // Masked output used to reach the caller one character at a time. It is
  // joined into bounded runs; every branch still produces exactly the
  // resident result, and a malformed record still writes nothing here.
  const SECRET = 'SYNTH\u{1F642}SECRET-4471';
  const run = async (
    text: string,
    limits: { tokenSpillChars?: number },
  ): Promise<{
    accepted: boolean;
    output: string;
    calls: number;
    splitPairs: number;
  }> => {
    let output = '';
    let calls = 0;
    let splitPairs = 0;
    const accepted = await redactRecordFromSource(
      {
        chunks: async function* (): AsyncIterable<string> {
          // Odd-sized chunks split the secret's surrogate pair.
          for (let at = 0; at < text.length; at += 4_099)
            yield await Promise.resolve(text.slice(at, at + 4_099));
        },
      },
      [SECRET],
      (piece) => {
        calls += 1;
        output += piece;
        const last = piece.charCodeAt(piece.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) splitPairs += 1;
      },
      limits,
    );
    return { accepted, output, calls, splitPairs };
  };
  const big = 300_000;

  it.each([
    ['a long string', { note: `${'s'.repeat(big)} ${SECRET} end` }],
    [
      'a long key',
      { [`${'k'.repeat(big)}${SECRET}`]: 1, [`${'k'.repeat(big)}`]: 2 },
    ],
    [
      'a long number',
      { n: Number('1'.repeat(20)), long: `${SECRET}${'9'.repeat(big)}` },
    ],
  ])(
    '%s',
    async (_name, value) => {
      const text = JSON.stringify(value);
      for (const limits of [{}, { tokenSpillChars: 1_024 }]) {
        const result = await run(text, limits);
        expect(result.accepted).toBe(true);
        const identical =
          result.output === redactSerializedJsonLine(text, [SECRET]);
        expect(identical).toBe(true);
        expect(result.output.includes(SECRET)).toBe(false);
        expect(result.calls).toBeLessThanOrEqual(
          2 * Math.ceil(text.length / 4_099) + 8,
        );
        // No run ends between the halves of a surrogate pair, so a caller that
        // encodes each run on its own never sees half a character.
        expect(result.splitPairs).toBe(0);
      }
    },
    60_000,
  );

  it('writes nothing for a malformed record', async () => {
    const result = await run(`{"note": "${SECRET}" ${'x'.repeat(big)}`, {});
    expect(result).toEqual({
      accepted: false,
      output: '',
      calls: 0,
      splitPairs: 0,
    });
  });
});

describe('a configured value made only of whitespace', () => {
  // A durable file copy must never be weaker than the inline field it
  // mirrors. An inline field is emitted whitespace-normalized, so a
  // whitespace-only value cannot survive there — its run collapses to a
  // single space. The durable copy keeps its formatting, so the value's own
  // characters are still sitting in the file, and the normalized projection
  // cannot find them: the value's normalized form is empty and an empty form
  // is never used as a pattern. Its exact characters are matched against the
  // file instead.
  const SECRET = '      '; // six spaces: eligible on length
  const TEXT = `alpha${SECRET}beta`;

  it('masks its exact characters in a durable copy', () => {
    expect(redactNormalizedPreservingFormat(TEXT, [SECRET])).toBe(
      'alpha***beta',
    );
  });

  it('cannot survive an inline field, which is emitted normalized', () => {
    // Not a mask, and deliberately so: the collapse itself removes the
    // value. Pinned because it is why the inline path needs no exact-match
    // pass of its own.
    expect(redactNormalizedText(TEXT, [SECRET])).toBe('alpha beta');
  });

  it('never becomes an any-whitespace wildcard', () => {
    // Whitespace that is not the value's exact characters is left alone: one
    // space, five spaces and a newline are all different text.
    expect(redactNormalizedPreservingFormat('alpha beta', [SECRET])).toBe(
      'alpha beta',
    );
    expect(redactNormalizedPreservingFormat('alpha     beta', [SECRET])).toBe(
      'alpha     beta',
    );
    expect(redactNormalizedPreservingFormat('alpha\nbeta', [SECRET])).toBe(
      'alpha\nbeta',
    );
    // A seven-space run holds the value at two overlapping offsets, so the
    // existing self-overlap merge (`extendMatchToFurthestOverlap`) covers the
    // whole run rather than leaving a stray character of a matched value.
    expect(redactNormalizedPreservingFormat('alpha       beta', [SECRET])).toBe(
      'alpha***beta',
    );
  });

  it('leaves formatting and unrelated content byte-exact', () => {
    const document = 'line one\n\tindented two\n\n  three  \n';
    expect(redactNormalizedPreservingFormat(document, ['nowhere-value'])).toBe(
      document,
    );
  });

  it('still applies the length floor to the configured value', () => {
    // Eligibility is decided on the configured value as written, here as
    // everywhere else: five spaces are too short to be matched.
    expect(redactNormalizedPreservingFormat('alpha     beta', ['     '])).toBe(
      'alpha     beta',
    );
  });

  it('keeps masking a value whose normalized form is not empty', () => {
    // Control for the ordinary path: a value with real characters is still
    // matched through the normalized projection, reflowed whitespace and all.
    expect(
      redactNormalizedPreservingFormat('see correct horse\nbattery staple.', [
        'correct horse battery staple',
      ]),
    ).toBe('see ***.');
  });
});
