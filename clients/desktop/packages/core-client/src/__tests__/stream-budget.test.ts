import type {
  CanopyJsonRpcNotification,
  CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';

import { createCanopyClient } from '../index';
import type {
  CanopyClientStreamFrame,
  CanopyClientStreamHandle,
  CanopyClientStreamOptions,
} from '../types';
import {
  CANONICAL_DEFINITIONS,
  canonicalInitializeResult,
  serveCanonicalCore,
} from './fixtures/canonical-core';
import { createObjectFramedPair } from './fixtures/object-pair';

// The approved budget contract, in canonical encoded envelope bytes.
const MiB = 1024 * 1024;
const STREAM_BUDGET = 16 * MiB;
const CONNECTION_BUDGET = 64 * MiB;
/** Held per active stream for its terminal, against both budgets. */
const TERMINAL_RESERVATION = 4096;
const STREAM_ROOM = STREAM_BUDGET - TERMINAL_RESERVATION;

type Frame = CanopyClientStreamFrame<unknown, unknown>;
type Handle = CanopyClientStreamHandle<unknown, unknown>;

const encoder = new TextEncoder();
const bytes = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).byteLength;

// 'é' is one UTF-16 unit but two UTF-8 bytes, so counting characters undercounts.
const WIDE = 'é'.repeat(STREAM_BUDGET / 2);
/** Exactly `size` encoded bytes, sliced from one shared string. */
function pad(size: number): string {
  if (size < 0 || size > STREAM_BUDGET) throw new Error(`Bad pad ${size}.`);
  return WIDE.slice(0, Math.floor(size / 2)) + (size % 2 ? 'a' : '');
}

/** Builds an envelope whose canonical encoding is exactly `size` bytes. */
function fit(
  build: (padding?: string) => CanopyJsonRpcNotification,
  size?: number,
): CanopyJsonRpcNotification {
  return size === undefined ? build() : build(pad(size - bytes(build(''))));
}

const turns = async (count = 4): Promise<void> => {
  for (let turn = 0; turn < count; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  jest.useRealTimers();
});

const useDeadlineTimers = (): void =>
  void jest.useFakeTimers({
    doNotFake: ['setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'],
  });

type Kind = 'item' | 'end';
interface Harness {
  readonly echo: (text: string) => Promise<unknown>;
  readonly open: (
    accepted: number,
    options?: CanopyClientStreamOptions<Frame>,
  ) => Promise<Handle>;
  /** Subscription ids the core answers the next opens with, in order. */
  readonly ids: string[];
  /** An item, or a completed end, encoded in exactly `size` bytes. */
  readonly message: (
    kind: Kind,
    handle: Handle | string,
    sequence: number,
    size?: number,
  ) => CanopyJsonRpcNotification;
  readonly deliver: (message: CanopyJsonRpcNotification) => Promise<void>;
  readonly post: (...args: Parameters<Harness['message']>) => Promise<void>;
  /** Charges a stream exactly `total` bytes: two items, then a padded end. */
  readonly fill: (handle: Handle, base: number, total: number) => Promise<void>;
  /** Short labels: a failing diff never prints megabyte pads. */
  readonly summary: (frame: Frame) => string;
  /** Up to `max` frame labels, then leaves the iterator as `break` does. */
  readonly drain: (handle: Handle, max: number) => Promise<string[]>;
}

