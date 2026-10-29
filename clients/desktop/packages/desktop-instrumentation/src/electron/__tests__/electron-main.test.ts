import type * as ElectronMainModule from '../main';
import type { PostHog } from 'posthog-node';
import { DESKTOP_OPERATIONS } from '../../operations';
import {
  EXPECTED_OPERATION_EVENTS,
  PRODUCT_OPERATION_EVENTS,
} from '../../__tests__/operation-events';
jest.mock('@datadog/electron-sdk', () => ({
  init: jest.fn(() => Promise.resolve(true)),
  startOperation: jest.fn(),
  succeedOperation: jest.fn(),
  failOperation: jest.fn(),
  addError: jest.fn(),
  notifyActivity: jest.fn(),
  setUser: jest.fn(),
}));

import type * as DatadogElectronSdkModule from '@datadog/electron-sdk';
import type {
  captureDesktopInstrumentationError as captureDesktopInstrumentationErrorFunction,
  failDesktopOperation as failDesktopOperationFunction,
  initializeDesktopInstrumentationMain as initializeDesktopInstrumentationMainFunction,
  keepDesktopInstrumentationSessionAlive as keepDesktopInstrumentationSessionAliveFunction,
  setDesktopInstrumentationUser as setDesktopInstrumentationUserFunction,
  startDesktopOperation as startDesktopOperationFunction,
  succeedDesktopOperation as succeedDesktopOperationFunction,
} from '../main';

type DatadogElectronSdk = typeof DatadogElectronSdkModule;

const ANON_ID = '11111111-2222-4333-8444-555555555555';
const POSTHOG_PERSON_ID = '22222222-2222-4222-8222-222222222222';
const POSTHOG_SESSION_ID = '33333333-3333-4333-8333-333333333333';
// Derived non-PII display name; without usr.name the Datadog RUM UI labels
// every session "Public User".
const EXPECTED_USER = { id: ANON_ID, name: 'anon-11111111' };

let datadogSdkMock: jest.Mocked<DatadogElectronSdk>;
let notifyActivityMock: jest.Mock;
let setUserMock: jest.Mock;
let initializeDesktopInstrumentationMain: typeof initializeDesktopInstrumentationMainFunction;
let setDesktopInstrumentationUser: typeof setDesktopInstrumentationUserFunction;
let startDesktopOperation: typeof startDesktopOperationFunction;

function readPatchedMockExport(module: object, name: string): jest.Mock {
  const value: unknown = Reflect.get(module, name);
  if (!jest.isMockFunction(value)) {
    throw new Error(`Expected ${name} to be a Jest mock function`);
  }
  return value;
}

function setDatadogSdkMock(sdkModule: DatadogElectronSdk): void {
  datadogSdkMock = jest.mocked(sdkModule);
  notifyActivityMock = readPatchedMockExport(sdkModule, 'notifyActivity');
  setUserMock = readPatchedMockExport(sdkModule, 'setUser');
}

