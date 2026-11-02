/**
 * @jest-environment jsdom
 */
import type { TryItCapability } from '@canopy/protocol/try-it';
import {
  createTryItChatLauncher,
  subscribeTryItChatLaunch,
  tryItChatPluginSelections,
  TryItStageCancelledError,
  type TryItChatDeps,
  type TryItChatLocation,
  type TryItChatStorage,
  type TryItStageDestination,
} from '../tryItChat';

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: { getState: jest.fn() },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: { getState: jest.fn() },
}));

const linear: TryItCapability = {
  kind: 'plugin',
  sourceId: 'curated/cloud',
  catalogId: 'linear',
  name: 'Linear',
};

const worktree: TryItChatLocation = {
  projectId: 'checkout',
  worktreeId: 'checkout-latency',
};

const chats: TryItChatLocation = {
  projectId: 'cowork-default',
  worktreeId: 'entry-1',
};

function memoryStorage(): TryItChatStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
}

type CreateChatParams = Parameters<TryItChatDeps['createChat']>[0];
type StageDraftParams = Parameters<TryItChatDeps['stageDraft']>[0];

function setup(
  options: {
    target?: TryItStageDestination;
    overrides?: Partial<TryItChatDeps>;
  } = {},
): {
  storage: ReturnType<typeof memoryStorage>;
  target: { current: TryItStageDestination };
  drafts: Set<string>;
  createChat: jest.Mock<Promise<TryItChatLocation>, [CreateChatParams]>;
  openChat: jest.Mock<
    Promise<'opened' | 'missing'>,
    [TryItChatLocation, string]
  >;
  stageDraft: jest.Mock<Promise<void>, [StageDraftParams]>;
  showChat: jest.Mock<Promise<void>, [TryItChatLocation, string]>;
  launcher: ReturnType<typeof createTryItChatLauncher>;
} {
  const storage = memoryStorage();
  let id = 0;
  const target = {
    current: options.target ?? {
      kind: 'existing' as const,
      location: worktree,
      chatId: 'grace-chat',
    },
  };
  const drafts = new Set<string>();
  const stagedIds = new Map<string, Set<string>>();
  const createChat = jest.fn((params: CreateChatParams) => {
    const location =
      params.target.kind === 'new-tab' ? params.target.location : chats;
    params.onChatCreated(location);
    return Promise.resolve(location);
  });
  const openChat = jest.fn<
    Promise<'opened' | 'missing'>,
    [TryItChatLocation, string]
  >(() => Promise.resolve('opened'));
  const stageDraft = jest.fn((params: StageDraftParams) => {
    drafts.add(params.chatId);
    const ids = stagedIds.get(params.chatId) ?? new Set<string>();
    ids.add(params.stagingId);
    stagedIds.set(params.chatId, ids);
    return Promise.resolve();
  });
  const showChat = jest.fn<Promise<void>, [TryItChatLocation, string]>(() =>
    Promise.resolve(),
  );
  const deps: TryItChatDeps = {
    storage,
    newId: () => `id-${++id}`,
    resolveTarget: () => Promise.resolve(target.current),
    createChat,
    openChat,
    hasDraft: (chatId) => drafts.has(chatId),
    isStageAccepted: (chatId, stagingId) =>
      stagedIds.get(chatId)?.has(stagingId) === true,
    stageDraft,
    showChat,
    ...options.overrides,
  };
  return {
    storage,
    target,
    drafts,
    createChat,
    openChat,
    stageDraft,
    showChat,
    launcher: createTryItChatLauncher(deps),
  };
}

const request = {
  accountId: 'account:1',
  capability: linear,
  prompt: 'Summarize my open Linear issues.',
};

it('recovers a partially created worktree chat instead of creating another', async () => {
  const { launcher, createChat, stageDraft } = setup({
    target: { kind: 'new-tab', location: worktree },
  });
  stageDraft.mockRejectedValueOnce(new Error('temporary staging failure'));
  await expect(launcher.start(request)).rejects.toThrow('temporary');
  await launcher.start(request);
  expect(createChat).toHaveBeenCalledTimes(1);
  expect(stageDraft.mock.calls[1][0].chatId).toBe(
    stageDraft.mock.calls[0][0].chatId,
  );
});

it('never reopens a fallback across navigation contexts', async () => {
  const { launcher, createChat, openChat } = setup({
    target: { kind: 'standalone' },
  });
  await launcher.start({ ...request, contextKey: 'personal' });
  await launcher.start({ ...request, contextKey: 'org:other' });
  expect(openChat).not.toHaveBeenCalled();
  expect(createChat).toHaveBeenCalledTimes(2);
});

