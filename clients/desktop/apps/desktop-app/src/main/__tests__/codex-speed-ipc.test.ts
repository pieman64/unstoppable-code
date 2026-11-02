import { EventEmitter } from 'node:events';
import {
  IPC_CHANNELS,
  type CodexSpeedCatalog,
  type ReadCodexSpeedRouteRequest,
} from '@canopy/desktop-shared/types';
import type { CodexSpeedRouteFacts } from '@canopy/desktop-shared/lib/codex-speed-availability';

const nativeRoute: CodexSpeedRouteFacts = {
  modelSelection: 'explicit',
  runtimeModel: 'future-codex-model',
  modelSource: 'codex-managed',
  harness: 'codex',
  routeProfile: 'codex-native',
};
const mockReadRoute = jest.fn<
  Promise<CodexSpeedRouteFacts>,
  [ReadCodexSpeedRouteRequest]
>(() => Promise.resolve(nativeRoute));
jest.mock('../codex/speed-route-context', () => ({
  readCodexSpeedRouteFacts: (
    request: ReadCodexSpeedRouteRequest,
  ): Promise<CodexSpeedRouteFacts> => mockReadRoute(request),
}));

type CapturedHandler = (event: unknown, ...args: unknown[]) => unknown;
type CatalogListener = (catalog: CodexSpeedCatalog) => void;

const DESKTOP_WINDOW_ERROR =
  'Codex speed capabilities require a desktop window.';
const INVALID_REQUEST_ERROR = 'Invalid Codex speed capability request.';

const handlers = new Map<string, CapturedHandler>();
const mockWindowSenders = new Set<unknown>();
const mockDisposers: jest.Mock<void, []>[] = [];
const mockReadCodexSpeedCatalog = jest.fn<
  Promise<CodexSpeedCatalog>,
  [{ force?: boolean; route?: 'account-proxy' }?]
>();
const mockSubscribeCodexSpeedCatalog = jest.fn<() => void, [CatalogListener]>(
  () => {
    const dispose = jest.fn<void, []>();
    mockDisposers.push(dispose);
    return dispose;
  },
);
const mockSetCodexSpeedConsumerActive = jest.fn<void, [string, boolean]>();
const mockSendToAllWindows = jest.fn<void, [string, ...unknown[]]>();

jest.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (sender: unknown): object | null =>
      mockWindowSenders.has(sender) ? {} : null,
  },
}));
// The catalog module is owned elsewhere; this spec covers only the IPC
// projection over its seam.
jest.mock('../model-routing/codex-account-models', () => ({
  readCodexSpeedCatalog: (
    ...args: [{ force?: boolean; route?: 'account-proxy' }?]
  ): Promise<CodexSpeedCatalog> => mockReadCodexSpeedCatalog(...args),
  subscribeCodexSpeedCatalog: (listener: CatalogListener): (() => void) =>
    mockSubscribeCodexSpeedCatalog(listener),
  setCodexSpeedConsumerActive: (consumerKey: string, active: boolean): void =>
    mockSetCodexSpeedConsumerActive(consumerKey, active),
}));
const mockRegisterProxyCatalog = jest.fn<void, []>();
jest.mock('../account-proxy/codex-speed-catalog', () => ({
  registerAccountProxyCodexSpeedCatalog: (): void => mockRegisterProxyCatalog(),
}));
const mockRegisterAccountModelRegistrySync = jest.fn<void, []>();
jest.mock('../model-routing/codex-account-model-registry', () => ({
  registerCodexAccountModelRegistrySync: (): void =>
    mockRegisterAccountModelRegistrySync(),
}));
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (channel: string, ...args: unknown[]): void =>
    mockSendToAllWindows(channel, ...args),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: CapturedHandler): void => {
    handlers.set(channel, handler);
  },
}));

import { registerCodexSpeedHandlers } from '../ipc/codex-speed';

/** The `WebContents` surface the handlers read, backed by a real emitter. */
class FakeSender extends EventEmitter {
  readonly mainFrame: object = {};
  private destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

interface FakeInvokeEvent {
  sender: FakeSender;
  senderFrame: object | null;
}

let nextSenderId = 0;

function createSender(options: { window?: boolean } = {}): FakeSender {
  nextSenderId += 1;
  const sender = new FakeSender(nextSenderId);
  if (options.window !== false) mockWindowSenders.add(sender);
  return sender;
}

function fromMainFrame(sender: FakeSender): FakeInvokeEvent {
  return { sender, senderFrame: sender.mainFrame };
}

/** Mirrors `registerIpcHandler`: a synchronous throw rejects the invoke. */
function invoke(
  channel: string,
  event: FakeInvokeEvent,
  ...args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) {
    return Promise.reject(new Error(`Missing handler for ${channel}`));
  }
  return new Promise<unknown>((resolve): void => {
    resolve(handler(event, ...args));
  });
}