describe('desktop instrumentation main user identity', () => {
  beforeEach(async () => {
    jest.resetModules();
    Object.assign(globalThis, {
      __CANOPY_DATADOG_ENABLED__: true,
      __CANOPY_DATADOG_CLIENT_TOKEN__: 'client-token',
      __CANOPY_DATADOG_APPLICATION_ID__: 'application-id',
      __CANOPY_DATADOG_ENV__: 'staging',
      __CANOPY_DATADOG_VARIANT__: 'internal-canopy',
      __CANOPY_DATADOG_PROXY__: 'http://127.0.0.1:8126',
    });
    const sdkModule = await import('@datadog/electron-sdk');
    setDatadogSdkMock(sdkModule);
    ({
      initializeDesktopInstrumentationMain,
      setDesktopInstrumentationUser,
      startDesktopOperation,
    } = await import('../main'));
    await initializeDesktopInstrumentationMain();
  });

  afterEach(() => {
    Object.assign(globalThis, {
      __CANOPY_DATADOG_ENABLED__: false,
      __CANOPY_DATADOG_CLIENT_TOKEN__: '',
      __CANOPY_DATADOG_APPLICATION_ID__: '',
      __CANOPY_DATADOG_ENV__: '',
      __CANOPY_DATADOG_VARIANT__: '',
      __CANOPY_DATADOG_PROXY__: '',
    });
  });

  it('omits anon_id before setDesktopInstrumentationUser is called', () => {
    startDesktopOperation('canopy.chat_turn', { context: { channel: 'chat' } });

    // The context must deep-equal `{ channel: 'chat' }`; if `anon_id` had been
    // injected, this exact-object match would fail.
    expect(datadogSdkMock.startOperation).toHaveBeenCalledWith(
      'canopy.chat_turn',
      expect.objectContaining({ context: { channel: 'chat' } }),
    );
  });

  it('injects anon_id once setDesktopInstrumentationUser is called', () => {
    setDesktopInstrumentationUser(ANON_ID);
    startDesktopOperation('canopy.chat_turn', { context: { channel: 'chat' } });

    expect(datadogSdkMock.startOperation).toHaveBeenCalledWith(
      'canopy.chat_turn',
      expect.objectContaining({
        context: { channel: 'chat', anon_id: ANON_ID },
      }),
    );
  });

  it('injects anon_id even when no operation context is supplied', () => {
    setDesktopInstrumentationUser(ANON_ID);
    startDesktopOperation('canopy.chat_turn');

    expect(datadogSdkMock.startOperation).toHaveBeenCalledWith(
      'canopy.chat_turn',
      {
        context: { anon_id: ANON_ID },
      },
    );
  });

  it('sets usr.id on the SDK so sessions/vitals get native user attribution', () => {
    setDesktopInstrumentationUser(ANON_ID);

    expect(setUserMock).toHaveBeenCalledWith(EXPECTED_USER);
  });

  it('sets usr.email on the SDK when a cloud account email is available', () => {
    setDesktopInstrumentationUser(ANON_ID, ' user@example.test ');

    expect(setUserMock).toHaveBeenCalledWith({
      ...EXPECTED_USER,
      email: 'user@example.test',
    });
  });

  it('does not attach PostHog person or session identifiers to Datadog operations', () => {
    setDesktopInstrumentationUser(ANON_ID);
    startDesktopOperation('canopy.chat_turn', {
      context: {
        channel: 'chat',
        distinct_id: POSTHOG_PERSON_ID,
        $session_id: POSTHOG_SESSION_ID,
        posthog_session_id: POSTHOG_SESSION_ID,
      },
    });

    expect(datadogSdkMock.startOperation).toHaveBeenCalledWith(
      'canopy.chat_turn',
      expect.objectContaining({
        context: { channel: 'chat', anon_id: ANON_ID },
      }),
    );
  });

  it('passes the release environment and variant to Electron RUM init', () => {
    expect(datadogSdkMock.init).toHaveBeenCalledWith(
      expect.objectContaining({
        env: 'staging',
        variant: 'internal-canopy',
      }),
    );
  });

  it('applies a pre-init anon id to the SDK once init completes', async () => {
    jest.resetModules();
    const sdkModule = await import('@datadog/electron-sdk');
    const sdkSetUserMock = readPatchedMockExport(sdkModule, 'setUser');
    sdkSetUserMock.mockClear();
    const main = await import('../main');

    main.setDesktopInstrumentationUser(ANON_ID);
    expect(sdkSetUserMock).not.toHaveBeenCalled();

    await main.initializeDesktopInstrumentationMain();
    expect(sdkSetUserMock).toHaveBeenCalledWith(EXPECTED_USER);
  });
});

const ENABLED_GLOBALS = {
  __CANOPY_DATADOG_ENABLED__: true,
  __CANOPY_DATADOG_CLIENT_TOKEN__: 'client-token',
  __CANOPY_DATADOG_APPLICATION_ID__: 'application-id',
  __CANOPY_DATADOG_PROXY__: 'http://127.0.0.1:8126',
};

const DISABLED_GLOBALS = {
  __CANOPY_DATADOG_ENABLED__: false,
  __CANOPY_DATADOG_CLIENT_TOKEN__: '',
  __CANOPY_DATADOG_APPLICATION_ID__: '',
  __CANOPY_DATADOG_PROXY__: '',
};

