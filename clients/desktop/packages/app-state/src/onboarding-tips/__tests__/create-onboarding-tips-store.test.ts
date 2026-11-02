/** @jest-environment jsdom */
import type { CanopyClient } from '@canopy/app-core';
import type {
  OnboardingTipsState,
  OnboardingTipsUpdate,
} from '@canopy/protocol/onboarding-tips';
import type { PortalChatSummaryEntity } from '@canopy/protocol/portal';
import { CLIENT_STORE_DISPOSE } from '../../client-store-lifecycle';
import {
  createOnboardingTipsStore,
  onboardingTipTranscript,
} from '../create-onboarding-tips-store';

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface FakeClient {
  client: CanopyClient;
  replaceSource: () => void;
  query: jest.Mock;
  reads: Deferred<OnboardingTipsState>[];
  /** `session.snapshot` reads: the worktree history check. */
  snapshots: Deferred<{ chatSummaries: PortalChatSummaryEntity[] }>[];
  updates: {
    args: OnboardingTipsUpdate;
    deferred: Deferred<OnboardingTipsState>;
  }[];
}

function fakeClient(onboardingTips = true): FakeClient {
  const sourceListeners = new Set<() => void>();
  const reads: Deferred<OnboardingTipsState>[] = [];
  const snapshots: FakeClient['snapshots'] = [];
  const updates: FakeClient['updates'] = [];
  const client = {
    subscribeOnboardingTipsSourceChange: (listener: () => void) => {
      sourceListeners.add(listener);
      return (): void => {
        sourceListeners.delete(listener);
      };
    },
    // Mutable, so a test can attach a paired desktop later.
    capabilities: { onboardingTips } as { onboardingTips?: boolean },
    query: jest.fn((name: string) =>
      name === 'session.snapshot'
        ? new Promise<{ chatSummaries: PortalChatSummaryEntity[] }>(
            (resolve, reject) => {
              snapshots.push({ resolve, reject });
            },
          )
        : new Promise<OnboardingTipsState>((resolve, reject) => {
            reads.push({ resolve, reject });
          }),
    ),
    command: jest.fn(
      (_name: string, args: OnboardingTipsUpdate) =>
        new Promise<OnboardingTipsState>((resolve, reject) => {
          updates.push({ args, deferred: { resolve, reject } });
        }),
    ),
    subscribe: jest.fn((): (() => void) => () => undefined),
  };
  // The store only calls the onboarding tip operations, which this fake
  // implements; the rest of the client surface is never reached.
  return {
    client: client as unknown as CanopyClient,
    replaceSource: () => sourceListeners.forEach((listener) => listener()),
    query: client.query,
    reads,
    snapshots,
    updates,
  };
}

/** A worktree chat summary; history fields as given. */
function worktreeChat(
  chatId: string,
  history: Partial<
    Pick<
      PortalChatSummaryEntity,
      'messageCount' | 'lastMessageRole' | 'lastMessageAt'
    >
  > = { messageCount: 0 },
  scope: PortalChatSummaryEntity['scope'] = 'worktree',
): PortalChatSummaryEntity {
  return {
    localId: chatId,
    chatId,
    scope,
    workspaceLocalId: 'p-1',
    worktreeLocalId: 'wt-1',
    title: chatId,
    ...history,
  };
}

const snapshotCalls = (fake: FakeClient): number =>
  fake.query.mock.calls.filter(([name]) => name === 'session.snapshot').length;

const emptyChat = (chatId = 'chat-1') =>
  ({
    chatId,
    workspaceLocalId: 'p-1',
    worktreeLocalId: 'wt-1',
    transcript: 'empty',
    newlyCreated: true,
  }) as const;

/** Arrives on an empty worktree chat that is the user's only one. */
async function arriveFresh(
  store: ReturnType<typeof createOnboardingTipsStore>,
  fake: FakeClient,
  slot = 'composer',
  chatId = 'chat-1',
): Promise<void> {
  store.getState().arrive(slot, ['worktree-chat'], {
    key: chatId,
    worktreeChat: emptyChat(chatId),
  });
  fake.snapshots.at(-1)?.resolve({ chatSummaries: [worktreeChat(chatId)] });
  await flush();
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve));

async function readyStore(
  dismissed: OnboardingTipsState['dismissed'] = {},
): Promise<{
  store: ReturnType<typeof createOnboardingTipsStore>;
  fake: FakeClient;
}> {
  const fake = fakeClient();
  const store = createOnboardingTipsStore(fake.client);
  store.getState().load();
  fake.reads[0]?.resolve({ dismissed });
  await flush();
  return { store, fake };
}

