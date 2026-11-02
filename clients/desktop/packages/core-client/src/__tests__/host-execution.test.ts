import { createInMemoryFramedPair } from '@canopy/core-transport';
import { WORKER_QUERY_DEFINITIONS } from '@canopy/protocol/canopy-core';

import { createCanopyClient } from '../index';
import { rejection } from './client-conformance';
import {
  canonicalInitializeResult,
  serveCanonicalCore,
} from './fixtures/canonical-core';

// CAN-5496: the client sends `_execution` only from its typed call option,
// only for an operation that accepts it, and never from params.
const execution = { childEnvironment: { PATH: '/forwarded/bin' } };
const branchParams = {
  scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
  repository: { kind: 'checkout' as const },
};

async function connect(): Promise<{
  client: Awaited<ReturnType<typeof createCanopyClient>>;
  requests: () => readonly { method: string; params: unknown }[];
}> {
  const { client: connection, server } = await createInMemoryFramedPair();
  const core = serveCanonicalCore(
    server,
    {
      'worker.git.branch.list': () => ({
        branches: [],
        defaultBranch: null,
        defaultBranchSource: null,
      }),
      'worker.filesystem.roots.list': () => ({ roots: [] }),
    },
    {
      initialize: canonicalInitializeResult({
        capabilities: {
          operations: [
            'worker.git.branch.list',
            'worker.filesystem.roots.list',
          ],
          events: [],
          streams: [],
        },
      }),
    },
  );
  const client = await createCanopyClient({
    connection,
    clientName: 'host-execution',
    clientVersion: '1.0.0',
    definitions: {
      queries: WORKER_QUERY_DEFINITIONS,
      instructions: {},
      streams: {},
    },
  });
  return {
    client,
    requests: () =>
      core.requests.filter(
        ({ method }) => method !== 'core.runtime.initialize',
      ),
  };
}

describe('createCanopyClient host execution', () => {
  it('sends the execution option as _execution beside _meta', async () => {
    const { client, requests } = await connect();
    await client.query('worker.git.branch.list', branchParams, {
      metadata: { traceparent: 'trace' },
      execution,
    });
    await client.query('worker.git.branch.list', branchParams);
    expect(requests().map(({ params }) => params)).toEqual([
      {
        ...branchParams,
        _meta: { traceparent: 'trace' },
        _execution: execution,
      },
      branchParams,
    ]);
    await client.close();
  });

  it('refuses execution for an operation that does not accept it, sending nothing', async () => {
    const { client, requests } = await connect();
    expect(
      await rejection(
        client.query(
          'worker.filesystem.roots.list',
          { scope: { workspaceId: 'workspace' } },
          { execution },
        ),
      ),
    ).toMatchObject({ kind: 'invalid_argument' });
    expect(requests()).toEqual([]);
    await client.close();
  });

  it('refuses _execution smuggled in params, even for an accepting operation', async () => {
    const { client, requests } = await connect();
    expect(
      await rejection(
        client.query('worker.git.branch.list', {
          ...branchParams,
          // Untyped callers (relayed params) reach the client too.
          ...({ _execution: execution } as object),
        }),
      ),
    ).toMatchObject({ kind: 'invalid_argument' });
    expect(requests()).toEqual([]);
    await client.close();
  });
});
