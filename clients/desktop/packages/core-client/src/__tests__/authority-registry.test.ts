import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type {
  CanopyStreamCursor,
  CoreRuntimeInitializeResult,
} from '@canopy/protocol/canopy-core';

import {
  createCanopyAuthorityRegistry,
  type CanopyAuthorityConnection,
  type CanopyAuthorityRegistry,
  type CanopyResolvedRoute,
} from '../authority-registry';
import { createCanopyClient } from '../client';
import { CanopyClientError } from '../errors';
import type { CanopyClient } from '../types';
import {
  CANONICAL_DEFINITIONS,
  canonicalInitializeResult,
  serveCanonicalCore,
} from './fixtures/canonical-core';

type Runtime = CoreRuntimeInitializeResult['runtime'];
type Defs = typeof CANONICAL_DEFINITIONS;
type TestClient = CanopyClient<
  Defs['queries'],
  Defs['instructions'],
  Defs['streams']
>;
interface Connected {
  client: TestClient;
  server: CanopyFramedConnection;
}

const opened: { close(): unknown }[] = [];
const servers: CanopyFramedConnection[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
  for (const server of servers.splice(0)) server.close();
});

async function authority(
  authorityId: string | null,
  profile: Runtime['profile'] = 'core+worker',
  runtimeId = `runtime-${String(authorityId)}`,
): Promise<Connected> {
  const { client: connection, server } = await createInMemoryFramedPair();
  servers.push(server);
  const { runtime } = canonicalInitializeResult();
  const initialize = canonicalInitializeResult({
    runtime: { ...runtime, authorityId, profile, runtimeId },
  });
  serveCanonicalCore(server, {}, { initialize });
  const client = await createCanopyClient({
    connection,
    clientName: 'authority-registry-test',
    clientVersion: '1.0.0',
    definitions: CANONICAL_DEFINITIONS,
  });
  opened.push(client);
  return { client, server };
}

/** Primary A with secondary B registered. */
async function primaryWithSecondary(): Promise<{
  a: TestClient;
  b: TestClient;
  aServer: CanopyFramedConnection;
  registry: CanopyAuthorityRegistry<TestClient>;
}> {
  const { client: a, server: aServer } = await authority('A');
  const { client: b } = await authority('B');
  const registry = createCanopyAuthorityRegistry({ primary: a });
  expect(registry.add(b)).toBe('B');
  return { a, b, aServer, registry };
}

function routeTo(
  registry: CanopyAuthorityRegistry<TestClient>,
  executionTargetId: string,
  primaryAuthorityId = 'A',
): CanopyResolvedRoute<TestClient> {
  return registry.resolve({
    mode: 'primary-routed',
    primaryAuthorityId,
    executionTargetId,
  });
}

function kindOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CanopyClientError) return error.payload.kind;
    throw error;
  }
  throw new Error('expected a CanopyClientError');
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

const cursor = (daemonEpoch: string, sequence: number): CanopyStreamCursor => ({
  daemonEpoch,
  sequence,
});

describe('createCanopyAuthorityRegistry construction', () => {
  it('registers only the local primary and keeps the client type', async () => {
    const { client } = await authority('A');
    const registry = createCanopyAuthorityRegistry({ primary: client });
    expect(registry.primaryAuthorityId).toBe('A');
    expect(registry.authorityIds()).toEqual(['A']);
    expect(registry.client('A')).toBe(client);
    expect(Object.isFrozen(registry)).toBe(true);
    const ids = registry.authorityIds();
    expect(registry.authorityIds()).not.toBe(ids);
    const typed: TestClient = registry.client('A');
    expect(typed.manifest.has('operations', 'core.test.echo')).toBe(true);
  });

  it('reads identity once when registering', async () => {
    const { client } = await authority('A');
    let reads = 0;
    const counted: CanopyAuthorityConnection = {
      signal: client.signal,
      get identity() {
        reads += 1;
        return client.identity;
      },
    };
    const registry = createCanopyAuthorityRegistry({ primary: counted });
    registry.client('A');
    registry.resolve({ mode: 'authority', authorityId: 'A' });
    expect(reads).toBe(1);
  });

  it.each([
    ['a null authority', null, 'core+worker'],
    ['an empty authority', '', 'core+worker'],
    ['a worker profile', 'W', 'worker'],
  ] as const)('rejects %s as invalid_argument', async (_, id, profile) => {
    const { client: bad } = await authority(id, profile);
    expect(kindOf(() => createCanopyAuthorityRegistry({ primary: bad }))).toBe(
      'invalid_argument',
    );
    const { client } = await authority('A');
    const registry = createCanopyAuthorityRegistry({ primary: client });
    expect(kindOf(() => registry.add(bad))).toBe('invalid_argument');
    expect(registry.authorityIds()).toEqual(['A']);
  });

  it('accepts a connection that carries only an authority and profile', () => {
    const controller = new AbortController();
    const minimal = {
      identity: { authorityId: 'web', profile: 'core+worker' },
      signal: controller.signal,
    } satisfies CanopyAuthorityConnection;
    const registry = createCanopyAuthorityRegistry({ primary: minimal });
    expect(
      registry.resolve({ mode: 'authority', authorityId: 'web' }).client,
    ).toBe(minimal);
    controller.abort();
    expect(
      kindOf(() => registry.resolve({ mode: 'authority', authorityId: 'web' })),
    ).toBe('unavailable');
  });

  it('rejects a closed client as unavailable', async () => {
    const { client: closed } = await authority('B');
    await closed.close();
    expect(
      kindOf(() => createCanopyAuthorityRegistry({ primary: closed })),
    ).toBe('unavailable');
    const { client } = await authority('A');
    const registry = createCanopyAuthorityRegistry({ primary: client });
    expect(kindOf(() => registry.add(closed))).toBe('unavailable');
  });

  it('rejects a duplicate handshake authority even from another runtime', async () => {
    const { client } = await authority('A');
    const { client: twin } = await authority(
      'A',
      'core+worker',
      'runtime-other',
    );
    const registry = createCanopyAuthorityRegistry({ primary: client });
    expect(kindOf(() => registry.add(twin))).toBe('already_exists');
    expect(registry.client('A')).toBe(client);
  });
});

