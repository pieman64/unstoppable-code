/**
 * @jest-environment jsdom
 */
import type { TryItCapability } from '@canopy/protocol/try-it';
import {
  createTryItChatLauncher,
  tryItChatPluginSelections,
  type TryItChatDeps,
  type TryItChatLocation,
  type TryItChatStorage,
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

const location: TryItChatLocation = {
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
type CreateChatMock = jest.Mock<Promise<void>, [CreateChatParams]>;
type OpenChatMock = jest.Mock<
  Promise<'opened' | 'missing'>,
  [TryItChatLocation, string]
>;

function setup(overrides: Partial<TryItChatDeps> = {}): {
  deps: TryItChatDeps;
  storage: ReturnType<typeof memoryStorage>;
  createChat: CreateChatMock;
  openChat: OpenChatMock;
  launcher: ReturnType<typeof createTryItChatLauncher>;
} {
  const storage = memoryStorage();
  let id = 0;
  const createChat: CreateChatMock = jest.fn((params: CreateChatParams) => {
    params.onChatCreated(location);
    return Promise.resolve();
  });
  const openChat: OpenChatMock = jest.fn(() => Promise.resolve('opened'));
  const deps: TryItChatDeps = {
    storage,
    newId: () => `id-${++id}`,
    createChat,
    openChat,
    resumeChat: jest.fn(() => Promise.resolve()),
    ...overrides,
  };
  return {
    deps,
    storage,
    createChat,
    openChat,
    launcher: createTryItChatLauncher(deps),
  };
}

const request = {
  accountId: 'account:1',
  capability: linear,
  prompt: 'Summarize my open Linear issues.',
};

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
  it('does not create or send when recoverable storage is unavailable', async () => {
    const { launcher, createChat } = setup({ storage: null });
    await expect(launcher.start(request)).rejects.toThrow('storage');
    expect(createChat).not.toHaveBeenCalled();
  });

  it('does not create when reading an earlier receipt fails', async () => {
    const { launcher, createChat } = setup({
      storage: {
        getItem: () => {
          throw new Error('read failed');
        },
        setItem: () => {},
      },
    });
    await expect(launcher.start(request)).rejects.toThrow('read failed');
    expect(createChat).not.toHaveBeenCalled();
  });

  it('does not create or send when persisting launch intent fails', async () => {
    const { launcher, createChat } = setup({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      },
    });
    await expect(launcher.start(request)).rejects.toThrow('quota');
    expect(createChat).not.toHaveBeenCalled();
  });

  it('creates one chat and sends the prompt once with the capability selected', async () => {
    const { launcher, createChat } = setup();
    await launcher.start(request);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat.mock.calls[0][0]).toMatchObject({
      chatId: 'id-2',
      message: request.prompt,
      pluginSelections: { unresolvedCapabilities: [linear] },
    });
    expect(launcher.readLaunch('account:1', linear)).toMatchObject({
      status: 'completed',
      requestId: 'id-1',
      chatId: 'id-2',
      location,
    });
  });

  it('creates the chat on the supported harness model without changing the launch', async () => {
    const { launcher, createChat } = setup();
    const model = { model: 'gpt-5.5', thinkingLevel: 'medium' as const };
    await launcher.start({ ...request, model });
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat.mock.calls[0][0]).toMatchObject({
      chatId: 'id-2',
      message: request.prompt,
      model,
    });
    // The receipt keys and ids are the same as a default-model launch.
    expect(launcher.readLaunch('account:1', linear)).toMatchObject({
      status: 'completed',
      requestId: 'id-1',
      chatId: 'id-2',
    });
    await launcher.start({ ...request, model });
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('leaves the model unset when the default harness can run the capability', async () => {
    const { launcher, createChat } = setup();
    await launcher.start(request);
    expect(createChat.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('joins concurrent activations of the same capability', async () => {
    let release: () => void = () => {};
    const createChat: CreateChatMock = jest.fn(
      (params: CreateChatParams) =>
        new Promise<void>((resolve) => {
          params.onChatCreated(location);
          release = resolve;
        }),
    );
    const { launcher } = setup({ createChat });
    const first = launcher.start(request);
    const second = launcher.start(request);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(launcher.readLaunch('account:1', linear)?.status).toBe('completed');
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('reopens a completed launch without creating or sending again', async () => {
    const { deps, createChat, openChat } = setup();
    await createTryItChatLauncher(deps).start(request);
    // A fresh launcher stands in for a remount or reload.
    await createTryItChatLauncher(deps).start(request);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(openChat).toHaveBeenCalledWith(location, 'id-2');
  });

  it('reopens a launch whose response was lost after the chat existed', async () => {
    const { deps, openChat, storage } = setup({
      createChat: (params: CreateChatParams): Promise<void> => {
        params.onChatCreated(location);
        // The process stops here: no acknowledgement reaches the launcher.
        return new Promise<void>(() => {});
      },
    });
    void createTryItChatLauncher(deps).start(request);
    await Promise.resolve();
    const stored: string | undefined = Array.from(storage.values.values())[0];
    const parsed: unknown = JSON.parse(stored ?? 'null');
    expect(parsed).toMatchObject({ status: 'pending', location });

    const createAfterReload: CreateChatMock = jest.fn(() => Promise.resolve());
    await createTryItChatLauncher({
      ...deps,
      createChat: createAfterReload,
    }).start(request);
    expect(deps.resumeChat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'id-2', requestId: 'id-1', location }),
    );
    expect(createAfterReload).not.toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledWith(location, 'id-2');
    expect(
      createTryItChatLauncher(deps).readLaunch(request.accountId, linear)
        ?.status,
    ).toBe('completed');
  });

  it('starts a new launch once the earlier chat is confirmed deleted', async () => {
    const { deps, createChat, openChat } = setup();
    const launcher = createTryItChatLauncher(deps);
    await launcher.start(request);
    openChat.mockResolvedValueOnce('missing');
    await launcher.start(request);
    expect(createChat).toHaveBeenCalledTimes(2);
    expect(createChat.mock.calls[1][0].chatId).not.toBe(
      createChat.mock.calls[0][0].chatId,
    );
  });

  it('keeps a failed launch recoverable and retries with the same ids', async () => {
    const createChat: CreateChatMock = jest
      .fn<Promise<void>, [CreateChatParams]>()
      .mockRejectedValueOnce(new Error('create failed'))
      .mockImplementationOnce((params: CreateChatParams) => {
        params.onChatCreated(location);
        return Promise.resolve();
      });
    const { launcher } = setup({ createChat });
    await expect(launcher.start(request)).rejects.toThrow('create failed');
    expect(launcher.readLaunch('account:1', linear)).toMatchObject({
      status: 'pending',
      requestId: 'id-1',
      chatId: 'id-2',
    });
    expect(launcher.readLaunch('account:1', linear)?.location).toBeUndefined();
    await launcher.start(request);
    expect(createChat.mock.calls[1][0].chatId).toBe('id-2');
    expect(launcher.readLaunch('account:1', linear)?.status).toBe('completed');
  });

  it('never reuses another account’s launch', async () => {
    const { launcher, createChat, openChat } = setup();
    await launcher.start(request);
    await launcher.start({ ...request, accountId: 'account:2' });
    expect(createChat).toHaveBeenCalledTimes(2);
    expect(openChat).not.toHaveBeenCalled();
    expect(launcher.readLaunch('account:2', linear)?.chatId).not.toBe(
      launcher.readLaunch('account:1', linear)?.chatId,
    );
  });

  it('keeps launches of different capabilities apart', async () => {
    const { launcher, createChat } = setup();
    const other: TryItCapability = { ...linear, catalogId: 'github' };
    await launcher.start(request);
    await launcher.start({ ...request, capability: other });
    expect(createChat).toHaveBeenCalledTimes(2);
    expect(launcher.readLaunch('account:1', linear)?.status).toBe('completed');
    expect(launcher.readLaunch('account:1', other)?.status).toBe('completed');
  });

  it('ignores a malformed stored launch', async () => {
    const { launcher, storage, createChat } = setup();
    await launcher.start(request);
    const key: string | undefined = Array.from(storage.values.keys())[0];
    if (key === undefined) throw new Error('launch not stored');
    storage.values.set(key, '{"version":1,"accountId":"account:1"}');
    expect(launcher.readLaunch('account:1', linear)).toBeNull();
    await launcher.start(request);
    expect(createChat).toHaveBeenCalledTimes(2);
  });
});

describe('rebindLaunch', () => {
  const guest = { ...request, accountId: 'guest' };
  const move = {
    fromAccountId: 'guest',
    toAccountId: 'account:1',
    capability: linear,
    chatId: 'id-2',
  };

  function withRemove(storage: ReturnType<typeof memoryStorage>): void {
    Object.assign(storage, {
      removeItem: (key: string): void => {
        storage.values.delete(key);
      },
    });
  }

  it('moves the guest launch so the account reopens the same chat', async () => {
    const { launcher, storage, openChat, createChat } = setup();
    withRemove(storage);
    await launcher.start(guest);
    expect(launcher.rebindLaunch(move)).toBe('rebound');
    expect(launcher.readLaunch('guest', linear)).toBeNull();
    expect(launcher.readLaunch('account:1', linear)).toMatchObject({
      accountId: 'account:1',
      chatId: 'id-2',
      requestId: 'id-1',
      status: 'completed',
      location,
    });
    await launcher.start(request);
    expect(openChat).toHaveBeenCalledWith(location, 'id-2');
    expect(createChat).toHaveBeenCalledTimes(1);
    // Repeating the rebind is harmless.
    expect(launcher.rebindLaunch(move)).toBe('missing');
  });

  it('never overwrites another launch for the account', async () => {
    const { launcher } = setup();
    await launcher.start(request);
    await launcher.start(guest);
    const accountLaunch = launcher.readLaunch('account:1', linear);
    expect(
      launcher.rebindLaunch({
        ...move,
        chatId: launcher.readLaunch('guest', linear)?.chatId ?? '',
      }),
    ).toBe('conflict');
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

describe('continueChat', () => {
  it('reuses the continuation ID and joins concurrent attempts at the acknowledged resume seam', async () => {
    const { launcher, deps, createChat } = setup();
    const params = {
      location,
      chatId: 'chat',
      requestId: 'continuation',
      message: 'Preserved prompt',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    };
    await Promise.all([
      launcher.continueChat(params),
      launcher.continueChat(params),
    ]);
    expect(deps.resumeChat).toHaveBeenCalledTimes(1);
    expect(deps.resumeChat).toHaveBeenCalledWith({
      ...params,
      durableContinuation: true,
    });
    expect(createChat).not.toHaveBeenCalled();
  });
});
