const mockOpenExternal = jest.fn<Promise<void>, [string]>();
const mockReadPreferencesFile = jest.fn();
const mockHostedSettingsEnabled = jest.fn<boolean, []>();
const mockGetCanopyCloudBaseUrl = jest.fn<string, []>();

jest.mock('electron', () => ({
  app: {
    getApplicationInfoForProtocol: (): Promise<never> =>
      Promise.reject(new Error('not available in tests')),
    isDefaultProtocolClient: (): boolean => false,
  },
  shell: {
    openExternal: (url: string): Promise<void> => mockOpenExternal(url),
  },
}));

jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => false,
}));
jest.mock('../lib/e2e-mock-control-plane', () => ({
  getE2eExternalOpenCaptureUrl: (): string | null => null,
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: (): void => undefined,
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): unknown => mockReadPreferencesFile(),
}));
jest.mock('../services/hosted-settings-feature-flag', () => ({
  isHostedSettingsEnabled: (): boolean => mockHostedSettingsEnabled(),
}));
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => mockGetCanopyCloudBaseUrl(),
}));

import {
  IPC_CHANNELS,
  type AppLinkBrowserEvent,
} from '@canopy/desktop-shared/types';
import {
  resetAppLinkRouterForTests,
  resolveAppLinkRequest,
  routeAppLink,
} from '../browser/app-link-router';

const WEB_ORIGIN = 'https://app.example.test';
const BILLING_URL = `${WEB_ORIGIN}/account/billing?tab=x#y`;

type Sender = {
  id: number;
  isDestroyed: jest.Mock<boolean, []>;
  send: jest.Mock<void, [string, AppLinkBrowserEvent]>;
};

function makeSender(id = 42): Sender {
  return {
    id,
    isDestroyed: jest.fn(() => false),
    send: jest.fn<void, [string, AppLinkBrowserEvent]>(),
  };
}

function sentEvents(sender: Sender): AppLinkBrowserEvent[] {
  return sender.send.mock.calls
    .filter(([channel]) => channel === IPC_CHANNELS.browserEvent)
    .map(([, event]) => event);
}

function settingsEvents(
  sender: Sender,
): Extract<AppLinkBrowserEvent, { type: 'settings-link-open-requested' }>[] {
  return sentEvents(sender).filter(
    (
      event,
    ): event is Extract<
      AppLinkBrowserEvent,
      { type: 'settings-link-open-requested' }
    > => event.type === 'settings-link-open-requested',
  );
}