async function connect(epoch = 'epoch-1'): Promise<Harness> {
  const pair = createObjectFramedPair();
  const { runtime } = canonicalInitializeResult();
  const ids: string[] = [];
  serveCanonicalCore(
    pair.server,
    {
      'core.test.echo': ({ text }) => ({ text, length: String(text).length }),
      'core.test.ticks': ({ cursor }) => {
        const subscriptionId = ids.shift();
        if (subscriptionId === undefined) return undefined;
        return { subscriptionId, acceptedCursor: cursor ?? null };
      },
    },
    {
      initialize: canonicalInitializeResult({
        runtime: { ...runtime, daemonEpoch: epoch },
      }),
    },
  );
  const client = await createCanopyClient({
    connection: pair.client,
    clientName: 'stream-budget',
    clientVersion: '1.0.0',
    definitions: CANONICAL_DEFINITIONS,
  });
  cleanups.push(async () => {
    await client.close();
    pair.close();
  });
  const cursor = (sequence: number): CanopyStreamCursor => ({
    daemonEpoch: epoch,
    sequence,
  });
  const message: Harness['message'] = (kind, handle, sequence, size) =>
    fit((padding) => {
      const subscriptionId =
        typeof handle === 'string' ? handle : handle.openResult.subscriptionId;
      const head = { subscriptionId, cursor: cursor(sequence) };
      return {
        jsonrpc: '2.0',
        method: `core.test.ticks.${kind}`,
        params:
          kind === 'item'
            ? {
                ...head,
                itemId: `item-${sequence}`,
                occurredAt: '2026-10-07T12:00:00Z',
                item: { tick: sequence, pad: padding },
              }
            : { ...head, outcome: 'completed', error: null, pad: padding },
      };
    }, size);
  const deliver: Harness['deliver'] = async (envelope) => {
    await pair.server.send(envelope);
    await turns();
  };
  const post: Harness['post'] = (...args) => deliver(message(...args));
  const summary: Harness['summary'] = (frame) => {
    const { daemonEpoch, sequence } = frame.cursor;
    const at = `${daemonEpoch === epoch ? '' : 'foreign-epoch'}@${sequence}`;
    if (frame.kind === 'item') return `item${at}`;
    return `${frame.outcome}:${frame.error?.kind ?? 'none'}${at}`;
  };
  return {
    ids,
    echo: (text) => client.query('core.test.echo', { text }),
    open: (accepted, options) =>
      client.openStream(
        'core.test.ticks',
        { count: 0, hold: true, cursor: cursor(accepted) },
        options,
      ),
    message,
    deliver,
    post,
    fill: async (handle, base, total): Promise<void> => {
      const end = 64 * 1024;
      const first = Math.floor((total - end) / 2);
      await post('item', handle, base + 1, first);
      await post('item', handle, base + 2, total - end - first);
      await post('end', handle, base + 2, end);
    },
    summary,
    drain: async (handle, max): Promise<string[]> => {
      const frames = handle.frames[Symbol.asyncIterator]();
      const seen: string[] = [];
      while (seen.length < max) {
        const next = await Promise.race([
          frames.next(),
          turns().then(() => null),
        ]);
        if (!next) return [...seen, 'pending'];
        if (next.done) return seen;
        seen.push(summary(next.value));
        if (next.value.kind === 'end') return seen;
      }
      await frames.return?.();
      return seen;
    },
  };
}