it('notifies launch observers after accepted local and cross-window writes', async () => {
  const { launcher } = setup();
  const observed: (string | undefined)[] = [];
  const unsubscribe = subscribeTryItChatLaunch(() => {
    observed.push(
      launcher.readLaunch(request.accountId, request.capability)?.status,
    );
  });
  try {
    await launcher.start(request);
    expect(observed.at(-1)).toBe('staged');
    const count = observed.length;
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    expect(observed).toHaveLength(count);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'canopy:try-it-launch:other' }),
    );
    expect(observed).toHaveLength(count + 1);
    unsubscribe();
    window.dispatchEvent(new StorageEvent('storage'));
    expect(observed).toHaveLength(count + 1);
  } finally {
    unsubscribe();
  }
});

describe('tryItChatPluginSelections', () => {
  it('selects the installed runtime reference', () => {
    expect(
      tryItChatPluginSelections({
        capability: linear,
        runtimeSelections: {
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: 'curated/cloud', pluginName: 'linear' },
          ],
        },
      }),
    ).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'curated/cloud', pluginName: 'linear' }],
    });
  });

  it('keeps an uninstalled capability as its catalog identity', () => {
    expect(tryItChatPluginSelections({ capability: linear })).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      unresolvedCapabilities: [linear],
    });
  });
});

