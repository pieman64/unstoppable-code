import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

const ORIGIN = 'https://cloud.example.com';
const ACCOUNT_ID = 'account-1';

const mockIpcHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>();
const mockState: {
  flagEnabled: boolean;
  accountId: string | null;
  keyReadable: boolean;
} = { flagEnabled: true, accountId: ACCOUNT_ID, keyReadable: true };
const mockReadCredentials = jest.fn(() =>
  mockState.keyReadable
    ? Promise.resolve({
        baseUrl: ORIGIN,
        apiKey: 'csk_desktop',
        account: { id: ACCOUNT_ID },
        capabilities: [],
      })
    : Promise.reject(new Error('missing api key')),
);
const mockBridge = jest.fn();

jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ): void => {
    mockIpcHandlers.set(channel, handler);
  },
}));

jest.mock('../client', () => ({
  resolveCanopyCloudCredentialContext: (): Promise<unknown> =>
    mockReadCredentials(),
}));

// Reconnect no longer touches the settings bridge (CAN-5989).
jest.mock('../settings-session', () => ({
  acquireSettingsBridgeSession: (...args: unknown[]): unknown =>
    mockBridge(...args),
}));

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => mockState.flagEnabled,
  }),
}));

jest.mock('../../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> =>
    Promise.resolve(
      mockState.accountId === null
        ? { status: 'ok', entry: null }
        : { status: 'ok', entry: { account: { id: mockState.accountId } } },
    ),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { createWebCoreBindingProvider } from '../web-core-connection';
import { CLOUD_CHATS_RECONNECT_WINDOW_MS } from '../web-core-reconnect';
import {
  desktopWebCoreBindingOptions,
  registerCloudChatsHandlers,
} from '../../ipc/cloud-chats';
import type { DesktopAppWindow } from '../../canopy-runtime/desktop-ipc-caller';
import type { RendererRelayEvent } from '../../canopy-runtime/renderer-relay/relay';
import { resolveTrustedRelaySurface } from '../../canopy-runtime/renderer-relay/trusted-surface';

const MAIN_URL = 'app://canopy/index.html';
const ADVISOR_URL = 'app://canopy/app-advisor.html';

function rendererEvent(id: number, url: string): RendererRelayEvent {
  const frame = { url, detached: false, isDestroyed: (): boolean => false };
  return {
    sender: {
      id,
      mainFrame: frame,
      getURL: () => url,
      isDestroyed: () => false,
      on: () => undefined,
      removeListener: () => undefined,
    },
    senderFrame: frame,
  };
}

const mainEvent = rendererEvent(1, MAIN_URL);
const advisorEvent = rendererEvent(2, ADVISOR_URL);
const windowOf = (event: RendererRelayEvent): DesktopAppWindow => ({
  isDestroyed: (): boolean => false,
  webContents: event.sender,
});

/** Main's real trusted-surface check over the app's own two windows. */
function registerHandlers(): void {
  registerCloudChatsHandlers((event) =>
    resolveTrustedRelaySurface(
      event,
      [
        { surface: 'main', window: windowOf(mainEvent), url: MAIN_URL },
        {
          surface: 'app-advisor',
          window: windowOf(advisorEvent),
          url: ADVISOR_URL,
        },
      ],
      [],
    ),
  );
}

/** window.api.cloudChats.reconnect(), through the registered handler. */
function clickReconnect(
  event: RendererRelayEvent = mainEvent,
): Promise<unknown> {
  const handler = mockIpcHandlers.get(IPC_CHANNELS.cloudChatsReconnect);
  if (!handler) throw new Error('cloud-chats:reconnect is not registered');
  // As `registerIpcHandler` does, a thrown refusal rejects the invoke.
  return Promise.resolve().then(() => handler(event));
}

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-renderer:main',
  clientInstanceId: 'renderer-relay:test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

let clock = 1_000_000;
beforeEach(() => {
  mockState.flagEnabled = true;
  mockState.accountId = ACCOUNT_ID;
  mockState.keyReadable = true;
  mockReadCredentials.mockClear();
  mockBridge.mockClear();
  clock += 60_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  registerHandlers();
});

afterEach(() => {
  mockIpcHandlers.clear();
  jest.restoreAllMocks();
});

describe('cloud-chats:reconnect with the desktop key (CAN-4185, CAN-5989)', () => {
  it('flag off and signed out are refused without reading the key', async () => {
    mockState.flagEnabled = false;
    await expect(clickReconnect()).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    mockState.flagEnabled = true;
    mockState.accountId = null;
    await expect(clickReconnect()).resolves.toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(mockReadCredentials).not.toHaveBeenCalled();
  });

  it('a sender other than the main window is refused', async () => {
    const stranger = rendererEvent(3, MAIN_URL);
    const navigated = rendererEvent(1, 'https://example.com/');
    const frameless: RendererRelayEvent = { ...mainEvent, senderFrame: null };
    for (const event of [advisorEvent, stranger, navigated, frameless])
      await expect(clickReconnect(event)).rejects.toThrow(
        'Untrusted cloud chats sender.',
      );
    expect(mockReadCredentials).not.toHaveBeenCalled();
  });

  it('confirms the key without the bridge, and a second click within 10 s shares the answer', async () => {
    const globalFetch = jest.spyOn(globalThis, 'fetch');
    await expect(clickReconnect()).resolves.toEqual({ ok: true });
    expect(mockReadCredentials).toHaveBeenCalledTimes(1);

    mockState.keyReadable = false;
    clock += CLOUD_CHATS_RECONNECT_WINDOW_MS - 1;
    await expect(clickReconnect()).resolves.toEqual({ ok: true });
    expect(mockReadCredentials).toHaveBeenCalledTimes(1);

    clock += 1;
    await expect(clickReconnect()).resolves.toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(mockReadCredentials).toHaveBeenCalledTimes(2);
    expect(mockBridge).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("main's binding opens with the stored desktop key and the cloud origin, never the bridge", async () => {
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json(
          { connectionId: 'conn-1', connectionToken: 'cwc_token' },
          { status: 201 },
        ),
      );
    const connection = await createWebCoreBindingProvider(
      desktopWebCoreBindingOptions(),
    )({
      caller: CALLER,
      webContentsId: 1,
      signal: new AbortController().signal,
    });
    expect(connection.connectionId).toBe('conn-1');
    const [url, init] = globalFetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(`${ORIGIN}/api/cloud/core/connections`));
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer csk_desktop',
    );
    expect(mockBridge).not.toHaveBeenCalled();
    connection.close();
  });
});
