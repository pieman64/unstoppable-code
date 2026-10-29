import { rejection } from '../../__tests__/client-conformance';
import {
  CANONICAL_DEFINITIONS,
  serveCanonicalCore,
} from '../../__tests__/fixtures/canonical-core';
import type { CanopyClient } from '../../types';
import { attachOrStartCanopyDaemon, connectCanopyClient } from '../index';
import { descriptorFor, ScriptedDaemon } from './fixtures/scripted-daemon';
import {
  listenSocketPeer,
  PEER_AUTH,
  type SocketPeer,
} from './fixtures/socket-peer';

type D = typeof CANONICAL_DEFINITIONS;
type Client = CanopyClient<D['queries'], D['instructions'], D['streams']>;

// Scripted discovery and claim ports; attach is a real socket or pipe connect.
let peer: SocketPeer;
let world: ScriptedDaemon;
beforeEach(async () => {
  peer = await listenSocketPeer();
  world = new ScriptedDaemon();
  world.publish(700);
  const endpoint = { kind: peer.kind, path: peer.path };
  world.raw = { ...descriptorFor(700), endpoint };
});
afterEach(() => peer.close());

const launch = (
  dataRootHash: string,
): ReturnType<typeof attachOrStartCanopyDaemon<Client>> =>
  attachOrStartCanopyDaemon({
    dataRoot: '/private/data',
    dataRootHash,
    runtimeMode: 'production',
    daemon: { executable: '/private/bin/canopy' },
    ports: {
      supervisor: world.supervisor,
      claim: world.claim,
      descriptor: {
        read: (signal) => world.descriptor.read(signal),
        readToken: () => Promise.resolve(PEER_AUTH.secret),
      },
    },
    attach: (endpoint, { timeoutMs, signal }) =>
      connectCanopyClient({
        endpoint,
        timeoutMs,
        signal,
        clientName: 'launcher-socket',
        clientVersion: '1.0.0',
        definitions: CANONICAL_DEFINITIONS,
      }),
    dispose: (client) => client.close(),
    timeoutMs: 2_000,
  });

it('attaches to a live descriptor through auth and initialize without starting a core', async () => {
  const launching = launch(PEER_AUTH.dataRootHash);
  const server = await peer.next();
  const echo = { text: 'live', length: 4 };
  const core = serveCanonicalCore(server, { 'core.test.echo': () => echo });
  const { value: client, descriptor, started } = await launching;
  expect([started, descriptor.endpoint.path]).toEqual([false, peer.path]);
  expect(world.events).toEqual(['read', 'inspect:700']);
  expect(client.identity.connectionId).toBe(server.connectionId);
  expect(await client.query('core.test.echo', { text: 'live' })).toEqual(echo);
  await client.close();
  await expect(core.done).resolves.toBeUndefined();
  expect(await peer.allClosed()).toBe(true);
});

it('fails closed when the live core serves a different data root', async () => {
  const payload = await rejection(launch('b'.repeat(64)));
  expect(payload).toMatchObject({ kind: 'failed_precondition' });
  for (const leak of [peer.path, PEER_AUTH.secret])
    expect(JSON.stringify(payload)).not.toContain(leak);
  expect(world.events).toEqual(['read', 'inspect:700']);
  expect(peer.accepted).toHaveLength(1);
  expect(await peer.allClosed()).toBe(true);
});