describe('createOnboardingTipsStore', () => {
  it('shares the transcript history and hydration policy across both hosts', () => {
    expect(onboardingTipTranscript([{ role: 'assistant' }], true)).toBe('used');
    expect(onboardingTipTranscript([{ role: 'user' }], false)).toBe('used');
    expect(onboardingTipTranscript([{ role: 'system' }], true)).toBe('empty');
    expect(onboardingTipTranscript([], false)).toBe('loading');
    expect(onboardingTipTranscript(undefined, true)).toBe('loading');
  });
  it('clears the previous source and reloads immediately after re-pairing', async () => {
    const { store, fake } = await readyStore({ workflows: 'desktop-a' });
    store.getState().dismiss('worktree-chat');
    fake.replaceSource();
    expect(store.getState().status).toBe('loading');
    expect(store.getState().dismissed).toEqual({});
    expect(fake.query).toHaveBeenCalledTimes(2);
    fake.reads[1]?.resolve({
      dismissed: { 'workflows-schedule': 'desktop-b' },
    });
    await flush();
    fake.updates[0]?.deferred.resolve({
      dismissed: { workflows: 'desktop-a' },
    });
    await flush();
    expect(store.getState().dismissed).toEqual({
      'workflows-schedule': 'desktop-b',
    });
    store[CLIENT_STORE_DISPOSE]?.();
    fake.replaceSource();
    expect(fake.query).toHaveBeenCalledTimes(2);
  });

  it('ignores a previous source read while the new source is loading', async () => {
    const fake = fakeClient();
    const store = createOnboardingTipsStore(fake.client);
    store.getState().load();
    fake.replaceSource();
    fake.reads[0]?.resolve({ dismissed: { workflows: 'desktop-a' } });
    await flush();
    expect(store.getState().status).toBe('loading');
    expect(store.getState().dismissed).toEqual({});
    fake.reads[1]?.resolve({ dismissed: {} });
    await flush();
    expect(store.getState().status).toBe('ready');
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it('does not restore previous source dismissals when its pending reset fails', async () => {
    const { store, fake } = await readyStore();
    store.getState().dismiss('workflows');
    const reset = store.getState().reset();
    const rejected = expect(reset).rejects.toThrow('old desktop offline');
    fake.replaceSource();
    fake.updates[1]?.deferred.reject(new Error('old desktop offline'));
    await rejected;
    fake.reads[1]?.resolve({ dismissed: {} });
    await flush();
    expect(store.getState().dismissed).toEqual({});
    store[CLIENT_STORE_DISPOSE]?.();
  });
  it('shows nothing on a host that keeps no dismissals', () => {
    const fake = fakeClient(false);
    const store = createOnboardingTipsStore(fake.client);
    store.getState().load();
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().status).toBe('unavailable');
    expect(store.getState().current).toBeNull();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('shows no tip when the first read fails', async () => {
    const fake = fakeClient();
    const store = createOnboardingTipsStore(fake.client);
    store.getState().load();
    fake.reads[0]?.reject(new Error('offline'));
    await flush();
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().status).toBe('unavailable');
    expect(store.getState().current).toBeNull();
  });

  it('reads once however many slots ask', async () => {
    const { store, fake } = await readyStore();
    store.getState().load();
    store.getState().load();
    expect(fake.query).toHaveBeenCalledTimes(1);
  });

  it('shows the highest-priority tip that is not dismissed', async () => {
    const { store } = await readyStore({
      workflows: '2026-10-24T09:00:00.000Z',
    });
    store.getState().arrive('page', ['workflows', 'workflows-schedule']);
    expect(store.getState().current).toEqual({
      tipId: 'workflows-schedule',
      slot: 'page',
    });
  });

  it('shows one tip at a time across slots', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('page', ['workflows']);
    await arriveFresh(store, fake);
    expect(store.getState().current).toEqual({
      tipId: 'workflows',
      slot: 'page',
    });
    store.getState().leave('page');
    expect(store.getState().current?.tipId).toBe('worktree-chat');
  });

  it('hands the tip to a waiting slot when the slot showing it goes away', async () => {
    const { store, fake } = await readyStore();
    await arriveFresh(store, fake);
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().current?.slot).toBe('composer');
    // The composer is hidden behind the page, not dismissed.
    store.getState().leave('composer');
    expect(store.getState().current).toEqual({
      tipId: 'workflows',
      slot: 'page',
    });
  });

  it('does not hand the tip on after a dismissal', async () => {
    const { store, fake } = await readyStore();
    await arriveFresh(store, fake);
    store.getState().arrive('page', ['workflows']);
    store.getState().dismiss('worktree-chat');
    store.getState().leave('composer');
    expect(store.getState().current).toBeNull();
  });

  it('reads again when the window regains focus', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat']);
    window.dispatchEvent(new Event('focus'));
    expect(fake.query).toHaveBeenCalledTimes(2);
    fake.reads[1]?.resolve({
      dismissed: { 'worktree-chat': '2026-10-24T09:00:00.000Z' },
    });
    await flush();
    expect(store.getState().current).toBeNull();
    store[CLIENT_STORE_DISPOSE]?.();
    window.dispatchEvent(new Event('focus'));
    expect(fake.query).toHaveBeenCalledTimes(2);
  });

  it('keeps a tip dismissed this session when an older read arrives', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('page', ['workflows']);
    store.getState().dismiss('workflows');
    window.dispatchEvent(new Event('focus'));
    // The read raced the save and does not have the dismissal yet.
    fake.reads[1]?.resolve({ dismissed: {} });
    await flush();
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().current).toBeNull();
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it('keeps a tip that still applies after the user moves within its surface', async () => {
    const { store } = await readyStore();
    store.getState().arrive('page', ['workflows']);
    store.getState().arrive('page', ['workflows', 'workflows-schedule']);
    expect(store.getState().current?.tipId).toBe('workflows');
  });

  it('waits for the next arrival after a dismissal, then shows the next tip', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('page', ['workflows', 'workflows-schedule']);
    store.getState().dismiss('workflows');
    expect(store.getState().current).toBeNull();
    expect(store.getState().dismissed.workflows).toEqual(expect.any(String));
    expect(fake.updates[0]?.args).toEqual({
      action: 'dismiss',
      tipId: 'workflows',
    });
    store.getState().arrive('page', ['workflows', 'workflows-schedule']);
    expect(store.getState().current?.tipId).toBe('workflows-schedule');
  });

  it('keeps a dismissed tip hidden when the host cannot save it', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('page', ['workflows']);
    store.getState().dismiss('workflows');
    fake.updates[0]?.deferred.reject(new Error('offline'));
    await flush();
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().current).toBeNull();
  });

  it('hides a tip another surface dismissed', async () => {
    const { store } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat']);
    store.getState().sync({ 'worktree-chat': '2026-10-24T09:00:00.000Z' });
    expect(store.getState().current).toBeNull();
  });

  it('ignores a pushed sync before the first read', () => {
    const fake = fakeClient();
    const store = createOnboardingTipsStore(fake.client);
    store.getState().sync({ workflows: '2026-10-24T09:00:00.000Z' });
    expect(store.getState().status).toBe('idle');
  });

  it('brings every tip back on the next arrival after a reset', async () => {
    const { store, fake } = await readyStore({
      workflows: '2026-10-24T09:00:00.000Z',
    });
    const reset = store.getState().reset();
    expect(fake.updates[0]?.args).toEqual({ action: 'reset' });
    fake.updates[0]?.deferred.resolve({ dismissed: {} });
    await reset;
    expect(store.getState().dismissed).toEqual({});
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().current?.tipId).toBe('workflows');
  });

  it('Show tips again wins over its own synced broadcast', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('page', ['workflows']);
    store.getState().dismiss('workflows');
    fake.updates[0]?.deferred.resolve({
      dismissed: { workflows: '2026-10-24T09:00:00.000Z' },
    });
    await flush();
    const reset = store.getState().reset();
    // Desktop main broadcasts the cleared preferences before it replies.
    store.getState().sync({});
    fake.updates[1]?.deferred.resolve({ dismissed: {} });
    await reset;
    expect(store.getState().dismissed).toEqual({});
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().current?.tipId).toBe('workflows');
  });

  it('follows the host record once a dismissal is saved', async () => {
    const { store, fake } = await readyStore();
    await arriveFresh(store, fake);
    store.getState().dismiss('worktree-chat');
    fake.updates[0]?.deferred.resolve({
      dismissed: { 'worktree-chat': '2026-10-24T09:00:00.000Z' },
    });
    await flush();
    // The Portal is now paired with another desktop that has no dismissals.
    window.dispatchEvent(new Event('focus'));
    fake.reads[1]?.resolve({ dismissed: {} });
    await flush();
    store.getState().leave('composer');
    await arriveFresh(store, fake);
    expect(store.getState().current?.tipId).toBe('worktree-chat');
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it('reads once the host gains the capability after an unavailable start', async () => {
    const fake = fakeClient(false);
    const store = createOnboardingTipsStore(fake.client);
    store.getState().load();
    expect(store.getState().status).toBe('unavailable');
    // The paired desktop attaches after the first slot mounted.
    Reflect.set(fake.client.capabilities, 'onboardingTips', true);
    window.dispatchEvent(new Event('focus'));
    expect(fake.query).toHaveBeenCalledTimes(1);
    fake.reads[0]?.resolve({ dismissed: {} });
    await flush();
    await arriveFresh(store, fake);
    expect(store.getState().current?.tipId).toBe('worktree-chat');
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it('keeps a saved dismissal when an older read lands after the save', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('page', ['workflows']);
    store.getState().dismiss('workflows');
    // A focus read starts before the save lands on the host.
    window.dispatchEvent(new Event('focus'));
    fake.updates[0]?.deferred.resolve({
      dismissed: { workflows: '2026-10-24T09:00:00.000Z' },
    });
    await flush();
    fake.reads[1]?.resolve({ dismissed: {} });
    await flush();
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().current).toBeNull();
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it('a late dismissal reply cannot undo Show tips again', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('page', ['workflows']);
    store.getState().dismiss('workflows');
    const reset = store.getState().reset();
    fake.updates[1]?.deferred.resolve({ dismissed: {} });
    await reset;
    fake.updates[0]?.deferred.resolve({
      dismissed: { workflows: '2026-10-24T09:00:00.000Z' },
    });
    await flush();
    store.getState().arrive('page', ['workflows']);
    expect(store.getState().current?.tipId).toBe('workflows');
  });

  it('ignores a read that resolves after the store is disposed', async () => {
    const fake = fakeClient();
    const store = createOnboardingTipsStore(fake.client);
    store.getState().load();
    store[CLIENT_STORE_DISPOSE]?.();
    fake.reads[0]?.resolve({ dismissed: {} });
    await flush();
    expect(store.getState().status).toBe('loading');
  });
});

describe('createOnboardingTipsStore worktree history (CAN-5005)', () => {
  const visit = (
    chatId = 'chat-1',
    transcript: 'loading' | 'empty' | 'used' = 'empty',
  ) =>
    ({
      key: chatId,
      worktreeChat: {
        chatId,
        workspaceLocalId: 'p-1',
        worktreeLocalId: 'wt-1',
        transcript,
        newlyCreated: true,
      },
    }) as const;

  it('does not call an unknown target summary fresh', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1', {})] });
    await flush();
    expect(store.getState().worktreeHistory).toBe('unknown');
    expect(store.getState().current).toBeNull();
  });

  it.each([
    [0, 'fresh'],
    [-1, 'unknown'],
    [2, 'used'],
  ] as const)(
    'gives count %s precedence over stale role metadata',
    async (messageCount, expected) => {
      const { store, fake } = await readyStore();
      store.getState().arrive('composer', ['worktree-chat'], visit());
      fake.snapshots[0]?.resolve({
        chatSummaries: [
          worktreeChat('chat-1', {
            messageCount,
            lastMessageRole: 'assistant',
          }),
        ],
      });
      await flush();
      expect(store.getState().worktreeHistory).toBe(expected);
      expect(store.getState().current?.tipId ?? null).toBe(
        expected === 'fresh' ? 'worktree-chat' : null,
      );
    },
  );

  it('treats absent counts and null legacy metadata as unknown', async () => {
    const { store, fake } = await readyStore();
    const legacy = worktreeChat('chat-1', {});
    Reflect.set(legacy, 'lastMessageRole', null);
    Reflect.set(legacy, 'lastMessageAt', null);
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.resolve({ chatSummaries: [legacy] });
    await flush();
    expect(store.getState().worktreeHistory).toBe('unknown');
    expect(store.getState().current).toBeNull();
  });

  it('does not conflate equal chat ids in different worktrees', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.resolve({
      chatSummaries: [
        worktreeChat('chat-1'),
        { ...worktreeChat('chat-1'), worktreeLocalId: 'another-worktree' },
      ],
    });
    await flush();
    expect(store.getState().current).toBeNull();
    expect(store.getState().worktreeHistory).toBe('used');
  });

  it('retains local creation experience even if the first empty chat was deleted before the snapshot', async () => {
    const { store, fake } = await readyStore();
    store.getState().noteWorktreeChatCreated(emptyChat('first'));
    store.getState().noteWorktreeChatCreated(emptyChat('second'));
    store.getState().arrive('composer', ['worktree-chat'], visit('second'));
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('second')] });
    await flush();
    expect(store.getState().worktreeHistory).toBe('used');
    expect(store.getState().current).toBeNull();
  });

  it.each([false, 'rejected'] as const)(
    'does not count a failed creation (%s) as experience on retry',
    async (outcome) => {
      const { store, fake } = await readyStore();
      const confirmation =
        outcome === false
          ? Promise.resolve(false)
          : Promise.reject(new Error('Create failed'));
      store
        .getState()
        .noteWorktreeChatCreated(emptyChat('failed'), confirmation);
      await flush();
      store
        .getState()
        .noteWorktreeChatCreated(emptyChat('retry'), Promise.resolve(true));
      await flush();
      store.getState().arrive('composer', ['worktree-chat'], {
        key: 'retry',
        worktreeChat: { ...emptyChat('retry'), newlyCreated: false },
      });
      fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('retry')] });
      await flush();
      expect(store.getState().worktreeHistory).toBe('fresh');
      expect(store.getState().current?.tipId).toBe('worktree-chat');
    },
  );

  it('a pending creation does not establish experience beside a confirmed chat', async () => {
    const { store } = await readyStore();
    store.getState().noteWorktreeChatCreated(emptyChat('confirmed'));
    let finish: (created: boolean) => void = () => undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    store
      .getState()
      .noteWorktreeChatCreated(emptyChat('pending'), confirmation);
    expect(store.getState().worktreeHistory).not.toBe('used');
    finish(true);
    await flush();
    expect(store.getState().worktreeHistory).toBe('used');
  });

  it.each(['source replacement', 'disposal'] as const)(
    'ignores creation confirmation after %s',
    async (change) => {
      const { store, fake } = await readyStore();
      if (change === 'disposal')
        store.getState().noteWorktreeChatCreated(emptyChat('confirmed'));
      let finish: (created: boolean) => void = () => undefined;
      const confirmation = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      store.getState().noteWorktreeChatCreated(emptyChat('old'), confirmation);
      if (change === 'source replacement') fake.replaceSource();
      else store[CLIENT_STORE_DISPOSE]?.();
      finish(true);
      await flush();
      store.getState().noteWorktreeChatCreated(emptyChat('new'));
      expect(store.getState().worktreeHistory).not.toBe('used');
    },
  );

  it('revalidates fresh history on a later genuine arrival without polling', async () => {
    const { store, fake } = await readyStore();
    await arriveFresh(store, fake);
    expect(snapshotCalls(fake)).toBe(1);
    store.getState().leave('composer');
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[1]?.resolve({
      chatSummaries: [
        worktreeChat('chat-1'),
        worktreeChat('other', { messageCount: 2 }),
      ],
    });
    await flush();
    expect(snapshotCalls(fake)).toBe(2);
    expect(store.getState().worktreeHistory).toBe('used');
    expect(store.getState().current).toBeNull();
  });

  it('suppresses an old empty target without session creation provenance', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], {
      key: 'old',
      worktreeChat: {
        chatId: 'old',
        workspaceLocalId: 'p-1',
        worktreeLocalId: 'wt-1',
        transcript: 'empty',
      },
    });
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('old')] });
    await flush();
    expect(store.getState().current).toBeNull();
    expect(store.getState().worktreeHistory).toBe('used');
    expect(fake.updates).toEqual([]);
  });

  it('does not treat a missing target summary as complete empty history', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.resolve({ chatSummaries: [] });
    await flush();
    expect(store.getState().worktreeHistory).toBe('unknown');
    expect(store.getState().current).toBeNull();
  });

  it('keeps experience from a prior empty chat after that chat is deleted', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.resolve({
      chatSummaries: [worktreeChat('chat-1'), worktreeChat('older')],
    });
    await flush();
    store.getState().arrive('composer', ['worktree-chat'], visit('newer'));
    fake.snapshots[1]?.resolve({ chatSummaries: [worktreeChat('newer')] });
    await flush();
    expect(store.getState().worktreeHistory).toBe('used');
    expect(store.getState().current).toBeNull();
  });

  it('does not resurrect a pending arrival after dismiss then reset', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    store.getState().dismiss('worktree-chat');
    const reset = store.getState().reset();
    fake.updates[1]?.deferred.resolve({ dismissed: {} });
    await reset;
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    expect(store.getState().current).toBeNull();
  });

  it('does not resurrect a pending arrival when eligibility disappears then returns', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    store.getState().arrive('composer', [], visit());
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    expect(store.getState().current).toBeNull();
  });

  it.each([
    ['the target', [worktreeChat('chat-1', { messageCount: 3 })]],
    [
      'a sibling in its worktree',
      [worktreeChat('chat-1'), worktreeChat('chat-2', { messageCount: 1 })],
    ],
    [
      'a chat in another workspace',
      [
        worktreeChat('chat-1'),
        {
          ...worktreeChat('chat-9', { messageCount: 4 }),
          worktreeLocalId: 'wt-9',
        },
      ],
    ],
    [
      'a legacy summary with only a role',
      [
        worktreeChat('chat-1'),
        worktreeChat('chat-2', { lastMessageRole: 'assistant' }),
      ],
    ],
    [
      'a legacy summary with only a time',
      [
        worktreeChat('chat-1'),
        worktreeChat('chat-2', { lastMessageAt: '2026-10-01T09:00:00.000Z' }),
      ],
    ],
  ])('hides the worktree tip when %s has history', async (_case, chats) => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.resolve({ chatSummaries: chats });
    await flush();
    expect(store.getState().current).toBeNull();
    expect(store.getState().worktreeHistory).toBe('used');
    // History is not a dismissal: nothing is saved.
    expect(fake.updates).toHaveLength(0);
  });

  it('hides the tip when another worktree chat exists, even an empty one', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.resolve({
      chatSummaries: [worktreeChat('chat-1'), worktreeChat('chat-0')],
    });
    await flush();
    expect(store.getState().current).toBeNull();
    expect(store.getState().worktreeHistory).toBe('used');
  });

  it('treats an unknown summary for another chat as a prior chat', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.resolve({
      chatSummaries: [worktreeChat('chat-1'), worktreeChat('chat-2', {})],
    });
    await flush();
    expect(store.getState().current).toBeNull();
  });

  it('shows the tip to a first-time user, whatever their standalone history', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    expect(store.getState().worktreeHistory).toBe('checking');
    expect(store.getState().current).toBeNull();
    fake.snapshots[0]?.resolve({
      chatSummaries: [
        // A first-use target has explicit empty history.
        worktreeChat('chat-1'),
        worktreeChat('solo', { messageCount: 12 }, 'standalone'),
      ],
    });
    await flush();
    expect(store.getState().worktreeHistory).toBe('fresh');
    expect(store.getState().current).toEqual({
      tipId: 'worktree-chat',
      slot: 'composer',
    });
  });

  it('hides the tip on a target whose transcript has history, without a read', async () => {
    const { store, fake } = await readyStore();
    store
      .getState()
      .arrive('composer', ['worktree-chat'], visit('chat-1', 'used'));
    expect(snapshotCalls(fake)).toBe(0);
    expect(store.getState().current).toBeNull();
    expect(store.getState().worktreeHistory).toBe('used');
  });

  it('waits for the transcript before showing, and a used one keeps it hidden', async () => {
    const { store, fake } = await readyStore();
    store
      .getState()
      .arrive('composer', ['worktree-chat'], visit('chat-1', 'loading'));
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    expect(store.getState().current).toBeNull();
    // A stale empty summary loses to the transcript that loaded.
    store
      .getState()
      .arrive('composer', ['worktree-chat'], visit('chat-1', 'used'));
    expect(store.getState().current).toBeNull();
    expect(store.getState().worktreeHistory).toBe('used');
  });

  it('finishes the same visit once an empty transcript loads', async () => {
    const { store, fake } = await readyStore();
    store
      .getState()
      .arrive('composer', ['worktree-chat'], visit('chat-1', 'loading'));
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    store
      .getState()
      .arrive('composer', ['worktree-chat'], visit('chat-1', 'empty'));
    expect(store.getState().current?.tipId).toBe('worktree-chat');
    expect(snapshotCalls(fake)).toBe(1);
  });

  it.each(['missing chat', 'failed read'])(
    'rechecks %s when the new chat becomes authoritative',
    async (earlyResult) => {
      const { store, fake } = await readyStore();
      store
        .getState()
        .arrive('composer', ['worktree-chat'], visit('chat-1', 'loading'));
      // Creation is still in flight, so any early history read omits this chat.
      const earlyReads = fake.snapshots.length;
      for (const snapshot of fake.snapshots) {
        if (earlyResult === 'failed read')
          snapshot.reject(new Error('Source changed'));
        else snapshot.resolve({ chatSummaries: [] });
      }
      await flush();
      expect(store.getState().current).toBeNull();
      store
        .getState()
        .arrive('composer', ['worktree-chat'], visit('chat-1', 'empty'));
      fake.snapshots[earlyReads]?.resolve({
        chatSummaries: [worktreeChat('chat-1')],
      });
      await flush();
      expect(store.getState().current).toEqual({
        tipId: 'worktree-chat',
        slot: 'composer',
      });
      const readsAfterArrival = snapshotCalls(fake);
      store
        .getState()
        .arrive('composer', ['worktree-chat'], visit('chat-1', 'empty'));
      expect(snapshotCalls(fake)).toBe(readsAfterArrival);
    },
  );

  it.each(['missing chat', 'failed read'])(
    'rechecks a pending %s after the transcript becomes authoritative',
    async (earlyResult) => {
      const { store, fake } = await readyStore();
      store
        .getState()
        .arrive('composer', ['worktree-chat'], visit('chat-1', 'loading'));
      store
        .getState()
        .arrive('composer', ['worktree-chat'], visit('chat-1', 'empty'));
      expect(snapshotCalls(fake)).toBe(1);
      if (earlyResult === 'failed read')
        fake.snapshots[0]?.reject(new Error('Source changed'));
      else fake.snapshots[0]?.resolve({ chatSummaries: [] });
      await flush();
      expect(snapshotCalls(fake)).toBe(2);
      fake.snapshots[1]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
      await flush();
      expect(store.getState().current).toEqual({
        tipId: 'worktree-chat',
        slot: 'composer',
      });
      store
        .getState()
        .arrive('composer', ['worktree-chat'], visit('chat-1', 'empty'));
      expect(snapshotCalls(fake)).toBe(2);
    },
  );

  it('does not poll after a deferred history retry also fails', async () => {
    const { store, fake } = await readyStore();
    store
      .getState()
      .arrive('composer', ['worktree-chat'], visit('chat-1', 'loading'));
    store
      .getState()
      .arrive('composer', ['worktree-chat'], visit('chat-1', 'empty'));
    fake.snapshots[0]?.reject(new Error('Source changed'));
    await flush();
    expect(snapshotCalls(fake)).toBe(2);
    fake.snapshots[1]?.reject(new Error('Still unavailable'));
    await flush();
    store
      .getState()
      .arrive('composer', ['worktree-chat'], visit('chat-1', 'empty'));
    expect(snapshotCalls(fake)).toBe(2);
    expect(store.getState().current).toBeNull();
  });

  it('reads no history for a dismissed tip or a host without tips', async () => {
    const { store, fake } = await readyStore({
      'worktree-chat': '2026-10-24T09:00:00.000Z',
    });
    store.getState().arrive('composer', ['worktree-chat'], visit());
    expect(snapshotCalls(fake)).toBe(0);

    const cloud = fakeClient(false);
    const cloudStore = createOnboardingTipsStore(cloud.client);
    cloudStore.getState().load();
    cloudStore.getState().arrive('composer', ['worktree-chat'], visit());
    expect(snapshotCalls(cloud)).toBe(0);
  });

  it('shares one read between visits that overlap', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit('chat-1'));
    store.getState().arrive('portal', ['worktree-chat'], visit('chat-1'));
    expect(snapshotCalls(fake)).toBe(1);
  });

  it('shows nothing when the read fails, and reads again only on a later visit', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.snapshots[0]?.reject(new Error('offline'));
    await flush();
    expect(store.getState().worktreeHistory).toBe('unknown');
    expect(store.getState().current).toBeNull();
    // A rerender of the same visit does not retry.
    store.getState().arrive('composer', ['worktree-chat'], visit());
    expect(snapshotCalls(fake)).toBe(1);
    store.getState().leave('composer');
    store.getState().arrive('composer', ['worktree-chat'], visit());
    expect(snapshotCalls(fake)).toBe(2);
    fake.snapshots[1]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    expect(store.getState().current?.tipId).toBe('worktree-chat');
  });

  it('drops a visit that left or moved on before the read returned', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit('chat-1'));
    store.getState().leave('composer');
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    expect(store.getState().current).toBeNull();

    store.getState().arrive('composer', ['worktree-chat'], visit('chat-1'));
    store.getState().arrive('composer', ['worktree-chat'], visit('chat-2'));
    // The reply is about chat-1 alone, so chat-2 was made before it.
    fake.snapshots[1]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    expect(store.getState().current).toBeNull();
  });

  it('a worktree send during the read wins over its empty reply', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    store.getState().noteTurnSent({ worktreeChat: true });
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    expect(store.getState().worktreeHistory).toBe('used');
    expect(store.getState().current).toBeNull();
  });

  it('removes a showing worktree tip on the first worktree send, for good', async () => {
    const { store, fake } = await readyStore();
    await arriveFresh(store, fake);
    expect(store.getState().current?.tipId).toBe('worktree-chat');
    store.getState().noteTurnSent({ worktreeChat: true });
    expect(store.getState().current).toBeNull();
    store.getState().arrive('composer', ['worktree-chat'], visit('chat-2'));
    expect(store.getState().current).toBeNull();
    expect(snapshotCalls(fake)).toBe(1);
    expect(fake.updates).toHaveLength(0);
  });

  it('ignores a reply from the previous source after re-pairing', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    fake.replaceSource();
    expect(store.getState().worktreeHistory).toBe('unknown');
    fake.snapshots[0]?.resolve({
      chatSummaries: [worktreeChat('chat-1', { messageCount: 2 })],
    });
    fake.reads[1]?.resolve({ dismissed: {} });
    await flush();
    expect(store.getState().worktreeHistory).toBe('unknown');
    // The slot visits again once the new source loads.
    await arriveFresh(store, fake);
    expect(store.getState().current?.tipId).toBe('worktree-chat');
  });

  it('ignores a reply after disposal', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    store[CLIENT_STORE_DISPOSE]?.();
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    expect(store.getState().current).toBeNull();
  });
});