describe('createCanopyClient stream byte budgets', () => {
  it('charges a stream its canonical UTF-8 envelope bytes, up to exactly its room', async () => {
    const core = await connect();
    const full = await core.open(10);
    const over = await core.open(20);
    const sibling: string[] = [];
    const live = await core.open(30, {
      onFrame: (frame) => sibling.push(core.summary(frame)),
    });
    const first = core.message('item', full, 11, STREAM_BUDGET / 2);
    expect(bytes(first)).toBe(STREAM_BUDGET / 2);
    expect(JSON.stringify(first).length).toBeLessThan(STREAM_BUDGET / 3);
    await core.deliver(first);
    await core.post('item', full, 12, STREAM_ROOM - STREAM_BUDGET / 2);
    await core.post('item', over, 21, STREAM_BUDGET / 2);
    await core.post('item', over, 22, STREAM_ROOM - STREAM_BUDGET / 2 + 1);
    await core.post('item', live, 31);
    expect(sibling).toEqual(['item@31']);
    expect(await core.echo('ok')).toEqual({ text: 'ok', length: 2 });
    await core.post('item', full, 13);

    expect(await core.drain(full, 4)).toEqual([
      'item@11',
      'item@12',
      'error:resource_exhausted@12',
    ]);
    expect(await core.drain(over, 3)).toEqual([
      'item@21',
      'error:resource_exhausted@21',
    ]);
  });

  it('bounds the connection at 64 MiB, ending only the offending stream', async () => {
    const core = await connect();
    const holders: Handle[] = [];
    for (let base = 100; base <= 400; base += 100) {
      holders.push(await core.open(base));
      await core.post('item', holders[holders.length - 1], base + 1, 7.5 * MiB);
      await core.post('item', holders[holders.length - 1], base + 2, 7.5 * MiB);
    }
    // 60 MiB is held: 5 MiB more fits its own stream but not the connection.
    const offender = await core.open(500);
    await core.post('item', offender, 501, 5 * MiB);

    expect(await core.drain(offender, 2)).toEqual([
      'error:resource_exhausted@500',
    ]);
    expect(await core.echo('ok')).toEqual({ text: 'ok', length: 2 });
    for (const [index, holder] of Array.from(holders.entries()))
      expect(await core.drain(holder, 2)).toEqual([
        `item@${index * 100 + 101}`,
        `item@${index * 100 + 102}`,
      ]);
    const fresh = await core.open(600);
    await core.post('item', fresh, 601, 5 * MiB);
    expect(await core.drain(fresh, 1)).toEqual(['item@601']);
  });

  it('releases only delivered frames across an early iterator return', async () => {
    const core = await connect();
    const stream = await core.open(0);
    const third = Math.floor(STREAM_ROOM / 3);
    await core.post('item', stream, 1, third);
    await core.post('item', stream, 2, third);
    await core.post('item', stream, 3, STREAM_ROOM - 2 * third);
    expect(await core.drain(stream, 1)).toEqual(['item@1']);
    await core.post('item', stream, 4, third);
    await core.post('item', stream, 5);

    expect(await core.drain(stream, 5)).toEqual([
      'item@2',
      'item@3',
      'item@4',
      'error:resource_exhausted@4',
    ]);
  });

  it('replaces a remote end beyond the reservation and remaining room', async () => {
    const core = await connect();
    const fits = await core.open(0);
    const oversized = await core.open(10);
    for (const [handle, base, extra] of [
      [fits, 0, 0],
      [oversized, 10, 1],
    ] as const) {
      await core.post('item', handle, base + 1, STREAM_ROOM - 1024);
      const end = TERMINAL_RESERVATION + 1024 + extra;
      await core.post('end', handle, base + 1, end);
    }

    expect(await core.drain(fits, 3)).toEqual(['item@1', 'completed:none@1']);
    expect(await core.drain(oversized, 3)).toEqual([
      'item@11',
      'error:resource_exhausted@11',
    ]);
  });

  it.each(['close', 'abort', 'deadline'] as const)(
    '%s discards unread frames and a retained end, ending once at the last delivered cursor',
    async (mode) => {
      useDeadlineTimers();
      const core = await connect();
      const controller = new AbortController();
      const deadlineAt = new Date(Date.now() + 60_000).toISOString();
      const stream = await core.open(0, {
        signal: controller.signal,
        metadata: { deadlineAt },
      });
      for (const sequence of [1, 2, 3])
        await core.post('item', stream, sequence, MiB);
      await core.post('end', stream, 3);
      expect(await core.drain(stream, 1)).toEqual(['item@1']);

      if (mode === 'close') stream.close();
      else if (mode === 'abort') controller.abort();
      else jest.advanceTimersByTime(60_000);
      const end =
        mode === 'deadline' ? 'error:deadline_exceeded' : 'cancelled:cancelled';
      expect(await core.drain(stream, 3)).toEqual([`${end}@1`]);
      stream.close();
      controller.abort();
      expect(await core.drain(stream, 1)).toEqual([]);
    },
  );

  it('refuses a stream whose terminal cannot be reserved until close, abort, or deadline releases charges', async () => {
    useDeadlineTimers();
    // Each control character escapes to six JSON bytes: the largest cursor.
    const core = await connect('\u0001'.repeat(512));
    const abort = new AbortController();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const holders = [
      await core.open(100, { signal: abort.signal }),
      await core.open(200, { metadata: { deadlineAt } }),
      await core.open(300),
      await core.open(400),
      await core.open(500),
    ];
    const share = Math.floor((CONNECTION_BUDGET - 8) / holders.length);
    const totals = holders.map((_, index) =>
      index ? share : CONNECTION_BUDGET - 8 - share * (holders.length - 1),
    );
    // Ended undrained streams keep their items and charged ends: 8 bytes stay free.
    for (const [index, holder] of Array.from(holders.entries()))
      await core.fill(holder, index * 100 + 100, totals[index]);
    const refused = { payload: { kind: 'resource_exhausted' } };
    await expect(core.open(600)).rejects.toMatchObject(refused);
    expect(await core.echo('ok')).toEqual({ text: 'ok', length: 2 });

    abort.abort();
    expect(await core.drain(holders[0], 3)).toEqual([
      'cancelled:cancelled@100',
    ]);
    await core.fill(await core.open(600), 600, totals[0]);
    await expect(core.open(700)).rejects.toMatchObject(refused);

    // The deadline's uncharged end is delivered while the connection is full.
    jest.advanceTimersByTime(60_000);
    expect(await core.drain(holders[1], 3)).toEqual([
      'error:deadline_exceeded@200',
    ]);
    await core.fill(await core.open(700), 700, totals[1]);
    await expect(core.open(800)).rejects.toMatchObject(refused);

    holders[2].close();
    expect(await core.drain(holders[2], 3)).toEqual([
      'cancelled:cancelled@300',
    ]);
    const last = await core.open(800);
    await core.post('item', last, 801, totals[2] + MiB);
    expect(await core.drain(last, 2)).toEqual(['error:resource_exhausted@800']);
  });
});

