import { EventEmitter } from 'node:events';
import { BRAND } from '@canopy/brand/current';
import { settingsOperationRequest } from '@canopy/protocol/settings';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

const ORIGIN = 'https://cloud.test';
const ACCOUNT_ID = 'account-1';
const CONSUME_PATH = `/api/v1/${BRAND.web.apiNamespace}/auth-link/consume`;
const BOOTSTRAP_PATH = settingsOperationRequest('settings.bootstrap', {}).path;

const mockIpcHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>();

/** The stub cloud: whether the flag is on, who is signed in, and whether the web session is live. */
const mockState: {
  flagEnabled: boolean;
  accountId: string | null;
  sessionValid: boolean;
} = { flagEnabled: true, accountId: ACCOUNT_ID, sessionValid: false };

const mintAuthLink = jest.fn(
  (): Promise<unknown> =>
    Promise.resolve({ url: `${ORIGIN}${CONSUME_PATH}?token=t` }),
);

/** What the stub cloud answers each bridge request with. */
function mockRespond(
  url: string,
  method: string,
): { status: number; body?: string; location?: string } {
  const { pathname } = new URL(url);
  if (pathname === CONSUME_PATH) {
    mockState.sessionValid = true;
    return { status: 303, location: `${ORIGIN}/` };
  }
  if (pathname === BOOTSTRAP_PATH)
    return {
      status: 200,
      body: JSON.stringify({
        version: 1,
        viewer: { id: ACCOUNT_ID, email: 'a@example.com', name: null },
        account: {
          billingEnabled: false,
          digestsEnabled: false,
          integrationsEnabled: false,
          freeAccess: false,
        },
        organizations: [],
        organization: null,
      }),
    };
  if (pathname.startsWith('/api/cloud/core/')) {
    // The web core refuses a session that was signed out or expired.
    if (!mockState.sessionValid) return { status: 401 };
    if (pathname === '/api/cloud/core/connections' && method === 'POST')
      return { status: 201, body: JSON.stringify({ connectionId: 'conn-1' }) };
    return { status: 204 };
  }
  return { status: 200, body: '{}' };
}

jest.mock('electron', () => {
  class FakeRequest extends EventEmitter {
    constructor(
      private readonly url: string,
      private readonly method: string,
    ) {
      super();
    }
    setHeader(): void {}
    write(): void {}
    abort(): void {}
    end(): void {
      setImmediate(() => {
        const answer = mockRespond(this.url, this.method);
        if (answer.location !== undefined) {
          this.emit('redirect', answer.status, 'GET', answer.location, {});
          return;
        }
        const message = new EventEmitter();
        Object.assign(message, {
          statusCode: answer.status,
          statusMessage: '',
          headers: { 'content-type': 'application/json' },
        });
        this.emit('response', message);
        if (answer.body !== undefined)
          message.emit('data', Buffer.from(answer.body));
        message.emit('end');
      });
    }
  }
  return {
    app: {
      on: jest.fn(),
      removeListener: jest.fn(),
      getVersion: (): string => '0.0.0',
    },
    ipcMain: {
      handle: (
        channel: string,
        handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
      ): void => {
        mockIpcHandlers.set(channel, handler);
      },
      removeHandler: (channel: string): void => {
        mockIpcHandlers.delete(channel);
      },
    },
    net: {
      request: (options: { url: string; method: string }): FakeRequest =>
        new FakeRequest(options.url, options.method),
    },
    session: {
      fromPartition: (): Record<string, unknown> => ({
        setPermissionRequestHandler: jest.fn(),
        setPermissionCheckHandler: jest.fn(),
        clearStorageData: (): Promise<void> => Promise.resolve(),
      }),
    },
  };
});

