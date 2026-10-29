import type * as NodeCrypto from 'node:crypto';
import { existsSync, promises as fsPromises } from 'node:fs';
import { readdir, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { redactSerializedJsonLine } from '../../../../lib/redaction';
import type * as BoundedJsonState from '../bounded-json-state';
import {
  boundedJsonStateCounters,
  FrameStack,
  KeyIdentityIndex,
  TokenBuffer,
  digestCopy,
  digestPushText,
  digestStart,
  type DigestState,
} from '../bounded-json-state';
import {
  redactRecordFromSource,
  streamingRedactionWorkCounters,
  type RecordRedactionLimits,
  type RecordSource,
} from '../streaming-json-redactor';

/**
 * The streaming masker must be byte-identical to the in-memory one.
 *
 * It is a different route to the SAME contract, not a second, weaker path, so
 * the established function is the oracle — with independent expected content
 * alongside it for the cases where both implementations agreeing would not
 * prove the answer is right.
 */
const replay = (text: string, chunk: number): RecordSource => ({
  // An async generator with nothing to await: the source interface is async
  // because the real one reads a file, and this one replays a string.
  // eslint-disable-next-line @typescript-eslint/require-await
  chunks: async function* (): AsyncIterable<string> {
    for (let at = 0; at < text.length; at += chunk)
      yield text.slice(at, at + chunk);
  },
});

const maskThrough = async (
  text: string,
  values: readonly string[],
  chunk: number,
  limits: RecordRedactionLimits = {},
): Promise<{ accepted: boolean; output: string }> => {
  let output = '';
  const accepted = await redactRecordFromSource(
    replay(text, chunk),
    values,
    (piece) => {
      output += piece;
    },
    limits,
  );
  return { accepted, output };
};

const CHUNKINGS = [1, 2, 7, 64, 4_096];

/**
 * Every backing store, not just the one a small record happens to take.
 *
 * The choice of backing must never change which input is accepted or what is
 * emitted, so the same expectation is asserted through all of them. The tiny
 * limits are the point: without them a green run proves only that the
 * in-memory path works.
 */
const BACKINGS: ReadonlyArray<readonly [string, RecordRedactionLimits]> = [
  ['default', {}],
  ['file-backed tokens', { tokenSpillChars: 1 }],
  ['digest key index', { exactKeySetChars: 1 }],
  ['both spilled', { exactKeySetChars: 1, tokenSpillChars: 1 }],
  ['spilling mid-record', { exactKeySetChars: 24, tokenSpillChars: 8 }],
];

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('streaming JSON masking matches the in-memory contract', () => {
  const RAW_CONTROL = `{"a":"x${String.fromCharCode(7)}SECRETVALUE"}`;
  const cases: Array<{
    name: string;
    text: string;
    values: string[];
    /** Independent expectation, where agreement alone would prove nothing. */
    expected?: string;
  }> = [
    {
      name: 'an identifier where a value belongs is not JSON',
      text: '{"v": EXAMPLEVALUE}',
      values: ['EXAMPLEVALUE'],
      expected: '{"v": ***}',
    },
    {
      name: 'a leading-zero number is not JSON',
      text: '{"v":01}',
      values: ['EXAMPLEVALUE'],
    },
    {
      name: 'an invalid escape is not JSON',
      text: '{"v":"x\\qEXAMPLEVALUE"}',
      values: ['EXAMPLEVALUE'],
    },
    {
      name: 'a raw control character is not JSON',
      text: RAW_CONTROL,
      values: ['SECRETVALUE'],
    },
    {
      name: 'trailing content is not JSON',
      text: '{"a":1} extra',
      values: ['SECRETVALUE'],
    },
    {
      name: 'a mismatched bracket is not JSON',
      text: '{"a":[1}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'two different values overlapping become one span',
      text: '{"v":"ABCDEFGH"}',
      values: ['ABCDEF', 'CDEFGH'],
      expected: '{"v":"***"}',
    },
    {
      name: 'a self-overlapping value becomes one span',
      text: '{"v":"ABABABABAB"}',
      values: ['ABABAB'],
      expected: '{"v":"***"}',
    },
    {
      name: 'an arbitrarily long periodic run is still one span',
      text: `{"v":"${'AB'.repeat(400)}"}`,
      values: ['ABABAB'],
      expected: '{"v":"***"}',
    },
    {
      name: 'an astral character does not shift later matches',
      text: '{"v":"\u{1F600}SECRETEND!"}',
      values: ['SECRET'],
      expected: '{"v":"\u{1F600}***END!"}',
    },
    {
      name: 'escaped codepoints decode before matching',
      text: '{"a":"pre \\u0041 SECRETVALUE post"}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'multi-line values inside a record',
      text: JSON.stringify({ a: 'x\nSECRETVALUE\ty' }),
      values: ['SECRETVALUE'],
    },
    {
      name: 'a masked key takes a free name',
      text: '{"SECRETVALUE":1,"b":2}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'a masked key routes around an ordinary collision',
      text: '{"***":1,"SECRETVALUE":2,"***__1":3}',
      values: ['SECRETVALUE'],
      expected: '{"***":1,"***__2":2,"***__1":3}',
    },
    {
      name: 'the same collision in the other order',
      text: '{"***__1":3,"SECRETVALUE":2,"***":1}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'an escaped key identity is the decoded one',
      text: '{"\\u002a\\u002a\\u002a":1,"SECRETVALUE":2}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'ordinary duplicate keys survive',
      text: '{"dup":"a","dup":"b"}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'nested scopes disambiguate independently',
      text: '{"o":{"SECRETVALUE":1,"***":2},"p":{"SECRETVALUE":3}}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'a deep record',
      text: `${'{"a":'.repeat(60)}"SECRETVALUE"${'}'.repeat(60)}`,
      values: ['SECRETVALUE'],
    },
    {
      name: 'numeric tokens are preserved exactly',
      text: '{"n":1740000000123456789,"f":1.0,"e":1e5,"neg":-3.5e-7}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'a matching numeric token is masked whole',
      text: '{"n":123456,"m":7}',
      values: ['123456'],
    },
    {
      name: 'literals are preserved',
      text: '{"t":true,"f":false,"n":null}',
      values: ['SECRETVALUE'],
    },
    {
      name: 'an escape-sequence collision is NOT masked',
      text: JSON.stringify({ type: 'result', result: '\nABCDE' }),
      values: ['nABCDE'],
    },
    {
      name: 'a punctuation collision is NOT masked',
      text: '{"a":"x","subtype":"y"}',
      values: ['","subtype":'],
    },
    {
      name: 'arrays at the top level',
      text: '[1,"SECRETVALUE",{"k":"SECRETVALUE"}]',
      values: ['SECRETVALUE'],
    },
    {
      name: 'insignificant whitespace is preserved',
      text: '{  "a" : "SECRETVALUE" ,\n "b" : [ 1 , 2 ] }',
      values: ['SECRETVALUE'],
    },
    {
      name: 'unmatched content is returned byte for byte',
      text: '{"a":"nothing","b":[1,2,3]}',
      values: ['ABSENTVALUE'],
    },
    {
      name: 'many sibling keys all masking to the same name',
      text: `{${Array.from({ length: 40 }, (_, index) => `"k${index}":"SECRETVALUE"`).join(',')}}`,
      values: ['SECRETVALUE'],
    },
    {
      name: 'a large value',
      text: JSON.stringify({
        SECRETVALUE: 'mk',
        filler: 'z'.repeat(50_000),
        '***': 'o',
      }),
      values: ['SECRETVALUE'],
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s',
    async (_name, testCase) => {
      let parses = true;
      try {
        JSON.parse(testCase.text);
      } catch {
        parses = false;
      }
      const oracle = redactSerializedJsonLine(testCase.text, testCase.values);
      if (testCase.expected !== undefined) {
        // Independent of both implementations.
        expect(oracle).toBe(testCase.expected);
      }
      for (const chunk of CHUNKINGS)
        for (const [backing, limits] of BACKINGS) {
          const { accepted, output } = await maskThrough(
            testCase.text,
            testCase.values,
            chunk,
            limits,
          );
          // Validity is decided for the WHOLE record, identically to
          // `JSON.parse`, and by the same rules through every backing.
          expect({ backing, chunk, accepted }).toEqual({
            backing,
            chunk,
            accepted: parses,
          });
          // Nothing is published for an invalid record, so the caller can still
          // apply the established raw matching contract.
          if (!accepted) {
            expect({ backing, chunk, output }).toEqual({
              backing,
              chunk,
              output: '',
            });
            continue;
          }
          expect({ backing, chunk, output }).toEqual({
            backing,
            chunk,
            output: oracle,
          });
        }
    },
    120_000,
  );
});

describe('the bounded state really is exercised', () => {
  // Positive controls. Without these the suite above could be passing because
  // every case quietly took the in-memory path.
  it('spills a token to a file and still emits it byte for byte', async () => {
    const buffer = new TokenBuffer('test', 8);
    for (const piece of ['abcdefghij', 'klmnop']) await buffer.push(piece);
    expect(buffer.length).toBe(16);
    let replayed = '';
    for await (const piece of buffer.replay()) replayed += piece;
    expect(replayed).toBe('abcdefghijklmnop');
    // The control itself: a green replay of a small token would prove nothing.
    expect(buffer.spilled).toBe(true);
    await buffer.dispose();
  });

  it('waits for an established token file instead of queueing the token in memory', async () => {
    // The budget only means something if a saturated write stops the caller.
    // `push` used to return `store.settling()`, which is `undefined` once the
    // file exists, so `append`'s `false` (the stream reporting a full queue)
    // was dropped: a source that never yields queued the whole token in the
    // stream's buffer - 16 MiB resident for a 16 MiB token.
    const buffer = new TokenBuffer('backpressure', 1_024);
    const piece = 'a'.repeat(8_192);
    const pieces = 2_048;
    let peakResident = 0;
    let waits = 0;
    try {
      for (let index = 0; index < pieces; index += 1) {
        const waiting = buffer.push(piece);
        if (waiting) {
          waits += 1;
          await waiting;
        }
        peakResident = Math.max(peakResident, buffer.residentLength);
      }
      // Positive control: this really is the file-backed path.
      expect(buffer.spilled).toBe(true);
      expect(buffer.length).toBe(piece.length * pieces);
      // Bounded by the block size and the stream's own queue, not by the
      // token: 16 MiB of text must never be resident at once.
      expect(peakResident).toBeLessThanOrEqual(1_024 * 1_024);
      // Backpressure actually engaged...
      expect(waits).toBeGreaterThan(0);
      // ...and only at block boundaries: never one wait per pushed piece, and
      // never one per character.
      expect(waits).toBeLessThanOrEqual(
        Math.ceil((piece.length * pieces) / (64 * 1_024)) + 2,
      );
      // The point of the bound is that the token is still exact.
      let replayedChars = 0;
      let allA = true;
      for await (const chunk of buffer.replay()) {
        replayedChars += chunk.length;
        if (!/^a*$/.test(chunk)) allA = false;
      }
      expect({ replayedChars, allA }).toEqual({
        replayedChars: piece.length * pieces,
        allA: true,
      });
    } finally {
      await buffer.dispose();
    }
  }, 60_000);

  it('does not make an accepted write wait', async () => {
    // A token that never saturates its store must cost no waiting at all: a
    // promise per accepted character (or per accepted block) was the
    // allocation this buffer exists to avoid.
    const held = new TokenBuffer('held', 1_024 * 1_024);
    try {
      let waits = 0;
      for (let index = 0; index < 64; index += 1)
        if (held.push('b'.repeat(4_096))) waits += 1;
      expect(held.spilled).toBe(false);
      expect(waits).toBe(0);
    } finally {
      await held.dispose();
    }
  });

  it('charges the index for the entries it keeps, not just their text', async () => {
    // `""` is a valid JSON property name. Charging only `text.length` means a
    // record made entirely of empty keys retains one Map, one Set and one
    // entry per scope while the budget reads zero — the budget stops being a
    // bound at exactly the input designed to exhaust it.
    // Names that cannot equal a masked name are not retained at all — the
    // strongest bound there is...
    const ignoring = new KeyIdentityIndex(1);
    for (let scope = 0; scope < 5_000; scope += 1) {
      const settled = ignoring.reserve(scope, digestStart(), '');
      if (settled) await settled;
    }
    expect(ignoring.residentBookkeeping).toBe(0);
    await ignoring.dispose();
    // ...and names that can, however short, are charged per entry and scope
    // and leave memory once the budget is passed.
    const index = new KeyIdentityIndex(1);
    for (let scope = 0; scope < 5_000; scope += 1) {
      const digest = digestStart();
      digestPushText(digest, '***');
      const settled = index.reserve(scope, digest, '***');
      if (settled) await settled;
    }
    expect(index.spilled).toBe(true);
    await index.dispose();
  }, 120_000);

  it('spills a record whose keys are all empty', async () => {
    // Same property through the actual processor, so this is not a claim
    // about the index in isolation. A one-character budget makes a few
    // hundred scopes enough to exercise spilling without a slow stress run.
    const scopes = 512;
    const empty = `[${Array.from({ length: scopes }, () => '{"":0}').join(',')}]`;
    const emptyResult = await maskThrough(empty, ['SECRETVALUE'], 4_096, {
      exactKeySetChars: 1,
    });
    expect(emptyResult.output).toBe(empty);
    const before = boundedJsonStateCounters.keyIndexSpills;
    const text = `[${Array.from({ length: scopes }, () => '{"***":0}').join(',')}]`;
    const { accepted, output } = await maskThrough(
      text,
      ['SECRETVALUE'],
      4_096,
      {
        exactKeySetChars: 1,
      },
    );
    expect(accepted).toBe(true);
    expect(output).toBe(text);
    expect(boundedJsonStateCounters.keyIndexSpills).toBeGreaterThan(before);
  }, 600_000);

  it.each([1, 1_000_000])(
    'compares identities exactly even when their digests collide (budget %i)',
    async (budget) => {
      // A digest is a lookup accelerator, never an identity. Two different
      // names that happen to share one must still be told apart, or a masked
      // key takes a suffix the resident oracle would not give it — output that
      // depends on the backing, which is exactly what is not allowed.
      // Witness: a different name handed the SAME digest is not present.
      const witness = new KeyIdentityIndex(budget);
      const shared = digestStart();
      digestPushText(shared, 'collide');
      const settledW = witness.reserve(0, digestCopy(shared), 'A***');
      if (settledW) await settledW;
      await expect(
        Promise.resolve(witness.allocate(0, digestCopy(shared), 'B***')),
      ).resolves.toBe(0);
      await witness.dispose();

      // Full semantics under a TOTAL collision: every identity, including
      // every `__N` candidate, shares one digest.
      const index = new KeyIdentityIndex(budget, {
        forceDigestCollisions: true,
      });
      const named = (name: string): DigestState => {
        const digest = digestStart();
        digestPushText(digest, name);
        return digest;
      };
      for (const name of ['A***', 'B***__1']) {
        const settled = index.reserve(0, named(name), name);
        if (settled) await settled;
      }
      await expect(
        Promise.resolve(index.allocate(0, named('B***'), 'B***')),
      ).resolves.toBe(0);
      // Present exactly, and `B***__1` is held by a different key, so the
      // oracle's answer is 2.
      await expect(
        Promise.resolve(index.allocate(0, named('B***'), 'B***')),
      ).resolves.toBe(2);
      await expect(
        Promise.resolve(index.allocate(0, named('B***'), 'B***')),
      ).resolves.toBe(3);
      await expect(
        Promise.resolve(index.allocate(7, named('A***'), 'A***')),
      ).resolves.toBe(0);
      await index.dispose();
    },
  );

  it('matches the resident oracle when every digest collides', async () => {
    // End to end through the processor, with the documented test seam that
    // makes every identity share one digest. Byte-identical output under
    // total collision is the proof that nothing relies on digest uniqueness.
    const keys = [
      '***',
      '***__1',
      'SECRETVALUE',
      'x***',
      'SECRETVALUEy',
      '***__2',
    ];
    const text = `{${keys.map((key, at) => `${JSON.stringify(key)}:${at}`).join(',')},"o":{"SECRETVALUE":1,"***":2}}`;
    for (const chunk of [1, 7, 4096])
      for (const exactKeySetChars of [1, 64, 1_000_000]) {
        const { accepted, output } = await maskThrough(
          text,
          ['SECRETVALUE'],
          chunk,
          {
            exactKeySetChars,
            tokenSpillChars: 4,
            forceDigestCollisions: true,
          },
        );
        expect(accepted).toBe(true);
        expect(output).toBe(redactSerializedJsonLine(text, ['SECRETVALUE']));
      }
  }, 120_000);

  it('keeps index bookkeeping and lookup work bounded as identities grow', async () => {
    // Every identity here contains the mask, so every one must be remembered.
    // What must NOT grow with them is the resident bookkeeping, and each
    // lookup must stay a bounded amount of work however many there are.
    // 40,000 identities double the 4,096-slot table five times, and the
    // checkpoints land at three different capacities. Every insert is several
    // file reads, so 300,000 of them overran a 300 s timeout on CI.
    const identities = 40_000;
    const index = new KeyIdentityIndex(1);
    const footprints: number[] = [];
    for (let at = 0; at < identities; at += 1) {
      const name = `k${at}***`;
      const digest = digestStart();
      digestPushText(digest, name);
      const settled = index.reserve(at % 97, digest, name);
      if (settled) await settled;
      if ((at + 1) % 10_000 === 0) footprints.push(index.residentBookkeeping);
    }
    expect(footprints).toHaveLength(4);
    expect(new Set(footprints).size).toBe(1);
    const probesBefore = boundedJsonStateCounters.indexSlotReads;
    for (let at = 0; at < 2_000; at += 1) {
      // Every lookup hits an identity that is present, in its own scope.
      const id = (at * 131) % identities;
      const name = `k${id}***`;
      const digest = digestStart();
      digestPushText(digest, name);
      await Promise.resolve(index.allocate(id % 97, digest, name));
    }
    const perLookup =
      (boundedJsonStateCounters.indexSlotReads - probesBefore) / 2_000;
    expect(perLookup).toBeLessThan(8);
    await index.dispose();
  }, 120_000);

  it('keeps identities separable after the index drops the text', async () => {
    const index = new KeyIdentityIndex(1);
    const alpha = digestStart();
    digestPushText(alpha, '***');
    const beta = digestStart();
    digestPushText(beta, '***');
    await index.reserve(0, alpha, '***');
    expect(index.spilled).toBe(true);
    // Same identity in the same scope collides; the same identity in another
    // scope does not. Identity is always supplied — a digest alone is never
    // enough to decide it.
    await expect(Promise.resolve(index.allocate(0, beta, '***'))).resolves.toBe(
      1,
    );
    await expect(Promise.resolve(index.allocate(1, beta, '***'))).resolves.toBe(
      0,
    );
    await index.dispose();
  });

  it('keeps nesting correct across the frame window it pages out', async () => {
    const stack = new FrameStack();
    const depth = 200_000;
    for (let at = 0; at < depth; at += 1)
      stack.push(at % 2 === 0 ? 'object' : 'array', at);
    expect(stack.size).toBe(depth);
    for (let at = depth - 1; at >= 0; at -= 1) {
      expect(stack.topScope).toBe(at);
      expect(stack.topKind).toBe(at % 2 === 0 ? 'object' : 'array');
      stack.pop();
    }
    expect(stack.size).toBe(0);
    await stack.dispose();
  }, 60_000);

  it('masks a record deeper than the resident frame window', async () => {
    const depth = 120_000;
    const text = `${'['.repeat(depth)}"SECRETVALUE"${']'.repeat(depth)}`;
    const { accepted, output } = await maskThrough(
      text,
      ['SECRETVALUE'],
      4_096,
    );
    expect(accepted).toBe(true);
    expect(output).toBe(`${'['.repeat(depth)}"***"${']'.repeat(depth)}`);
  }, 60_000);

  it('masks a value far larger than any token budget', async () => {
    const value = `${'z'.repeat(300_000)}SECRETVALUE${'y'.repeat(300_000)}`;
    const text = JSON.stringify({ big: value });
    const { accepted, output } = await maskThrough(
      text,
      ['SECRETVALUE'],
      4_096,
      { tokenSpillChars: 1, exactKeySetChars: 1 },
    );
    expect(accepted).toBe(true);
    expect(output).toBe(redactSerializedJsonLine(text, ['SECRETVALUE']));
  }, 120_000);

  it('keeps the matcher window bounded while the record is not', async () => {
    // The counters are the measurement. Without them "bounded" is a claim
    // about code nobody ran at a size where it matters.
    const before = { ...streamingRedactionWorkCounters };
    const value = `${'z'.repeat(400_000)}SECRETVALUE${'y'.repeat(400_000)}`;
    const text = JSON.stringify({ big: value });
    const { accepted } = await maskThrough(text, ['SECRETVALUE'], 4_096);
    expect(accepted).toBe(true);
    // Positive control: the scan really covered the whole record.
    expect(
      streamingRedactionWorkCounters.charsScanned - before.charsScanned,
    ).toBeGreaterThan(800_000);
    // And the retained window stayed at the longest configured value, not at
    // anything proportional to what was scanned.
    expect(streamingRedactionWorkCounters.maxWindowChars).toBeLessThan(1_000);
    expect(streamingRedactionWorkCounters.windowCompactions).toBeGreaterThan(
      before.windowCompactions,
    );
  }, 120_000);

  it('masks a KEY far larger than any token budget', async () => {
    const key = `${'z'.repeat(200_000)}SECRETVALUE`;
    const text = JSON.stringify({ [key]: 1, other: 2 });
    const { accepted, output } = await maskThrough(
      text,
      ['SECRETVALUE'],
      4_096,
      { tokenSpillChars: 1_024 },
    );
    expect(accepted).toBe(true);
    expect(output).toBe(redactSerializedJsonLine(text, ['SECRETVALUE']));
  }, 120_000);
});

describe('an unfinished key never outlives its record', () => {
  // A key over 1 MiB spills its decoded text to a private file while the
  // record is being validated. A record that turns out to be invalid returned
  // early without disposing it, leaving decoded child output — which can
  // include a configured value, unmasked — on disk. Every way the pass can end
  // must remove it.
  const MARKER = 'SYNTHETIC_REDACTION_MARKER';
  const KEY = MARKER + 'k'.repeat(1_200_000);
  let root = '';
  const realMkdtemp = fsPromises.mkdtemp.bind(fsPromises);
  /**
   * Every private directory this pass creates, redirected into a root the
   * test owns. Setting TMPDIR would not do it: the test sandbox has its own
   * copy of the environment, which `os.tmpdir()` never reads, so directories
   * would land in the real temp dir and an empty root would prove nothing.
   */
  const redirectInto = (
    before?: (prefix: string) => Promise<void> | void,
  ): void => {
    jest
      .spyOn(fsPromises, 'mkdtemp')
      .mockImplementation(async (prefix, options) => {
        await before?.(String(prefix));
        return realMkdtemp(join(root, basename(String(prefix))), options);
      });
  };

  beforeEach(async () => {
    root = await realMkdtemp(join(tmpdir(), 'canopy-inspect-owned-'));
    redirectInto();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const chunked = (text: string): { chunks: () => AsyncIterable<string> } => ({
    chunks: async function* (): AsyncIterable<string> {
      for (let at = 0; at < text.length; at += 65_536)
        yield await Promise.resolve(text.slice(at, at + 65_536));
    },
  });

  it('leaves nothing behind for a valid record with a spilled key (control)', async () => {
    let created = 0;
    jest.restoreAllMocks();
    redirectInto((prefix) => {
      if (prefix.includes('canopy-record-identity-')) created += 1;
    });
    expect(
      await redactRecordFromSource(
        chunked(`{"${KEY}":1}`),
        [MARKER],
        () => undefined,
      ),
    ).toBe(true);
    // Positive control: the key really did spill to its own directory.
    expect(created).toBeGreaterThan(0);
    expect(await readdir(root)).toEqual([]);
  }, 60_000);

  it.each([
    ['a raw control character', `{"${KEY}\u0001":1}`],
    ['the end of the record', `{"${KEY}`],
    ['a bad escape', `{"${KEY}\\q":1}`],
  ])('removes a spilled key cut short by %s', async (_name, text) => {
    expect(
      await redactRecordFromSource(chunked(text), [MARKER], () => undefined),
    ).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it('removes a spilled key when reading the record fails part way through it', async () => {
    const failing = {
      chunks: async function* (): AsyncIterable<string> {
        const text = `{"${KEY}`;
        for (let at = 0; at < text.length; at += 65_536)
          yield await Promise.resolve(text.slice(at, at + 65_536));
        throw new Error('synthetic read failure');
      },
    };
    await expect(
      redactRecordFromSource(failing, [MARKER], () => undefined),
    ).rejects.toThrow('synthetic read failure');
    expect(await readdir(root)).toEqual([]);
  });

  it('removes a key whose spill file was still being created when the record failed', async () => {
    jest.restoreAllMocks();
    // Creation completes only after the pass has already decided.
    redirectInto(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(
      await redactRecordFromSource(
        chunked(`{"${KEY}\u0001":1}`),
        [MARKER],
        () => undefined,
      ),
    ).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it('removes the key even when reserving its identity fails', async () => {
    // A name containing the mask is recorded in the key index; its storage
    // failing must not leave the key's own spilled text behind.
    jest.restoreAllMocks();
    redirectInto((prefix) => {
      if (prefix.includes('canopy-keyindex-'))
        throw new Error('synthetic index failure');
    });
    await expect(
      redactRecordFromSource(
        chunked(`{"***${KEY}":1}`),
        [MARKER],
        () => undefined,
        { exactKeySetChars: 1 },
      ),
    ).rejects.toThrow('synthetic index failure');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('the key index owns every resource the moment it has it', () => {
  // The index acquires a private directory, then two files, and on growth a
  // third. Recording each only after the NEXT step succeeded left whatever
  // was already acquired outside disposal when a step failed: a directory on a
  // failed chmod, an open descriptor on a failed open or truncate.
  type Tracked = { handle: FileHandle; name: string };
  const realOpen = fsPromises.open.bind(fsPromises);
  const realMkdtemp = fsPromises.mkdtemp.bind(fsPromises);
  const realChmod = fsPromises.chmod.bind(fsPromises);
  let handles: Tracked[] = [];
  let directories: string[] = [];

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const { handle } of handles)
      if (handle.fd !== -1) await handle.close().catch(() => undefined);
    for (const directory of directories)
      await rm(directory, { recursive: true, force: true });
    handles = [];
    directories = [];
  });

  const injected = (): Error =>
    Object.assign(new Error('synthetic key index EIO'), { code: 'EIO' });

  /** Tracks key-index resources and fails the named stage. */
  const failAt = (stage: string): void => {
    jest
      .spyOn(fsPromises, 'mkdtemp')
      .mockImplementation(async (prefix, options) => {
        const made = await realMkdtemp(prefix, options);
        if (String(prefix).includes('canopy-keyindex-')) directories.push(made);
        return made;
      });
    jest.spyOn(fsPromises, 'chmod').mockImplementation(async (path, mode) => {
      if (stage === 'chmod' && String(path).includes('canopy-keyindex-'))
        throw injected();
      return realChmod(path, mode);
    });
    jest
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (path, flags, mode) => {
        const name = String(path);
        if (!name.includes('canopy-keyindex-'))
          return realOpen(path, flags, mode);
        if (stage === 'data-open' && name.endsWith('/data')) throw injected();
        const handle = await realOpen(path, flags, mode);
        handles.push({ handle, name });
        if (
          (stage === 'initial-truncate' && name.endsWith('/slots-0')) ||
          (stage === 'grow-truncate' && name.endsWith('/slots-1'))
        )
          handle.truncate = (): Promise<void> => Promise.reject(injected());
        if (stage === 'grow-write' && name.endsWith('/slots-1'))
          handle.write = (): never => {
            throw injected();
          };
        return handle;
      });
  };

  const maskedKeys = (count: number): RecordSource => {
    const record = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: count }, (_, at) => [`***${String(at)}`, at]),
      ),
    );
    return {
      chunks: async function* (): AsyncIterable<string> {
        for (let at = 0; at < record.length; at += 4096)
          yield await Promise.resolve(record.slice(at, at + 4096));
      },
    };
  };

  it.each([
    ['chmod', 2],
    ['data-open', 2],
    ['initial-truncate', 2],
    // 2,050 recorded names push the table past half of its first 4,096 slots.
    ['grow-truncate', 2_050],
    ['grow-write', 2_050],
  ])('leaves nothing behind when %s fails', async (stage, count) => {
    failAt(stage);
    await expect(
      redactRecordFromSource(
        maskedKeys(count),
        ['SECRETVALUE'],
        () => undefined,
        {
          exactKeySetChars: 1,
        },
      ),
    ).rejects.toThrow('synthetic key index EIO');
    // Positive control: the index really reached its storage.
    expect(directories.length).toBe(1);
    expect(handles.filter(({ handle }) => handle.fd !== -1)).toEqual([]);
    expect(directories.filter((directory) => existsSync(directory))).toEqual(
      [],
    );
  });

  it('releases storage acquired after the index was disposed', async () => {
    // Disposal can run while an open is still in flight; whatever that open
    // acquires afterwards must be released, not published into a disposed
    // index.
    let releaseOpen: () => void = () => undefined;
    const openHeld = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let openStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      openStarted = resolve;
    });
    failAt('none');
    // Held at directory creation: the directory appears only after disposal.
    jest
      .spyOn(fsPromises, 'mkdtemp')
      .mockImplementation(async (prefix, options) => {
        if (!String(prefix).includes('canopy-keyindex-'))
          return realMkdtemp(prefix, options);
        openStarted();
        await openHeld;
        const made = await realMkdtemp(prefix, options);
        directories.push(made);
        return made;
      });
    const index = new KeyIdentityIndex(1);
    const text = '***name';
    const digest = digestStart();
    digestPushText(digest, text);
    const reserving = Promise.resolve(index.reserve(0, digest, text)).catch(
      (error: unknown) => error,
    );
    await started;
    await index.dispose();
    releaseOpen();
    await reserving;
    expect(handles.filter(({ handle }) => handle.fd !== -1)).toEqual([]);
    expect(directories.filter((directory) => existsSync(directory))).toEqual(
      [],
    );
  });
});

describe('a spilled key keeps its exact decoded identity', () => {
  // A key over 1 MiB spills its DECODED text while it is being compared. JSON
  // escapes can decode to a lone surrogate, which UTF-8 storage replaces with
  // U+FFFD — so two different keys became the same identity before the exact
  // comparison ever saw them. With every digest colliding (a deliberate test
  // seam, not a claim that collisions are likely), only the text decides, and
  // the result must still equal the in-memory masker's.
  const PREFIX = 'k'.repeat(1024 * 1024 + 10);
  const chunked = (text: string, size: number): RecordSource => ({
    chunks: async function* (): AsyncIterable<string> {
      for (let at = 0; at < text.length; at += size)
        yield await Promise.resolve(text.slice(at, at + size));
    },
  });

  it.each([
    ['a lone high surrogate', '\ud800', '�'],
    ['a lone low surrogate', '\udc00', '�'],
    ['a real surrogate pair', '\u{1F600}', '��'],
  ])(
    'tells a key holding %s from one holding replacement characters',
    async (_name, unit, replacement) => {
      const record = `{${JSON.stringify(`${PREFIX}${unit}***`)}:1,${JSON.stringify(
        `${PREFIX}${replacement}SECRETVALUE`,
      )}:2}`;
      const expected = redactSerializedJsonLine(record, ['SECRETVALUE']);
      for (const forceDigestCollisions of [false, true])
        for (const size of [4_096, 65_536]) {
          let actual = '';
          const accepted = await redactRecordFromSource(
            chunked(record, size),
            ['SECRETVALUE'],
            (text) => {
              actual += text;
            },
            { exactKeySetChars: 1, forceDigestCollisions },
          );
          expect(accepted).toBe(true);
          expect(actual.length).toBe(expected.length);
          expect(actual === expected).toBe(true);
        }
    },
    120_000,
  );
});

describe('object scope ids past 32 bits', () => {
  // Every object in a record gets the next scope id, and keys are compared
  // per scope. The ids were stored as signed 32-bit integers, so past 2^31
  // objects they came back negative and past 2^32 they wrapped onto earlier
  // scopes, merging unrelated objects' key sets. No record is refused for its
  // object count, so the ids must survive at any count a record can reach.
  it.each([2 ** 31 - 1, 2 ** 31, 2 ** 31 + 5, 2 ** 32 + 7, 2 ** 40 + 3])(
    'keeps scope %i exactly',
    async (scope) => {
      const frames = new FrameStack();
      try {
        frames.push('object', scope);
        expect(frames.topScope).toBe(scope);
      } finally {
        await frames.dispose();
      }
    },
  );

  it('keeps large scope ids exactly across the file-backed part of the stack', async () => {
    const frames = new FrameStack();
    const base = 2 ** 32 + 11;
    // Past the resident window, so the deepest frames are paged out and back.
    const depth = 140_000;
    try {
      for (let level = 0; level < depth; level += 1)
        frames.push(level % 2 === 0 ? 'object' : 'array', base + level);
      for (let level = depth - 1; level >= 0; level -= 1) {
        expect(frames.topScope).toBe(base + level);
        frames.pop();
      }
    } finally {
      await frames.dispose();
    }
  }, 60_000);
});

describe('the digest salt', () => {
  // Drawing the salt at module load made merely IMPORTING the executor chain
  // require a working `randomBytes`, so unrelated suites that partially mock
  // `node:crypto` broke on import. The salt is drawn once, on first use, and
  // is never replaced by a constant.
  it('is drawn from randomBytes once, on first use, not at import', () => {
    const actual = jest.requireActual<typeof NodeCrypto>('node:crypto');
    const drawn = jest.fn((size: number) => actual.randomBytes(size));
    jest.isolateModules(() => {
      jest.doMock('node:crypto', () => ({ ...actual, randomBytes: drawn }));
      const state = jest.requireActual<typeof BoundedJsonState>(
        '../bounded-json-state',
      );
      expect(drawn).not.toHaveBeenCalled();
      const first = state.digestStart();
      const second = state.digestStart();
      expect(drawn).toHaveBeenCalledTimes(1);
      expect(drawn).toHaveBeenCalledWith(16);
      // One salt per process: every digest starts from the same seeds.
      expect(second).toEqual(first);
    });
    jest.dontMock('node:crypto');
  });
});
