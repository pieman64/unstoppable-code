import type * as ClientModule from '../client';
import type { PostHogRuntimeFlags } from '../types';
import type * as ElectronMainModule from '../electron/main';

interface CapturedMessage {
  event: string;
  properties: Record<string, unknown>;
}

type PostHogFetch = (
  url: string,
  options: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<unknown>;

const mockCapture = jest.fn<
  void,
  [{ distinctId?: string; event: string; properties?: Record<string, unknown> }]
>();
const mockCaptureException = jest.fn<
  void,
  [unknown, string | undefined, Record<string, unknown>]
>();
const mockShutdown = jest.fn<Promise<void>, [number]>();
const mockConstructor = jest.fn<object, [string, unknown]>(() => ({
  capture: mockCapture,
  captureException: mockCaptureException,
  shutdown: mockShutdown,
  on: jest.fn(),
}));
jest.mock('posthog-node', () => ({ PostHog: mockConstructor }), {
  virtual: true,
});
type BeforeSend = (event: CapturedMessage) => unknown;
let mockBeforeSend: BeforeSend | undefined;
/** Enough of the browser SDK for the renderer client to initialize. */
const mockBrowserSdk = {
  init: jest.fn((_key: string, config: { before_send?: BeforeSend }) => {
    mockBeforeSend = config.before_send;
  }),
  onSessionId: jest.fn(() => (): void => undefined),
  capture: jest.fn(),
  captureException: jest.fn(),
  register_for_session: jest.fn(),
  unregister_for_session: jest.fn(),
  sessionManager: { setBootstrapSessionId: (): boolean => true },
  requestRouter: { endpointFor: (): string => 'http://127.0.0.1:18763/s/' },
  _send_request: jest.fn(),
  _send_retriable_request: jest.fn(),
  _retryQueue: {
    retriableRequest: jest.fn(),
    unload: jest.fn(),
    resume: jest.fn(),
  },
  _requestQueue: { unload: jest.fn() },
  set_config: jest.fn(),
  opt_out_capturing: jest.fn(),
  opt_in_capturing: jest.fn(),
  startSessionRecording: jest.fn(),
  stopSessionRecording: jest.fn(),
  sessionRecordingStarted: jest.fn(() => false),
  sessionRecording: { onRemoteConfig: jest.fn() },
};
jest.mock(
  'posthog-js/dist/module.full.no-external',
  () => ({ __esModule: true, default: mockBrowserSdk }),
  { virtual: true },
);

const ANONYMOUS_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_URL = 'http://127.0.0.1:18763/batch/';
const EPOCH_KEY = '__canopy_operation_epoch';

function hasFetch(value: unknown): value is { fetch: PostHogFetch } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetch' in value &&
    typeof value.fetch === 'function'
  );
}

/** The delivery hook the most recent client was constructed with. */
function latestFetch(): PostHogFetch {
  const options: unknown = mockConstructor.mock.calls.at(-1)?.[1];
  if (!hasFetch(options)) throw new Error('Expected a PostHog delivery hook');
  return options.fetch;
}

function captured(): CapturedMessage[] {
  return [
    ...mockCapture.mock.calls.map(([message]) => ({
      event: message.event,
      properties: message.properties ?? {},
    })),
    ...mockCaptureException.mock.calls.map(([, , properties]) => ({
      event: '$exception',
      properties,
    })),
  ];
}

function capturedEvent(event: string): CapturedMessage {
  const message = captured().find((candidate) => candidate.event === event);
  if (!message) throw new Error(`Expected a captured ${event}`);
  return message;
}

/** Events that `sendPostHogRequest` lets through to the network. */
async function deliver(messages: CapturedMessage[]): Promise<string[]> {
  const outgoing = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}'));
  try {
    await latestFetch()(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'phc_test', batch: messages }),
    });
    const body: unknown = outgoing.mock.calls[0]?.[1]?.body;
    if (body === undefined) return [];
    if (typeof body !== 'string') throw new Error('Unexpected batch body');
    const payload: unknown = JSON.parse(body);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('batch' in payload) ||
      !Array.isArray(payload.batch)
    )
      throw new Error('Unexpected batch payload');
    return payload.batch.map((message: unknown) =>
      typeof message === 'object' && message !== null && 'event' in message
        ? String(message.event)
        : '',
    );
  } finally {
    outgoing.mockRestore();
  }
}

