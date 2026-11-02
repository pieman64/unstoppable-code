/** @jest-environment jsdom */
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import {
  offerProjectDeletionDiscard,
  type ProjectDeletionDiscardOffer,
} from '@canopy/app-state';
import type { ProjectDeletionDiscardDescription } from '@canopy/protocol/portal/project-deletion-discard';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardResult,
} from '@canopy/protocol/portal/worktree-discard';
import { PROJECT_DELETION_DISCARD_DIALOG_TEST_ID } from '@canopy/ui-shared/components/ProjectDeletionDiscardDialog';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectDeletionDiscardHost } from '../ProjectDeletionDiscardHost';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function worktree(id: string): WorktreeDiscardDescription {
  return {
    version: 1,
    workspaceId: 'ws',
    worktreeId: id,
    createdAt: '2026-10-30T00:00:00.000Z',
    status: 'discardable',
    causes: ['source-gone'],
    sources: [{ repoId: 'a', path: '/repos/a', state: 'gone-absent' }],
    targets: [
      {
        kind: 'live-checkout',
        path: `/data/ws/worktrees/${id}`,
        identity: '1:2',
        identityVerified: false,
        reason: 'source-gone',
      },
    ],
    alsoDeleted: ['chats'],
    preserved: ['source-working-files', 'branches'],
    mayRemain: [],
    confirmation: `token-${id}`,
  };
}

const DISCARDABLE: ProjectDeletionDiscardDescription = {
  version: 1,
  workspaceId: 'ws',
  status: 'discardable',
  items: [
    { worktreeName: 'owl', description: worktree('one') },
    { worktreeName: 'lark', description: worktree('two') },
  ],
};

const DISCARDED: WorktreeDiscardResult = {
  status: 'discarded',
  removed: ['live-checkout'],
  gitCleanup: [],
  warnings: [],
};

interface Fake {
  readonly client: CanopyClient;
  readonly calls: Array<{ name: CommandName; args: unknown }>;
}

function fakeClient(
  describe: ProjectDeletionDiscardDescription,
  capabilities: Partial<CanopyCapabilities> = {
    worktreeDiscard: true,
    projectDeletionDiscard: true,
  },
): Fake {
  const calls: Fake['calls'] = [];
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(name: CommandName, args: unknown): Promise<unknown> {
    calls.push({ name, args });
    if (name === 'workspace.delete.discard.describe')
      return Promise.resolve(describe);
    if (name === 'worktree.discard') return Promise.resolve(DISCARDED);
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  }
  const client: CanopyClient = {
    capabilities: {
      localExecution: true,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'read-only',
      routing: 'url',
      overviewNotifications: true,
      ...capabilities,
    },
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}"]`,
  );
}

function offer(
  extra: Partial<ProjectDeletionDiscardOffer> = {},
): ProjectDeletionDiscardOffer {
  return {
    workspaceId: 'ws',
    projectName: 'Garden',
    message: 'A source repository is unavailable.',
    retry: jest.fn(),
    onOpen: jest.fn(),
    ...extra,
  };
}