jest.mock('../client', () => ({
  ...jest.requireActual<object>('../client'),
  requestCanopyCloudJson: (): Promise<unknown> => mintAuthLink(),
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
  getCanopyCloudCredentials: (): Promise<unknown> =>
    Promise.resolve({
      baseUrl: ORIGIN,
      apiKey: 'csk_test',
      account: { id: ACCOUNT_ID },
      capabilities: [],
    }),
  hasCanopyCloudIdentityChanged: (): boolean => false,
  peekCanopyCloudAccount: (): null => null,
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  acquireSettingsBridgeSession,
  resetSettingsBridgeForTests,
} from '../settings-session';
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
  return handler(event);
}

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-renderer:main',
  clientInstanceId: 'renderer-relay:test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

/** The cloud section's next web core connection, as the relay opens it. */
function openCloudConnection(): ReturnType<
  ReturnType<typeof createWebCoreBindingProvider>
> {
  return createWebCoreBindingProvider(desktopWebCoreBindingOptions())({
    caller: CALLER,
    webContentsId: 1,
    signal: new AbortController().signal,
  });
}

let clock = 1_000_000;
beforeEach(() => {
  mockState.flagEnabled = true;
  mockState.accountId = ACCOUNT_ID;
  mockState.sessionValid = false;
  clock += 60_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  registerHandlers();
});

afterEach(() => {
  resetSettingsBridgeForTests();
  mintAuthLink.mockClear();
  mockIpcHandlers.clear();
  jest.restoreAllMocks();
});

/** Sign the web session out under the bridge; its next request answers 401. */
async function expireBridge(): Promise<void> {
  const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
  await session.ensureReady();
  mockState.sessionValid = false;
  const response = await session.fetch('/api/cloud/core/connections', {
    method: 'POST',
    authOrigin: true,
  });
  expect(response.status).toBe(401);
  expect(session.state).toBe('expired');
}

describe('cloud-chats:reconnect (CAN-4185 PR-C)', () => {
  it('flag off is refused without minting', async () => {
    mockState.flagEnabled = false;
    await expect(clickReconnect()).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(mintAuthLink).not.toHaveBeenCalled();
  });

  it('signed out is refused without minting', async () => {
    mockState.accountId = null;
    await expect(clickReconnect()).resolves.toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(mintAuthLink).not.toHaveBeenCalled();
  });

  it('a sender other than the main window is refused without minting', async () => {
    await expireBridge();
    mintAuthLink.mockClear();
    // App Advisor, a renderer the app does not own (a Portal or bridge
    // client), a stale document and a frameless synthetic event.
    const stranger = rendererEvent(3, MAIN_URL);
    const navigated = rendererEvent(1, 'https://example.com/');
    const frameless: RendererRelayEvent = { ...mainEvent, senderFrame: null };
    for (const event of [advisorEvent, stranger, navigated, frameless])
      await expect(clickReconnect(event)).rejects.toThrow(
        'Untrusted cloud chats sender.',
      );
    expect(mintAuthLink).not.toHaveBeenCalled();
  });

  it('a 401 leaves the bridge expired; reconnect remints once, and a second click within 10 s does not mint again', async () => {
    await expireBridge();
    expect(mintAuthLink).toHaveBeenCalledTimes(1);
    // The relay's own requests never remint an expired bridge.
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    await expect(
      session.fetch('/api/cloud/core/connections', { method: 'POST' }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(mintAuthLink).toHaveBeenCalledTimes(1);

    await expect(clickReconnect()).resolves.toEqual({ ok: true });
    expect(mintAuthLink).toHaveBeenCalledTimes(2);
    expect(session.state).toBe('ready');

    // Expired again, but a click inside the window shares the last attempt.
    await expireBridge();
    clock += CLOUD_CHATS_RECONNECT_WINDOW_MS - 1;
    await expect(clickReconnect()).resolves.toEqual({ ok: true });
    expect(mintAuthLink).toHaveBeenCalledTimes(2);
    expect(session.state).toBe('expired');

    clock += 1;
    await expect(clickReconnect()).resolves.toEqual({ ok: true });
    expect(mintAuthLink).toHaveBeenCalledTimes(3);
    expect(session.state).toBe('ready');
  });

  it('a successful remint lets the cloud section connect again', async () => {
    const first = await openCloudConnection();
    expect(first.connectionId).toBe('conn-1');
    first.close();
    expect(mintAuthLink).toHaveBeenCalledTimes(1);

    // The web session is revoked: the next open is refused and the bridge
    // expires, and further opens stay refused without minting.
    mockState.sessionValid = false;
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(openCloudConnection()).rejects.toMatchObject({
        payload: { kind: 'unauthenticated' },
      });
    expect(mintAuthLink).toHaveBeenCalledTimes(1);

    await expect(clickReconnect()).resolves.toEqual({ ok: true });
    const resubscribed = await openCloudConnection();
    expect(resubscribed.connectionId).toBe('conn-1');
    expect(resubscribed.signal.aborted).toBe(false);
    expect(mintAuthLink).toHaveBeenCalledTimes(2);
    resubscribed.close();
  });
});
