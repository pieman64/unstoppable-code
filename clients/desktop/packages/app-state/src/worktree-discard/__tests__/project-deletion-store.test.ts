import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type { ProjectDeletionDiscardDescription } from '@canopy/protocol/portal/project-deletion-discard';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardResult,
} from '@canopy/protocol/portal/worktree-discard';
import type { ProjectDeletionDiscardOffer } from '../project-deletion-offer';
import { projectDeletionDiscardStoreFor } from '../project-deletion-store';

function item(
  worktreeId: string,
  confirmation = `token-${worktreeId}`,
): ProjectDeletionDiscardDescription['items'][number] {
  const description: WorktreeDiscardDescription = {
    version: 1,
    workspaceId: 'ws',
    worktreeId,
    createdAt: '2026-10-30T00:00:00.000Z',
    status: 'discardable',
    causes: ['source-gone'],
    sources: [],
    targets: [],
    alsoDeleted: [],
    preserved: ['branches'],
    mayRemain: [],
    confirmation,
  };
  return { worktreeName: `name-${worktreeId}`, description };
}

const DISCARDED: WorktreeDiscardResult = {
  status: 'discarded',
  removed: [],
  gitCleanup: [],
  warnings: ['left a ref'],
};

function description(
  items: ProjectDeletionDiscardDescription['items'],
  extra: Partial<ProjectDeletionDiscardDescription> = {},
): ProjectDeletionDiscardDescription {
  return {
    version: 1,
    workspaceId: 'ws',
    status: 'discardable',
    items,
    ...extra,
  };
}

function worktreeIdOf(args: unknown): string {
  return typeof args === 'object' &&
    args !== null &&
    'worktreeId' in args &&
    typeof args.worktreeId === 'string'
    ? args.worktreeId
    : '';
}

interface Call {
  readonly name: CommandName;
  readonly args: unknown;
}