describe('createOnboardingTipsStore notice hold (CAN-5005)', () => {
  const visit = (chatId = 'chat-1') =>
    ({
      key: chatId,
      worktreeChat: {
        chatId,
        workspaceLocalId: 'p-1',
        worktreeLocalId: 'wt-1',
        transcript: 'empty',
        newlyCreated: true,
      },
    }) as const;

  it('clears the showing and waiting tips when a notice takes the budget', async () => {
    const { store, fake } = await readyStore();
    await arriveFresh(store, fake);
    store.getState().arrive('page', ['workflows'], { key: 'workflows' });
    store.getState().holdForNotice('whats-new:1');
    expect(store.getState().held).toBe(true);
    expect(store.getState().current).toBeNull();
    store.getState().leave('composer');
    expect(store.getState().current).toBeNull();
  });

  it('holds once per notice', async () => {
    const { store, fake } = await readyStore();
    store.getState().holdForNotice('whats-new:1');
    store.getState().noteTurnSent({ worktreeChat: false });
    store.getState().holdForNotice('whats-new:1');
    expect(store.getState().held).toBe(false);
    store.getState().arrive('page', ['workflows'], { key: 'workflows' });
    expect(store.getState().current?.tipId).toBe('workflows');
    expect(fake.updates).toHaveLength(0);
  });

  it('holds every tip until a send, then shows one only on a later visit', async () => {
    const { store } = await readyStore();
    store.getState().holdForNotice('whats-new:1');
    store.getState().arrive('page', ['workflows'], { key: 'workflows' });
    expect(store.getState().current).toBeNull();
    // A standalone send lifts the hold, but shows nothing in place.
    store.getState().noteTurnSent({ worktreeChat: false });
    expect(store.getState().held).toBe(false);
    expect(store.getState().worktreeHistory).toBe('unknown');
    store.getState().arrive('page', ['workflows', 'workflows-schedule'], {
      key: 'workflows',
    });
    expect(store.getState().current).toBeNull();
    store.getState().leave('page');
    store.getState().arrive('page', ['workflows'], { key: 'workflows' });
    expect(store.getState().current?.tipId).toBe('workflows');
  });

  it('a notice ends a pending visit even when a send lifts the hold before the reply', async () => {
    const { store, fake } = await readyStore();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    store.getState().holdForNotice('whats-new:1');
    store.getState().noteTurnSent({ worktreeChat: false });
    fake.snapshots[0]?.resolve({ chatSummaries: [worktreeChat('chat-1')] });
    await flush();
    expect(store.getState().worktreeHistory).toBe('fresh');
    expect(store.getState().current).toBeNull();
    store.getState().arrive('composer', ['worktree-chat'], visit());
    expect(store.getState().current).toBeNull();
  });

  it('holds before the dismissals load', () => {
    const fake = fakeClient();
    const store = createOnboardingTipsStore(fake.client);
    store.getState().holdForNotice('whats-new:1');
    store.getState().load();
    fake.reads[0]?.resolve({ dismissed: {} });
    return flush().then(() => {
      store.getState().arrive('page', ['workflows'], { key: 'workflows' });
      expect(store.getState().current).toBeNull();
      expect(store.getState().held).toBe(true);
    });
  });

  it('does not revive a held arrival when preferences finish after the send', async () => {
    const fake = fakeClient();
    const store = createOnboardingTipsStore(fake.client);
    store.getState().load();
    store.getState().holdForNotice('notice');
    store.getState().arrive('page', ['workflows'], { key: 'workflows' });
    store.getState().noteTurnSent({ worktreeChat: false });
    fake.reads[0]?.resolve({ dismissed: {} });
    await flush();
    store.getState().arrive('page', ['workflows'], { key: 'workflows' });
    expect(store.getState().current).toBeNull();
  });

  it('Show tips again keeps the hold and worktree history', async () => {
    const { store, fake } = await readyStore({
      workflows: '2026-10-24T09:00:00.000Z',
    });
    store.getState().noteTurnSent({ worktreeChat: true });
    store.getState().holdForNotice('whats-new:1');
    const reset = store.getState().reset();
    fake.updates[0]?.deferred.resolve({ dismissed: {} });
    await reset;
    expect(store.getState().held).toBe(true);
    expect(store.getState().worktreeHistory).toBe('used');
    store.getState().sync({});
    store.getState().arrive('page', ['workflows'], { key: 'workflows' });
    expect(store.getState().current).toBeNull();
    store.getState().noteTurnSent({ worktreeChat: false });
    store.getState().leave('page');
    store.getState().arrive('page', ['workflows'], { key: 'workflows' });
    expect(store.getState().current?.tipId).toBe('workflows');
    store.getState().arrive('composer', ['worktree-chat'], visit('chat-9'));
    expect(snapshotCalls(fake)).toBe(0);
  });

  it('keeps the hold across re-pairing', async () => {
    const { store, fake } = await readyStore();
    store.getState().holdForNotice('whats-new:1');
    fake.replaceSource();
    fake.reads[1]?.resolve({ dismissed: {} });
    await flush();
    expect(store.getState().held).toBe(true);
  });
});
