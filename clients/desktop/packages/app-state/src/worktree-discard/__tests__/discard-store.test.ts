import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardResult,
} from '@canopy/protocol/portal/worktree-discard';
import type { WorktreeDiscardOffer } from '../discard-offer';
import {
  worktreeDiscardStoreFor,
  worktreeRemovalRetryable,
} from '../discard-store';

const DISCARDABLE: WorktreeDiscardDescription = {
  version: 1,
  workspaceId: 'ws',
  worktreeId: 'wt',
  createdAt: '2026-10-30T00:00:00.000Z',
  status: 'discardable',
  causes: ['source-gone'],
  sources: [{ repoId: 'a', path: '/repos/a', state: 'gone-absent' }],
  targets: [],
  alsoDeleted: [],
  preserved: ['branches'],
  mayRemain: [],
  confirmation: 'token-1',
};

function clientWithDiscard(discard: Promise<WorktreeDiscardResult>): {
  client: CanopyClient;
  calls: CommandName[];
} {
  const calls: CommandName[] = [];
  const capabilities: CanopyCapabilities = {
    localExecution: true,
    terminalPty: false,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'read-only',
    routing: 'url',
    overviewNotifications: true,
    worktreeDiscard: true,
  };
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(name: CommandName, args: unknown): Promise<unknown> {
    void args;
    calls.push(name);
    if (name === 'worktree.discard') return discard;
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  }
  const client: CanopyClient = {
    capabilities,
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      void args;
      return Promise.reject(new Error(`Unexpected query: ${name}`));
    },
    command,
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
  return { client, calls };
}

function offer(worktreeId: string): WorktreeDiscardOffer {
  return {
    workspaceId: 'ws',
    worktreeId,
    worktreeName: worktreeId,
    message: 'refused',
    description: { ...DISCARDABLE, worktreeId },
    retry: jest.fn(),
  };
}

describe('worktree discard store (CAN-5336)', () => {
  it('keeps a running discard and reports it when another offer arrives meanwhile', async () => {
    let finish: (result: WorktreeDiscardResult) => void = () => undefined;
    const pending = new Promise<WorktreeDiscardResult>((resolve) => {
      finish = resolve;
    });
    const { client } = clientWithDiscard(pending);
    const store = worktreeDiscardStoreFor(client);
    await expect(store.getState().open(offer('first'))).resolves.toBe(true);
    const running = store.getState().discard();
    expect(store.getState().view).toMatchObject({ phase: 'open', busy: true });

    // The later refusal shows only its message; the running dialog stays.
    await expect(store.getState().open(offer('second'))).resolves.toBe(false);
    expect(store.getState().view).toMatchObject({
      phase: 'open',
      busy: true,
      offer: { worktreeId: 'first' },
    });

    finish({
      status: 'discarded',
      removed: [],
      gitCleanup: [],
      warnings: ['kept'],
    });
    // The host still reconciles the list for a discard that ran.
    await expect(running).resolves.toEqual({ warnings: ['kept'] });
    expect(store.getState().view).toEqual({ phase: 'closed' });
  });

  it('reports the temporary project a discard left empty, so the host can drop it', async () => {
    const { client } = clientWithDiscard(
      Promise.resolve({
        status: 'discarded',
        removed: ['live-checkout'],
        gitCleanup: [],
        warnings: [],
        removedTemporaryWorkspaceId: 'ws',
      }),
    );
    const store = worktreeDiscardStoreFor(client);
    await store.getState().open(offer('last'));
    await expect(store.getState().discard()).resolves.toEqual({
      warnings: [],
      removedTemporaryWorkspaceId: 'ws',
    });
  });

  it.each<NonNullable<WorktreeDiscardDescription['refusal']>>([
    { reason: 'retry-available', retry: 'delete-project' },
    { reason: 'project-deletion-pending' },
  ])(
    'never replays the worktree removal when the refusal points at project deletion (%o)',
    async (refusal) => {
      const { client } = clientWithDiscard(
        Promise.resolve({
          status: 'refused',
          reason: refusal.reason,
          description: {
            ...DISCARDABLE,
            worktreeId: 'child',
            status: 'refused',
            causes: [],
            refusal,
          },
        }),
      );
      const store = worktreeDiscardStoreFor(client);
      const offered = offer('child');
      await store.getState().open(offered);
      await expect(store.getState().discard()).resolves.toBeNull();
      expect(worktreeRemovalRetryable(store.getState().view)).toBe(false);

      store.getState().retry();
      expect(offered.retry).not.toHaveBeenCalled();
      expect(store.getState().view).toMatchObject({
        phase: 'open',
        error: { kind: 'refused', reason: refusal.reason },
      });

      // Cancel still closes; the next opening may retry again.
      store.getState().close();
      await store.getState().open(offer('next'));
      expect(worktreeRemovalRetryable(store.getState().view)).toBe(true);
    },
  );
});

