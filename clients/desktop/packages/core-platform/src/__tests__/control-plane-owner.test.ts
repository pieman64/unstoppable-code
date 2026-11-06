import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCanopyClient } from '@canopy/core-client/node';
import {
  createCanopyFramedConnection,
  createCanopyOwnerProof,
} from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CANOPY_RUNTIME_QUERY_DEFINITIONS,
  createCanopyDispatcher,
  createCanopyRuntime,
  type CanopyDispatcher,
  type CanopyRuntime,
  type CanopyRuntimeQueries,
  type CanopyRuntimeStreams,
  type PlatformEndpointListener,
  type PlatformUnixSocketAddress,
} from '@canopy/core-runtime';
import {
  createCanopyOwnerProofVerifier,
  serveCanopyDaemonControlPlane,
  type CanopyControlConnectionIdentity,
  type CanopyOwnerProofVerifier,
} from '@canopy/core-runtime/node';
import { decodeCanopyError } from '@canopy/protocol/canopy-core';
import { createPlatformEndpointServices } from '@canopy/core-platform';

const posix = process.platform === 'win32' ? describe.skip : describe;
const AUTH = { secret: 'socket-secret', dataRootHash: '0'.repeat(64) };
const DEFINITIONS = {
  queries: CANOPY_RUNTIME_QUERY_DEFINITIONS,
  instructions: {},
  streams: {},
};

let directory = '';
let sockets = 0;
const teardown: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'owner-')));
});
afterEach(async () => {
  for (const step of teardown.splice(0).reverse())
    await step().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});

async function bindListener(): Promise<
  PlatformEndpointListener<PlatformUnixSocketAddress>
> {
  const endpoints = createPlatformEndpointServices(
    process.platform === 'darwin' ? 'darwin' : 'linux',
  );
  if (endpoints.semantics !== 'filesystem-socket')
    throw new Error('Unix sockets required.');
  const bound = await endpoints.bind({
    kind: 'unix-socket',
    path: join(directory, `${(sockets += 1)}.sock`),
  });
  if (bound.kind !== 'bound') throw new Error('Socket in use.');
  teardown.push(() => bound.listener.close());
  return bound.listener;
}

type Kernel = CanopyRuntime<
  CanopyDispatcher<
    CanopyRuntimeQueries,
    Record<never, never>,
    CanopyRuntimeStreams
  >
>;

async function startedKernel(): Promise<Kernel> {
  const runtime = createCanopyRuntime({
    profile: 'core',
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    definitions: { queries: {}, instructions: {}, streams: {} },
    owners: [],
    services: [],
    principalFor: () => 'interface',
    phaseDeadlineMs: 1_000,
    createDispatcher: (input) =>
      createCanopyDispatcher({
        profile: input.profile,
        definitions: input.definitions,
        handlers: { ...input.runtimeHandlers, instructions: {} },
      }),
  });
  await runtime.start();
  teardown.push(() => runtime.shutdown('test'));
  return runtime;
}

async function controlPlane(ownerProof?: CanopyOwnerProofVerifier): Promise<{
  path: string;
  identities: CanopyControlConnectionIdentity[];
}> {
  const listener = await bindListener();
  const runtime = await startedKernel();
  const identities: CanopyControlConnectionIdentity[] = [];
  const plane = serveCanopyDaemonControlPlane({
    binding: { listener, auth: AUTH },
    dispatcher: runtime.dispatcher,
    operations: runtime.operations,
    callerFor: (identity) => {
      identities.push(identity);
      return {
        principalId: 'local-user',
        clientInstanceId:
          identity.lease?.clientInstanceId ?? identity.connectionId,
        authorityId: 'local',
        interfaceKind: 'test',
        grants: ['core.runtime.read', 'core.client.manage'],
      };
    },
    ...(ownerProof && { ownerProof }),
    buildVersion: '0.0.0-test',
    idleGrace: { graceMs: 30_000 },
    onIdle: () => undefined,
  });
  teardown.push(() => plane.close());
  return { path: listener.address.path, identities };
}

function client(
  path: string,
  ownerProof?: (connectionId: string) => string,
): ReturnType<
  typeof connectCanopyClient<typeof CANOPY_RUNTIME_QUERY_DEFINITIONS>
> {
  const connecting = connectCanopyClient({
    endpoint: { kind: 'socket', path, auth: AUTH },
    clientName: 'owner-test',
    clientVersion: '0',
    definitions: DEFINITIONS,
    ...(ownerProof && { ownerProof }),
  });
  void connecting.then(
    (connected) => teardown.push(() => connected.close()),
    () => undefined,
  );
  return connecting;
}