describe('desktop instrumentation session keepalive', () => {
  let captureDesktopInstrumentationError: typeof captureDesktopInstrumentationErrorFunction;
  let failDesktopOperation: typeof failDesktopOperationFunction;
  let keepDesktopInstrumentationSessionAlive: typeof keepDesktopInstrumentationSessionAliveFunction;
  let succeedDesktopOperation: typeof succeedDesktopOperationFunction;

  async function loadMain(): Promise<void> {
    const sdkModule = await import('@datadog/electron-sdk');
    setDatadogSdkMock(sdkModule);
    ({
      captureDesktopInstrumentationError,
      failDesktopOperation,
      initializeDesktopInstrumentationMain,
      keepDesktopInstrumentationSessionAlive,
      startDesktopOperation,
      succeedDesktopOperation,
    } = await import('../main'));
  }

  beforeEach(() => {
    jest.resetModules();
    Object.assign(globalThis, ENABLED_GLOBALS);
  });

  afterEach(() => {
    Object.assign(globalThis, DISABLED_GLOBALS);
  });

  it('renews the session before emitting each operation', async () => {
    await loadMain();
    await initializeDesktopInstrumentationMain();

    startDesktopOperation('canopy.chat_turn');
    succeedDesktopOperation('canopy.agent_task');
    failDesktopOperation('canopy.pipeline_execution', 'error');
    captureDesktopInstrumentationError(new Error('boom'));

    expect(notifyActivityMock).toHaveBeenCalledTimes(4);

    const order = (fn: jest.Mock): number => {
      const [first] = fn.mock.invocationCallOrder;
      if (first === undefined) {
        throw new Error('expected the mock to have been invoked');
      }
      return first;
    };

    // Each emitter must renew before it emits so the op lands in a live session.
    expect(order(notifyActivityMock)).toBeLessThan(
      order(datadogSdkMock.startOperation),
    );
    expect(notifyActivityMock.mock.invocationCallOrder[1]).toBeLessThan(
      order(datadogSdkMock.succeedOperation),
    );
    expect(notifyActivityMock.mock.invocationCallOrder[2]).toBeLessThan(
      order(datadogSdkMock.failOperation),
    );
    expect(notifyActivityMock.mock.invocationCallOrder[3]).toBeLessThan(
      order(datadogSdkMock.addError),
    );
  });

  it('does not renew when instrumentation is not initialized', async () => {
    await loadMain();

    keepDesktopInstrumentationSessionAlive();
    startDesktopOperation('canopy.chat_turn');

    expect(notifyActivityMock).not.toHaveBeenCalled();
    expect(datadogSdkMock.startOperation).not.toHaveBeenCalled();
  });

  it('still emits and warns once when notifyActivity is unavailable', async () => {
    // Re-mock the SDK without `notifyActivity` to simulate an un-patched
    // `node_modules`. ES module namespaces are frozen, so the property cannot be
    // deleted from the shared mock after import — `doMock` swaps the module.
    jest.resetModules();
    jest.doMock('@datadog/electron-sdk', () => ({
      init: jest.fn(() => Promise.resolve(true)),
      startOperation: jest.fn(),
      succeedOperation: jest.fn(),
      failOperation: jest.fn(),
      addError: jest.fn(),
    }));

    const sdkModule = await import('@datadog/electron-sdk');
    const sdkMock = jest.mocked(sdkModule);
    const main = await import('../main');
    await main.initializeDesktopInstrumentationMain();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => {
      main.startDesktopOperation('canopy.chat_turn');
      main.succeedDesktopOperation('canopy.agent_task');
    }).not.toThrow();

    expect(sdkMock.startOperation).toHaveBeenCalledTimes(1);
    expect(sdkMock.succeedOperation).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('notifyActivity');

    warnSpy.mockRestore();
    jest.dontMock('@datadog/electron-sdk');
  });

  it('still injects anon_id context and warns once when setUser is unavailable', async () => {
    // Simulate an un-patched node_modules where the vendored `setUser` export
    // is absent. ES module namespaces are frozen, so swap the module mock.
    jest.resetModules();
    jest.doMock('@datadog/electron-sdk', () => ({
      init: jest.fn(() => Promise.resolve(true)),
      startOperation: jest.fn(),
      succeedOperation: jest.fn(),
      failOperation: jest.fn(),
      addError: jest.fn(),
      notifyActivity: jest.fn(),
    }));

    const sdkModule = await import('@datadog/electron-sdk');
    const sdkMock = jest.mocked(sdkModule);
    const main = await import('../main');
    await main.initializeDesktopInstrumentationMain();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => {
      main.setDesktopInstrumentationUser(ANON_ID);
      main.setDesktopInstrumentationUser(ANON_ID);
      main.startDesktopOperation('canopy.chat_turn');
    }).not.toThrow();

    expect(sdkMock.startOperation).toHaveBeenCalledWith(
      'canopy.chat_turn',
      expect.objectContaining({ context: { anon_id: ANON_ID } }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('setUser');

    warnSpy.mockRestore();
    jest.dontMock('@datadog/electron-sdk');
  });
});

const mockPostHogCapture = jest.fn<void, [Parameters<PostHog['capture']>[0]]>();
const mockPostHogShutdown = jest.fn().mockResolvedValue(undefined);
const mockPostHogConstructor = jest.fn().mockImplementation(() => ({
  capture: mockPostHogCapture,
  shutdown: mockPostHogShutdown,
  on: jest.fn(),
}));
function getMockPostHogFetch(): (
  url: string,
  options: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<unknown> {
  const call: unknown = mockPostHogConstructor.mock.calls[0];
  const options: unknown = Array.isArray(call) ? call[1] : undefined;
  if (!hasPostHogFetch(options))
    throw new Error('Expected a PostHog delivery hook');
  return options.fetch;
}

function hasPostHogFetch(value: unknown): value is {
  fetch: (
    url: string,
    options: { method: 'POST'; headers: Record<string, string>; body: string },
  ) => Promise<unknown>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetch' in value &&
    typeof value.fetch === 'function'
  );
}
jest.mock('posthog-node', () => ({ PostHog: mockPostHogConstructor }), {
  virtual: true,
});

