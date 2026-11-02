import * as crypto from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChatTranscriptArtifacts,
  CreatedArtifacts,
} from '../lib/chat-transcript-artifacts';
import { SurrogateTracker } from '../lib/chat-transcript-field-spool';

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Deterministic partitions without a global random source. */
function seededPartitions(value: string, seed: number): string[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state;
  };
  const chunks: string[] = [];
  for (let start = 0; start < value.length; ) {
    const length = next() % 40_000;
    chunks.push(value.slice(start, start + length));
    start += length;
  }
  return chunks;
}

async function readAll(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  ref: Awaited<ReturnType<ChatTranscriptArtifacts['put']>>,
): Promise<string> {
  let restored = '';
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await artifacts.readRange(chatId, ref, offset, 8191);
    restored += page.text;
    offset = page.nextOffset;
  }
  return restored;
}

describe('surrogate tracking across chunks', () => {
  it.each([
    ['a split pair', ['a\uD83D', '', '\uDE00b'], false],
    ['a final lone high surrogate', ['ab', '\uD83D'], true],
    ['a lone low surrogate', ['ab\uDE00c'], true],
    ['a low surrogate opening a chunk', ['ab', '\uDE00'], true],
    ['two highs before one low', ['\uD83D', '😀'], true],
    ['no surrogates', ['plain', '', 'text'], false],
    ['an empty body', [], false],
  ])('detects %s', (_name, chunks, unpaired) => {
    const tracker = new SurrogateTracker();
    for (const chunk of chunks) tracker.accept(chunk);
    expect(tracker.finish()).toBe(unpaired);
  });
});