describe('PostHog main gating by usage-data policy', () => {
  let main: typeof ElectronMainModule;
  const getInstallLaunch = jest.fn(() =>
    Promise.resolve({ isFirstLaunch: true, isReinstall: false }),
  );

  beforeEach(async () => {
    jest.resetModules();
    mockConstructor.mockClear();
    mockCapture.mockClear();
    mockCaptureException.mockClear();
    mockShutdown.mockReset().mockResolvedValue(undefined);
    getInstallLaunch.mockClear();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
    });
    main = await import('../electron/main');
  });

  afterEach(() => {
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: false,
      __CANOPY_POSTHOG_PROJECT_KEY__: '',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
    });
  });

  async function start(policy: {
    events: boolean;
    errors: boolean;
    launchEvents: boolean;
  }): Promise<void> {
    main.setDesktopPostHogCapturePolicy(policy);
    await main.initializePostHogMain(
      () => Promise.resolve(ANONYMOUS_ID),
      undefined,
      getInstallLaunch,
    );
  }

  it('sends only error events while Usage analytics is off', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    main.succeedDesktopOperation('canopy.chat_turn');
    main.captureDesktopInstrumentationError(new Error('boom'));

    expect(captured().map(({ event }) => event)).toEqual(['$exception']);
    await expect(deliver(captured())).resolves.toEqual(['$exception']);
  });

  it('sends the launch event with its install facts once Usage analytics turns on', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    // The SDK flushes whatever it holds while analytics is still off.
    const flushedWhileOff = captured();
    await expect(deliver(flushedWhileOff)).resolves.toEqual([]);

    main.setDesktopPostHogCapturePolicy({
      events: true,
      errors: true,
      launchEvents: true,
    });
    main.setDesktopPostHogCapturePolicy({
      events: true,
      errors: true,
      launchEvents: true,
    });

    const launches = captured()
      .slice(flushedWhileOff.length)
      .filter(({ event }) => event === 'desktop:app_start');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.properties).toEqual(
      expect.objectContaining({ is_first_launch: true, is_reinstall: false }),
    );
    await expect(deliver(launches)).resolves.toEqual(['desktop:app_start']);
  });

  it('leaves out the account domain from errors while Usage analytics is off', async () => {
    main.setDesktopPostHogCapturePolicy({
      events: false,
      errors: true,
      launchEvents: false,
    });
    await main.initializePostHogMain(() => Promise.resolve(ANONYMOUS_ID), {
      getSnapshot: () => Promise.resolve('person@example.com'),
      onSnapshotChanged: (): (() => void) => (): void => undefined,
    });
    await main.getDesktopPostHogEmailDomain();
    main.captureDesktopInstrumentationError(new Error('boom'));

    const properties = capturedEvent('$exception').properties;
    expect(properties).not.toHaveProperty('email_domain');
    expect(properties.$process_person_profile).toBe(false);
  });

  it('drops queued errors once Error reports turns off', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    main.captureDesktopInstrumentationError(new Error('boom'));
    const queued = captured();

    main.setDesktopPostHogCapturePolicy({
      events: true,
      errors: false,
      launchEvents: true,
    });
    main.captureDesktopInstrumentationError(new Error('after'));

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    await expect(deliver(queued)).resolves.toEqual(['desktop:app_start']);
  });

  it('keeps a queued desktop:app_start when only the LaunchDarkly flag turns off', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    main.succeedDesktopOperation('canopy.chat_turn');
    const queued = captured();

    main.setDesktopPostHogCapturePolicy({
      events: false,
      errors: false,
      launchEvents: true,
    });

    await expect(deliver(queued)).resolves.toEqual(['desktop:app_start']);
  });

  it('drops a queued desktop:app_start once Usage analytics turns off', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    const queued = captured();

    main.setDesktopPostHogCapturePolicy({
      events: false,
      errors: true,
      launchEvents: false,
    });

    await expect(deliver(queued)).resolves.toEqual([]);
  });

  it('does not revive events captured before an off/on toggle', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    main.succeedDesktopOperation('canopy.chat_turn');
    main.captureDesktopInstrumentationError(new Error('boom'));
    const queued = captured();

    const off = { events: false, errors: false, launchEvents: false };
    const on = { events: true, errors: true, launchEvents: true };
    main.setDesktopPostHogCapturePolicy(off);
    main.setDesktopPostHogCapturePolicy(on);

    await expect(deliver(queued)).resolves.toEqual([]);
  });

  it('restarts with one client and no second desktop:app_start', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    const firstShutdown = mockShutdown;

    main.setDesktopPostHogCapturePolicy({
      events: false,
      errors: false,
      launchEvents: false,
    });
    const suspended = main.suspendPostHogMain();
    // A flip back on while the shutdown is in flight waits for it.
    main.setDesktopPostHogCapturePolicy({
      events: true,
      errors: true,
      launchEvents: true,
    });
    const restarted = main.initializePostHogMain(
      () => Promise.resolve(ANONYMOUS_ID),
      undefined,
      getInstallLaunch,
    );
    await suspended;
    await expect(restarted).resolves.toEqual({
      enabled: true,
      provider: 'posthog',
    });

    expect(firstShutdown).toHaveBeenCalledTimes(1);
    expect(mockConstructor).toHaveBeenCalledTimes(2);
    expect(getInstallLaunch).toHaveBeenCalledTimes(1);
    expect(
      captured().filter(({ event }) => event === 'desktop:app_start'),
    ).toHaveLength(1);

    main.succeedDesktopOperation('canopy.chat_turn');
    const operation = captured().at(-1);
    expect(operation?.properties[EPOCH_KEY]).toEqual(expect.any(Number));
    await expect(deliver(operation ? [operation] : [])).resolves.toEqual([
      'chat:turn_end',
    ]);
  });
});