describe('PostHog background client and session authority', () => {
  const posthogId = POSTHOG_PERSON_ID;
  let main: typeof ElectronMainModule;
  beforeEach(async () => {
    jest.useRealTimers();
    jest.resetModules();
    mockPostHogConstructor.mockClear();
    mockPostHogCapture.mockClear();
    mockPostHogShutdown.mockClear();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
      __CANOPY_DATADOG_ENABLED__: false,
    });
    main = await import('../main');
  });
  afterEach(() =>
    Object.assign(globalThis, { __CANOPY_POSTHOG_ENABLED__: false }),
  );

  it('uses the separate host identity and both privacy layers, overriding event-supplied session and identity', async () => {
    main.setDesktopInstrumentationUser(ANON_ID, 'private@example.test');
    await main.initializePostHogMain(() => Promise.resolve(posthogId));
    const session = main.getDesktopPostHogSession();
    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const startupEvent = mockPostHogCapture.mock.calls[0]?.[0];
    expect(startupEvent).toEqual(
      expect.objectContaining({
        distinctId: posthogId,
        event: 'desktop:app_start',
      }),
    );
    expect(startupEvent?.properties).toEqual(
      expect.objectContaining({
        $session_id: session.sessionId,
        $process_person_profile: false,
      }),
    );
    main.captureDesktopPostHogEvent('background_test', {
      $session_id: 'wrong',
      distinct_id: ANON_ID,
      'usr.id': ANON_ID,
      dd_session_id: 'dd-session-private',
      dd_view_id: 'dd-view-private',
      prompt: 'private prose',
      email: 'private@example.test',
      detail:
        '/Users/private/project token=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      $current_url: 'file:///Users/private/app/index.html',
      count: 2,
    });
    const event = mockPostHogCapture.mock.calls.at(-1)?.[0];
    expect(event).toEqual(
      expect.objectContaining({
        distinctId: posthogId,
        event: 'background_test',
      }),
    );
    expect(event?.properties).toEqual(
      expect.objectContaining({
        $session_id: session.sessionId,
        $process_person_profile: false,
        $current_url: 'app://main',
        count: 2,
      }),
    );
    const wire = JSON.stringify(event);
    for (const secret of [
      ANON_ID,
      'dd-session-private',
      'dd-view-private',
      'private@example.test',
      'private prose',
      '/Users/private',
      'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(mockPostHogConstructor).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ disableGeoip: false }),
    );
    await main.flushDesktopInstrumentation();
    expect(mockPostHogShutdown).toHaveBeenCalledTimes(1);
  });

  it('publishes only the current domain when capture is enabled and clears the profile on sign-out', async () => {
    let push: (domain: string | null) => void = () => undefined;
    const unsubscribe = jest.fn();
    await main.initializePostHogMain(() => Promise.resolve(posthogId), {
      getSnapshot: () => Promise.resolve('UnstoppableDomains.com'),
      onSnapshotChanged: (listener) => {
        push = listener;
        return unsubscribe;
      },
    });
    expect(mockPostHogCapture).toHaveBeenCalledTimes(1);
    await main.getDesktopPostHogEmailDomain();
    expect(
      mockPostHogCapture.mock.calls[0]?.[0].properties?.email_domain,
    ).toBeUndefined();
    main.setDesktopPostHogOperationCaptureEnabled(true);
    const expectedProfileProperties: unknown = expect.objectContaining({
      email_domain: 'unstoppabledomains.com',
      $set: { email_domain: 'unstoppabledomains.com' },
      $process_person_profile: true,
      $is_identified: false,
    });
    expect(mockPostHogCapture.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        event: '$set',
        distinctId: posthogId,
        properties: expectedProfileProperties,
      }),
    );
    const publishedCount = mockPostHogCapture.mock.calls.length;
    main.setDesktopPostHogOperationCaptureEnabled(true);
    expect(mockPostHogCapture).toHaveBeenCalledTimes(publishedCount);
    main.captureDesktopPostHogEvent('domain_test', {
      email_domain: 'spoof.test',
    });
    expect(
      mockPostHogCapture.mock.calls.at(-1)?.[0].properties?.email_domain,
    ).toBe('unstoppabledomains.com');
    main.setDesktopPostHogOperationCaptureEnabled(false);
    const disabledCount = mockPostHogCapture.mock.calls.length;
    push('other.test');
    push(null);
    expect(mockPostHogCapture).toHaveBeenCalledTimes(disabledCount);
    main.setDesktopPostHogOperationCaptureEnabled(true);
    expect(mockPostHogCapture.mock.calls.at(-1)?.[0].properties?.$set).toEqual({
      email_domain: null,
    });
    await main.flushDesktopInstrumentation();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps renderer domain updates alive after background PostHog initialization fails', async () => {
    let push: (domain: string | null) => void = () => undefined;
    const unsubscribe = jest.fn();
    mockPostHogConstructor.mockImplementationOnce(() => {
      throw new Error('PostHog SDK unavailable');
    });
    const result = await main.initializePostHogMain(
      () => Promise.resolve(posthogId),
      {
        getSnapshot: () => Promise.resolve('example.test'),
        onSnapshotChanged: (listener) => {
          push = listener;
          return unsubscribe;
        },
      },
    );
    expect(result.enabled).toBe(false);
    expect(await main.getDesktopPostHogEmailDomain()).toBe('example.test');
    expect(unsubscribe).not.toHaveBeenCalled();

    push(null);
    expect(await main.getDesktopPostHogEmailDomain()).toBeNull();
    await main.flushDesktopInstrumentation();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('discards queued person updates after disabling capture, including late retries after re-enable', async () => {
    let push: (domain: string | null) => void = () => undefined;
    main.setDesktopPostHogOperationCaptureEnabled(true);
    await main.initializePostHogMain(() => Promise.resolve(posthogId), {
      getSnapshot: () => Promise.resolve('example.test'),
      onSnapshotChanged: (listener) => {
        push = listener;
        return (): void => undefined;
      },
    });
    await main.getDesktopPostHogEmailDomain();
    const profile = mockPostHogCapture.mock.calls.find(
      ([event]) => event.event === '$set',
    )?.[0];
    expect(profile).toBeDefined();
    const send = getMockPostHogFetch();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}'));
    const request = {
      method: 'POST' as const,
      headers: {},
      body: JSON.stringify({ batch: [profile] }),
    };
    try {
      await send('http://127.0.0.1:18763/batch/', request);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]?.body).not.toContain(
        '__canopy_operation_epoch',
      );
      fetchSpy.mockClear();
      push('other.test');
      await send('http://127.0.0.1:18763/batch/', request);
      expect(fetchSpy).not.toHaveBeenCalled();
      main.setDesktopPostHogOperationCaptureEnabled(false);
      await send('http://127.0.0.1:18763/batch/', request);
      expect(fetchSpy).not.toHaveBeenCalled();
      main.setDesktopPostHogOperationCaptureEnabled(true);
      await send('http://127.0.0.1:18763/batch/', request);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await main.flushDesktopInstrumentation();
    }
  });

  it('serializes competing rotations and rejects malformed or stale proposals', () => {
    const initial = main.getDesktopPostHogSession();
    const rotated = `${Date.now()
      .toString(16)
      .padStart(12, '0')
      .replace(/(.{8})/, '$1-')}-7111-8111-111111111111`;
    const accepted = main.adoptDesktopPostHogSession({
      sessionId: rotated,
      revision: initial.revision,
    });
    expect(accepted).toEqual({
      sessionId: rotated,
      revision: initial.revision + 1,
    });
    expect(
      main.adoptDesktopPostHogSession({
        sessionId: initial.sessionId,
        revision: initial.revision,
      }),
    ).toEqual(accepted);
    expect(() =>
      main.adoptDesktopPostHogSession({
        sessionId: ANON_ID,
        revision: accepted.revision,
      }),
    ).toThrow();
    expect(() =>
      main.adoptDesktopPostHogSession({
        sessionId: 'ffffffff-ffff-7111-8111-111111111111',
        revision: accepted.revision,
      }),
    ).toThrow();
  });

  it('does not load a disabled SDK or request its identity', async () => {
    Object.assign(globalThis, { __CANOPY_POSTHOG_ENABLED__: false });
    const getId = jest.fn();
    expect(await main.initializePostHogMain(getId)).toEqual({
      enabled: false,
      provider: 'posthog',
      reason: 'disabled',
    });
    expect(getId).not.toHaveBeenCalled();
    expect(mockPostHogConstructor).not.toHaveBeenCalled();
  });

  it('stamps the adopted session on later background captures', async () => {
    await main.initializePostHogMain(() => Promise.resolve(posthogId));
    const initial = main.getDesktopPostHogSession();
    const sessionId = initial.sessionId.replace(
      /.$/,
      initial.sessionId.endsWith('0') ? '1' : '0',
    );
    main.adoptDesktopPostHogSession({ sessionId, revision: initial.revision });
    main.captureDesktopPostHogEvent('after_rotation');
    expect(
      mockPostHogCapture.mock.calls.at(-1)?.[0].properties?.$session_id,
    ).toBe(sessionId);
  });

  it('waits for initialization on shutdown and tolerates a failed transport', async () => {
    let resolveId: ((id: string) => void) | undefined;
    const initialization = main.initializePostHogMain(
      () =>
        new Promise<string>((resolve) => {
          resolveId = resolve;
        }),
    );
    mockPostHogShutdown.mockRejectedValueOnce(new Error('offline'));
    const shutdown = main.flushDesktopInstrumentation();
    expect(mockPostHogShutdown).not.toHaveBeenCalled();
    resolveId?.(posthogId);
    await initialization;
    await expect(shutdown).resolves.toBeUndefined();
    await main.flushDesktopInstrumentation();
    expect(mockPostHogShutdown).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown when initialization stalls and closes a client created after the deadline', async () => {
    jest.useFakeTimers();
    let resolveId: ((id: string) => void) | undefined;
    const initialization = main.initializePostHogMain(
      () =>
        new Promise<string>((resolve) => {
          resolveId = resolve;
        }),
    );
    let shutdownSettled = false;
    const shutdown = main.flushDesktopInstrumentation().then(() => {
      shutdownSettled = true;
    });

    await jest.advanceTimersByTimeAsync(5_000);
    expect(shutdownSettled).toBe(true);
    expect(mockPostHogConstructor).not.toHaveBeenCalled();

    resolveId?.(posthogId);
    await initialization;
    await shutdown;
    expect(mockPostHogShutdown).toHaveBeenCalledTimes(1);
  });
});

