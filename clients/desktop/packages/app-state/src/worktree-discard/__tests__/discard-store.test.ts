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