function setActive(
  sender: FakeSender,
  consumerId: string,
  active: boolean,
): Promise<unknown> {
  return invoke(IPC_CHANNELS.codexSpeedSetActive, fromMainFrame(sender), {
    consumerId,
    active,
  });
}

function listenerCounts(sender: FakeSender): Record<string, number> {
  return {
    destroyed: sender.listenerCount('destroyed'),
    'render-process-gone': sender.listenerCount('render-process-gone'),
    'did-navigate': sender.listenerCount('did-navigate'),
  };
}

function catalog(generation: number): CodexSpeedCatalog {
  return {
    generation,
    status: 'ready',
    fetchedAt: 1_000,
    expiresAt: 301_000,
    truncated: false,
    models: [
      {
        id: 'codex-model-a',
        model: 'codex-model-a',
        tiers: ['priority', 'ultrafast'],
        source: 'serviceTiers',
      },
    ],
    denials: [],
  };
}

describe('registerCodexSpeedHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    mockDisposers.length = 0;
    registerCodexSpeedHandlers();
  });

  describe('contextual route read', () => {
    it('resolves only portable context input through the host reader', async () => {
      const request: ReadCodexSpeedRouteRequest = {
        context: {
          kind: 'chat',
          projectId: 'workspace',
          worktreeId: 'entry',
          chatId: 'chat',
        },
        model: 'future-codex-model',
      };
      await expect(
        invoke(
          IPC_CHANNELS.codexSpeedReadRoute,
          fromMainFrame(createSender()),
          request,
        ),
      ).resolves.toEqual(nativeRoute);
      expect(mockReadRoute).toHaveBeenCalledWith(request);
    });

    it.each([
      { context: { kind: 'home', projectId: '../workspace' } },
      { context: { kind: 'chat', projectId: 'workspace' } },
      { context: { kind: 'defaults' }, routeProfile: 'codex-native' },
    ])(
      'rejects invalid or asserted route input %j before the host read',
      async (request) => {
        await expect(
          invoke(
            IPC_CHANNELS.codexSpeedReadRoute,
            fromMainFrame(createSender()),
            request,
          ),
        ).rejects.toThrow(INVALID_REQUEST_ERROR);
        expect(mockReadRoute).not.toHaveBeenCalled();
      },
    );

    it('requires the main frame of a desktop window', async () => {
      const sender = createSender();
      await expect(
        invoke(
          IPC_CHANNELS.codexSpeedReadRoute,
          { sender, senderFrame: {} },
          { context: { kind: 'defaults' } },
        ),
      ).rejects.toThrow(DESKTOP_WINDOW_ERROR);
      expect(mockReadRoute).not.toHaveBeenCalled();
    });
  });

  describe('sender checks', () => {
    it.each<{ label: string; event: () => FakeInvokeEvent }>([
      {
        label: 'a sub-frame',
        event: (): FakeInvokeEvent => ({
          sender: createSender(),
          senderFrame: {},
        }),
      },
      {
        label: 'a frame that is already gone',
        event: (): FakeInvokeEvent => ({
          sender: createSender(),
          senderFrame: null,
        }),
      },
      {
        label: 'contents that no desktop window owns',
        event: (): FakeInvokeEvent =>
          fromMainFrame(createSender({ window: false })),
      },
      {
        label: 'destroyed contents',
        event: (): FakeInvokeEvent => {
          const sender = createSender();
          sender.destroy();
          return fromMainFrame(sender);
        },
      },
    ])(
      'rejects $label before reading or changing anything',
      async ({ event }) => {
        await expect(
          invoke(IPC_CHANNELS.codexSpeedRead, event(), { force: true }),
        ).rejects.toThrow(DESKTOP_WINDOW_ERROR);
        const setActiveEvent = event();
        await expect(
          invoke(IPC_CHANNELS.codexSpeedSetActive, setActiveEvent, {
            consumerId: 'composer',
            active: true,
          }),
        ).rejects.toThrow(DESKTOP_WINDOW_ERROR);

        expect(mockReadCodexSpeedCatalog).not.toHaveBeenCalled();
        expect(mockSetCodexSpeedConsumerActive).not.toHaveBeenCalled();
        expect(listenerCounts(setActiveEvent.sender)).toEqual({
          destroyed: 0,
          'render-process-gone': 0,
          'did-navigate': 0,
        });
      },
    );
  });

  describe('codexSpeedRead', () => {
    it('returns the main catalog and forwards only an explicit force', async () => {
      const current = catalog(3);
      mockReadCodexSpeedCatalog.mockResolvedValue(current);
      const event = fromMainFrame(createSender());
      const forced = { force: true };

      await expect(invoke(IPC_CHANNELS.codexSpeedRead, event)).resolves.toBe(
        current,
      );
      await invoke(IPC_CHANNELS.codexSpeedRead, event, {});
      await invoke(IPC_CHANNELS.codexSpeedRead, event, { force: false });
      await invoke(IPC_CHANNELS.codexSpeedRead, event, { force: undefined });
      await expect(
        invoke(IPC_CHANNELS.codexSpeedRead, event, forced),
      ).resolves.toBe(current);

      expect(mockReadCodexSpeedCatalog.mock.calls).toEqual([
        [undefined],
        [undefined],
        [undefined],
        [undefined],
        [{ force: true }],
      ]);
      expect(mockReadCodexSpeedCatalog.mock.calls[4]?.[0]).not.toBe(forced);
    });

    it('forwards a request for the account proxy route catalog', async () => {
      mockReadCodexSpeedCatalog.mockResolvedValue(catalog(3));
      const event = fromMainFrame(createSender());
      await invoke(IPC_CHANNELS.codexSpeedRead, event, {
        route: 'account-proxy',
      });
      await invoke(IPC_CHANNELS.codexSpeedRead, event, {
        force: true,
        route: 'account-proxy',
      });
      expect(mockReadCodexSpeedCatalog.mock.calls).toEqual([
        [{ route: 'account-proxy' }],
        [{ force: true, route: 'account-proxy' }],
      ]);
      expect(mockRegisterProxyCatalog).toHaveBeenCalled();
    });

    it.each<{ label: string; options: unknown }>([
      { label: 'null', options: null },
      { label: 'a string', options: 'force' },
      { label: 'a boolean', options: true },
      { label: 'an array', options: [] },
      { label: 'a non-plain object', options: new Date(0) },
      { label: 'a string force', options: { force: 'yes' } },
      { label: 'a numeric force', options: { force: 1 } },
      { label: 'an extra key', options: { force: true, extra: true } },
      { label: 'an unknown key', options: { refresh: true } },
      { label: 'an unknown route', options: { route: 'native' } },
    ])('rejects $label as read options', async ({ options }) => {
      await expect(
        invoke(
          IPC_CHANNELS.codexSpeedRead,
          fromMainFrame(createSender()),
          options,
        ),
      ).rejects.toThrow(INVALID_REQUEST_ERROR);
      expect(mockReadCodexSpeedCatalog).not.toHaveBeenCalled();
    });
  });

  describe('codexSpeedSetActive', () => {
    it.each<{ label: string; request: unknown }>([
      { label: 'no request', request: undefined },
      { label: 'null', request: null },
      { label: 'a string', request: 'composer' },
      { label: 'an array', request: [] },
      { label: 'a missing active flag', request: { consumerId: 'composer' } },
      { label: 'a missing consumer id', request: { active: true } },
      {
        label: 'a string active flag',
        request: { consumerId: 'composer', active: 'true' },
      },
      {
        label: 'an extra key',
        request: { consumerId: 'composer', active: true, extra: true },
      },
      { label: 'an empty id', request: { consumerId: '', active: true } },
      { label: 'a numeric id', request: { consumerId: 42, active: true } },
      {
        label: 'an id with a leading colon',
        request: { consumerId: ':composer', active: true },
      },
      {
        label: 'an id with a leading hyphen',
        request: { consumerId: '-composer', active: true },
      },
      {
        label: 'an id with a space',
        request: { consumerId: 'composer tab', active: true },
      },
      {
        label: 'an id with a slash',
        request: { consumerId: 'composer/tab', active: true },
      },
      {
        label: 'an id with a dot',
        request: { consumerId: 'composer.tab', active: true },
      },
      {
        label: 'a non-ASCII id',
        request: { consumerId: 'compösér', active: true },
      },
      {
        label: 'a 129-character id',
        request: { consumerId: 'x'.repeat(129), active: true },
      },
    ])('rejects $label', async ({ request }) => {
      const sender = createSender();
      await expect(
        invoke(
          IPC_CHANNELS.codexSpeedSetActive,
          fromMainFrame(sender),
          request,
        ),
      ).rejects.toThrow(INVALID_REQUEST_ERROR);
      expect(mockSetCodexSpeedConsumerActive).not.toHaveBeenCalled();
      expect(listenerCounts(sender)).toEqual({
        destroyed: 0,
        'render-process-gone': 0,
        'did-navigate': 0,
      });
    });

    it('accepts ids at the character and length limits', async () => {
      const sender = createSender();
      const longest = 'x'.repeat(128);

      await setActive(sender, 'Composer:tab_1-a', true);
      await setActive(sender, longest, true);

      expect(mockSetCodexSpeedConsumerActive.mock.calls).toEqual([
        [`${sender.id}:Composer:tab_1-a`, true],
        [`${sender.id}:${longest}`, true],
      ]);
    });

    it('prefixes consumer keys with the sender id so windows stay independent', async () => {
      const first = createSender();
      const second = createSender();

      await setActive(first, 'composer', true);
      await setActive(second, 'composer', true);
      await setActive(first, 'composer', false);

      expect(mockSetCodexSpeedConsumerActive.mock.calls).toEqual([
        [`${first.id}:composer`, true],
        [`${second.id}:composer`, true],
        [`${first.id}:composer`, false],
      ]);
      mockSetCodexSpeedConsumerActive.mockClear();

      first.destroy();
      expect(mockSetCodexSpeedConsumerActive).not.toHaveBeenCalled();
      second.emit('did-navigate');
      expect(mockSetCodexSpeedConsumerActive.mock.calls).toEqual([
        [`${second.id}:composer`, false],
      ]);
    });

    it('forwards repeated activations and releases to the idempotent main set', async () => {
      const sender = createSender();
      const key = `${sender.id}:composer`;

      await setActive(sender, 'composer', true);
      await setActive(sender, 'composer', true);
      await setActive(sender, 'composer', false);
      await setActive(sender, 'composer', false);

      expect(mockSetCodexSpeedConsumerActive.mock.calls).toEqual([
        [key, true],
        [key, true],
        [key, false],
        [key, false],
      ]);
      mockSetCodexSpeedConsumerActive.mockClear();
      sender.emit('did-navigate');
      expect(mockSetCodexSpeedConsumerActive).not.toHaveBeenCalled();
    });

    it('forwards a release from a sender that never registered without observing it', async () => {
      const sender = createSender();

      await setActive(sender, 'composer', false);

      expect(mockSetCodexSpeedConsumerActive.mock.calls).toEqual([
        [`${sender.id}:composer`, false],
      ]);
      expect(listenerCounts(sender)).toEqual({
        destroyed: 0,
        'render-process-gone': 0,
        'did-navigate': 0,
      });
    });

    it('caps each sender at 64 active consumers', async () => {
      const sender = createSender();
      const other = createSender();
      for (let index = 0; index < 64; index += 1) {
        await setActive(sender, `consumer-${index}`, true);
      }
      mockSetCodexSpeedConsumerActive.mockClear();

      await expect(setActive(sender, 'consumer-64', true)).rejects.toThrow(
        INVALID_REQUEST_ERROR,
      );
      expect(mockSetCodexSpeedConsumerActive).not.toHaveBeenCalled();

      // Re-activating a registered consumer is not a new registration, other
      // windows keep their own budget, and a release frees a slot.
      await setActive(sender, 'consumer-0', true);
      await setActive(other, 'consumer-64', true);
      await setActive(sender, 'consumer-0', false);
      await setActive(sender, 'consumer-64', true);

      expect(mockSetCodexSpeedConsumerActive.mock.calls).toEqual([
        [`${sender.id}:consumer-0`, true],
        [`${other.id}:consumer-64`, true],
        [`${sender.id}:consumer-0`, false],
        [`${sender.id}:consumer-64`, true],
      ]);
    });
  });

  describe('sender lifecycle', () => {
    it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
      "releases only that sender's consumers on %s",
      async (eventName) => {
        const owner = createSender();
        const other = createSender();
        await setActive(owner, 'composer', true);
        await setActive(owner, 'settings', true);
        await setActive(other, 'composer', true);
        mockSetCodexSpeedConsumerActive.mockClear();

        if (eventName === 'destroyed') owner.destroy();
        else owner.emit(eventName);

        expect(mockSetCodexSpeedConsumerActive.mock.calls).toEqual([
          [`${owner.id}:composer`, false],
          [`${owner.id}:settings`, false],
        ]);
      },
    );

    it.each(['render-process-gone', 'did-navigate'])(
      'keeps observing a window after %s so its new page can register again',
      async (eventName) => {
        const sender = createSender();
        const key = `${sender.id}:composer`;
        await setActive(sender, 'composer', true);
        sender.emit(eventName);
        mockSetCodexSpeedConsumerActive.mockClear();

        await setActive(sender, 'composer', true);
        sender.emit(eventName);

        expect(mockSetCodexSpeedConsumerActive.mock.calls).toEqual([
          [key, true],
          [key, false],
        ]);
        expect(listenerCounts(sender)).toEqual({
          destroyed: 1,
          'render-process-gone': 1,
          'did-navigate': 1,
        });
      },
    );

    it('attaches lifecycle listeners once per sender and drops them when it is destroyed', async () => {
      const sender = createSender();
      await setActive(sender, 'composer', true);
      await setActive(sender, 'composer', true);
      await setActive(sender, 'settings', true);
      await setActive(sender, 'composer', false);
      await setActive(sender, 'composer', true);
      expect(listenerCounts(sender)).toEqual({
        destroyed: 1,
        'render-process-gone': 1,
        'did-navigate': 1,
      });

      sender.destroy();
      expect(listenerCounts(sender)).toEqual({
        destroyed: 0,
        'render-process-gone': 0,
        'did-navigate': 0,
      });
      mockSetCodexSpeedConsumerActive.mockClear();

      // A dead sender is rejected and is never observed again.
      await expect(setActive(sender, 'composer', true)).rejects.toThrow(
        DESKTOP_WINDOW_ERROR,
      );
      sender.emit('did-navigate');
      expect(mockSetCodexSpeedConsumerActive).not.toHaveBeenCalled();
      expect(listenerCounts(sender)).toEqual({
        destroyed: 0,
        'render-process-gone': 0,
        'did-navigate': 0,
      });
    });
  });

  describe('catalog broadcast', () => {
    it('only subscribes at registration: no read, timer, or consumer change', () => {
      jest.useFakeTimers();
      try {
        registerCodexSpeedHandlers();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }

      expect(mockSubscribeCodexSpeedCatalog).toHaveBeenCalledTimes(2);
      // Account-only Codex models follow the same catalog (CAN-4716).
      expect(mockRegisterAccountModelRegistrySync).toHaveBeenCalled();
      expect(mockReadCodexSpeedCatalog).not.toHaveBeenCalled();
      expect(mockSetCodexSpeedConsumerActive).not.toHaveBeenCalled();
      expect(mockSendToAllWindows).not.toHaveBeenCalled();
    });

    it('forwards every catalog change to all windows', () => {
      const listener = mockSubscribeCodexSpeedCatalog.mock.calls[0]?.[0];
      if (!listener) throw new Error('Catalog subscription was not created');
      const first = catalog(4);
      const second = catalog(5);

      listener(first);
      listener(second);

      expect(mockSendToAllWindows.mock.calls).toEqual([
        [IPC_CHANNELS.codexSpeedChanged, first],
        [IPC_CHANNELS.codexSpeedChanged, second],
      ]);
    });

    it('disposes the previous subscription before re-registering', () => {
      expect(mockSubscribeCodexSpeedCatalog).toHaveBeenCalledTimes(1);
      const [firstDispose] = mockDisposers;
      if (!firstDispose)
        throw new Error('Catalog subscription was not created');

      registerCodexSpeedHandlers();

      expect(firstDispose).toHaveBeenCalledTimes(1);
      expect(mockSubscribeCodexSpeedCatalog).toHaveBeenCalledTimes(2);
      expect(firstDispose.mock.invocationCallOrder[0]).toBeLessThan(
        mockSubscribeCodexSpeedCatalog.mock.invocationCallOrder[1] ?? 0,
      );
      expect(mockDisposers[1]).not.toHaveBeenCalled();
    });
  });
});
