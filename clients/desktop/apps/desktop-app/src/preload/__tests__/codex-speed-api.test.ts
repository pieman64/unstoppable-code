import {
  IPC_CHANNELS,
  type CodexSpeedApi,
  type CodexSpeedCatalog,
} from '@canopy/desktop-shared/types';
import { createCodexSpeedApi } from '../api/codex-speed-api';
import type { CodexSpeedRouteFacts } from '@canopy/desktop-shared/lib/codex-speed-availability';

type ChangedListener = (event: unknown, payload: unknown) => void;

const INVALID_REQUEST_ERROR = 'Invalid Codex speed capability request.';
const UNAVAILABLE_ERROR = 'Codex speed capabilities were unavailable.';

function catalog(generation = 1): CodexSpeedCatalog {
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

/** Calls an API method with input its signature forbids, as renderer code can. */
function callUntyped(
  method: (...args: never[]) => unknown,
  ...args: unknown[]
): unknown {
  const result: unknown = Reflect.apply(method, undefined, args);
  return result;
}

describe('Codex speed preload API', () => {
  const invoke = jest.fn<Promise<unknown>, [string, unknown?]>();
  const on = jest.fn<void, [string, ChangedListener]>();
  const removeListener = jest.fn<void, [string, ChangedListener]>();

  function createApi(): CodexSpeedApi {
    return createCodexSpeedApi({ invoke, on, removeListener });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    invoke.mockReset();
    invoke.mockResolvedValue(catalog());
  });

  it('does no IPC work until a method is called', () => {
    createApi();

    expect(invoke).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });

  describe('readRoute', () => {
    const route: CodexSpeedRouteFacts = {
      modelSelection: 'explicit',
      runtimeModel: 'future-codex-model',
      modelSource: 'codex-managed',
      harness: 'codex',
      routeProfile: 'codex-native',
    };

    it('reads a trusted context through its dedicated channel', async () => {
      invoke.mockResolvedValueOnce(route);
      const request = {
        context: { kind: 'defaults' as const },
        model: 'future-codex-model',
      };
      await expect(createApi().readRoute(request)).resolves.toEqual(route);
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.codexSpeedReadRoute,
        request,
      );
    });

    it.each([
      { context: { kind: 'home', projectId: '../workspace' } },
      { context: { kind: 'defaults' }, routeProfile: 'codex-native' },
      { context: { kind: 'chat', projectId: 'workspace' } },
    ])(
      'rejects malformed route requests %j before invoking',
      async (request) => {
        await expect(
          callUntyped(createApi().readRoute, request),
        ).rejects.toThrow(INVALID_REQUEST_ERROR);
        expect(invoke).not.toHaveBeenCalled();
      },
    );

    it('rejects unportable host responses', async () => {
      invoke.mockResolvedValueOnce({ ...route, accountId: 'private-account' });
      await expect(
        createApi().readRoute({ context: { kind: 'defaults' } }),
      ).rejects.toThrow(UNAVAILABLE_ERROR);
    });
  });

  describe('readCapabilities', () => {
    it('reads without an argument unless a refresh is forced', async () => {
      const api = createApi();
      const forced = { force: true };

      await api.readCapabilities();
      await api.readCapabilities({});
      await api.readCapabilities({ force: false });
      await api.readCapabilities(forced);

      expect(invoke.mock.calls).toStrictEqual([
        [IPC_CHANNELS.codexSpeedRead],
        [IPC_CHANNELS.codexSpeedRead],
        [IPC_CHANNELS.codexSpeedRead],
        [IPC_CHANNELS.codexSpeedRead, { force: true }],
      ]);
      expect(invoke.mock.calls[3]?.[1]).not.toBe(forced);
    });

    it('forwards a request for the account proxy route catalog', async () => {
      const api = createApi();
      await api.readCapabilities({ route: 'account-proxy' });
      await api.readCapabilities({ force: true, route: 'account-proxy' });
      expect(invoke.mock.calls).toStrictEqual([
        [IPC_CHANNELS.codexSpeedRead, { route: 'account-proxy' }],
        [IPC_CHANNELS.codexSpeedRead, { force: true, route: 'account-proxy' }],
      ]);
    });

    it('resolves the validated catalog', async () => {
      const current = catalog(7);
      invoke.mockResolvedValueOnce(current);

      await expect(createApi().readCapabilities()).resolves.toEqual(current);
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
    ])('rejects $label as options without invoking', async ({ options }) => {
      await expect(
        callUntyped(createApi().readCapabilities, options),
      ).rejects.toThrow(INVALID_REQUEST_ERROR);
      expect(invoke).not.toHaveBeenCalled();
    });

    it.each<{ label: string; response: unknown }>([
      { label: 'no response', response: undefined },
      { label: 'null', response: null },
      { label: 'an empty object', response: {} },
      {
        label: 'a negative generation',
        response: { ...catalog(), generation: -1 },
      },
      {
        label: 'an unknown status',
        response: { ...catalog(), status: 'pending' },
      },
      {
        label: 'a malformed model',
        response: { ...catalog(), models: [{ id: 'codex-model-a' }] },
      },
    ])('rejects $label as unavailable capabilities', async ({ response }) => {
      invoke.mockResolvedValueOnce(response);

      await expect(createApi().readCapabilities()).rejects.toThrow(
        UNAVAILABLE_ERROR,
      );
    });

    it('propagates read failures from main', async () => {
      const failure = new Error('backend unavailable');
      invoke.mockRejectedValueOnce(failure);

      await expect(createApi().readCapabilities()).rejects.toBe(failure);
    });
  });

  describe('setActive', () => {
    it('sends a fresh consumer registration and resolves without a value', async () => {
      const api = createApi();
      const request = { consumerId: 'Composer:tab_1-a', active: true };
      const longest = 'x'.repeat(128);
      invoke.mockResolvedValueOnce('ignored');

      await expect(api.setActive(request)).resolves.toBeUndefined();
      await api.setActive({ consumerId: longest, active: false });

      expect(invoke.mock.calls).toStrictEqual([
        [
          IPC_CHANNELS.codexSpeedSetActive,
          { consumerId: 'Composer:tab_1-a', active: true },
        ],
        [
          IPC_CHANNELS.codexSpeedSetActive,
          { consumerId: longest, active: false },
        ],
      ]);
      expect(invoke.mock.calls[0]?.[1]).not.toBe(request);
    });

    it('drops unexpected request fields before invoking', async () => {
      await expect(
        callUntyped(createApi().setActive, {
          consumerId: 'composer',
          active: false,
          extra: 'value',
        }),
      ).resolves.toBeUndefined();

      expect(invoke.mock.calls).toStrictEqual([
        [
          IPC_CHANNELS.codexSpeedSetActive,
          { consumerId: 'composer', active: false },
        ],
      ]);
    });

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
        label: 'a non-ASCII id',
        request: { consumerId: 'compösér', active: true },
      },
      {
        label: 'a 129-character id',
        request: { consumerId: 'x'.repeat(129), active: true },
      },
    ])('rejects $label without invoking', async ({ request }) => {
      await expect(callUntyped(createApi().setActive, request)).rejects.toThrow(
        INVALID_REQUEST_ERROR,
      );
      expect(invoke).not.toHaveBeenCalled();
    });

    it('propagates registration failures from main', async () => {
      const failure = new Error('backend unavailable');
      invoke.mockRejectedValueOnce(failure);

      await expect(
        createApi().setActive({ consumerId: 'composer', active: true }),
      ).rejects.toBe(failure);
    });
  });

  describe('onChanged', () => {
    it('forwards only well-formed catalog changes', () => {
      const callback = jest.fn<void, [CodexSpeedCatalog]>();
      createApi().onChanged(callback);
      expect(on).toHaveBeenCalledTimes(1);
      expect(on.mock.calls[0]?.[0]).toBe(IPC_CHANNELS.codexSpeedChanged);
      const listener = on.mock.calls[0]?.[1];
      if (!listener) throw new Error('Changed listener was not registered');
      const next = catalog(2);

      listener({}, next);
      listener({}, undefined);
      listener({}, 'catalog');
      listener({}, { ...catalog(3), truncated: 'no' });
      listener({}, { ...catalog(3), denials: [{ model: 'codex-model-a' }] });

      expect(callback.mock.calls).toEqual([[next]]);
    });

    it('returns an idempotent disposer that removes only its own listener', () => {
      const api = createApi();
      const disposeFirst = api.onChanged(jest.fn<void, [CodexSpeedCatalog]>());
      const disposeSecond = api.onChanged(jest.fn<void, [CodexSpeedCatalog]>());
      const firstListener = on.mock.calls[0]?.[1];
      const secondListener = on.mock.calls[1]?.[1];
      expect(firstListener).toBeDefined();
      expect(secondListener).toBeDefined();
      expect(firstListener).not.toBe(secondListener);

      disposeFirst();
      disposeFirst();

      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(removeListener.mock.calls[0]?.[0]).toBe(
        IPC_CHANNELS.codexSpeedChanged,
      );
      expect(removeListener.mock.calls[0]?.[1]).toBe(firstListener);

      disposeSecond();
      disposeSecond();

      expect(removeListener).toHaveBeenCalledTimes(2);
      expect(removeListener.mock.calls[1]?.[1]).toBe(secondListener);
    });
  });
});