/** A raw framed connection, for initialize params a client never sends. */
async function rawConnection(path: string): Promise<CanopyFramedConnection> {
  const wire = createConnection(path);
  teardown.push(() => Promise.resolve(wire.destroy()));
  return createCanopyFramedConnection(wire, {
    role: 'client',
    auth: AUTH,
    handshakeTimeoutMs: 2_000,
  });
}

async function initializeWith(
  connection: CanopyFramedConnection,
  ownerProof: unknown,
): Promise<ReturnType<typeof decodeCanopyError> | null> {
  await connection.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'core.runtime.initialize',
    params: {
      client: {
        name: 'raw',
        version: '0',
        protocolVersions: [1],
        capabilities: [],
        ownerProof,
      },
    },
  });
  const response = await connection.receive();
  if (!('id' in response) || 'method' in response)
    throw new Error('Expected a response.');
  return 'error' in response ? decodeCanopyError(response.error) : null;
}

async function closed(connection: CanopyFramedConnection): Promise<boolean> {
  await connection.receive().catch(() => undefined);
  return connection.signal.aborted;
}

const REFUSED = {
  kind: 'unauthenticated',
  message: 'The owner proof was refused.',
};

posix('daemon owner proof (CAN-5771)', () => {
  const secret = randomBytes(32);
  const verifier = (): CanopyOwnerProofVerifier =>
    createCanopyOwnerProofVerifier({
      secret,
      dataRootHash: AUTH.dataRootHash,
    });
  const prove = (connectionId: string): string =>
    createCanopyOwnerProof(secret, connectionId, AUTH.dataRootHash);

  it('a connection that proves the owner secret is an owner for its life', async () => {
    const daemon = await controlPlane(verifier());
    let ownerConnection = '';
    const owner = await client(daemon.path, (id) => {
      ownerConnection = id;
      return prove(id);
    });
    await owner.query('core.runtime.health.get', {});
    const ownerIdentities = daemon.identities.filter(
      (identity) => identity.connectionId === ownerConnection,
    );
    expect(ownerIdentities.length).toBeGreaterThanOrEqual(2);
    expect(ownerIdentities.every((identity) => identity.owner)).toBe(true);

    const peer = await client(daemon.path);
    await peer.query('core.runtime.health.get', {});
    const peerIdentities = daemon.identities.filter(
      (identity) => identity.connectionId !== ownerConnection,
    );
    expect(peerIdentities.length).toBeGreaterThan(0);
    expect(peerIdentities.every((identity) => !identity.owner)).toBe(true);
  });

  it('a wrong owner proof is refused and closes the connection', async () => {
    const daemon = await controlPlane(verifier());
    const other = randomBytes(32);
    await expect(
      client(daemon.path, (id) =>
        createCanopyOwnerProof(other, id, AUTH.dataRootHash),
      ),
    ).rejects.toMatchObject({ payload: REFUSED });
    expect(daemon.identities.some((identity) => identity.owner)).toBe(false);

    const raw = await rawConnection(daemon.path);
    const refusal = await initializeWith(
      raw,
      createCanopyOwnerProof(other, raw.connectionId, AUTH.dataRootHash),
    );
    expect(refusal).toMatchObject(REFUSED);
    expect(await closed(raw)).toBe(true);
    expect(daemon.identities.some((identity) => identity.owner)).toBe(false);
  });

  it('a proof made for another connection is refused', async () => {
    const daemon = await controlPlane(verifier());
    let replayed = '';
    await client(daemon.path, (id) => (replayed = prove(id)));
    const raw = await rawConnection(daemon.path);
    expect(await initializeWith(raw, replayed)).toMatchObject(REFUSED);
    expect(await closed(raw)).toBe(true);
    expect(
      daemon.identities.some(
        (identity) =>
          identity.connectionId === raw.connectionId && identity.owner,
      ),
    ).toBe(false);
  });

  it('a daemon without an owner secret refuses every proof', async () => {
    const daemon = await controlPlane();
    await expect(client(daemon.path, prove)).rejects.toMatchObject({
      payload: REFUSED,
    });
    const peer = await client(daemon.path);
    await expect(
      peer.query('core.runtime.health.get', {}),
    ).resolves.toBeTruthy();
    expect(daemon.identities.some((identity) => identity.owner)).toBe(false);
  });

  it('a proof that is not a string is refused', async () => {
    const daemon = await controlPlane(verifier());
    const raw = await rawConnection(daemon.path);
    expect(await initializeWith(raw, 42)).toMatchObject(REFUSED);
    expect(await closed(raw)).toBe(true);
  });
});