/** `answer` answers every command and sees each call. */
function fakeClient(
  answer: (call: Call) => Promise<unknown>,
  extraCapabilities: Partial<CanopyCapabilities> = {},
): { client: CanopyClient; calls: Call[] } {
  const calls: Call[] = [];
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
    projectDeletionDiscard: true,
    ...extraCapabilities,
  };
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(name: CommandName, args: unknown): Promise<unknown> {
    const call = { name, args };
    calls.push(call);
    return answer(call);
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

function offer(
  extra: Omit<Partial<ProjectDeletionDiscardOffer>, 'retry' | 'onOpen'> = {},
): ProjectDeletionDiscardOffer & { retry: jest.Mock; onOpen: jest.Mock } {
  return {
    workspaceId: 'ws',
    projectName: 'Project',
    message: 'A source repository is unavailable.',
    ...extra,
    retry: jest.fn(),
    onOpen: jest.fn(),
  };
}

function discardCalls(calls: readonly Call[]): unknown[] {
  return calls
    .filter((call) => call.name === 'worktree.discard')
    .map((call) => call.args);
}

describe('CAN-5337 project deletion discard store', () => {
  it('opens one confirmation, discards each item with its own token after it, then runs the deletion again', async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(DISCARDED));
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({ description: description([item('a'), item('b')]) });

    await expect(store.getState().open(opened)).resolves.toBe(true);

    expect(opened.onOpen).toHaveBeenCalledTimes(1);
    // Nothing runs before the confirmation.
    expect(calls).toEqual([]);
    const reported: string[] = [];
    await store
      .getState()
      .confirm((discarded) => reported.push(discarded.worktreeId));

    expect(discardCalls(calls)).toEqual([
      { workspaceId: 'ws', worktreeId: 'a', confirmation: 'token-a' },
      { workspaceId: 'ws', worktreeId: 'b', confirmation: 'token-b' },
    ]);
    expect(reported).toEqual(['a', 'b']);
    expect(opened.retry).toHaveBeenCalledTimes(1);
    expect(store.getState().view.phase).toBe('closed');
  });

  it('reports each discard before the next one starts', async () => {
    const order: string[] = [];
    const { client } = fakeClient((call) => {
      if (call.name === 'worktree.discard')
        order.push(`discard:${worktreeIdOf(call.args)}`);
      return Promise.resolve(DISCARDED);
    });
    const store = projectDeletionDiscardStoreFor(client);
    await store
      .getState()
      .open(offer({ description: description([item('a'), item('b')]) }));
    await store
      .getState()
      .confirm((discarded) => order.push(`reported:${discarded.worktreeId}`));
    expect(order).toEqual([
      'discard:a',
      'reported:a',
      'discard:b',
      'reported:b',
    ]);
  });

  it('describes an offer without a description and stays closed when nothing can be discarded', async () => {
    const { client, calls } = fakeClient((call) =>
      call.name === 'workspace.delete.discard.describe'
        ? Promise.resolve(description([], { status: 'refused' }))
        : Promise.reject(new Error('unexpected')),
    );
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer();
    await expect(store.getState().open(opened)).resolves.toBe(false);
    expect(calls.map((call) => call.name)).toEqual([
      'workspace.delete.discard.describe',
    ]);
    expect(opened.onOpen).not.toHaveBeenCalled();
    expect(store.getState().view.phase).toBe('closed');
  });

  it('stays closed when the describe fails', async () => {
    const { client } = fakeClient(() => Promise.reject(new Error('offline')));
    const store = projectDeletionDiscardStoreFor(client);
    await expect(store.getState().open(offer())).resolves.toBe(false);
  });

  it('stops on a changed item with its fresh description, keeps earlier discards final, and continues from it on the next confirmation', async () => {
    const fresh = item('b', 'token-b2').description;
    let firstB = true;
    const { client, calls } = fakeClient((call) => {
      const worktreeId = worktreeIdOf(call.args);
      if (worktreeId === 'b' && firstB) {
        firstB = false;
        return Promise.resolve({
          status: 'refused',
          reason: 'changed',
          description: fresh,
        });
      }
      return Promise.resolve(DISCARDED);
    });
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({
      description: description([item('a'), item('b'), item('c')]),
    });
    await store.getState().open(opened);
    await store.getState().confirm(() => undefined);

    const stopped = store.getState().view;
    if (stopped.phase !== 'open') throw new Error('Expected the open view');
    expect(stopped.busy).toBe(false);
    expect(stopped.error).toEqual({ kind: 'changed', worktreeName: 'name-b' });
    expect(stopped.rows.map((row) => row.progress)).toEqual([
      'discarded',
      'stopped',
      'pending',
    ]);
    expect(stopped.rows[1].description).toBe(fresh);
    expect(opened.retry).not.toHaveBeenCalled();
    // Never automatic: the stop waits for another confirmation.
    expect(discardCalls(calls)).toHaveLength(2);

    await store.getState().confirm(() => undefined);
    expect(discardCalls(calls).slice(2)).toEqual([
      { workspaceId: 'ws', worktreeId: 'b', confirmation: 'token-b2' },
      { workspaceId: 'ws', worktreeId: 'c', confirmation: 'token-c' },
    ]);
    expect(opened.retry).toHaveBeenCalledTimes(1);
  });

  it('skips an item the ordinary deletion removes after all', async () => {
    const { client } = fakeClient((call) =>
      worktreeIdOf(call.args) === 'a'
        ? Promise.resolve({
            status: 'refused',
            reason: 'retry-available',
            description: item('a').description,
          })
        : Promise.resolve(DISCARDED),
    );
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({ description: description([item('a'), item('b')]) });
    await store.getState().open(opened);
    const reported: string[] = [];
    await store
      .getState()
      .confirm((discarded) => reported.push(discarded.worktreeId));
    expect(reported).toEqual(['b']);
    expect(opened.retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a busy refusal',
      (): Promise<unknown> =>
        Promise.resolve({
          status: 'refused',
          reason: 'busy',
          description: item('a').description,
        }),
      { kind: 'refused', worktreeName: 'name-a', reason: 'busy' },
    ],
    [
      'a transport failure',
      (): Promise<unknown> =>
        Promise.reject(
          new Error(
            "The desktop hasn't confirmed the discard. Check the worktree list before you try again.",
          ),
        ),
      {
        kind: 'failed',
        message:
          "The desktop hasn't confirmed the discard. Check the worktree list before you try again.",
      },
    ],
  ])('stops on %s with its reason', async (_label, answer, error) => {
    const { client } = fakeClient(answer);
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({ description: description([item('a'), item('b')]) });
    await store.getState().open(opened);
    await store.getState().confirm(() => undefined);
    const view = store.getState().view;
    if (view.phase !== 'open') throw new Error('Expected the open view');
    expect(view.error).toEqual(error);
    expect(view.rows.map((row) => row.progress)).toEqual([
      'stopped',
      'pending',
    ]);
    expect(opened.retry).not.toHaveBeenCalled();
  });

  it('supersedes a listed interrupted deletion before any discard', async () => {
    const { client, calls } = fakeClient((call) =>
      call.name === 'workspace.delete'
        ? Promise.reject(new Error('A source repository is unavailable.'))
        : Promise.resolve(DISCARDED),
    );
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({
      description: description([item('a')], {
        interruptedDeletion: { operationId: 'op-1' },
      }),
    });
    await store.getState().open(opened);
    await store.getState().confirm(() => undefined);
    expect(calls.map((call) => call.name)).toEqual([
      'workspace.delete',
      'worktree.discard',
    ]);
    expect(calls[0].args).toEqual({
      workspaceId: 'ws',
      supersedeInterruptedDeletion: 'op-1',
    });
    expect(opened.retry).toHaveBeenCalledTimes(1);
  });

  it('supersedes again on the next confirmation when a discard still meets the interrupted deletion', async () => {
    let reachable = false;
    const { client, calls } = fakeClient((call) => {
      if (call.name === 'workspace.delete')
        return Promise.reject(
          new Error(reachable ? 'A source is unavailable.' : 'Offline'),
        );
      return Promise.resolve(
        reachable
          ? DISCARDED
          : {
              status: 'refused',
              reason: 'project-deletion-pending',
              description: { ...item('a').description, status: 'refused' },
            },
      );
    });
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({
      description: description([item('a')], {
        interruptedDeletion: { operationId: 'op-1' },
      }),
    });
    await store.getState().open(opened);
    await store.getState().confirm(() => undefined);
    const stopped = store.getState().view;
    if (stopped.phase !== 'open') throw new Error('Expected the open view');
    expect(stopped.superseded).toBe(false);
    expect(stopped.error).toEqual({
      kind: 'refused',
      worktreeName: 'name-a',
      reason: 'project-deletion-pending',
    });
    // The confirmed description, and its token, still stand.
    expect(stopped.rows[0].description.status).toBe('discardable');

    reachable = true;
    await store.getState().confirm(() => undefined);
    expect(calls.map((call) => call.name)).toEqual([
      'workspace.delete',
      'worktree.discard',
      'workspace.delete',
      'worktree.discard',
    ]);
    expect(discardCalls(calls)[1]).toMatchObject({ confirmation: 'token-a' });
    expect(opened.retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['opens a new confirmation for what newly blocks it', true],
    ['shows its refusal when nothing new is listed', false],
  ])(
    'describes again when superseding with nothing listed is refused: %s',
    async (_label, newlyBlocked) => {
      const { client, calls } = fakeClient((call) => {
        if (call.name === 'workspace.delete')
          return Promise.reject(new Error('A source is unavailable.'));
        return Promise.resolve(
          newlyBlocked
            ? description([item('b')])
            : description([], { interruptedDeletion: { operationId: 'op-1' } }),
        );
      });
      const store = projectDeletionDiscardStoreFor(client);
      const opened = offer({
        description: description([], {
          interruptedDeletion: { operationId: 'op-1' },
        }),
      });
      await store.getState().open(opened);
      await store.getState().confirm(() => undefined);
      expect(calls.map((call) => call.name)).toEqual([
        'workspace.delete',
        'workspace.delete.discard.describe',
      ]);
      const view = store.getState().view;
      if (view.phase !== 'open') throw new Error('Expected the open view');
      expect(view.busy).toBe(false);
      if (newlyBlocked) {
        expect(view.rows.map((row) => row.worktreeId)).toEqual(['b']);
        expect(view.error).toBe(null);
      } else
        expect(view.error).toEqual({
          kind: 'failed',
          message: 'A source is unavailable.',
        });
      // Nothing is discarded without a confirmation.
      expect(discardCalls(calls)).toEqual([]);
      expect(opened.retry).not.toHaveBeenCalled();
    },
  );

  it('finishes when superseding the interrupted deletion deletes the project', async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(undefined));
    const store = projectDeletionDiscardStoreFor(client);
    const onDeleted = jest.fn();
    const opened = offer({
      description: description([], {
        interruptedDeletion: { operationId: 'op-1' },
      }),
      onDeleted,
    });
    await expect(store.getState().open(opened)).resolves.toBe(true);
    await store.getState().confirm(() => undefined);
    expect(calls.map((call) => call.name)).toEqual(['workspace.delete']);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(opened.retry).not.toHaveBeenCalled();
    expect(store.getState().view.phase).toBe('closed');
  });

  it('a fresh confirmation after the deletion runs again names the earlier discards as final', async () => {
    const { client } = fakeClient(() => Promise.resolve(DISCARDED));
    const store = projectDeletionDiscardStoreFor(client);
    await store
      .getState()
      .open(offer({ description: description([item('a')]) }));
    await store.getState().confirm(() => undefined);
    // The re-run deletion refused for an item that newly failed.
    await store
      .getState()
      .open(offer({ description: description([item('b')]) }));
    const view = store.getState().view;
    if (view.phase !== 'open') throw new Error('Expected the open view');
    expect(view.earlierDiscarded).toEqual(['name-a']);
    expect(view.rows.map((row) => row.worktreeId)).toEqual(['b']);
    // Closing forgets them.
    store.getState().close();
    await store
      .getState()
      .open(offer({ description: description([item('b')]) }));
    const reopened = store.getState().view;
    if (reopened.phase !== 'open') throw new Error('Expected the open view');
    expect(reopened.earlierDiscarded).toEqual([]);
  });

  it('discards one item at a time under the same confirmation, then runs the deletion once none is left', async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(DISCARDED));
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({
      description: description([item('a'), item('b'), item('c')]),
    });
    await store.getState().open(opened);
    const reported: string[] = [];
    const report = (discarded: { worktreeId: string }): void => {
      reported.push(discarded.worktreeId);
    };

    await store.getState().discardItem('b', report);
    expect(discardCalls(calls)).toEqual([
      { workspaceId: 'ws', worktreeId: 'b', confirmation: 'token-b' },
    ]);
    expect(reported).toEqual(['b']);
    const afterOne = store.getState().view;
    if (afterOne.phase !== 'open') throw new Error('Expected the open view');
    expect(afterOne.busy).toBe(false);
    expect(afterOne.rows.map((row) => row.progress)).toEqual([
      'pending',
      'discarded',
      'pending',
    ]);
    expect(opened.retry).not.toHaveBeenCalled();

    // A finished row is not discarded twice.
    await store.getState().discardItem('b', report);
    expect(discardCalls(calls)).toHaveLength(1);

    await store.getState().discardItem('a', report);
    expect(opened.retry).not.toHaveBeenCalled();
    expect(store.getState().view.phase).toBe('open');
    await store.getState().discardItem('c', report);
    expect(reported).toEqual(['b', 'a', 'c']);
    expect(opened.retry).toHaveBeenCalledTimes(1);
    expect(store.getState().view.phase).toBe('closed');
  });

  it('confirming after a one-at-a-time discard takes only what remains', async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(DISCARDED));
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({ description: description([item('a'), item('b')]) });
    await store.getState().open(opened);
    await store.getState().discardItem('a', () => undefined);
    await store.getState().confirm(() => undefined);
    expect(discardCalls(calls).map(worktreeIdOf)).toEqual(['a', 'b']);
    expect(opened.retry).toHaveBeenCalledTimes(1);
  });

  it('a one-at-a-time discard stops on its changed item and leaves the rest listed', async () => {
    const fresh = item('a', 'token-a2').description;
    const { client } = fakeClient(() =>
      Promise.resolve({
        status: 'refused',
        reason: 'changed',
        description: fresh,
      }),
    );
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({ description: description([item('a'), item('b')]) });
    await store.getState().open(opened);
    await store.getState().discardItem('a', () => undefined);
    const view = store.getState().view;
    if (view.phase !== 'open') throw new Error('Expected the open view');
    expect(view.busy).toBe(false);
    expect(view.error).toEqual({ kind: 'changed', worktreeName: 'name-a' });
    expect(view.rows.map((row) => row.progress)).toEqual([
      'stopped',
      'pending',
    ]);
    expect(view.rows[0].description).toBe(fresh);
    expect(opened.retry).not.toHaveBeenCalled();
  });

  it('a one-at-a-time discard supersedes a listed interrupted deletion first, once', async () => {
    const { client, calls } = fakeClient((call) =>
      call.name === 'workspace.delete'
        ? Promise.reject(new Error('A source repository is unavailable.'))
        : Promise.resolve(DISCARDED),
    );
    const store = projectDeletionDiscardStoreFor(client);
    const opened = offer({
      description: description([item('a'), item('b')], {
        interruptedDeletion: { operationId: 'op-1' },
      }),
    });
    await store.getState().open(opened);
    await store.getState().discardItem('a', () => undefined);
    await store.getState().discardItem('b', () => undefined);
    expect(calls.map((call) => call.name)).toEqual([
      'workspace.delete',
      'worktree.discard',
      'worktree.discard',
    ]);
    expect(opened.retry).toHaveBeenCalledTimes(1);
  });

  it('cannot be closed or re-confirmed while the run is going', async () => {
    let finish: (result: WorktreeDiscardResult) => void = () => undefined;
    const { client, calls } = fakeClient(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const store = projectDeletionDiscardStoreFor(client);
    await store
      .getState()
      .open(offer({ description: description([item('a')]) }));
    const run = store.getState().confirm(() => undefined);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    store.getState().close();
    void store.getState().confirm(() => undefined);
    void store.getState().discardItem('a', () => undefined);
    expect(store.getState().view.phase).toBe('open');
    expect(discardCalls(calls)).toHaveLength(1);
    finish(DISCARDED);
    await run;
    expect(store.getState().view.phase).toBe('closed');
  });
});

