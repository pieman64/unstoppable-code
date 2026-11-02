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
  archiveRefusalOutcome,
  offerWorktreeDiscard,
  type WorktreeDiscardOffer,
} from '@canopy/app-state';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardResult,
} from '@canopy/protocol/portal/worktree-discard';
import { WORKTREE_DISCARD_DIALOG_TEST_ID } from '@canopy/ui-shared/components/WorktreeDiscardDialog';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorktreeDiscardHost } from '../WorktreeDiscardHost';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const DISCARDABLE: WorktreeDiscardDescription = {
  version: 1,
  workspaceId: 'ws',
  worktreeId: 'wt',
  createdAt: '2026-10-30T00:00:00.000Z',
  status: 'discardable',
  causes: ['source-gone'],
  sources: [{ repoId: 'a', path: '/repos/a', state: 'gone-absent' }],
  targets: [
    {
      kind: 'live-checkout',
      path: '/data/ws/worktrees/wt',
      identity: '1:2',
      identityVerified: true,
      reason: 'source-gone',
    },
  ],
  alsoDeleted: ['chats'],
  preserved: ['branches'],
  mayRemain: [],
  confirmation: 'token-1',
};
const REFUSED: WorktreeDiscardDescription = {
  ...DISCARDABLE,
  status: 'refused',
  causes: [],
  refusal: { reason: 'source-unverified' },
  targets: [],
};

interface Fake {
  readonly client: CanopyClient;
  readonly calls: Array<{ name: CommandName; args: unknown }>;
}