describe('createTryItChatLauncher', () => {
  it('stages into the current worktree chat without creating one', async () => {
    const { launcher, createChat, stageDraft } = setup();
    await expect(launcher.start(request)).resolves.toBe('staged');
    expect(createChat).not.toHaveBeenCalled();
    expect(stageDraft).toHaveBeenCalledTimes(1);
    expect(stageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        location: worktree,
        chatId: 'grace-chat',
        prompt: request.prompt,
        pluginSelections: tryItChatPluginSelections(request),
      }),
    );
    expect(launcher.readLaunch('account:1', linear)).toEqual({
      version: 2,
      operation: 'stage-draft',
      accountId: 'account:1',
      requestId: 'id-1',
      stagingId: stageDraft.mock.calls[0][0].stagingId,
      capability: linear,
      chatId: 'grace-chat',
      prompt: request.prompt,
      destination: 'worktree',
      status: 'staged',
      location: worktree,
    });
  });

  it('creates an empty chat in the worktree when none is editable', async () => {
    const { launcher, createChat, stageDraft } = setup({
      target: { kind: 'new-tab', location: worktree },
    });
    await launcher.start({
      ...request,
      model: { model: 'gpt-5', thinkingLevel: 'medium' },
    });
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'new-tab', location: worktree },
        chatId: 'id-2',
        model: { model: 'gpt-5', thinkingLevel: 'medium' },
      }),
    );
    expect(stageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ location: worktree, chatId: 'id-2' }),
    );
    expect(launcher.readLaunch('account:1', linear)).toMatchObject({
      destination: 'worktree',
      status: 'staged',
      chatId: 'id-2',
      location: worktree,
    });
  });

  it('creates an empty standalone chat when no worktree is selected', async () => {
    const { launcher, createChat, stageDraft } = setup({
      target: { kind: 'standalone' },
    });
    await launcher.start(request);
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'standalone' } }),
    );
    expect(stageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ location: chats, chatId: 'id-2' }),
    );
    expect(launcher.readLaunch('account:1', linear)).toMatchObject({
      destination: 'standalone',
      location: chats,
    });
  });

  it('reopens the staged draft instead of appending another starter', async () => {
    const { launcher, stageDraft } = setup();
    await launcher.start(request);
    await expect(launcher.start(request)).resolves.toBe('reopened');
    expect(stageDraft).toHaveBeenCalledTimes(2);
    expect(stageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        location: worktree,
        chatId: 'grace-chat',
        pluginSelections: tryItChatPluginSelections(request),
        preserveDraft: true,
      }),
    );
  });

  it('stages again once the draft was cleared or sent', async () => {
    const { launcher, stageDraft, drafts } = setup();
    await launcher.start(request);
    drafts.clear();
    await expect(launcher.start(request)).resolves.toBe('staged');
    expect(stageDraft).toHaveBeenCalledTimes(2);
  });

  it('appends a fresh starter to a new draft after the prior draft was sent', async () => {
    let accepted = true;
    const { launcher, stageDraft } = setup({
      overrides: { isStageAccepted: () => accepted },
    });
    await launcher.start(request);
    // Send retires the prior insertion receipt; the user then types new text.
    accepted = false;
    await expect(launcher.start(request)).resolves.toBe('staged');
    expect(stageDraft).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ preserveDraft: true }),
    );
  });

  it('follows the current destination over an earlier launch', async () => {
    const { launcher, stageDraft, target } = setup();
    await launcher.start(request);
    target.current = {
      kind: 'existing',
      location: worktree,
      chatId: 'another-chat',
    };
    await expect(launcher.start(request)).resolves.toBe('staged');
    expect(stageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: 'another-chat' }),
    );
  });

  it('reuses the earlier standalone fallback chat', async () => {
    const { launcher, createChat, openChat, stageDraft, drafts } = setup({
      target: { kind: 'standalone' },
    });
    await launcher.start(request);
    await expect(launcher.start(request)).resolves.toBe('reopened');
    expect(openChat).toHaveBeenCalledWith(chats, 'id-2');
    drafts.clear();
    await expect(launcher.start(request)).resolves.toBe('staged');
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(stageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ location: chats, chatId: 'id-2' }),
    );
    await expect(launcher.start(request)).resolves.toBe('reopened');
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('creates a new standalone chat once the earlier one is confirmed gone', async () => {
    const { launcher, createChat, openChat } = setup({
      target: { kind: 'standalone' },
    });
    await launcher.start(request);
    openChat.mockResolvedValueOnce('missing');
    await launcher.start(request);
    expect(createChat).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent activations into one launch', async () => {
    const { launcher, stageDraft } = setup();
    await Promise.all([launcher.start(request), launcher.start(request)]);
    expect(stageDraft).toHaveBeenCalledTimes(1);
  });

  it('stages a different capability once beside the first', async () => {
    const { launcher, stageDraft } = setup();
    const other: TryItCapability = { ...linear, catalogId: 'github' };
    await launcher.start(request);
    await launcher.start({ ...request, capability: other });
    expect(stageDraft).toHaveBeenCalledTimes(2);
    await launcher.start({ ...request, capability: other });
    expect(stageDraft).toHaveBeenCalledTimes(3);
    expect(stageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ preserveDraft: true }),
    );
  });

  it('never reuses a launch across accounts', async () => {
    const { launcher, stageDraft } = setup();
    await launcher.start(request);
    await launcher.start({ ...request, accountId: 'account:2' });
    expect(stageDraft).toHaveBeenCalledTimes(2);
  });

  it('does not stage when recoverable storage is unavailable', async () => {
    const { launcher, stageDraft, createChat } = setup({
      overrides: { storage: null },
    });
    await expect(launcher.start(request)).rejects.toThrow('storage');
    expect(createChat).not.toHaveBeenCalled();
    expect(stageDraft).not.toHaveBeenCalled();
  });

  it('cancels without staging when the account changes during launch', async () => {
    let current = true;
    const { launcher, stageDraft } = setup({
      overrides: {
        resolveTarget: () => {
          current = false;
          return Promise.resolve({
            kind: 'existing',
            location: worktree,
            chatId: 'grace-chat',
          });
        },
      },
    });
    await expect(
      launcher.start({ ...request, isCurrent: () => current }),
    ).rejects.toBeInstanceOf(TryItStageCancelledError);
    expect(stageDraft).not.toHaveBeenCalled();
  });

  it('keeps a failed staging recoverable without claiming it was staged', async () => {
    const { launcher, stageDraft } = setup();
    stageDraft.mockRejectedValueOnce(new Error('tab closed'));
    await expect(launcher.start(request)).rejects.toThrow('tab closed');
    expect(launcher.readLaunch('account:1', linear)?.status).toBe('staging');
    await expect(launcher.start(request)).resolves.toBe('staged');
  });

  it.each<TryItStageDestination>([
    { kind: 'existing', location: worktree, chatId: 'grace-chat' },
    { kind: 'new-tab', location: worktree },
    { kind: 'standalone' },
  ])(
    'finalizes an accepted $kind draft after its completion write fails',
    async (target) => {
      const { launcher, storage, stageDraft, createChat } = setup({ target });
      const save = storage.setItem;
      let failCompletion = true;
      storage.setItem = (key, value): void => {
        const candidate: unknown = JSON.parse(value);
        if (
          failCompletion &&
          typeof candidate === 'object' &&
          candidate !== null &&
          'status' in candidate &&
          candidate.status === 'staged'
        ) {
          failCompletion = false;
          throw new Error('completion write unavailable');
        }
        save(key, value);
      };
      await expect(launcher.start(request)).rejects.toThrow('completion write');
      const pending = launcher.readLaunch(request.accountId, linear);
      expect(pending?.status).toBe('staging');
      const creations = createChat.mock.calls.length;
      await expect(launcher.start(request)).resolves.toBe('reopened');
      expect(launcher.readLaunch(request.accountId, linear)).toEqual({
        ...pending,
        status: 'staged',
      });
      expect(stageDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({
          preserveDraft: true,
          chatId: pending?.chatId,
        }),
      );
      expect(createChat).toHaveBeenCalledTimes(creations);
    },
  );

  it.each(['pending', 'completed'])(
    'never resumes or reopens a legacy %s launch',
    async (status) => {
      const { launcher, storage, openChat, stageDraft, showChat } = setup({
        overrides: { isStageAccepted: () => false },
      });
      await launcher.start(request);
      const key = Array.from(storage.values.keys())[0];
      if (key === undefined) throw new Error('launch not stored');
      storage.values.set(
        key,
        JSON.stringify({
          version: 1,
          accountId: 'account:1',
          requestId: 'legacy',
          capability: linear,
          chatId: 'grace-chat',
          prompt: request.prompt,
          destination: 'standalone',
          status,
          location: worktree,
        }),
      );
      expect(launcher.readLaunch('account:1', linear)).toMatchObject({
        version: 1,
        status,
      });
      stageDraft.mockClear();
      await expect(launcher.start(request)).resolves.toBe('staged');
      expect(openChat).not.toHaveBeenCalled();
      expect(showChat).not.toHaveBeenCalled();
      expect(stageDraft).toHaveBeenCalledTimes(1);
      expect(launcher.readLaunch('account:1', linear)).toMatchObject({
        version: 2,
        status: 'staged',
      });
    },
  );

  it('recovers an accepted draft from its target receipt when the launch is malformed', async () => {
    const { launcher, storage, stageDraft } = setup();
    await launcher.start(request);
    const key = Array.from(storage.values.keys())[0];
    if (key === undefined) throw new Error('launch not stored');
    storage.values.set(key, '{"version":2,"accountId":"account:1"}');
    expect(launcher.readLaunch('account:1', linear)).toBeNull();
    await launcher.start(request);
    expect(stageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ preserveDraft: true }),
    );
  });
});