describe('PostHog operation forwarding from the background process', () => {
  const posthogId = POSTHOG_PERSON_ID;
  let main: typeof ElectronMainModule;
  const context = { action: 'create', provider: 'claude' };

  function capturedEvents(): Array<Parameters<PostHog['capture']>[0]> {
    return mockPostHogCapture.mock.calls
      .map(([message]) => message)
      .filter((message) => message.event !== 'desktop:app_start');
  }

  async function loadMain(options: { datadog: boolean }): Promise<void> {
    jest.useRealTimers();
    jest.resetModules();
    mockPostHogConstructor.mockClear();
    mockPostHogCapture.mockClear();
    Object.assign(globalThis, {
      ...(options.datadog ? ENABLED_GLOBALS : DISABLED_GLOBALS),
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
    });
    // Earlier suites swap this module with `doMock`/`dontMock`.
    jest.doMock('@datadog/electron-sdk', () => ({
      init: jest.fn(() => Promise.resolve(true)),
      startOperation: jest.fn(),
      succeedOperation: jest.fn(),
      failOperation: jest.fn(),
      addError: jest.fn(),
      notifyActivity: jest.fn(),
      setUser: jest.fn(),
    }));
    const sdkModule = await import('@datadog/electron-sdk');
    setDatadogSdkMock(sdkModule);
    main = await import('../main');
    await main.initializeDesktopInstrumentationMain();
    await main.initializePostHogMain(() => Promise.resolve(posthogId));
    main.setDesktopPostHogOperationCaptureEnabled(true);
  }

  beforeEach(async () => {
    await loadMain({ datadog: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.assign(globalThis, {
      ...DISABLED_GLOBALS,
      __CANOPY_POSTHOG_ENABLED__: false,
      __CANOPY_DATADOG_VERSION__: '0.0.0-test',
      __CANOPY_APP_VERSION__: '0.0.0-test',
    });
  });

  it('classifies every operation name as product or excluded exactly once', () => {
    expect(EXPECTED_OPERATION_EVENTS.map(([name]) => name).sort()).toEqual(
      Object.keys(DESKTOP_OPERATIONS).sort(),
    );
  });

  it.each(EXPECTED_OPERATION_EVENTS)(
    '%s produces PostHog event %s and unchanged Datadog calls',
    (name, event) => {
      main.startDesktopOperation(name, { operationKey: 'op_1', context });
      main.succeedDesktopOperation(name, { operationKey: 'op_1', context });

      expect(capturedEvents().map((message) => message.event)).toEqual(
        event === null ? [] : [event],
      );
      expect(datadogSdkMock.startOperation).toHaveBeenCalledTimes(1);
      expect(datadogSdkMock.startOperation).toHaveBeenCalledWith(name, {
        operationKey: 'op_1',
        context,
      });
      expect(datadogSdkMock.succeedOperation).toHaveBeenCalledTimes(1);
      expect(datadogSdkMock.succeedOperation).toHaveBeenCalledWith(name, {
        operationKey: 'op_1',
        context,
      });
    },
  );

  it.each(PRODUCT_OPERATION_EVENTS)(
    '%s produces one %s failure event',
    (name, event) => {
      main.startDesktopOperation(name, { operationKey: 'op_1', context });
      main.failDesktopOperation(name, 'abandoned', {
        operationKey: 'op_1',
        context,
      });

      const captured = capturedEvents();
      expect(captured).toHaveLength(1);
      expect(captured[0]?.event).toBe(event);
      expect(captured[0]?.properties).toEqual(
        expect.objectContaining({
          status: 'failure',
          failure_reason: 'abandoned',
        }),
      );
      expect(datadogSdkMock.failOperation).toHaveBeenCalledWith(
        name,
        'abandoned',
        { operationKey: 'op_1', context },
      );
    },
  );

  it('sends status, wall-clock duration, surface, and the sanitized context', () => {
    jest.useFakeTimers({ now: 1_000 });
    main.startDesktopOperation('canopy.worktree_crud', {
      operationKey: 'op_1',
      context: { action: 'create' },
    });
    jest.setSystemTime(1_250);
    main.succeedDesktopOperation('canopy.worktree_crud', {
      operationKey: 'op_1',
      context: {
        action: 'create',
        detail: '/Users/private/project',
        anon_id: ANON_ID,
      },
    });

    const [message] = capturedEvents();
    expect(message?.distinctId).toBe(posthogId);
    expect(message?.properties).toEqual(
      expect.objectContaining({
        action: 'create',
        status: 'success',
        duration_ms: 250,
        surface: 'background',
        app_version: '0.0.0-test',
        $session_id: main.getDesktopPostHogSession().sessionId,
      }),
    );
    expect(message?.properties).not.toHaveProperty('detail');
    expect(message?.properties).not.toHaveProperty('failure_reason');
    expect(JSON.stringify(message)).not.toContain('/Users/private');
  });

  it('projects only approved context keys and normalizes boolean names', () => {
    main.succeedDesktopOperation('canopy.workspace_crud', {
      context: {
        action: 'create',
        workspace_is_temporary: true,
        unapproved_future_context: 'do not forward',
      },
    });
    expect(capturedEvents()[0]?.properties).toEqual(
      expect.objectContaining({
        action: 'create',
        is_workspace_temporary: true,
      }),
    );
    expect(capturedEvents()[0]?.properties).not.toHaveProperty(
      'workspace_is_temporary',
    );
    expect(capturedEvents()[0]?.properties).not.toHaveProperty(
      'unapproved_future_context',
    );
  });

  it.each([
    ['canopy.chat_turn', 'chat:turn_end'],
    ['canopy.agent_task', 'agent:task_end'],
  ] as const)(
    'forwards whether AI credits paid for %s on %s',
    (operation, event) => {
      main.succeedDesktopOperation(operation, {
        context: { provider: 'claude', is_ai_credits_routed: true },
      });
      main.succeedDesktopOperation(operation, {
        context: { provider: 'codex', is_ai_credits_routed: false },
      });

      expect(
        capturedEvents().map((message): [string, unknown] => [
          message.event,
          message.properties?.is_ai_credits_routed,
        ]),
      ).toEqual([
        [event, true],
        [event, false],
      ]);
    },
  );

  // Release builds without Datadog secrets bundle an empty Datadog version,
  // and only internal builds bump the committed package.json version.
  it.each([
    { datadogVersion: '0.26.8', label: 'a stale Datadog version' },
    { datadogVersion: '', label: 'a blank Datadog version' },
  ])(
    'stamps the bundled app version over $label, which context cannot replace',
    async ({ datadogVersion }) => {
      Object.assign(globalThis, {
        __CANOPY_APP_VERSION__: '9999.0.0-internal.1234',
        __CANOPY_DATADOG_VERSION__: datadogVersion,
      });
      // The version is independent of Datadog being enabled.
      await loadMain({ datadog: false });
      main.succeedDesktopOperation('canopy.onboarding_profile', {
        context: { profile_role: 'designer', app_version: '0.0.1-spoofed' },
      });
      main.failDesktopOperation('canopy.agent_task', 'error', {
        context: { provider: 'claude' },
      });

      expect(
        capturedEvents().map((message): [string, unknown] => [
          message.event,
          message.properties?.app_version,
        ]),
      ).toEqual([
        ['onboarding:profile_update', '9999.0.0-internal.1234'],
        ['agent:task_end', '9999.0.0-internal.1234'],
      ]);
    },
  );

  it('omits the app version when the build did not bundle one', async () => {
    Object.assign(globalThis, {
      __CANOPY_APP_VERSION__: ' ',
      __CANOPY_DATADOG_VERSION__: '0.26.8',
    });
    await loadMain({ datadog: true });
    main.succeedDesktopOperation('canopy.onboarding_profile', {
      context: { profile_role: 'designer', app_version: '0.0.1-spoofed' },
    });

    const [message] = capturedEvents();
    expect(message?.event).toBe('onboarding:profile_update');
    expect(message?.properties).not.toHaveProperty('app_version');
  });

  it('keeps an operation-measured duration and replaces its own status field', () => {
    jest.useFakeTimers({ now: 1_000 });
    main.startDesktopOperation('canopy.chat_turn', { operationKey: 'turn' });
    jest.setSystemTime(9_000);
    main.failDesktopOperation('canopy.chat_turn', 'abandoned', {
      operationKey: 'turn',
      context: { status: 'cancelled', duration_ms: 1_234 },
    });

    expect(capturedEvents()[0]?.properties).toEqual(
      expect.objectContaining({
        status: 'failure',
        failure_reason: 'abandoned',
        duration_ms: 1_234,
      }),
    );
  });

  it('pairs concurrent operations by operation key', () => {
    jest.useFakeTimers({ now: 1_000 });
    main.startDesktopOperation('canopy.agent_task', { operationKey: 'a' });
    jest.setSystemTime(2_000);
    main.startDesktopOperation('canopy.agent_task', { operationKey: 'b' });
    jest.setSystemTime(2_500);
    main.succeedDesktopOperation('canopy.agent_task', { operationKey: 'a' });
    main.succeedDesktopOperation('canopy.agent_task', { operationKey: 'b' });

    expect(
      capturedEvents().map(
        (message): unknown => message.properties?.duration_ms,
      ),
    ).toEqual([1_500, 500]);
  });

  it('omits duration when the start was never observed or was evicted', () => {
    main.startDesktopOperation('canopy.agent_task', { operationKey: 'first' });
    for (let index = 0; index < 500; index += 1) {
      main.startDesktopOperation('canopy.agent_task', {
        operationKey: `later-${index}`,
      });
    }
    main.succeedDesktopOperation('canopy.agent_task', {
      operationKey: 'first',
    });
    main.succeedDesktopOperation('canopy.agent_task', {
      operationKey: 'never-started',
    });

    for (const message of capturedEvents()) {
      expect(message.properties).not.toHaveProperty('duration_ms');
    }
    expect(capturedEvents()).toHaveLength(2);
  });

  it('does not let excluded pipeline reads evict a product operation start', () => {
    jest.useFakeTimers({ now: 1_000 });
    main.startDesktopOperation('canopy.agent_task', {
      operationKey: 'important',
    });
    for (let index = 0; index < 500; index += 1) {
      main.startDesktopOperation('canopy.pipeline_crud', {
        operationKey: `read-${index}`,
        context: { action: 'list' },
      });
    }
    jest.setSystemTime(1_250);
    main.succeedDesktopOperation('canopy.agent_task', {
      operationKey: 'important',
    });
    expect(capturedEvents()[0]?.properties?.duration_ms).toBe(250);
  });

  it.each(['list', 'discover', 'get', 'shared_list', 'shared_get'])(
    'does not forward the pipeline definition read %s',
    (action) => {
      main.startDesktopOperation('canopy.pipeline_crud', {
        operationKey: 'read',
        context: { action },
      });
      main.succeedDesktopOperation('canopy.pipeline_crud', {
        operationKey: 'read',
        context: { action },
      });

      expect(capturedEvents()).toEqual([]);
      expect(datadogSdkMock.succeedOperation).toHaveBeenCalledTimes(1);
    },
  );

  it('forwards nothing until the capture flag allows it, and stops when it is withdrawn', () => {
    main.setDesktopPostHogOperationCaptureEnabled(false);
    main.succeedDesktopOperation('canopy.chat_turn', { operationKey: 'off' });
    expect(capturedEvents()).toEqual([]);
    expect(datadogSdkMock.succeedOperation).toHaveBeenCalledTimes(1);

    main.setDesktopPostHogOperationCaptureEnabled(true);
    main.succeedDesktopOperation('canopy.chat_turn', { operationKey: 'on' });
    expect(capturedEvents()).toHaveLength(1);
  });

  it('forwards operations when Datadog is disabled', async () => {
    await loadMain({ datadog: false });
    main.startDesktopOperation('canopy.chat_turn', { operationKey: 'turn' });
    main.succeedDesktopOperation('canopy.chat_turn', { operationKey: 'turn' });

    expect(capturedEvents().map((message) => message.event)).toEqual([
      'chat:turn_end',
    ]);
    expect(datadogSdkMock.startOperation).not.toHaveBeenCalled();
  });

  it('drains an enabled completion recorded before PostHog initialization', async () => {
    await loadMain({ datadog: false });
    let resolveId: ((id: string) => void) | undefined;
    const pendingId = new Promise<string>((resolve) => {
      resolveId = resolve;
    });
    // A fresh module represents the startup interval before the identity is ready.
    jest.resetModules();
    mockPostHogCapture.mockClear();
    const startupMain = await import('../main');
    startupMain.setDesktopPostHogOperationCaptureEnabled(true);
    const initialization = startupMain.initializePostHogMain(() => pendingId);
    startupMain.succeedDesktopOperation('canopy.chat_turn');
    expect(mockPostHogCapture).not.toHaveBeenCalled();
    resolveId?.(posthogId);
    await initialization;
    expect(
      mockPostHogCapture.mock.calls.map(([message]) => message.event),
    ).toEqual(['desktop:app_start', 'chat:turn_end']);
  });

  it('does not release a queued startup completion after capture is disabled', async () => {
    jest.resetModules();
    mockPostHogCapture.mockClear();
    const startupMain = await import('../main');
    let resolveId: ((id: string) => void) | undefined;
    const pendingId = new Promise<string>((resolve) => {
      resolveId = resolve;
    });
    startupMain.setDesktopPostHogOperationCaptureEnabled(true);
    const initialization = startupMain.initializePostHogMain(() => pendingId);
    startupMain.succeedDesktopOperation('canopy.chat_turn');
    startupMain.setDesktopPostHogOperationCaptureEnabled(false);
    resolveId?.(posthogId);
    await initialization;
    expect(
      mockPostHogCapture.mock.calls.map(([message]) => message.event),
    ).toEqual(['desktop:app_start']);
  });

  it('filters queued operations at batch delivery after capture is disabled', async () => {
    const send = getMockPostHogFetch();
    const outgoing = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response());
    try {
      main.setDesktopPostHogOperationCaptureEnabled(false);
      await send('http://127.0.0.1:18763/batch/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: 'phc_test',
          batch: [
            { event: 'chat:turn_end', properties: {} },
            { event: 'desktop:app_start', properties: {} },
          ],
        }),
      });
      const sentBody: unknown = outgoing.mock.calls[0]?.[1]?.body;
      expect(JSON.parse(String(sentBody))).toEqual(
        expect.objectContaining({
          batch: [{ event: 'desktop:app_start', properties: {} }],
        }),
      );
    } finally {
      outgoing.mockRestore();
    }
  });

  it('does not revive an old operation batch after capture is re-enabled', async () => {
    main.succeedDesktopOperation('canopy.chat_turn');
    const operation = capturedEvents()[0];
    const send = getMockPostHogFetch();
    const outgoing = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response());
    try {
      main.setDesktopPostHogOperationCaptureEnabled(false);
      main.setDesktopPostHogOperationCaptureEnabled(true);
      await send('http://127.0.0.1:18763/batch/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'phc_test', batch: [operation] }),
      });
      expect(outgoing).not.toHaveBeenCalled();
    } finally {
      outgoing.mockRestore();
    }
  });

  it('sends current operations without the internal capture generation', async () => {
    main.succeedDesktopOperation('canopy.chat_turn');
    const operation = capturedEvents()[0];
    const send = getMockPostHogFetch();
    const outgoing = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response());
    try {
      await send('http://127.0.0.1:18763/batch/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'phc_test', batch: [operation] }),
      });
      const sentBody: unknown = outgoing.mock.calls[0]?.[1]?.body;
      expect(String(sentBody)).toContain('chat:turn_end');
      expect(String(sentBody)).not.toContain('__canopy_operation_epoch');
    } finally {
      outgoing.mockRestore();
    }
  });

  it('never forwards handled errors', () => {
    main.captureDesktopInstrumentationError(new Error('boom'));
    expect(capturedEvents()).toEqual([]);
  });
});