function fakeClient(
  describe: Array<WorktreeDiscardDescription | Error>,
  discard: Array<WorktreeDiscardResult | Error> = [],
  supported = true,
): Fake {
  const calls: Fake['calls'] = [];
  const capabilities: CanopyCapabilities = {
    localExecution: true,
    terminalPty: false,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'read-only',
    routing: 'url',
    overviewNotifications: true,
    ...(supported ? { worktreeDiscard: true } : {}),
  };
  function answer<T>(next: T | Error | undefined): Promise<T> {
    if (next === undefined) return Promise.reject(new Error('no answer'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(name: CommandName, args: unknown): Promise<unknown> {
    calls.push({ name, args });
    if (name === 'worktree.discard.describe') return answer(describe.shift());
    if (name === 'worktree.discard') return answer(discard.shift());
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
  for (let index = 0; index < 5; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="${WORKTREE_DISCARD_DIALOG_TEST_ID}"]`,
  );
}

function button(suffix: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(
    `[data-testid="${WORKTREE_DISCARD_DIALOG_TEST_ID}-${suffix}"]`,
  );
  if (!element) throw new Error(`Missing ${suffix}`);
  return element;
}

function mount(
  fake: Fake,
  notify = jest.fn<void, [WorktreeDiscardOffer]>(),
  onDiscarded = jest.fn(),
): { notify: typeof notify; onDiscarded: typeof onDiscarded } {
  act(() => {
    root.render(
      <WorktreeDiscardHost
        client={fake.client}
        notify={notify}
        onDiscarded={onDiscarded}
      />,
    );
  });
  return { notify, onDiscarded };
}

function offer(
  extra: Partial<WorktreeDiscardOffer> = {},
): WorktreeDiscardOffer {
  return {
    workspaceId: 'ws',
    worktreeId: 'wt',
    worktreeName: 'owl',
    message: "Couldn't verify the worktree's source repositories.",
    retry: jest.fn(),
    ...extra,
  };
}

describe('WorktreeDiscardHost (CAN-5336)', () => {
  it('describes an offer without a description, then confirms and discards with its token', async () => {
    const fake = fakeClient(
      [DISCARDABLE],
      [
        {
          status: 'discarded',
          removed: ['live-checkout'],
          gitCleanup: [],
          warnings: ['w'],
          removedTemporaryWorkspaceId: 'ws',
        },
      ],
    );
    const { notify, onDiscarded } = mount(fake);
    act(() => offerWorktreeDiscard(offer()));
    await flush();
    expect(dialog()?.textContent).toContain('Discard worktree “owl”?');
    expect(dialog()?.textContent).toContain('/data/ws/worktrees/wt');
    act(() => button('confirm').click());
    await flush();
    expect(fake.calls).toEqual([
      {
        name: 'worktree.discard.describe',
        args: { workspaceId: 'ws', worktreeId: 'wt' },
      },
      {
        name: 'worktree.discard',
        args: { workspaceId: 'ws', worktreeId: 'wt', confirmation: 'token-1' },
      },
    ]);
    expect(dialog()).toBeNull();
    expect(onDiscarded).toHaveBeenCalledWith({
      workspaceId: 'ws',
      worktreeId: 'wt',
      warnings: ['w'],
      removedTemporaryWorkspaceId: 'ws',
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("uses a typed refusal's description without describing again", async () => {
    const fake = fakeClient([]);
    mount(fake);
    act(() => offerWorktreeDiscard(offer({ description: DISCARDABLE })));
    await flush();
    expect(dialog()).not.toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['a refused description', [REFUSED]],
    ['a failed description', [new Error('offline')]],
  ] as const)(
    "shows the refusal's own message for %s",
    async (_label, describe) => {
      const fake = fakeClient([...describe]);
      const { notify } = mount(fake);
      const offered = offer();
      act(() => offerWorktreeDiscard(offered));
      await flush();
      expect(dialog()).toBeNull();
      expect(notify).toHaveBeenCalledWith(offered);
    },
  );

  it("shows the message without asking a host that can't discard", async () => {
    const fake = fakeClient([DISCARDABLE], [], false);
    const { notify } = mount(fake);
    const offered = offer();
    act(() => offerWorktreeDiscard(offered));
    await flush();
    expect(fake.calls).toEqual([]);
    expect(dialog()).toBeNull();
    expect(notify).toHaveBeenCalledWith(offered);
  });

  it('keeps the dialog open with the new description when it changed, and never confirms on its own', async () => {
    const changed = { ...DISCARDABLE, confirmation: 'token-2' };
    const fake = fakeClient(
      [DISCARDABLE],
      [
        { status: 'refused', reason: 'changed', description: changed },
        { status: 'discarded', removed: [], gitCleanup: [], warnings: [] },
      ],
    );
    const { onDiscarded } = mount(fake);
    act(() => offerWorktreeDiscard(offer()));
    await flush();
    act(() => button('confirm').click());
    await flush();
    expect(dialog()?.textContent).toContain('This worktree changed.');
    expect(fake.calls).toHaveLength(2);
    act(() => button('confirm').click());
    await flush();
    expect(fake.calls[2]).toEqual({
      name: 'worktree.discard',
      args: { workspaceId: 'ws', worktreeId: 'wt', confirmation: 'token-2' },
    });
    expect(onDiscarded).toHaveBeenCalledTimes(1);
    expect(onDiscarded).toHaveBeenCalledWith({
      workspaceId: 'ws',
      worktreeId: 'wt',
      warnings: [],
    });
  });

  it('shows a refusal or a failure in place and keeps the dialog open', async () => {
    const fake = fakeClient(
      [DISCARDABLE],
      [
        { status: 'refused', reason: 'busy', description: DISCARDABLE },
        new Error(
          "Error invoking remote method 'worktree:discard': Error: Disk is busy.",
        ),
      ],
    );
    mount(fake);
    act(() => offerWorktreeDiscard(offer()));
    await flush();
    act(() => button('confirm').click());
    await flush();
    expect(dialog()?.textContent).toContain(
      'Something is still running in this worktree.',
    );
    act(() => button('confirm').click());
    await flush();
    expect(
      document.querySelector('[data-testid="confirm-dialog-error"]')
        ?.textContent,
    ).toBe('Disk is busy.');
  });

  it('Retry closes and runs the ordinary removal again; Cancel only closes', async () => {
    const retry = jest.fn();
    const fake = fakeClient([DISCARDABLE, DISCARDABLE]);
    mount(fake);
    act(() => offerWorktreeDiscard(offer({ retry })));
    await flush();
    act(() => button('retry').click());
    expect(dialog()).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => offerWorktreeDiscard(offer({ retry })));
    await flush();
    act(() => button('cancel').click());
    expect(dialog()).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('drops Retry when the refusal points at deleting the project again', async () => {
    const retry = jest.fn();
    const fake = fakeClient(
      [DISCARDABLE],
      [
        {
          status: 'refused',
          reason: 'retry-available',
          description: {
            ...REFUSED,
            refusal: { reason: 'retry-available', retry: 'delete-project' },
          },
        },
      ],
    );
    mount(fake);
    act(() => offerWorktreeDiscard(offer({ retry })));
    await flush();
    act(() => button('confirm').click());
    await flush();
    expect(dialog()?.textContent).toContain(
      'Delete the project again instead.',
    );
    expect(
      document.querySelector(
        `[data-testid="${WORKTREE_DISCARD_DIALOG_TEST_ID}-retry"]`,
      ),
    ).toBeNull();
    act(() => button('cancel').click());
    expect(dialog()).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('archiveRefusalOutcome (CAN-5336 Q9 client guard)', () => {
  it('offers only a discardable refusal and fails any other with its message', () => {
    expect(archiveRefusalOutcome({ success: true, warnings: [] })).toBeNull();
    expect(archiveRefusalOutcome(undefined)).toBeNull();
    expect(
      archiveRefusalOutcome({
        success: false,
        refusal: { message: 'gone', discard: { status: 'discardable' } },
      }),
    ).toEqual({ kind: 'offer', message: 'gone' });
    // An older desktop types every recovery-required refusal (leg C).
    expect(
      archiveRefusalOutcome({
        success: false,
        refusal: { message: 'journal', discard: { status: 'refused' } },
      }),
    ).toEqual({ kind: 'fail', message: 'journal' });
    expect(
      archiveRefusalOutcome({ success: false, refusal: { discard: null } }),
    ).toMatchObject({ kind: 'fail' });
  });
});