describe('streamed artifact publication (phase 07 new feature)', () => {
  let root: string;
  let artifacts: ChatTranscriptArtifacts;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-field-spool-'));
    artifacts = new ChatTranscriptArtifacts(root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const large = 'x'.repeat(16_383) + '🌲' + '界'.repeat(20_000);
  const cases: Array<[string, string[]]> = [
    ['a surrogate pair split around an empty chunk', ['\uD83D', '', '\uDE00']],
    ['a final lone high surrogate', ['text ', '\uD83D']],
    ['a lone low surrogate', ['text \uDE00 more']],
    [
      'an invalid surrogate early and a valid pair later',
      ['\uD800 early', ' middle ', '\uD83D', '\uDE00 late'],
    ],
    ['an empty body', []],
    ['only empty chunks', ['', '']],
    ['one large chunk crossing slice boundaries', [large]],
    [
      'a pair split exactly at the staging slice boundary',
      ['y'.repeat(16_383) + '\uD83D', '\uDE00' + '界'.repeat(30_000)],
    ],
  ];

  it.each(cases)('matches whole-string put for %s', async (_name, chunks) => {
    const whole = chunks.join('');
    const expected = await artifacts.put('whole', whole);
    const created = new CreatedArtifacts();
    const ref = await artifacts.putStream('stream', chunks, created);
    expect(ref).toEqual(expected);
    expect(created.size).toBe(1);
    const streamed = await readFile(
      join(root, 'tool-output', 'stream', `${ref.artifactId}.txt`),
    );
    expect(streamed).toEqual(
      await readFile(
        join(root, 'tool-output', 'whole', `${expected.artifactId}.txt`),
      ),
    );
    expect(ref.sha256).toBe(
      crypto.createHash('sha256').update(streamed).digest('hex'),
    );
    const cold = new ChatTranscriptArtifacts(root);
    await cold.verify('stream', ref);
    expect((await readAll(cold, 'stream', ref)) === whole).toBe(true);
    expect(await readdir(join(root, 'tool-output', 'stream'))).toEqual([
      `${ref.artifactId}.txt`,
    ]);
  });

  it.each([
    ['UTF-8', 'a🌲b界c'.repeat(200)],
    ['UTF-16LE', 'a🌲b\uD800c界\uDFFF'.repeat(200)],
  ])(
    'matches put for one-code-unit and seeded random partitions (%s)',
    async (_name, whole) => {
      const expected = await artifacts.put('whole', whole);
      // Code point partitions, then single code unit partitions.
      expect(await artifacts.putStream('points', Array.from(whole))).toEqual(
        expected,
      );
      const units: string[] = [];
      for (let index = 0; index < whole.length; index += 1)
        units.push(whole.charAt(index));
      expect(await artifacts.putStream('code-units', units)).toEqual(expected);
      const body = whole.repeat(60);
      const bodyRef = await artifacts.put('whole-large', body);
      for (const seed of [1, 7, 42]) {
        const ref = await artifacts.putStream(
          `random-${seed}`,
          seededPartitions(body, seed),
        );
        expect(ref).toEqual(bodyRef);
        expect(
          (await readAll(
            new ChatTranscriptArtifacts(root),
            `random-${seed}`,
            ref,
          )) === body,
        ).toBe(true);
      }
    },
  );

  it('accepts asynchronous chunk sources', async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield 'async ';
      await nextTurn();
      yield '\uD83D';
      yield '\uDE00 body';
    }
    expect(await artifacts.putStream('chat-1', chunks())).toEqual(
      await artifacts.put('whole', 'async 😀 body'),
    );
  });

  it('reuses a verified artifact without recording a new publication', async () => {
    const body = 'reused 🌲\n'.repeat(10_000);
    const ref = await artifacts.put('chat-1', body);
    const rename = jest.spyOn(fsPromises, 'rename');
    const created = new CreatedArtifacts();
    expect(
      await artifacts.putStream('chat-1', seededPartitions(body, 3), created),
    ).toEqual(ref);
    expect(created.size).toBe(0);
    expect(rename).not.toHaveBeenCalled();
    expect(await readdir(join(root, 'tool-output', 'chat-1'))).toEqual([
      `${ref.artifactId}.txt`,
    ]);
  });

  it('removes staged files and publishes nothing when aborted', async () => {
    const controller = new AbortController();
    async function* chunks(): AsyncGenerator<string> {
      yield 'first chunk 🌲'.repeat(10_000);
      await nextTurn();
      controller.abort(new Error('cancelled by caller'));
      yield 'second chunk';
    }
    const created = new CreatedArtifacts();
    await expect(
      artifacts.putStream('chat-1', chunks(), created, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled by caller');
    expect(created.size).toBe(0);
    expect(await readdir(join(root, 'tool-output', 'chat-1'))).toEqual([]);
  });

  it('rejects an already aborted signal before staging', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(
      artifacts.putStream('chat-1', ['body'], undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('already cancelled');
  });

  it.each([
    ['staging', 'write'],
    ['encoding', 'writeFile'],
  ] as const)(
    'removes staged files when %s fails with ENOSPC',
    async (_stage, method) => {
      const open = fsPromises.open;
      jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          const [path, flags] = args;
          const isEncoded = flags === 'wx';
          if (
            String(path).endsWith('.tmp') &&
            (method === 'write' ? !isEncoded : isEncoded)
          )
            jest.spyOn(handle, method).mockRejectedValue(
              Object.assign(new Error('no space left on device'), {
                code: 'ENOSPC',
              }),
            );
          return handle;
        });
      const created = new CreatedArtifacts();
      await expect(
        artifacts.putStream('chat-1', ['body 🌲', ' more'], created),
      ).rejects.toThrow('no space left on device');
      expect(created.size).toBe(0);
      expect(await readdir(join(root, 'tool-output', 'chat-1'))).toEqual([]);
    },
  );

  it('removes staged files when publication fails before the rename', async () => {
    const rename = jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValue(new Error('rename failed'));
    await expect(
      artifacts.putStream('chat-1', ['body \uD800 unpaired']),
    ).rejects.toThrow('rename failed');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await readdir(join(root, 'tool-output', 'chat-1'))).toEqual([]);
  });

  it('refuses to publish from a read-only store', async () => {
    await expect(
      new ChatTranscriptArtifacts(root, true).putStream('chat-1', ['body']),
    ).rejects.toThrow('read-only');
  });

  it('hashes a multi-megabyte stream without blocking the event loop', async () => {
    const chunk = 'streamed 🌲 body\n'.repeat(4096);
    const chunks = Array.from({ length: 64 }, () => chunk);
    let bytesSinceTurn = 0;
    let maxBytesBetweenTurns = 0;
    let scheduled = false;
    const update = Reflect.get(crypto.Hash.prototype, 'update');
    jest.spyOn(crypto.Hash.prototype, 'update').mockImplementation(function (
      this: crypto.Hash,
      data: crypto.BinaryLike,
      encoding?: BufferEncoding,
    ) {
      const bytes =
        typeof data === 'string'
          ? Buffer.byteLength(data, encoding)
          : data.byteLength;
      bytesSinceTurn += bytes;
      maxBytesBetweenTurns = Math.max(maxBytesBetweenTurns, bytesSinceTurn);
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          bytesSinceTurn = 0;
          scheduled = false;
        });
      }
      const result: unknown = Reflect.apply(update, this, [data, encoding]);
      if (!(result instanceof crypto.Hash))
        throw new Error('Hash update did not return its handle');
      return result;
    });
    const ref = await artifacts.putStream('chat-1', chunks);
    jest.restoreAllMocks();
    expect(ref.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect(maxBytesBetweenTurns).toBeLessThanOrEqual(1024 * 1024);
    expect(ref).toEqual(await artifacts.put('whole', chunks.join('')));
  });
});