describe('createCanopyClient refused stream subscriptions', () => {
  const MAX_EPOCH = '\u0001'.repeat(512);
  const refused = { payload: { kind: 'resource_exhausted' } };
  const failed = { payload: { kind: 'internal' } };

  /** Five ended, undrained holders leave 8 bytes free: every open is refused. */
  async function saturate(core: Harness): Promise<Handle[]> {
    const holders: Handle[] = [];
    const share = Math.floor((CONNECTION_BUDGET - 8) / 5);
    for (let index = 0; index < 5; index += 1) {
      const base = index * 100 + 100;
      holders.push(await core.open(base));
      const total = index ? share : CONNECTION_BUDGET - 8 - share * 4;
      await core.fill(holders[index], base, total);
    }
    return holders;
  }

  /** Refuses an open the core accepted as `id`, then frees the first holder. */
  async function refuseThenRelease(core: Harness, id: string): Promise<void> {
    const [first] = await saturate(core);
    core.ids.push(id);
    await expect(core.open(600)).rejects.toMatchObject(refused);
    first.close();
    expect(await core.drain(first, 3)).toEqual(['cancelled:cancelled@100']);
  }

  it('drops a refused stream, then fails closed when the core reopens its still-active id', async () => {
    const core = await connect(MAX_EPOCH);
    await refuseThenRelease(core, 'refused');
    const sibling = await core.open(700);
    await core.post('item', 'refused', 601);
    await core.post('item', sibling, 701);
    expect(await core.echo('ok')).toEqual({ text: 'ok', length: 2 });
    expect(await core.drain(sibling, 1)).toEqual(['item@701']);

    core.ids.push('refused');
    await expect(core.open(800)).rejects.toMatchObject(failed);
    expect(await core.drain(sibling, 2)).toEqual(['error:internal@701']);
    await expect(core.echo('ok')).rejects.toMatchObject(failed);
  });

  it.each(['foreign-method', 'malformed', 'valid'] as const)(
    'frees a refused id for reuse only on its valid remote end (%s)',
    async (mode) => {
      const core = await connect(MAX_EPOCH);
      await refuseThenRelease(core, 'refused');
      const end = core.message('end', 'refused', 600);
      if (mode === 'foreign-method') end.method = 'core.test.other.end';
      if (mode === 'malformed') end.params.outcome = 'exploded';
      await core.deliver(end);

      core.ids.push('refused');
      const reopened = core.open(700);
      if (mode !== 'valid')
        return void (await expect(reopened).rejects.toMatchObject(failed));
      const handle = await reopened;
      await core.post('item', handle, 701);
      expect(await core.drain(handle, 2)).toEqual(['item@701', 'pending']);
      expect(await core.echo('ok')).toEqual({ text: 'ok', length: 2 });
    },
  );

  it('fails closed rather than forget a refused id past 1 MiB of retained ids', async () => {
    const core = await connect(MAX_EPOCH);
    await saturate(core);
    // 'é' is two UTF-8 bytes: counting characters would retain both ids.
    core.ids.push('é'.repeat(150_000), 'é'.repeat(400_000));
    await expect(core.open(600)).rejects.toMatchObject(refused);
    expect(await core.echo('ok')).toEqual({ text: 'ok', length: 2 });
    await expect(core.open(700)).rejects.toMatchObject(refused);
    await expect(core.echo('ok')).rejects.toMatchObject(refused);
  });

  it.each(['close', 'abort', 'deadline'] as const)(
    '%s of an undrained ended stream keeps a new stream reusing its id routed',
    async (mode) => {
      if (mode === 'deadline') useDeadlineTimers();
      const core = await connect(MAX_EPOCH);
      const controller = new AbortController();
      const deadlineAt = new Date(Date.now() + 60_000).toISOString();
      core.ids.push('shared', 'shared');
      const ended = await core.open(0, {
        signal: controller.signal,
        metadata: { deadlineAt },
      });
      await core.post('item', ended, 1);
      expect(await core.drain(ended, 1)).toEqual(['item@1']);
      await core.post('item', ended, 2);
      await core.post('end', ended, 2);
      const reused = await core.open(10);

      if (mode === 'close') ended.close();
      else if (mode === 'abort') controller.abort();
      else jest.advanceTimersByTime(60_000);
      const end =
        mode === 'deadline' ? 'error:deadline_exceeded' : 'cancelled:cancelled';
      expect(await core.drain(ended, 3)).toEqual([`${end}@1`]);
      await core.post('item', reused, 11);
      await core.post('end', reused, 11);
      expect(await core.drain(reused, 3)).toEqual([
        'item@11',
        'completed:none@11',
      ]);
      // Exact saturation fits only if the reused stream released everything.
      const holders = await saturate(core);
      expect(await core.drain(holders[4], 4)).toEqual([
        'item@501',
        'item@502',
        'completed:none@502',
      ]);
    },
  );
});
