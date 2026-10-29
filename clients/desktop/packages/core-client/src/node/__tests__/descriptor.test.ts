import { CanopyClientError } from '../../errors';
import { rejection } from '../../__tests__/client-conformance';
import type { CanopyRuntimeDescriptor } from '../daemon-ports';
import {
  classifyCanopyDescriptor,
  parseCanopyRuntimeDescriptor,
  type CanopyDescriptorState,
} from '../descriptor';

const descriptor: CanopyRuntimeDescriptor = {
  version: 1,
  pid: 4242,
  startIdentity: 'start-1',
  endpoint: { kind: 'socket', path: '/tmp/private/core.sock' },
  protocolRange: { min: 1, max: 2 },
  buildVersion: '1.2.3',
  tokenRef: 'private-token-ref',
};
type Identity = { readonly startIdentity: string } | null;
const leaky = (): Promise<never> =>
  Promise.reject(new Error('/tmp/private secret-detail'));
const hang = (): Promise<never> => new Promise<never>(() => {});
const resolved = (value: Identity) => (): Promise<Identity> =>
  Promise.resolve(value);
const range = (min: number, max: number): object => ({ min, max });
const withField = (key: string, values: unknown[]): unknown[] =>
  values.map((value) => ({ ...descriptor, [key]: value }));

interface World {
  readonly read?: () => Promise<unknown>;
  readonly inspect?: () => Promise<Identity>;
  readonly versions?: readonly number[];
  readonly signal?: AbortSignal;
}

function harness(
  raw: unknown,
  world: World = {},
): [string[], Promise<CanopyDescriptorState>] {
  const calls: string[] = [];
  const { read = (): Promise<unknown> => Promise.resolve(raw) } = world;
  const { inspect = resolved({ startIdentity: 'start-1' }) } = world;
  const result = classifyCanopyDescriptor({
    source: {
      read: () => (calls.push('read'), read()),
      readToken: () => (calls.push('readToken'), leaky()),
    },
    supervisor: {
      inspectProcess: (pid) => (calls.push(`inspect:${pid}`), inspect()),
    },
    protocolVersions: world.versions ?? [1],
    signal: world.signal ?? new AbortController().signal,
  });
  return [calls, result];
}

it('parses socket and pipe descriptors, dropping unknown additive fields', () => {
  expect(parseCanopyRuntimeDescriptor(descriptor)).toEqual(descriptor);
  const endpoint = { kind: 'pipe', path: '\\\\.\\pipe\\c' };
  const future = {
    ...descriptor,
    schemaVersion: 2,
    endpoint: { ...endpoint, family: 'pipe' },
    protocolRange: { ...descriptor.protocolRange, preferred: 2 },
  };
  const pipe = { ...descriptor, endpoint };
  expect(parseCanopyRuntimeDescriptor(future)).toEqual(pipe);
});

it.each<unknown>([
  null,
  [descriptor],
  JSON.stringify(descriptor),
  ...withField('version', [undefined, 2, '1']),
  ...withField('pid', [undefined, 0, -1, 1.5, 2 ** 53, '4242']),
  ...withField('startIdentity', ['', ' start-1', 7]),
  ...withField('buildVersion', ['  ']),
  ...withField('tokenRef', [undefined]),
  ...withField('endpoint', [null, { kind: 'tcp', path: 'x' }]),
  ...withField('endpoint', [{ kind: 'socket', path: '' }]),
  ...withField('protocolRange', [undefined, range(0, 1), range(2, 1)]),
  ...withField('protocolRange', [range(1, 1.5), range(1, Infinity)]),
])('rejects malformed descriptor %j', (value) => {
  expect(parseCanopyRuntimeDescriptor(value)).toBeNull();
});

it('reports absent only for an exact null read, without reading tokens', async () => {
  const [calls, result] = harness(null);
  expect(await result).toEqual({ kind: 'absent' });
  expect(calls).toEqual(['read']);
});

it.each<unknown>([undefined, {}, { ...descriptor, pid: 0 }])(
  'fails closed on %j without inspecting a process',
  async (raw) => {
    const [calls, result] = harness(raw);
    expect(await rejection(result)).toEqual({
      kind: 'failed_precondition',
      message: 'Core runtime descriptor is malformed.',
      retry: { kind: 'never' },
    });
    expect(calls).toEqual(['read']);
  },
);