describe('ProjectDeletionDiscardHost (CAN-5337)', () => {
  it('lists each worktree with its paths in one confirmation, then discards them and runs the deletion again', async () => {
    const fake = fakeClient(DISCARDABLE);
    const onItemDiscarded = jest.fn();
    act(() => {
      root.render(
        <ProjectDeletionDiscardHost
          client={fake.client}
          onItemDiscarded={onItemDiscarded}
        />,
      );
    });
    const opened = offer();
    act(() => offerProjectDeletionDiscard(opened));
    await flush();

    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Delete project “Garden”?');
    expect(text).toContain('owl');
    expect(text).toContain('/data/ws/worktrees/one');
    expect(text).toContain('lark');
    expect(text).toContain('/data/ws/worktrees/two');
    expect(text).not.toContain('Branches in the source repository are kept.');
    expect(opened.onOpen).toHaveBeenCalledTimes(1);
    expect(fake.calls.map((call) => call.name)).toEqual([
      'workspace.delete.discard.describe',
    ]);

    const confirm = document.querySelector<HTMLButtonElement>(
      `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-confirm"]`,
    );
    expect(confirm?.textContent).toContain(
      'Discard worktrees and delete project',
    );
    act(() => confirm?.click());
    await flush();

    expect(fake.calls.slice(1)).toEqual([
      {
        name: 'worktree.discard',
        args: {
          workspaceId: 'ws',
          worktreeId: 'one',
          confirmation: 'token-one',
        },
      },
      {
        name: 'worktree.discard',
        args: {
          workspaceId: 'ws',
          worktreeId: 'two',
          confirmation: 'token-two',
        },
      },
    ]);
    expect(onItemDiscarded.mock.calls).toEqual([
      [{ workspaceId: 'ws', worktreeId: 'one', warnings: [] }],
      [{ workspaceId: 'ws', worktreeId: 'two', warnings: [] }],
    ]);
    expect(opened.retry).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('discards one row from the same confirmation, keeps the rest listed, and confirming takes only what remains', async () => {
    const fake = fakeClient(DISCARDABLE);
    const onItemDiscarded = jest.fn();
    act(() => {
      root.render(
        <ProjectDeletionDiscardHost
          client={fake.client}
          onItemDiscarded={onItemDiscarded}
        />,
      );
    });
    const opened = offer();
    act(() => offerProjectDeletionDiscard(opened));
    await flush();
    const rowDiscards = (): HTMLButtonElement[] =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-item-discard"]`,
        ),
      );
    expect(rowDiscards()).toHaveLength(2);

    act(() => rowDiscards()[1].click());
    await flush();
    expect(fake.calls.slice(1)).toEqual([
      {
        name: 'worktree.discard',
        args: {
          workspaceId: 'ws',
          worktreeId: 'two',
          confirmation: 'token-two',
        },
      },
    ]);
    expect(onItemDiscarded.mock.calls).toEqual([
      [{ workspaceId: 'ws', worktreeId: 'two', warnings: [] }],
    ]);
    expect(dialog()?.textContent).toContain('Discarded');
    expect(opened.retry).not.toHaveBeenCalled();
    // With one left, the dialog's own action discards it and deletes.
    expect(rowDiscards()).toHaveLength(0);

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          `[data-testid="${PROJECT_DELETION_DISCARD_DIALOG_TEST_ID}-confirm"]`,
        )
        ?.click(),
    );
    await flush();
    expect(fake.calls.slice(2)).toEqual([
      {
        name: 'worktree.discard',
        args: {
          workspaceId: 'ws',
          worktreeId: 'one',
          confirmation: 'token-one',
        },
      },
    ]);
    expect(opened.retry).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it.each([
    ['without the capability', { worktreeDiscard: true }],
    ['without the worktree discard', { projectDeletionDiscard: true }],
  ])('opens nothing %s', async (_label, capabilities) => {
    const fake = fakeClient(DISCARDABLE, capabilities);
    act(() => {
      root.render(
        <ProjectDeletionDiscardHost
          client={fake.client}
          onItemDiscarded={jest.fn()}
        />,
      );
    });
    const opened = offer();
    act(() => offerProjectDeletionDiscard(opened));
    await flush();
    expect(dialog()).toBeNull();
    expect(fake.calls).toEqual([]);
    expect(opened.onOpen).not.toHaveBeenCalled();
  });

  it('opens nothing for a refused description, so the refusal stands', async () => {
    const fake = fakeClient({ ...DISCARDABLE, status: 'refused', items: [] });
    act(() => {
      root.render(
        <ProjectDeletionDiscardHost
          client={fake.client}
          onItemDiscarded={jest.fn()}
        />,
      );
    });
    const opened = offer();
    act(() => offerProjectDeletionDiscard(opened));
    await flush();
    expect(dialog()).toBeNull();
    expect(opened.onOpen).not.toHaveBeenCalled();
  });
});
