import {
  CANOPY_CLIENT_PROTOCOL_VERSIONS,
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
  type CanopyFramedConnection,
  type CanopyJsonRpcMessage,
  type CoreRuntimeInitializeResult,
} from '@canopy/core-client';
import { createInMemoryFramedPair } from '@canopy/core-transport';

import {
  CANONICAL_DEFINITIONS,
  serveCanonicalCore,
} from './fixtures/canonical-core';

describe('@canopy/core-client alias', () => {
  it('re-exports the binding contract and helpers, and initializes a live client', async () => {
    const { client, server } = await createInMemoryFramedPair();
    const connection: CanopyFramedConnection = client;
    const message: CanopyJsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'core.runtime.initialize',
      params: {},
    };
    await connection.send(message);
    expect(await server.receive()).toEqual(message);
    const core = serveCanonicalCore(server, {});
    const live = await createCanopyClient({
      connection,
      clientName: 'test',
      clientVersion: '0',
      definitions: CANONICAL_DEFINITIONS,
    });
    expect(live.identity.runtimeId).toBe('runtime-1');
    expect(core.requests.map((request) => request.method)).toEqual([
      'core.runtime.initialize',
    ]);
    expect(CANOPY_CLIENT_PROTOCOL_VERSIONS).toEqual([1]);
    expect(
      new CanopyClientError({
        kind: 'cancelled',
        message: 'c',
        retry: { kind: 'never' },
      }).toJSON().kind,
    ).toBe('cancelled');
    const profile: CoreRuntimeInitializeResult['runtime']['profile'] =
      'core+worker';
    const typed: Pick<CanopyClient, 'runtime' | 'identity'> | null = null;
    expect([profile, typed]).toEqual(['core+worker', null]);
    await live.close();
    await core.done;
  });
});