it('marks dead and reused PIDs stale even when the range is incompatible', async () => {
  const old = { ...descriptor, protocolRange: { min: 9, max: 9 } };
  const [, gone] = harness(old, { inspect: resolved(null) });
  expect(await gone).toEqual({ kind: 'stale', reason: 'process_exited' });
  const reused = { inspect: resolved({ startIdentity: 'start-2' }) };
  const mismatch = { kind: 'stale', reason: 'identity_mismatch' };
  expect(await harness(old, reused)[1]).toEqual(mismatch);
});

it.each<[number[], number, number, CanopyDescriptorState['kind']]>([
  [[1], 1, 1, 'live'],
  [[1, 2], 2, 5, 'live'],
  [[3], 1, 3, 'live'],
  [[4], 1, 3, 'incompatible'],
  [[1], 2, 3, 'incompatible'],
  [[], 1, 1, 'incompatible'],
])('versions %j vs %i..%i: %s', async (versions, min, max, kind) => {
  const raw = { ...descriptor, protocolRange: { min, max } };
  const [calls, result] = harness(raw, { versions });
  expect(await result).toEqual({ kind, descriptor: raw });
  expect(calls).toEqual(['read', 'inspect:4242']);
});

it('rejects invalid client protocol versions before any port call', async () => {
  for (const versions of [[0], [1.5], [Number.NaN]]) {
    const [calls, result] = harness(descriptor, { versions });
    expect(await rejection(result)).toMatchObject({ kind: 'invalid_argument' });
    expect(calls).toEqual([]);
  }
});

it('redacts read, typed, and inspect port failures to fixed text', async () => {
  const payload = { kind: 'not_found', message: 'p', retry: { kind: 'never' } };
  const typed = Object.assign(new Error('private'), { payload });
  const reads = [leaky, (): Promise<never> => Promise.reject(typed)];
  for (const world of [...reads.map((read) => ({ read })), { inspect: leaky }])
    expect(await rejection(harness(descriptor, world)[1])).toEqual({
      kind: 'unavailable',
      message: 'Core discovery failed.',
      retry: { kind: 'same_request' },
    });
});

it('cancels before reading and while a port ignores the signal', async () => {
  const stop = { kind: 'cancelled', message: 'Core discovery was cancelled.' };
  const reason = new Error('secret-detail');
  const signal = AbortSignal.abort(reason);
  const [calls, early] = harness(descriptor, { signal });
  expect(await rejection(early)).toMatchObject(stop);
  expect(calls).toEqual([]);
  for (const world of [{ read: hang }, { inspect: hang }]) {
    const controller = new AbortController();
    const { signal } = controller;
    const [, result] = harness(descriptor, { ...world, signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(reason);
    expect(await rejection(result)).toMatchObject(stop);
  }
});

it('keeps native inspection limitations typed and redacted', async () => {
  const inspect = (): Promise<never> =>
    Promise.reject(
      new CanopyClientError({
        kind: 'capability_unavailable',
        message: 'private host detail',
        retry: { kind: 'never' },
      }),
    );
  expect(await rejection(harness(descriptor, { inspect })[1])).toMatchObject({
    kind: 'capability_unavailable',
    message: 'Core process identity cannot be verified on this host.',
  });
});

it('compares Windows incarnation identities verbatim and never calls unavailable identity stale', async () => {
  const startIdentity = 'win32:v1:4242:20261008062326123456';
  const raw = { ...descriptor, startIdentity };
  expect(
    await harness(raw, { inspect: resolved({ startIdentity }) })[1],
  ).toEqual({ kind: 'live', descriptor: raw });
  const next = 'win32:v1:4242:20261008062326123457';
  expect(
    await harness(raw, { inspect: resolved({ startIdentity: next }) })[1],
  ).toEqual({ kind: 'stale', reason: 'identity_mismatch' });
  const [, unknown] = harness(raw, { inspect: leaky });
  expect(await rejection(unknown)).toMatchObject({ kind: 'unavailable' });
});