describe('authority registry membership', () => {
  it('reports unknown authorities as not_found', async () => {
    const { client } = await authority('A');
    const registry = createCanopyAuthorityRegistry({ primary: client });
    expect(kindOf(() => registry.client('Z'))).toBe('not_found');
    expect(kindOf(() => registry.cursor('Z'))).toBe('not_found');
    expect(kindOf(() => registry.setPrimary('Z'))).toBe('not_found');
    expect(kindOf(() => registry.remove('Z'))).toBe('not_found');
    expect(
      kindOf(() => registry.resolve({ mode: 'authority', authorityId: 'Z' })),
    ).toBe('not_found');
  });

  it('switches the primary and protects the current one from removal', async () => {
    const { a, registry } = await primaryWithSecondary();
    expect(kindOf(() => registry.remove('A'))).toBe('failed_precondition');
    registry.setPrimary('B');
    expect(registry.primaryAuthorityId).toBe('B');
    registry.remove('A');
    expect(registry.authorityIds()).toEqual(['B']);
    expect(a.signal.aborted).toBe(false);
  });

  it('keeps a disconnected primary registered without failing over', async () => {
    const { a, b, aServer: server, registry } = await primaryWithSecondary();
    server.close();
    await aborted(a.signal);
    expect(registry.authorityIds()).toEqual(['A', 'B']);
    expect(registry.primaryAuthorityId).toBe('A');
    expect(
      kindOf(() => registry.resolve({ mode: 'authority', authorityId: 'A' })),
    ).toBe('unavailable');
    expect(kindOf(() => routeTo(registry, 'B'))).toBe('unavailable');
    expect(
      registry.resolve({ mode: 'authority', authorityId: 'B' }).client,
    ).toBe(b);
    expect(kindOf(() => registry.setPrimary('A'))).toBe('unavailable');
  });
});

describe('authority registry routing', () => {
  it('separates a direct route to B from a primary route to target B', async () => {
    const { a, b, registry } = await primaryWithSecondary();
    expect(registry.resolve({ mode: 'authority', authorityId: 'B' })).toEqual({
      mode: 'authority',
      authorityId: 'B',
      client: b,
      executionTargetId: null,
    });
    const routed = routeTo(registry, 'B');
    expect(routed).toEqual({
      mode: 'primary-routed',
      authorityId: 'A',
      client: a,
      executionTargetId: 'B',
    });
    expect(routed.client).toBe(a);
  });

  it('preserves opaque targets and requires the selected primary', async () => {
    const { registry } = await primaryWithSecondary();
    for (const target of ['local', 'automatic', 'worker:host-9/target#1'])
      expect(routeTo(registry, target).executionTargetId).toBe(target);
    expect(kindOf(() => routeTo(registry, 'local', 'B'))).toBe(
      'failed_precondition',
    );
    expect(kindOf(() => routeTo(registry, ''))).toBe('invalid_argument');
  });
});

describe('authority cursor slots', () => {
  it('keeps independent frozen copies per authority, even on one epoch', async () => {
    const { registry } = await primaryWithSecondary();
    const slotA = registry.cursor('A');
    expect(slotA.authorityId).toBe('A');
    expect(Object.isFrozen(slotA)).toBe(true);
    expect(slotA.read()).toBeNull();
    const input = cursor('epoch-1', 7);
    slotA.write(input);
    registry.cursor('B').write(cursor('epoch-1', 2));
    input.sequence = 99;
    expect(slotA.read()).toEqual(cursor('epoch-1', 7));
    expect(Object.isFrozen(slotA.read())).toBe(true);
    expect(registry.cursor('B').read()).toEqual(cursor('epoch-1', 2));
  });

  it('rejects invalid cursors and applies no event semantics', async () => {
    const { client } = await authority('A');
    const slot = createCanopyAuthorityRegistry({ primary: client }).cursor('A');
    expect(kindOf(() => slot.write(cursor('', 1)))).toBe('invalid_argument');
    expect(kindOf(() => slot.write(cursor('epoch-1', -1)))).toBe(
      'invalid_argument',
    );
    expect(slot.read()).toBeNull();
    slot.write(cursor('epoch-2', 10));
    slot.write(cursor('epoch-1', 3));
    expect(slot.read()).toEqual(cursor('epoch-1', 3));
    slot.clear();
    expect(slot.read()).toBeNull();
  });

  it('keeps a cursor until cleared and gives a re-added authority a fresh slot', async () => {
    const { b, registry } = await primaryWithSecondary();
    registry.cursor('B').write(cursor('epoch-1', 5));
    registry.setPrimary('B');
    registry.setPrimary('A');
    expect(registry.cursor('B').read()).toEqual(cursor('epoch-1', 5));
    registry.remove('B');
    expect(kindOf(() => registry.cursor('B'))).toBe('not_found');
    registry.add(b);
    expect(registry.cursor('B').read()).toBeNull();
  });
});