describe('worktree discard store, retained archives (CAN-5338)', () => {
  const RETAINED: WorktreeDiscardDescription = {
    ...DISCARDABLE,
    worktreeId: 'archived',
    targets: [
      {
        kind: 'retained-archive',
        path: '/data/a/archived-containers/archived',
        identity: '1:2:3',
        identityVerified: false,
        reason: 'source-gone',
      },
    ],
  };

  function recordingClient(described: WorktreeDiscardDescription): {
    client: CanopyClient;
    calls: { name: CommandName; args: unknown }[];
  } {
    const calls: { name: CommandName; args: unknown }[] = [];
    const { client } = clientWithDiscard(Promise.resolve(DISCARDED));
    function command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']>;
    function command(name: CommandName, args: unknown): Promise<unknown> {
      calls.push({ name, args });
      if (name === 'worktree.discard.describe')
        return Promise.resolve(described);
      if (name === 'worktree.discard') return Promise.resolve(DISCARDED);
      return Promise.reject(new Error(`Unexpected command: ${name}`));
    }
    return { client: { ...client, command }, calls };
  }

  const DISCARDED: WorktreeDiscardResult = {
    status: 'discarded',
    removed: ['retained-archive'],
    gitCleanup: [],
    warnings: [],
  };

  it('describes a retained offer with the opt-in, discards with it, and reports the archive', async () => {
    const { client, calls } = recordingClient(RETAINED);
    const store = worktreeDiscardStoreFor(client);
    await expect(
      store.getState().open({
        workspaceId: 'ws',
        worktreeId: 'archived',
        worktreeName: 'Archived',
        message: "Couldn't permanently delete this item",
        retainedArchives: true,
        retry: jest.fn(),
      }),
    ).resolves.toBe(true);
    await expect(store.getState().discard()).resolves.toEqual({
      warnings: [],
      retainedArchive: true,
    });
    expect(calls).toEqual([
      {
        name: 'worktree.discard.describe',
        args: {
          workspaceId: 'ws',
          worktreeId: 'archived',
          retainedArchives: true,
        },
      },
      {
        name: 'worktree.discard',
        args: {
          workspaceId: 'ws',
          worktreeId: 'archived',
          confirmation: 'token-1',
          retainedArchives: true,
        },
      },
    ]);
  });

  it('sends no opt-in for an ordinary offer', async () => {
    const { client, calls } = recordingClient({
      ...DISCARDABLE,
      worktreeId: 'live',
    });
    const store = worktreeDiscardStoreFor(client);
    await store.getState().open({
      workspaceId: 'ws',
      worktreeId: 'live',
      worktreeName: 'live',
      message: 'refused',
      retry: jest.fn(),
    });
    await expect(store.getState().discard()).resolves.toEqual({
      warnings: [],
    });
    expect(calls.map((call) => call.args)).toEqual([
      { workspaceId: 'ws', worktreeId: 'live' },
      { workspaceId: 'ws', worktreeId: 'live', confirmation: 'token-1' },
    ]);
  });
});
