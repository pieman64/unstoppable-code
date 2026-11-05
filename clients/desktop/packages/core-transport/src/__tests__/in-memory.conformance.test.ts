import {
  CANOPY_TRANSPORT_CONFORMANCE_PENDING,
  createInMemoryFramedPair,
  runCanopyJournalConformance,
  runCanopyTransportConformance,
  type CanopyConformancePairOptions,
  type CanopyFramedPair,
  type CanopyJournalConformanceTarget,
} from '@canopy/core-transport';
import type { CanopyJsonRpcMessage } from '@canopy/protocol/canopy-core';

runCanopyTransportConformance({
  name: 'in-memory',
  createPair: createInMemoryFramedPair,
  describe,
  it,
  todo: it.todo,
});

it('lists every pending case with its owning ticket', () => {
  expect(CANOPY_TRANSPORT_CONFORMANCE_PENDING.length).toBeGreaterThan(0);
  for (const { owner } of CANOPY_TRANSPORT_CONFORMANCE_PENDING)
    expect(owner).toMatch(/^(CAN-\d+ [A-Z]\d+|W\d+)$/);
});

function collectCases(
  createPair: (
    options?: CanopyConformancePairOptions,
  ) => Promise<CanopyFramedPair>,
): Map<string, () => Promise<void>> {
  const cases = new Map<string, () => Promise<void>>();
  runCanopyTransportConformance({
    name: 'collected',
    createPair,
    describe: (_name, body) => body(),
    it: (name, body) => void cases.set(name, body),
    todo: () => undefined,
  });
  return cases;
}

it('registers the cases a message binding without a server close cannot run as todo', () => {
  const run: string[] = [];
  const todo: string[] = [];
  runCanopyTransportConformance({
    name: 'collected',
    createPair: createInMemoryFramedPair,
    describe: (_name, body) => body(),
    it: (name) => void run.push(name),
    todo: (name) => void todo.push(name),
    byteWire: false,
    serverClose: false,
  });
  expect(todo).toEqual(
    expect.arrayContaining([
      'reassembles a request written one byte at a time (no byte wire on this binding)',
      'carries payloads up to the frame cap and fails closed beyond it (no byte wire on this binding)',
      'applies backpressure to an unread stream and resumes in order (no byte wire on this binding)',
      'answers malformed envelopes and closes on malformed frames (no byte wire on this binding)',
      'negotiates bulk channels within their caps (no byte wire on this binding)',
      'bulk channel credit flow control (no byte wire on this binding)',
      'fails authentication closed (no byte wire on this binding)',
      'fails closed with an actionable error on a protocol-major mismatch (no server close reaches the client on this binding)',
    ]),
  );
  expect(todo).toHaveLength(8 + CANOPY_TRANSPORT_CONFORMANCE_PENDING.length);
  expect(run).toContain('surfaces a disconnect mid-stream to both ends');
  expect(run).toContain('resumes a subscription after the acknowledged cursor');
});

it('keeps each case isolated when a runner schedules cases concurrently', async () => {
  const results = await Promise.allSettled(
    Array.from(collectCases(createInMemoryFramedPair).values(), (body) =>
      body(),
    ),
  );
  expect(results.filter(({ status }) => status === 'rejected')).toEqual([]);
});

it('closes pairs a nonconforming binding wrongly accepts during authentication', async () => {
  const accepted: CanopyFramedPair[] = [];
  const authCase = collectCases(async () => {
    const created = await createInMemoryFramedPair();
    accepted.push(created);
    return created;
  }).get('fails authentication closed');
  await expect(authCase?.()).rejects.toThrow('Expected a rejection.');
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.client.signal.aborted).toBe(true);
});

it('runs journal cases on a public target and closes it after its pairs', async () => {
  const daemonEpoch = 'epoch-unresponsive';
  const pairs: CanopyFramedPair[] = [];
  const opens: CanopyJsonRpcMessage[] = [];
  const closedAfterPairs: boolean[] = [];
  // Hangs up on the first frame, so every case fails instead of waiting.
  const target: CanopyJournalConformanceTarget = {
    name: 'unresponsive',
    method: 'core.runtime.events',
    start: () =>
      Promise.resolve({
        daemonEpoch,
        serve: (server) =>
          void server.receive().then(
            (message) => {
              opens.push(message);
              server.close();
            },
            () => undefined,
          ),
        append: (count) =>
          Promise.resolve(
            Array.from({ length: count }, (_, index) => ({
              daemonEpoch,
              sequence: index + 1,
            })),
          ),
        expire: () => Promise.resolve({ daemonEpoch, sequence: 0 }),
        close: () => {
          closedAfterPairs.push(
            pairs.every(({ client }) => client.signal.aborted),
          );
          return Promise.resolve();
        },
      }),
  };
  const cases = new Map<string, () => Promise<void>>();
  runCanopyJournalConformance({
    name: 'collected',
    createPair: async (options) => {
      const created = await createInMemoryFramedPair(options);
      pairs.push(created);
      return created;
    },
    target,
    describe: (_name, body) => body(),
    it: (name, body) => void cases.set(name, body),
  });
  expect(Array.from(cases.keys())).toEqual([
    'resumes a subscription after the acknowledged cursor',
    'replays a late subscriber without a cursor through the head',
    'answers a foreign-epoch cursor with snapshot_required',
    'answers a cursor past the head with snapshot_required',
    'answers an evicted cursor with snapshot_required',
  ]);
  for (const body of Array.from(cases.values()))
    await expect(body()).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
  expect(closedAfterPairs).toEqual(Array(cases.size).fill(true));
  // The target's method and params alone shape the open; no forced families.
  expect(
    opens.map((open) => 'method' in open && [open.method, open.params]),
  ).toEqual([
    ['core.runtime.events', { cursor: null }],
    ['core.runtime.events', { cursor: null }],
    [
      'core.runtime.events',
      { cursor: { daemonEpoch: `${daemonEpoch}-foreign`, sequence: 1 } },
    ],
    ['core.runtime.events', { cursor: { daemonEpoch, sequence: 2 } }],
    ['core.runtime.events', { cursor: { daemonEpoch, sequence: 0 } }],
  ]);
});