describe('CAN-5338 project deletion discard store, retained archives', () => {
  it('describes with the opt-in and discards a listed archive with it, reporting it as an archive', async () => {
    const archived = item('archived');
    const retained: ProjectDeletionDiscardDescription['items'][number] = {
      worktreeName: 'Archived worktree',
      description: {
        ...archived.description,
        targets: [
          {
            kind: 'retained-archive',
            path: '/data/ws/archived-containers/archived',
            identity: '1:2:3',
            identityVerified: false,
            reason: 'source-gone',
          },
        ],
      },
    };
    const { client, calls } = fakeClient((call) =>
      call.name === 'workspace.delete.discard.describe'
        ? Promise.resolve(description([item('a'), retained]))
        : Promise.resolve(DISCARDED),
    );
    const store = projectDeletionDiscardStoreFor(client);
    await expect(store.getState().open(offer())).resolves.toBe(true);
    const reported: { worktreeId: string; retainedArchive?: true }[] = [];
    await store.getState().confirm(({ worktreeId, retainedArchive }) =>
      reported.push({
        worktreeId,
        ...(retainedArchive ? { retainedArchive } : {}),
      }),
    );

    expect(calls[0]).toEqual({
      name: 'workspace.delete.discard.describe',
      args: { workspaceId: 'ws', retainedArchives: true },
    });
    expect(discardCalls(calls)).toEqual([
      { workspaceId: 'ws', worktreeId: 'a', confirmation: 'token-a' },
      {
        workspaceId: 'ws',
        worktreeId: 'archived',
        confirmation: 'token-archived',
        retainedArchives: true,
      },
    ]);
    expect(reported).toEqual([
      { worktreeId: 'a' },
      { worktreeId: 'archived', retainedArchive: true },
    ]);
  });
});