describe('PostHog renderer identity by usage-data policy', () => {
  let client: typeof ClientModule;

  beforeEach(async () => {
    jest.resetModules();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
      __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 100,
    });
    client = await import('../client');
  });

  afterEach(() => {
    client.disposePostHogInstrumentationClient();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: false,
      __CANOPY_POSTHOG_PROJECT_KEY__: '',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
      __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 0,
    });
  });

  function flags(open: boolean): PostHogRuntimeFlags {
    return {
      captureEnabled: true,
      sessionReplaySampleRate: 0,
      autocaptureEnabled: false,
      productAnalytics: open,
      errorReports: false,
      sessionReplay: false,
    };
  }

  // Main's identity store creates `posthog-context.json` on first read.
  it('asks main for its identity only once a category opens', async () => {
    let push: ((next: PostHogRuntimeFlags) => void) | undefined;
    const getPostHogAnonymousId = jest.fn(() => Promise.resolve(ANONYMOUS_ID));
    const initialization = client.initializeDesktopInstrumentationClient({
      surface: 'main',
      getPostHogAnonymousId,
      posthogFlags: {
        getSnapshot: () => Promise.resolve(flags(false)),
        onSnapshotChanged: (listener): (() => void) => {
          push = listener;
          return (): void => undefined;
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getPostHogAnonymousId).not.toHaveBeenCalled();

    push?.(flags(true));
    await initialization;
    expect(getPostHogAnonymousId).toHaveBeenCalledTimes(1);
  });

  it('never asks for an identity when disposed while both are off', async () => {
    const getPostHogAnonymousId = jest.fn(() => Promise.resolve(ANONYMOUS_ID));
    const initialization = client.initializeDesktopInstrumentationClient({
      surface: 'main',
      getPostHogAnonymousId,
      posthogFlags: {
        getSnapshot: () => Promise.resolve(flags(false)),
        onSnapshotChanged: (): (() => void) => (): void => undefined,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.disposePostHogInstrumentationClient();

    await expect(initialization).resolves.toEqual([
      { enabled: false, provider: 'posthog', reason: 'disabled' },
    ]);
    expect(getPostHogAnonymousId).not.toHaveBeenCalled();
  });

  it('leaves out the account domain from errors while Usage analytics is off', async () => {
    const session = {
      sessionId: '01890000-0000-7000-8000-000000000000',
      revision: 0,
    };
    await expect(
      client.initializeDesktopInstrumentationClient({
        surface: 'main',
        getPostHogAnonymousId: () => Promise.resolve(ANONYMOUS_ID),
        posthogFlags: {
          getSnapshot: () =>
            Promise.resolve({ ...flags(false), errorReports: true }),
          onSnapshotChanged: (): (() => void) => (): void => undefined,
        },
        posthogAccount: {
          getSnapshot: () => Promise.resolve('example.com'),
          onSnapshotChanged: (): (() => void) => (): void => undefined,
        },
        posthogSession: {
          get: () => Promise.resolve(session),
          report: (proposal) => Promise.resolve(proposal),
          subscribe: (): (() => void) => (): void => undefined,
        },
      }),
    ).resolves.toEqual([{ enabled: true, provider: 'posthog' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = mockBeforeSend?.({
      event: '$exception',
      properties: {
        distinct_id: ANONYMOUS_ID,
        token: 'phc_test',
        $session_id: session.sessionId,
      },
    });
    const properties: unknown =
      typeof sent === 'object' && sent !== null && 'properties' in sent
        ? sent.properties
        : undefined;
    expect(properties).toHaveProperty('$process_person_profile', false);
    expect(properties).not.toHaveProperty('email_domain');
    expect(JSON.stringify(sent)).not.toContain('example.com');
  });

  it.each([
    [
      'Usage analytics turns off while Error reports stays on',
      { ...flags(true), errorReports: true },
      { ...flags(false), errorReports: true },
    ],
    [
      'only Session recordings turns off',
      { ...flags(true), sessionReplay: true, sessionReplaySampleRate: 100 },
      { ...flags(true), sessionReplay: false, sessionReplaySampleRate: 100 },
    ],
  ])('drops queued batches when %s', async (_case, initial, next) => {
    // The runtime guard wraps this transport while the client is installed.
    const transport = mockBrowserSdk._send_retriable_request;
    transport.mockClear();
    mockBrowserSdk._requestQueue.unload.mockClear();
    let push: ((next: PostHogRuntimeFlags) => void) | undefined;
    const session = {
      sessionId: '01890000-0000-7000-8000-000000000000',
      revision: 0,
    };
    await expect(
      client.initializeDesktopInstrumentationClient({
        surface: 'main',
        getPostHogAnonymousId: () => Promise.resolve(ANONYMOUS_ID),
        posthogFlags: {
          getSnapshot: () => Promise.resolve(initial),
          onSnapshotChanged: (listener): (() => void) => {
            push = listener;
            return (): void => undefined;
          },
        },
        posthogSession: {
          get: () => Promise.resolve(session),
          report: (proposal) => Promise.resolve(proposal),
          subscribe: (): (() => void) => (): void => undefined,
        },
      }),
    ).resolves.toEqual([{ enabled: true, provider: 'posthog' }]);
    // posthog-js `RequestQueue.unload` beacons fresh batch objects through
    // the SDK's (guarded) retriable transport instead of discarding them.
    mockBrowserSdk._requestQueue.unload.mockImplementation((): void => {
      mockBrowserSdk._send_retriable_request({ url: '/s/', data: [] });
    });
    try {
      push?.(next);
      expect(mockBrowserSdk._requestQueue.unload).toHaveBeenCalledTimes(1);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      mockBrowserSdk._requestQueue.unload.mockReset();
    }
  });
});