function openEvents(
  sender: Sender,
): Extract<AppLinkBrowserEvent, { type: 'app-link-open-requested' }>[] {
  return sentEvents(sender).filter(
    (
      event,
    ): event is Extract<
      AppLinkBrowserEvent,
      { type: 'app-link-open-requested' }
    > => event.type === 'app-link-open-requested',
  );
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe('routeAppLink settings hand-off', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenExternal.mockResolvedValue(undefined);
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: false,
      inAppBrowserLocalServersOnly: false,
    });
    mockHostedSettingsEnabled.mockReturnValue(true);
    mockGetCanopyCloudBaseUrl.mockReturnValue(WEB_ORIGIN);
  });

  afterEach(() => {
    resetAppLinkRouterForTests();
    jest.useRealTimers();
  });

  it('asks the sender renderer to open a web settings link inside Settings', async () => {
    const sender = makeSender();
    const pending = routeAppLink({
      url: BILLING_URL,
      sender,
      source: 'app-link',
    });
    await flushMicrotasks();

    const [event] = settingsEvents(sender);
    expect(event).toMatchObject({
      type: 'settings-link-open-requested',
      url: BILLING_URL,
      path: '/account/billing?tab=x#y',
    });
    expect(event?.requestId).toMatch(/\S/);
    expect(
      resolveAppLinkRequest(sender, {
        requestId: event?.requestId ?? '',
        handled: true,
        phase: 'acknowledge',
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe('settings');
    expect(mockReadPreferencesFile).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('falls through to the external open when the renderer declines', async () => {
    const sender = makeSender();
    const pending = routeAppLink({
      url: BILLING_URL,
      sender,
      source: 'app-link',
    });
    await flushMicrotasks();
    const [event] = settingsEvents(sender);
    resolveAppLinkRequest(sender, {
      requestId: event?.requestId ?? '',
      handled: false,
      phase: 'acknowledge',
    });

    await expect(pending).resolves.toBe('external');
    expect(mockReadPreferencesFile).toHaveBeenCalledTimes(1);
    expect(mockOpenExternal).toHaveBeenCalledWith(BILLING_URL);
  });

  it('falls through to the built-in browser request with a fresh request id when declined', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      openAppLinksInBuiltInBrowser: true,
      inAppBrowserLocalServersOnly: false,
    });
    const sender = makeSender();
    const pending = routeAppLink({
      url: BILLING_URL,
      sender,
      source: 'app-link',
    });
    await flushMicrotasks();
    const [settingsEvent] = settingsEvents(sender);
    resolveAppLinkRequest(sender, {
      requestId: settingsEvent?.requestId ?? '',
      handled: false,
      phase: 'acknowledge',
    });
    await flushMicrotasks();
    const [openEvent] = openEvents(sender);
    expect(openEvent?.requestId).toEqual(expect.any(String));
    expect(openEvent?.requestId).not.toBe(settingsEvent?.requestId);
    resolveAppLinkRequest(sender, {
      requestId: openEvent?.requestId ?? '',
      handled: true,
      phase: 'acknowledge',
    });

    await expect(pending).resolves.toBe('in-app');
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('falls through to existing routing when the renderer never answers', async () => {
    jest.useFakeTimers();
    const sender = makeSender();
    const pending = routeAppLink({
      url: BILLING_URL,
      sender,
      source: 'app-link',
    });
    await flushMicrotasks();
    expect(settingsEvents(sender)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1_500);

    await expect(pending).resolves.toBe('external');
    expect(mockOpenExternal).toHaveBeenCalledWith(BILLING_URL);
  });

  it('ignores a complete-phase reply to a settings request', async () => {
    jest.useFakeTimers();
    const sender = makeSender();
    const pending = routeAppLink({
      url: BILLING_URL,
      sender,
      source: 'app-link',
    });
    await flushMicrotasks();
    const [event] = settingsEvents(sender);

    expect(() =>
      resolveAppLinkRequest(sender, {
        requestId: event?.requestId ?? '',
        handled: true,
        phase: 'complete',
      }),
    ).not.toThrow();
    expect(
      resolveAppLinkRequest(sender, {
        requestId: event?.requestId ?? '',
        handled: true,
        phase: 'complete',
      }),
    ).toBe(false);

    await jest.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toBe('external');
  });

  it('ignores an acknowledgement from a different sender', async () => {
    jest.useFakeTimers();
    const sender = makeSender(42);
    const pending = routeAppLink({
      url: BILLING_URL,
      sender,
      source: 'app-link',
    });
    await flushMicrotasks();
    const [event] = settingsEvents(sender);

    expect(
      resolveAppLinkRequest(makeSender(7), {
        requestId: event?.requestId ?? '',
        handled: true,
        phase: 'acknowledge',
      }),
    ).toBe(false);

    await jest.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toBe('external');
    expect(mockOpenExternal).toHaveBeenCalledWith(BILLING_URL);
  });

  it.each([
    [
      'the main-process flag is off',
      (): void => {
        mockHostedSettingsEnabled.mockReturnValue(false);
      },
      BILLING_URL,
      'app-link',
    ],
    [
      'the flag service throws',
      (): void => {
        mockHostedSettingsEnabled.mockImplementation(() => {
          throw new Error('flag service unavailable');
        });
      },
      BILLING_URL,
      'app-link',
    ],
    [
      'the web origin is unconfigured',
      (): void => {
        mockGetCanopyCloudBaseUrl.mockImplementation(() => {
          throw new Error('CanopyCloudConfigError: missing base URL');
        });
      },
      BILLING_URL,
      'app-link',
    ],
    [
      'the link came from the OS',
      (): void => undefined,
      BILLING_URL,
      'system-default',
    ],
    [
      'the path is not a settings page',
      (): void => undefined,
      `${WEB_ORIGIN}/pricing`,
      'app-link',
    ],
    [
      'the path is a share page',
      (): void => undefined,
      `${WEB_ORIGIN}/share/abc`,
      'app-link',
    ],
    [
      'the path is a legal page',
      (): void => undefined,
      `${WEB_ORIGIN}/legal`,
      'app-link',
    ],
    [
      'the path is checkout',
      (): void => undefined,
      `${WEB_ORIGIN}/checkout`,
      'app-link',
    ],
    [
      'the origin is foreign',
      (): void => undefined,
      'https://evil.example/account/billing',
      'app-link',
    ],
  ] as const)(
    "keeps today's routing when %s",
    async (_label, arrange, url, source) => {
      arrange();
      mockReadPreferencesFile.mockResolvedValue({
        openAppLinksInBuiltInBrowser: false,
        inAppBrowserLocalServersOnly: false,
        useAsSystemDefaultBrowser: false,
      });
      const sender = makeSender();

      await expect(routeAppLink({ url, sender, source })).resolves.toBe(
        'external',
      );
      expect(settingsEvents(sender)).toHaveLength(0);
      expect(mockReadPreferencesFile).toHaveBeenCalledTimes(1);
      expect(mockOpenExternal).toHaveBeenCalledWith(url);
    },
  );

  it('opens externally without an event when there is no sender', async () => {
    await expect(
      routeAppLink({ url: BILLING_URL, sender: null, source: 'app-link' }),
    ).resolves.toBe('external');
    expect(mockOpenExternal).toHaveBeenCalledWith(BILLING_URL);
  });

  it('opens externally without an event when the sender is destroyed', async () => {
    const sender = makeSender();
    sender.isDestroyed.mockReturnValue(true);

    await expect(
      routeAppLink({ url: BILLING_URL, sender, source: 'app-link' }),
    ).resolves.toBe('external');
    expect(sender.send).not.toHaveBeenCalled();
    expect(mockOpenExternal).toHaveBeenCalledWith(BILLING_URL);
  });
});
