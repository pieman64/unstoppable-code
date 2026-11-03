import {
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../dispatcher';
import { createInProcessCanopyClient } from '../in-process-client';

const caller: CanopyCallerDescriptor = {
  principalId: 'bound-user',
  clientInstanceId: 'bound-client',
  authorityId: 'bound-authority',
  interfaceKind: 'test',
  grants: ['worker.filesystem.read'],
};

const params = {
  scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
};

describe('createInProcessCanopyClient', () => {
  it('binds trusted caller data outside params and matches direct dispatch', async () => {
    const seenCallers: CanopyCallerDescriptor[] = [];
    const dispatcher = createCanopyDispatcher({
      profile: 'worker',
      definitions: WORKER_QUERY_DEFINITIONS,
      handlers: {
        'worker.filesystem.roots.list': (_query, context) => {
          seenCallers.push(context.caller);
          return { roots: [] };
        },
        'worker.filesystem.directory.list': () => ({ entries: [] }),
        'worker.filesystem.file.read': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.search': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.link.resolve': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.branch.list': () => ({
          branches: [],
          defaultBranch: null,
          defaultBranchSource: null,
        }),
        'worker.git.executable.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.remote.get': () => ({
          origin: { state: 'absent' as const },
        }),
        'worker.git.worktree.health.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.diff.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.list': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.pipeline.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
      },
    });
    const client = createInProcessCanopyClient(dispatcher, caller);

    const direct = await dispatcher.query(
      'worker.filesystem.roots.list',
      structuredClone(params),
      { caller: structuredClone(caller) },
    );
    const inProcess = await client.query(
      'worker.filesystem.roots.list',
      structuredClone(params),
    );

    expect(JSON.parse(JSON.stringify(inProcess))).toEqual(
      JSON.parse(JSON.stringify(direct)),
    );
    expect(seenCallers).toEqual([caller, caller]);
  });

  it('does not retry failed operations', async () => {
    const roots = jest.fn(() => {
      throw new Error('transient-looking failure');
    });
    const dispatcher = createCanopyDispatcher({
      profile: 'worker',
      definitions: WORKER_QUERY_DEFINITIONS,
      handlers: {
        'worker.filesystem.roots.list': roots,
        'worker.filesystem.directory.list': () => ({ entries: [] }),
        'worker.filesystem.file.read': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.search': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.link.resolve': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.branch.list': () => ({
          branches: [],
          defaultBranch: null,
          defaultBranchSource: null,
        }),
        'worker.git.executable.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.remote.get': () => ({
          origin: { state: 'absent' as const },
        }),
        'worker.git.worktree.health.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.diff.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.list': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.pipeline.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
      },
    });
    const client = createInProcessCanopyClient(dispatcher, caller);

    await expect(
      client.query('worker.filesystem.roots.list', params),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(roots).toHaveBeenCalledTimes(1);
  });

  it('preserves a worker operation name through a synthetic forwarding route', async () => {
    const roots = jest.fn(() => ({ roots: [] }));
    const dispatcher = createCanopyDispatcher({
      profile: 'worker',
      definitions: WORKER_QUERY_DEFINITIONS,
      handlers: {
        'worker.filesystem.roots.list': roots,
        'worker.filesystem.directory.list': () => ({ entries: [] }),
        'worker.filesystem.file.read': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.search': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.link.resolve': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.branch.list': () => ({
          branches: [],
          defaultBranch: null,
          defaultBranchSource: null,
        }),
        'worker.git.executable.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.remote.get': () => ({
          origin: { state: 'absent' as const },
        }),
        'worker.git.worktree.health.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.diff.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.list': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.pipeline.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
      },
    });
    const forwardedNames: string[] = [];
    const forward = (name: string): Promise<unknown> => {
      forwardedNames.push(name);
      // @ts-expect-error The forwarding test intentionally accepts runtime names.
      return dispatcher.query(name, params, { caller });
    };

    await expect(forward('worker.filesystem.roots.list')).resolves.toEqual({
      roots: [],
    });
    expect(forwardedNames).toEqual(['worker.filesystem.roots.list']);
    expect(roots).toHaveBeenCalledTimes(1);

    await expect(forward('core.filesystem.roots.list')).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
    expect(roots).toHaveBeenCalledTimes(1);
  });

  it('strictly rejects caller-like fields embedded in JSON-round-tripped params', async () => {
    const roots = jest.fn(() => ({ roots: [] }));
    const dispatcher = createCanopyDispatcher({
      profile: 'worker',
      definitions: WORKER_QUERY_DEFINITIONS,
      handlers: {
        'worker.filesystem.roots.list': roots,
        'worker.filesystem.directory.list': () => ({ entries: [] }),
        'worker.filesystem.file.read': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.search': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.link.resolve': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.branch.list': () => ({
          branches: [],
          defaultBranch: null,
          defaultBranchSource: null,
        }),
        'worker.git.executable.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.remote.get': () => ({
          origin: { state: 'absent' as const },
        }),
        'worker.git.worktree.health.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.diff.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.list': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.pipeline.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
      },
    });
    const client = createInProcessCanopyClient(dispatcher, caller);
    const spoofed: unknown = JSON.parse(
      JSON.stringify({
        ...params,
        grants: ['worker.filesystem.admin'],
        authorityId: 'spoofed',
      }),
    );

    await expect(
      // @ts-expect-error JSON input is intentionally unknown at compile time.
      client.query('worker.filesystem.roots.list', spoofed),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(roots).not.toHaveBeenCalled();
  });
});