describe('rebindLaunch', () => {
  const guest = { ...request, accountId: 'guest' };
  const move = {
    fromAccountId: 'guest',
    toAccountId: 'account:1',
    capability: linear,
    chatId: 'grace-chat',
  };

  function withRemove(storage: ReturnType<typeof memoryStorage>): void {
    Object.assign(storage, {
      removeItem: (key: string): void => {
        storage.values.delete(key);
      },
    });
  }

  it('moves the guest launch so the account reopens the same draft', async () => {
    const { launcher, storage, stageDraft } = setup();
    withRemove(storage);
    await launcher.start(guest);
    expect(launcher.rebindLaunch(move)).toBe('rebound');
    expect(launcher.readLaunch('guest', linear)).toBeNull();
    expect(launcher.readLaunch('account:1', linear)).toMatchObject({
      accountId: 'account:1',
      chatId: 'grace-chat',
      requestId: 'id-1',
      status: 'staged',
      location: worktree,
    });
    await expect(launcher.start(request)).resolves.toBe('reopened');
    expect(stageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ preserveDraft: true }),
    );
    // Repeating the rebind is harmless.
    expect(launcher.rebindLaunch(move)).toBe('missing');
  });

  it('never overwrites another launch for the account', async () => {
    const { launcher, target } = setup();
    await launcher.start(request);
    target.current = { kind: 'existing', location: worktree, chatId: 'other' };
    await launcher.start(guest);
    const accountLaunch = launcher.readLaunch('account:1', linear);
    expect(launcher.rebindLaunch({ ...move, chatId: 'other' })).toBe(
      'conflict',
    );
    expect(launcher.readLaunch('account:1', linear)).toEqual(accountLaunch);
    expect(launcher.readLaunch('guest', linear)).not.toBeNull();
  });

  it('only moves the launch for the named chat', async () => {
    const { launcher } = setup();
    await launcher.start(guest);
    expect(launcher.rebindLaunch({ ...move, chatId: 'other' })).toBe('missing');
    expect(launcher.readLaunch('account:1', linear)).toBeNull();
  });

  it('keeps the guest launch when the account write fails', async () => {
    const { launcher, storage } = setup();
    await launcher.start(guest);
    const setItem = storage.setItem;
    storage.setItem = (): void => {
      throw new Error('quota');
    };
    expect(launcher.rebindLaunch(move)).toBe('failed');
    storage.setItem = setItem;
    expect(launcher.readLaunch('guest', linear)).not.toBeNull();
    expect(launcher.readLaunch('account:1', linear)).toBeNull();
  });
});
