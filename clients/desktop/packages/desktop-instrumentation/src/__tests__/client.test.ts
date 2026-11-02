import type { PostHogSessionState as State } from '@canopy/desktop-shared/types/observability';
import type { connectPostHogSession as ConnectPostHogSession } from '../client/posthog-session';
import type * as ClientModule from '../client';
import type { PostHogConfig } from 'posthog-js';
import type {
  DesktopInstrumentationClientInitOptions,
  PostHogRouteSource,
  PostHogRuntimeFlags,
} from '../types';
import type { PostHogRoute } from '../posthog-routes';
import { DESKTOP_OPERATIONS } from '../operations';
import {
  EXPECTED_OPERATION_EVENTS,
  PRODUCT_OPERATION_EVENTS,
} from './operation-events';

const mockPostHogInit = jest.fn<void, [string, Partial<PostHogConfig>]>();
const mockPostHogCapture = jest.fn<void, [string, Record<string, unknown>]>();
const mockPostHogIdentify = jest.fn();
const mockPostHogSetPersonProperties = jest.fn();
const sessionId = `${Date.now()
  .toString(16)
  .padStart(12, '0')
  .replace(/(.{8})/, '$1-')}-7111-8111-111111111111`;
const sessionBridge = {
  get: (): Promise<State> => Promise.resolve({ sessionId, revision: 0 }),
  report: jest.fn(),
  subscribe: jest.fn(() => jest.fn()),
};
const mockPostHogOnSessionId = jest.fn<
  jest.Mock,
  [listener: (sessionId: string, windowId?: string) => void]
>(() => jest.fn());
const mockPostHogSetSessionId = jest.fn(() => true);
const mockPostHogOptIn = jest.fn();
const mockPostHogOptOut = jest.fn();
const mockPostHogStop = jest.fn();
const mockPostHogStart = jest.fn();
const mockPostHogRemoteConfig = jest.fn();
const mockPostHogRecordingStarted = jest.fn(() => false);
const mockPostHogSetConfig = jest.fn();
const mockPostHogRegisterForSession = jest.fn();
const mockPostHogUnregisterForSession = jest.fn();
const mockPostHogBatchUnload = jest.fn();
const mockPostHogRetryUnload = jest.fn();
const mockStartFeatureOperation = jest.fn();
const mockSucceedFeatureOperation = jest.fn();
const mockFailFeatureOperation = jest.fn();
jest.mock(
  'posthog-js/dist/module.full.no-external',
  () => ({
    __esModule: true,
    default: {
      init: mockPostHogInit,
      capture: mockPostHogCapture,
      identify: mockPostHogIdentify,
      setPersonProperties: mockPostHogSetPersonProperties,
      onSessionId: mockPostHogOnSessionId,
      sessionManager: { setBootstrapSessionId: mockPostHogSetSessionId },
      opt_in_capturing: mockPostHogOptIn,
      opt_out_capturing: mockPostHogOptOut,
      stopSessionRecording: mockPostHogStop,
      startSessionRecording: mockPostHogStart,
      sessionRecordingStarted: mockPostHogRecordingStarted,
      sessionRecording: { onRemoteConfig: mockPostHogRemoteConfig },
      set_config: mockPostHogSetConfig,
      register_for_session: mockPostHogRegisterForSession,
      unregister_for_session: mockPostHogUnregisterForSession,
      _send_request: jest.fn(),
      _send_retriable_request: jest.fn(),
      _requestQueue: { unload: mockPostHogBatchUnload },
      _retryQueue: {
        retriableRequest: jest.fn(),
        unload: mockPostHogRetryUnload,
        resume: jest.fn(),
      },
    },
  }),
  { virtual: true },
);

// `setUser` is a method signature in the RUM type, so referencing it through
// the mocked module trips eslint's `unbound-method`. Capture it as a
// standalone (mock-prefixed for jest hoisting) function instead.
const mockSetUser = jest.fn();

jest.mock('@datadog/browser-rum', () => ({
  datadogRum: {
    init: jest.fn(),
    setViewName: jest.fn(),
    setViewContextProperty: jest.fn(),
    addFeatureFlagEvaluation: jest.fn(),
    startFeatureOperation: mockStartFeatureOperation,
    succeedFeatureOperation: mockSucceedFeatureOperation,
    failFeatureOperation: mockFailFeatureOperation,
    setUser: mockSetUser,
  },
}));

import type { datadogRum } from '@datadog/browser-rum';
import type {
  addClientFeatureFlagEvaluation as addClientFeatureFlagEvaluationFunction,
  initializeDesktopInstrumentationClient as initializeDesktopInstrumentationClientFunction,
  normalizeDatadogFeatureFlagKey as normalizeDatadogFeatureFlagKeyFunction,
  setClientInstrumentationUser as setClientInstrumentationUserFunction,
  startClientOperation as startClientOperationFunction,
} from '../client';

let datadogRumMock: jest.Mocked<typeof datadogRum>;
let initializeDesktopInstrumentationClient: typeof initializeDesktopInstrumentationClientFunction;
let addClientFeatureFlagEvaluation: typeof addClientFeatureFlagEvaluationFunction;
let normalizeDatadogFeatureFlagKey: typeof normalizeDatadogFeatureFlagKeyFunction;
let setClientInstrumentationUser: typeof setClientInstrumentationUserFunction;
let startClientOperation: typeof startClientOperationFunction;

describe('desktop instrumentation client', () => {
  beforeEach(async () => {
    jest.resetModules();
    mockSetUser.mockClear();
    mockStartFeatureOperation.mockClear();
    Object.assign(globalThis, {
      __CANOPY_DATADOG_ENABLED__: true,
      __CANOPY_DATADOG_CLIENT_TOKEN__: 'client-token',
      __CANOPY_DATADOG_APPLICATION_ID__: 'application-id',
      __CANOPY_DATADOG_ENV__: 'staging',
      __CANOPY_DATADOG_VARIANT__: 'rc-canopy',
      __CANOPY_DATADOG_PROXY__: 'http://127.0.0.1:8126',
    });
    const browserRumModule = await import('@datadog/browser-rum');
    datadogRumMock = jest.mocked(browserRumModule.datadogRum);
    ({
      addClientFeatureFlagEvaluation,
      initializeDesktopInstrumentationClient,
      normalizeDatadogFeatureFlagKey,
      setClientInstrumentationUser,
      startClientOperation,
    } = await import('../client'));
  });

  afterEach(() => {
    Object.assign(globalThis, {
      __CANOPY_DATADOG_ENABLED__: false,
      __CANOPY_DATADOG_CLIENT_TOKEN__: '',
      __CANOPY_DATADOG_APPLICATION_ID__: '',
      __CANOPY_DATADOG_ENV__: '',
      __CANOPY_DATADOG_VARIANT__: '',
      __CANOPY_DATADOG_PROXY__: '',
      __CANOPY_DATADOG_ALLOWED_TRACING_URLS__: [],
      __CANOPY_DATADOG_TRACE_SAMPLE_RATE__: undefined,
    });
  });

  it('passes configured proxy through to Browser RUM init', async () => {
    await expect(
      initializeDesktopInstrumentationClient({ surface: 'main' }),
    ).resolves.toEqual([
      { enabled: true, provider: 'datadog' },
      { enabled: false, provider: 'posthog', reason: 'disabled' },
    ]);

    expect(datadogRumMock.init).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: 'application-id',
        clientToken: 'client-token',
        env: 'staging',
        variant: 'rc-canopy',
        proxy: 'http://127.0.0.1:8126',
        enablePrivacyForActionName: true,
      }),
    );
  });

  it('configures first-party trace correlation only for explicit URL prefixes', async () => {
    Object.assign(globalThis, {
      __CANOPY_DATADOG_ALLOWED_TRACING_URLS__: [
        'https://api.canopy.example',
        'https://portal.canopy.example/v1',
      ],
      __CANOPY_DATADOG_TRACE_SAMPLE_RATE__: 25,
    });

    await expect(
      initializeDesktopInstrumentationClient({ surface: 'main' }),
    ).resolves.toEqual([
      { enabled: true, provider: 'datadog' },
      { enabled: false, provider: 'posthog', reason: 'disabled' },
    ]);

    expect(datadogRumMock.init).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTracingUrls: [
          {
            match: 'https://api.canopy.example',
            propagatorTypes: ['tracecontext'],
          },
          {
            match: 'https://portal.canopy.example/v1',
            propagatorTypes: ['tracecontext'],
          },
        ],
        traceContextInjection: 'sampled',
        traceSampleRate: 25,
      }),
    );
  });

  it('reports LaunchDarkly feature flag evaluations to Datadog RUM with Datadog-safe keys', async () => {
    await initializeDesktopInstrumentationClient({ surface: 'main' });

    addClientFeatureFlagEvaluation('canopy-portal-enabled', false);

    expect(datadogRumMock.addFeatureFlagEvaluation).toHaveBeenCalledWith(
      'canopy_portal_enabled',
      false,
    );
  });

  it('normalizes unsupported Datadog feature flag key characters', () => {
    expect(normalizeDatadogFeatureFlagKey('flag:with+bad-characters')).toBe(
      'flag_with_bad_characters',
    );
    expect(normalizeDatadogFeatureFlagKey('&&')).toBe('feature_flag');
  });

  it('sets the anonymous install id on the RUM user after init', async () => {
    await initializeDesktopInstrumentationClient({ surface: 'main' });

    setClientInstrumentationUser('11111111-1111-4111-8111-111111111111');

    expect(mockSetUser).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      // Derived non-PII display name; without usr.name the Datadog RUM UI
      // labels every session "Public User".
      name: 'anon-11111111',
    });
  });

  it('sets the cloud account email through the native RUM user field', async () => {
    await initializeDesktopInstrumentationClient({ surface: 'main' });

    setClientInstrumentationUser(
      '11111111-1111-4111-8111-111111111111',
      ' user@example.test ',
    );

    expect(mockSetUser).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'anon-11111111',
      email: 'user@example.test',
    });
  });

  it('does not attach PostHog person or session identifiers to Datadog operations', async () => {
    await initializeDesktopInstrumentationClient({ surface: 'main' });

    startClientOperation('canopy.slow_action', {
      context: {
        channel: 'chat',
        distinct_id: '22222222-2222-4222-8222-222222222222',
        $session_id: '33333333-3333-4333-8333-333333333333',
        posthog_session_id: '44444444-4444-4444-8444-444444444444',
      },
    });

    expect(mockStartFeatureOperation).toHaveBeenCalledWith(
      'canopy.slow_action',
      {
        context: { channel: 'chat' },
      },
    );
  });

  it('does not set the RUM user before init', () => {
    setClientInstrumentationUser('11111111-1111-4111-8111-111111111111');

    expect(mockSetUser).not.toHaveBeenCalled();
  });

  it('does not reuse initialized state across module resets', async () => {
    Object.assign(globalThis, {
      __CANOPY_DATADOG_ENABLED__: false,
    });

    await expect(
      initializeDesktopInstrumentationClient({ surface: 'main' }),
    ).resolves.toEqual([
      { enabled: false, provider: 'datadog', reason: 'disabled' },
      { enabled: false, provider: 'posthog', reason: 'disabled' },
    ]);

    expect(datadogRumMock.init).not.toHaveBeenCalled();
  });
});

const enabledPostHogFlags: NonNullable<
  DesktopInstrumentationClientInitOptions['posthogFlags']
> = {
  getSnapshot: () =>
    Promise.resolve({
      captureEnabled: true,
      sessionReplaySampleRate: 100,
    }),
  onSnapshotChanged: () => (): void => undefined,
};

function createRouteSource(initial: PostHogRoute): PostHogRouteSource & {
  emit(route: PostHogRoute): void;
  subscribe: jest.MockedFunction<PostHogRouteSource['subscribe']>;
  unsubscribe: jest.Mock<void, []>;
} {
  let route = initial;
  const listeners = new Set<(next: PostHogRoute) => void>();
  const unsubscribe = jest.fn(() => listeners.clear());
  return {
    getSnapshot: () => route,
    subscribe: jest.fn((listener) => {
      listeners.add(listener);
      return unsubscribe;
    }),
    emit(next: PostHogRoute): void {
      route = next;
      listeners.forEach((listener) => listener(next));
    },
    unsubscribe,
  };
}

describe('PostHog browser initialization', () => {
  const posthogId = '22222222-2222-4222-8222-222222222222';
  beforeEach(async () => {
    jest.resetModules();
    mockPostHogInit.mockReset();
    mockPostHogSetSessionId.mockReturnValue(true);
    mockPostHogOnSessionId.mockReturnValue(jest.fn());
    sessionBridge.subscribe.mockReturnValue(jest.fn());
    mockPostHogCapture.mockReset();
    mockPostHogIdentify.mockReset();
    mockPostHogSetPersonProperties.mockReset();
    mockPostHogRegisterForSession.mockReset();
    mockPostHogUnregisterForSession.mockReset();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
      __CANOPY_DATADOG_ENABLED__: false,
    });
    ({ initializeDesktopInstrumentationClient, setClientInstrumentationUser } =
      await import('../client'));
    const initialize = initializeDesktopInstrumentationClient;
    initializeDesktopInstrumentationClient = (
      options,
    ): ReturnType<typeof initialize> =>
      initialize({ ...options, posthogFlags: enabledPostHogFlags });
  });
  afterEach(() => {
    Object.assign(globalThis, { __CANOPY_POSTHOG_ENABLED__: false });
  });

  it('pins product-only settings and bootstraps a separate anonymous identity', async () => {
    const identity = {
      posthogSession: sessionBridge,
      getPostHogAnonymousId: (): Promise<string> => Promise.resolve(posthogId),
    };
    const anyFunction: unknown = expect.any(Function);
    await initializeDesktopInstrumentationClient({
      surface: 'main',
      ...identity,
    });
    const expectedRecording: unknown = expect.objectContaining({
      maskAllInputs: true,
      maskAllElementAttributes: false,
      maskAttributeFn: anyFunction,
      maskTextFn: anyFunction,
      recordHeaders: false,
      recordBody: false,
    });
    expect(mockPostHogInit).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        api_host: 'http://127.0.0.1:18763',
        persistence: 'localStorage',
        capture_exceptions: false,
        capture_performance: false,
        disable_surveys: true,
        disable_session_recording: true,
        enable_recording_console_log: false,
        session_recording: expectedRecording,
        autocapture: false,
        rageclick: true,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        capture_pageview: false,
        capture_pageleave: false,
        mask_all_text: false,
        mask_all_element_attributes: false,
        person_profiles: 'identified_only',
        bootstrap: {
          distinctID: posthogId,
          isIdentifiedID: false,
          sessionID: sessionId,
        },
        before_send: anyFunction,
      }),
    );
    expect(mockPostHogCapture).toHaveBeenCalledWith('app_opened', {
      surface: 'main',
    });
    setClientInstrumentationUser(
      '11111111-1111-4111-8111-111111111111',
      'user@example.test',
    );
    expect(mockPostHogIdentify).not.toHaveBeenCalled();
  });

  it('annotates events independently of Datadog and clears the domain without writing person profiles', async () => {
    let push: (domain: string | null) => void = () => undefined;
    const unsubscribe = jest.fn();
    await initializeDesktopInstrumentationClient({
      surface: 'app-advisor',
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogAccount: {
        getSnapshot: () => Promise.resolve('UnstoppableDomains.com'),
        onSnapshotChanged: (listener) => {
          push = listener;
          return unsubscribe;
        },
      },
    });
    expect(mockPostHogSetPersonProperties).not.toHaveBeenCalled();
    const beforeSend = mockPostHogInit.mock.calls[0]?.[1].before_send;
    if (typeof beforeSend !== 'function')
      throw new Error('Expected before_send');
    const event = {
      uuid: 'event-id',
      event: 'safe_event',
      properties: { distinct_id: posthogId, email_domain: 'spoof.test' },
      $set: {
        email: 'private@unstoppabledomains.com',
        email_domain: 'spoof.test',
      },
    };
    expect(beforeSend(event)?.properties).toEqual(
      expect.objectContaining({
        email_domain: 'unstoppabledomains.com',
        $process_person_profile: true,
        $is_identified: false,
      }),
    );
    expect(beforeSend(event)?.$set).toBeUndefined();
    expect(beforeSend({ ...event, event: '$set' })).toBeNull();
    expect(beforeSend({ ...event, event: '$unset' })).toBeNull();
    expect(beforeSend({ ...event, event: '$identify' })).toBeNull();
    const cachedPersonEvent = {
      ...event,
      $set_once: { email_domain: 'stale.test' },
      properties: {
        ...event.properties,
        $set: { email_domain: 'stale.test' },
        $set_once: { email_domain: 'stale.test' },
      },
    };
    expect(beforeSend(cachedPersonEvent)?.$set_once).toBeUndefined();
    expect(beforeSend(cachedPersonEvent)?.properties.$set).toBeUndefined();
    expect(beforeSend(cachedPersonEvent)?.properties.$set_once).toBeUndefined();
    push(null);
    expect(mockPostHogSetPersonProperties).not.toHaveBeenCalled();
    expect(beforeSend(event)?.properties.email_domain).toBeNull();
    expect(beforeSend(event)?.$set).toBeUndefined();
    push('other.test');
    expect(beforeSend(event)?.properties.email_domain).toBe('other.test');
    expect(mockPostHogIdentify).not.toHaveBeenCalled();
    const { disposePostHogInstrumentationClient } = await import('../client');
    disposePostHogInstrumentationClient();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('annotates the latest account state after capture re-enables without publishing profile changes', async () => {
    const client = await import('../client');
    let push: (domain: string | null) => void = () => undefined;
    let emitFlags: (flags: PostHogRuntimeFlags) => void = () => undefined;
    await client.initializeDesktopInstrumentationClient({
      surface: 'main',
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogAccount: {
        getSnapshot: () => Promise.resolve('example.test'),
        onSnapshotChanged: (listener) => {
          push = listener;
          return (): void => undefined;
        },
      },
      posthogFlags: {
        getSnapshot: enabledPostHogFlags.getSnapshot,
        onSnapshotChanged: (listener) => {
          emitFlags = listener;
          return (): void => undefined;
        },
      },
    });
    expect(mockPostHogSetPersonProperties).not.toHaveBeenCalled();
    emitFlags({ captureEnabled: false, sessionReplaySampleRate: 0 });
    const beforeDisabled = mockPostHogCapture.mock.calls.length;
    push('other.test');
    push(null);
    expect(mockPostHogCapture).toHaveBeenCalledTimes(beforeDisabled);
    expect(mockPostHogSetPersonProperties).not.toHaveBeenCalledWith({
      email_domain: 'other.test',
    });
    emitFlags({ captureEnabled: true, sessionReplaySampleRate: 0 });
    const beforeSend = mockPostHogInit.mock.calls[0]?.[1].before_send;
    if (typeof beforeSend !== 'function')
      throw new Error('Expected before_send');
    expect(
      beforeSend({
        uuid: 'event-id',
        event: 'safe_event',
        properties: { distinct_id: posthogId },
      })?.properties.email_domain,
    ).toBeNull();
    expect(mockPostHogCapture).toHaveBeenCalledTimes(beforeDisabled);
    expect(mockPostHogSetPersonProperties).not.toHaveBeenCalled();
    client.disposePostHogInstrumentationClient();
  });

  it('pins every replay privacy option and maps only page URLs to the current route', async () => {
    const { buildPostHogSessionRecordingOptions } =
      await import('../client/posthog-replay-options');
    let route: PostHogRoute | undefined = 'app://main/home';
    const options = buildPostHogSessionRecordingOptions(() => route);
    expect(Object.isFrozen(options)).toBe(true);
    const anyFunction: unknown = expect.any(Function);
    expect(options).toEqual({
      maskAllInputs: true,
      maskInputFn: anyFunction,
      maskTextSelector: '*',
      maskTextFn: anyFunction,
      maskAllElementAttributes: false,
      maskAttributeFn: anyFunction,
      slimDOMOptions: { comment: true },
      blockClass: 'ph-no-capture',
      blockSelector:
        'webview, iframe, canvas, video, input[type="file"], input[type="hidden"], .monaco-aria-container',
      recordCrossOriginIframes: false,
      captureCanvas: { recordCanvas: false },
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: anyFunction,
    });
    if (typeof options.maskInputFn !== 'function') {
      throw new Error('Expected input masker');
    }
    expect(options.maskInputFn('private input')).toBe('********');
    // Exercise the intentionally sparse and adversarial recorder inputs accepted
    // by our generic implementation, beyond the SDK's full-request signature.
    const mask = options.maskCapturedNetworkRequestFn as <
      T extends { name?: string; url?: string },
    >(
      request: T,
    ) => T | null;
    expect(mask({ name: 'file:///Users/private/app/index.html' })).toEqual({
      name: 'app://main/home',
    });
    route = 'app://app-advisor';
    expect(mask({ name: 'file:///Users/private/app/index.html' })).toEqual({
      name: 'app://app-advisor',
    });
    expect(
      mask({ name: 'file:///Users/private/file.txt', entryType: 'resource' }),
    ).toBeNull();
    expect(
      mask({
        name: 'app-renderer://bundle/assets/index-1.js',
        entryType: 'resource',
      }),
    ).toBeNull();
    expect(
      mask({ name: 'x', url: 'app-renderer://bundle/storage-bridge.html' }),
    ).toBeNull();
    expect(
      mask({
        name: 'https://example.test/path?secret=1',
        url: 'https://example.test/other?secret=2',
      }),
    ).toEqual({
      name: 'https://example.test/path',
      url: 'https://example.test/other',
    });
    expect(
      mask({
        get name(): string {
          throw new Error('unsafe getter');
        },
      }),
    ).toBeNull();
  });

  it('registers the initial route and admits its page view before app_opened', async () => {
    const routes = createRouteSource('app://main/home');
    await initializeDesktopInstrumentationClient({
      surface: 'main',
      posthogRoutes: routes,
      posthogSession: sessionBridge,
      getPostHogAnonymousId: (): Promise<string> => Promise.resolve(posthogId),
    });

    const properties = {
      screen_route: 'app://main/home',
      $current_url: 'app://main/home',
    };
    expect(routes.subscribe).toHaveBeenCalledTimes(1);
    expect(mockPostHogRegisterForSession).toHaveBeenCalledWith(properties);
    expect(mockPostHogCapture).toHaveBeenNthCalledWith(
      1,
      '$pageview',
      properties,
    );
    expect(mockPostHogCapture).toHaveBeenNthCalledWith(2, 'app_opened', {
      surface: 'main',
    });
  });

  it('reports a PostHog failure separately from disabled Datadog', async () => {
    mockPostHogInit.mockImplementation(() => {
      throw new Error('SDK failed');
    });
    const identity = {
      posthogSession: sessionBridge,
      getPostHogAnonymousId: (): Promise<string> => Promise.resolve(posthogId),
    };
    await expect(
      initializeDesktopInstrumentationClient({ surface: 'main', ...identity }),
    ).resolves.toEqual([
      { enabled: false, provider: 'datadog', reason: 'disabled' },
      { enabled: false, provider: 'posthog', reason: 'SDK failed' },
    ]);
  });
});

describe('PostHog lifecycle and privacy', () => {
  const posthogId = '33333333-3333-4333-8333-333333333333';
  beforeEach(async () => {
    jest.resetModules();
    mockPostHogInit.mockReset();
    mockPostHogSetSessionId.mockReturnValue(true);
    mockPostHogOnSessionId.mockReturnValue(jest.fn());
    sessionBridge.subscribe.mockReturnValue(jest.fn());
    mockPostHogCapture.mockReset();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_DATADOG_ENABLED__: false,
    });
    ({ initializeDesktopInstrumentationClient } = await import('../client'));
    const initialize = initializeDesktopInstrumentationClient;
    initializeDesktopInstrumentationClient = (
      options,
    ): ReturnType<typeof initialize> =>
      initialize({ ...options, posthogFlags: enabledPostHogFlags });
  });
  afterEach(() =>
    Object.assign(globalThis, { __CANOPY_POSTHOG_ENABLED__: false }),
  );
  it('reports Datadog readiness before a pending PostHog identity, and initializes once', async () => {
    let resolveId: ((id: string) => void) | undefined;
    const identity = new Promise<string>((resolve) => {
      resolveId = resolve;
    });
    const reported = jest.fn();
    const options: DesktopInstrumentationClientInitOptions = {
      surface: 'main' as const,
      posthogSession: sessionBridge,
      getPostHogAnonymousId: (): Promise<string> => identity,
      onProviderInitialized: reported,
    };
    const first = initializeDesktopInstrumentationClient(options);
    const second = initializeDesktopInstrumentationClient(options);
    await Promise.resolve();
    expect(reported).toHaveBeenCalledWith({
      enabled: false,
      provider: 'datadog',
      reason: 'disabled',
    });
    expect(mockPostHogInit).not.toHaveBeenCalled();
    if (!resolveId) throw new Error('Missing identity resolver');
    resolveId(posthogId);
    await Promise.all([first, second]);
    expect(mockPostHogInit).toHaveBeenCalledTimes(1);
    expect(mockPostHogCapture).toHaveBeenCalledTimes(1);
  });
  it('fails closed if the host cannot supply a valid provider identity', async () => {
    const results = await initializeDesktopInstrumentationClient({
      surface: 'main',
      posthogSession: sessionBridge,
      getPostHogAnonymousId: (): Promise<string> =>
        Promise.resolve('user@example.test'),
    });
    expect(results[1]).toEqual({
      enabled: false,
      provider: 'posthog',
      reason: 'PostHog anonymous identity is unavailable',
    });
    expect(mockPostHogInit).not.toHaveBeenCalled();
    expect(mockPostHogCapture).not.toHaveBeenCalled();
  });
  it('sanitizes actual SDK event properties and drops unknown identities', async () => {
    await initializeDesktopInstrumentationClient({
      surface: 'app-advisor',
      posthogSession: sessionBridge,
      getPostHogAnonymousId: (): Promise<string> => Promise.resolve(posthogId),
    });
    const beforeSend = mockPostHogInit.mock.calls[0]?.[1].before_send;
    if (typeof beforeSend !== 'function') throw new Error('Missing sanitizer');
    const event = beforeSend({
      uuid: 'event-id',
      event: 'app_opened',
      properties: {
        distinct_id: posthogId,
        token: 'phc_test',
        email: 'private@example.test',
        'usr.id': '11111111-1111-4111-8111-111111111111',
        usr: { id: 'datadog-browser-user-private' },
        dd_session_id: 'dd-session-private',
        dd_view_id: 'dd-view-private',
        prompt: 'private prose',
        $current_url: 'file:///Users/private/app/index.html',
        $ip: '127.0.0.1',
      },
    });
    expect(event?.properties).toEqual({
      distinct_id: posthogId,
      $is_identified: false,
      $process_person_profile: false,
      token: 'phc_test',
      surface: 'app-advisor',
      screen_route: 'app://app-advisor',
      $current_url: 'app://app-advisor',
      $session_id: sessionId,
    });
    expect(
      beforeSend({
        uuid: 'event-id',
        event: 'app_opened',
        properties: { distinct_id: 'datadog-id' },
      }),
    ).toBeNull();
    expect(
      beforeSend({
        uuid: 'event-id',
        event: '$identify',
        properties: { distinct_id: posthogId },
      }),
    ).toBeNull();
    expect(beforeSend(null)).toBeNull();
    expect(
      beforeSend({
        uuid: 'event-id',
        event: 'app_opened',
        properties: {
          distinct_id: posthogId,
          get bad() {
            throw new Error('untrusted');
          },
        },
      }),
    ).toBeNull();
  });

  it('passes snapshot bytes through before_send while sanitizing its envelope', async () => {
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 100,
    });
    try {
      await initializeDesktopInstrumentationClient({
        surface: 'main',
        posthogSession: sessionBridge,
        getPostHogAnonymousId: () => Promise.resolve(posthogId),
      });
      const beforeSend = mockPostHogInit.mock.calls[0]?.[1].before_send;
      if (typeof beforeSend !== 'function')
        throw new Error('Missing sanitizer');
      const bytes = '\u001f\u008b/Users/private/a@example.test\u0000';
      const result = beforeSend({
        uuid: 'snapshot-id',
        event: '$snapshot',
        properties: {
          distinct_id: posthogId,
          $session_id: sessionId,
          $window_id: 'window-1',
          $snapshot_data: bytes,
          note: 'private@example.test',
        },
      });
      expect(result?.properties.$snapshot_data).toBe(bytes);
      expect(result?.properties.note).toBe('<redacted-email>');
      expect(result?.properties.$session_id).toBe(sessionId);
      expect(result?.properties.$window_id).toBe('window-1');
    } finally {
      Object.assign(globalThis, {
        __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: undefined,
      });
    }
  });
});

describe('PostHog LaunchDarkly evaluations', () => {
  const options: DesktopInstrumentationClientInitOptions = {
    surface: 'main',
    posthogSession: sessionBridge,
    getPostHogAnonymousId: () =>
      Promise.resolve('33333333-3333-4333-8333-333333333333'),
    posthogFlags: enabledPostHogFlags,
  };
  const evaluations = (): unknown[] =>
    mockPostHogCapture.mock.calls.filter(
      ([event]) => event === '$feature_flag_called',
    );

  beforeEach(() => {
    jest.resetModules();
    mockPostHogInit.mockReset();
    mockPostHogCapture.mockReset();
    mockPostHogOnSessionId.mockClear();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_DATADOG_ENABLED__: false,
    });
  });
  afterEach(async () => {
    (await import('../client')).disposePostHogInstrumentationClient();
    Object.assign(globalThis, { __CANOPY_POSTHOG_ENABLED__: false });
  });

  it('reports first and changed scalar evaluations without repeats or Datadog', async () => {
    const client = await import('../client');
    await client.initializeDesktopInstrumentationClient(options);
    for (const value of [
      false,
      false,
      true,
      true,
      false,
      0,
      0,
      '0',
      '0',
      null,
      null,
      undefined,
    ]) {
      client.addClientFeatureFlagEvaluation('canopy-portal-enabled', value);
    }
    client.addClientFeatureFlagEvaluation('another-flag', false);
    expect(evaluations()).toEqual(
      [false, true, false, 0, '0', null]
        .map((value) => [
          '$feature_flag_called',
          {
            $feature_flag: 'canopy-portal-enabled',
            $feature_flag_response: value,
          },
        ])
        .concat([
          [
            '$feature_flag_called',
            { $feature_flag: 'another-flag', $feature_flag_response: false },
          ],
        ]),
    );
  });

  it('retries an evaluation after the session bridge recovers', async () => {
    const client = await import('../client');
    let updateSession: ((state: State) => void) | undefined;
    await client.initializeDesktopInstrumentationClient({
      ...options,
      posthogSession: {
        get: sessionBridge.get,
        report: () => Promise.reject(new Error('bridge unavailable')),
        subscribe: (listener) => {
          updateSession = listener;
          return jest.fn();
        },
      },
    });
    const accepted: unknown[] = [];
    mockPostHogCapture.mockImplementation((event, properties) => {
      const beforeSend = mockPostHogInit.mock.calls[0]?.[1].before_send as
        | ((event: {
            uuid: string;
            event: string;
            properties: Record<string, unknown>;
          }) => unknown)
        | undefined;
      const result = beforeSend?.({
        uuid: 'event-id',
        event,
        properties: {
          ...properties,
          distinct_id: '33333333-3333-4333-8333-333333333333',
        },
      });
      if (result) accepted.push(result);
    });
    const onSessionId = mockPostHogOnSessionId.mock.calls[1]?.[0];
    if (!onSessionId) throw new Error('Missing session listener');
    onSessionId(sessionId.replace(/111111111111$/, '222222222222'), 'window');
    await new Promise<void>((resolve) => setImmediate(resolve));

    client.addClientFeatureFlagEvaluation('flag', true);
    expect(accepted).toEqual([]);

    updateSession?.({ sessionId, revision: 1 });
    client.addClientFeatureFlagEvaluation('flag', true);
    client.addClientFeatureFlagEvaluation('flag', true);
    expect(accepted).toHaveLength(1);
    const delivered = accepted[0] as {
      event: string;
      properties: Record<string, unknown>;
    };
    expect(delivered.event).toBe('$feature_flag_called');
    expect(delivered.properties.$feature_flag).toBe('flag');
    expect(delivered.properties.$feature_flag_response).toBe(true);
  });

  it('retains the latest evaluation during asynchronous initialization', async () => {
    const client = await import('../client');
    let resolveId!: (id: string) => void;
    const pending = client.initializeDesktopInstrumentationClient({
      ...options,
      getPostHogAnonymousId: () =>
        new Promise<string>((resolve) => {
          resolveId = resolve;
        }),
    });
    client.addClientFeatureFlagEvaluation('first-flag', false);
    client.addClientFeatureFlagEvaluation('first-flag', true);
    client.addClientFeatureFlagEvaluation('second-flag', null);
    expect(evaluations()).toEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveId('33333333-3333-4333-8333-333333333333');
    await pending;
    client.addClientFeatureFlagEvaluation('first-flag', true);
    expect(evaluations()).toEqual([
      [
        '$feature_flag_called',
        { $feature_flag: 'first-flag', $feature_flag_response: true },
      ],
      [
        '$feature_flag_called',
        { $feature_flag: 'second-flag', $feature_flag_response: null },
      ],
    ]);
  });

  it('does not replay startup evaluations across a disabled capture interval', async () => {
    const client = await import('../client');
    let resolveId!: (id: string) => void;
    let change!: (flags: PostHogRuntimeFlags) => void;
    const pending = client.initializeDesktopInstrumentationClient({
      ...options,
      getPostHogAnonymousId: () =>
        new Promise<string>((resolve) => {
          resolveId = resolve;
        }),
      posthogFlags: {
        getSnapshot: enabledPostHogFlags.getSnapshot,
        onSnapshotChanged: (listener) => {
          change = listener;
          return jest.fn();
        },
      },
    });
    client.addClientFeatureFlagEvaluation('before-disable', true);
    change({ captureEnabled: false, sessionReplaySampleRate: 0 });
    client.addClientFeatureFlagEvaluation('during-disable', true);
    change({ captureEnabled: true, sessionReplaySampleRate: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveId('33333333-3333-4333-8333-333333333333');
    await pending;
    expect(evaluations()).toEqual([]);
    client.addClientFeatureFlagEvaluation('during-disable', true);
    expect(evaluations()).toHaveLength(1);
  });

  it('drops disabled evaluations without consuming their later enabled report', async () => {
    const client = await import('../client');
    let change!: (flags: PostHogRuntimeFlags) => void;
    await client.initializeDesktopInstrumentationClient({
      ...options,
      posthogFlags: {
        getSnapshot: () =>
          Promise.resolve({
            captureEnabled: false,
            sessionReplaySampleRate: 0,
          }),
        onSnapshotChanged: (listener) => {
          change = listener;
          return jest.fn();
        },
      },
    });
    client.addClientFeatureFlagEvaluation('flag', true);
    expect(evaluations()).toEqual([]);
    change({ captureEnabled: true, sessionReplaySampleRate: 0 });
    expect(evaluations()).toEqual([]);
    client.addClientFeatureFlagEvaluation('flag', true);
    client.addClientFeatureFlagEvaluation('flag', true);
    expect(evaluations()).toHaveLength(1);
    change({ captureEnabled: false, sessionReplaySampleRate: 0 });
    client.addClientFeatureFlagEvaluation('flag', false);
    expect(evaluations()).toHaveLength(1);
    change({ captureEnabled: true, sessionReplaySampleRate: 0 });
    client.addClientFeatureFlagEvaluation('flag', false);
    expect(evaluations()).toHaveLength(2);
  });

  it('releases evaluation state on disposal and allows a fresh initialization', async () => {
    const client = await import('../client');
    await client.initializeDesktopInstrumentationClient(options);
    client.addClientFeatureFlagEvaluation('flag', true);
    client.disposePostHogInstrumentationClient();
    client.addClientFeatureFlagEvaluation('flag', false);
    expect(evaluations()).toHaveLength(1);
    await client.initializeDesktopInstrumentationClient(options);
    client.addClientFeatureFlagEvaluation('flag', true);
    expect(evaluations()).toHaveLength(2);
  });

  it('keeps Datadog reporting independent of PostHog and its deduplication', async () => {
    Object.assign(globalThis, {
      __CANOPY_DATADOG_ENABLED__: true,
      __CANOPY_DATADOG_CLIENT_TOKEN__: 'client-token',
      __CANOPY_DATADOG_APPLICATION_ID__: 'application-id',
    });
    const client = await import('../client');
    const { datadogRum: rum } = await import('@datadog/browser-rum');
    await client.initializeDesktopInstrumentationClient(options);
    client.addClientFeatureFlagEvaluation('canopy-portal-enabled', false);
    client.addClientFeatureFlagEvaluation('canopy-portal-enabled', false);
    expect(rum.addFeatureFlagEvaluation).toHaveBeenCalledTimes(2);
    expect(rum.addFeatureFlagEvaluation).toHaveBeenCalledWith(
      'canopy_portal_enabled',
      false,
    );
    expect(evaluations()).toHaveLength(1);
    jest.mocked(rum.addFeatureFlagEvaluation).mockImplementationOnce(() => {
      throw new Error('Datadog failed');
    });
    expect(() =>
      client.addClientFeatureFlagEvaluation('canopy-portal-enabled', true),
    ).not.toThrow();
    expect(evaluations()).toHaveLength(2);
  });

  it('discards pending evaluations after failed initialization', async () => {
    const client = await import('../client');
    const pending = client.initializeDesktopInstrumentationClient({
      ...options,
      getPostHogAnonymousId: () =>
        Promise.reject(new Error('identity unavailable')),
    });
    client.addClientFeatureFlagEvaluation('stale-flag', true);
    const results = await pending;
    expect(results[1].enabled).toBe(false);
    client.addClientFeatureFlagEvaluation('stale-flag', false);
    client.disposePostHogInstrumentationClient();
    await client.initializeDesktopInstrumentationClient(options);
    expect(evaluations()).toEqual([]);
    client.addClientFeatureFlagEvaluation('stale-flag', false);
    expect(evaluations()).toHaveLength(1);
  });

  it('isolates SDK exceptions and retries an evaluation on the next snapshot', async () => {
    const client = await import('../client');
    await client.initializeDesktopInstrumentationClient(options);
    mockPostHogCapture.mockImplementationOnce(() => {
      throw new Error('capture failed');
    });
    expect(() =>
      client.addClientFeatureFlagEvaluation('flag', true),
    ).not.toThrow();
    client.addClientFeatureFlagEvaluation('flag', true);
    expect(evaluations()).toHaveLength(2);
  });
});

describe('PostHog window session synchronization', () => {
  type Sdk = Parameters<typeof ConnectPostHogSession>[0];
  const rotatedId = sessionId.replace(/111111111111$/, '222222222222');
  const initial = { sessionId, revision: 0 };

  function fakeSdk(): { sdk: Sdk; id(): string; rotate(next: string): void } {
    let id = sessionId;
    let listener: Parameters<Sdk['onSessionId']>[0] | undefined;
    const sdk: Sdk = {
      onSessionId(callback) {
        listener = callback;
        callback(id, 'window');
        return () => {
          listener = undefined;
        };
      },
      sessionManager: {
        setBootstrapSessionId(next) {
          id = next;
          listener?.(id, 'window');
          return true;
        },
      },
      capture: jest.fn(),
    };
    return {
      sdk,
      id: () => id,
      rotate: (next: string): void => {
        id = next;
        listener?.(next, 'window');
      },
    };
  }

  it('converges three windows and buffers the triggering capture until main adopts the rotation', async () => {
    const { connectPostHogSession } = await import('../client/posthog-session');
    const listeners = new Set<(state: State) => void>();
    let resolveReport: ((state: State) => void) | undefined;
    const bridge = {
      get: (): Promise<State> => Promise.resolve(initial),
      report: jest.fn(
        () =>
          new Promise<State>((resolve) => {
            resolveReport = resolve;
          }),
      ),
      subscribe: (listener: (state: State) => void): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const windows = [fakeSdk(), fakeSdk(), fakeSdk()];
    const connections = await Promise.all(
      windows.map(({ sdk }) => connectPostHogSession(sdk, bridge)),
    );
    connections.forEach((connection) => connection.start());
    windows[1].rotate(rotatedId);
    const event = {
      uuid: 'event',
      event: 'rotation_trigger',
      properties: { $session_id: rotatedId, count: 2 },
    };
    expect(connections[1].filter(event)).toBeNull();
    await Promise.resolve();
    expect(bridge.report).toHaveBeenCalledTimes(1);
    const adopted = { sessionId: rotatedId, revision: 1 };
    listeners.forEach((listener) => listener(adopted));
    resolveReport?.(adopted);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(windows.map((window) => window.id())).toEqual([
      rotatedId,
      rotatedId,
      rotatedId,
    ]);
    expect(windows[1].sdk.capture).toHaveBeenCalledWith(
      'rotation_trigger',
      { count: 2 },
      { timestamp: undefined },
    );
    // Main's broadcast does not cause a report loop, and stale responses lose.
    listeners.forEach((listener) => listener(initial));
    expect(bridge.report).toHaveBeenCalledTimes(1);
    for (const connection of connections) {
      expect(connection.filter(event)?.properties.$session_id).toBe(rotatedId);
      connection.dispose();
    }
    expect(listeners.size).toBe(0);
  });

  it('keeps recorder identity and transport for buffered snapshots and drops stale ones', async () => {
    const { connectPostHogSession } = await import('../client/posthog-session');
    const window = fakeSdk();
    const sdk = {
      ...window.sdk,
      requestRouter: {
        endpointFor: jest.fn(() => 'http://127.0.0.1:18763/s/'),
      },
    };
    let resolveReport: ((state: State) => void) | undefined;
    const connection = await connectPostHogSession(sdk, {
      get: () => Promise.resolve(initial),
      report: () =>
        new Promise<State>((resolve) => {
          resolveReport = resolve;
        }),
      subscribe: () => (): void => undefined,
    });
    connection.start();
    const snapshot = {
      uuid: 'snapshot',
      event: '$snapshot',
      properties: {
        $session_id: rotatedId,
        $window_id: 'recorder-window',
        $snapshot_data: 'compressed bytes',
      },
    };
    expect(connection.filter(snapshot)).toBeNull();
    window.rotate(rotatedId);
    expect(connection.filter(snapshot)).toBeNull();
    expect(
      connection.filter({
        ...snapshot,
        uuid: 'old-snapshot',
        properties: { ...snapshot.properties, $session_id: sessionId },
      }),
    ).toBeNull();
    await Promise.resolve();
    resolveReport?.({ sessionId: rotatedId, revision: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sdk.capture).toHaveBeenCalledTimes(1);
    expect(sdk.capture).toHaveBeenCalledWith('$snapshot', snapshot.properties, {
      timestamp: undefined,
      _url: 'http://127.0.0.1:18763/s/',
      _noTruncate: true,
      _batchKey: 'recordings',
      skip_client_rate_limiting: true,
    });
    connection.dispose();
  });

  it('keeps a broadcast that races initial bootstrap and releases subscriptions after failure', async () => {
    const { connectPostHogSession } = await import('../client/posthog-session');
    const unsubscribe = jest.fn();
    const { sdk } = fakeSdk();
    const connection = await connectPostHogSession(sdk, {
      get: (): Promise<State> => Promise.resolve(initial),
      report: jest.fn(),
      subscribe: (listener) => {
        listener({ sessionId: rotatedId, revision: 1 });
        return unsubscribe;
      },
    });
    expect(connection.sessionId).toBe(rotatedId);
    connection.start();
    connection.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await expect(
      connectPostHogSession(sdk, {
        get: () => Promise.reject(new Error('disconnected')),
        report: jest.fn(),
        subscribe: () => unsubscribe,
      }),
    ).rejects.toThrow('disconnected');
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a rejected rotation and recovers on an authoritative broadcast', async () => {
    const { connectPostHogSession } = await import('../client/posthog-session');
    const window = fakeSdk();
    let update: ((state: State) => void) | undefined;
    const connection = await connectPostHogSession(window.sdk, {
      get: (): Promise<State> => Promise.resolve(initial),
      report: () => Promise.reject(new Error('disconnected')),
      subscribe: (listener) => {
        update = listener;
        return (): void => undefined;
      },
    });
    connection.start();
    const captureAvailable = jest.fn();
    connection.onCaptureAvailable(captureAvailable);
    window.rotate(rotatedId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const event = { uuid: 'event', event: 'product_event', properties: {} };
    expect(connection.filter(event)).toBeNull();
    update?.({ sessionId, revision: 1 });
    expect(captureAvailable).toHaveBeenCalledTimes(1);
    update?.({ sessionId: rotatedId, revision: 1 });
    expect(connection.filter(event)?.properties.$session_id).toBe(rotatedId);
    expect(captureAvailable).toHaveBeenCalledTimes(1);
    connection.dispose();
    expect(connection.filter(event)).toBeNull();
  });

  it('notifies adopted sessions for host broadcasts and before proposal-buffered events drain', async () => {
    const { connectPostHogSession } = await import('../client/posthog-session');
    const hostWindow = fakeSdk();
    let hostUpdate: ((state: State) => void) | undefined;
    const hostConnection = await connectPostHogSession(hostWindow.sdk, {
      get: (): Promise<State> => Promise.resolve(initial),
      report: jest.fn(),
      subscribe: (listener) => {
        hostUpdate = listener;
        return (): void => undefined;
      },
    });
    hostConnection.start();
    const hostAdopted = jest.fn();
    const unsubscribeHostAdopted = hostConnection.onAdopted(hostAdopted);
    hostUpdate?.({ sessionId: rotatedId, revision: 1 });
    expect(hostAdopted).toHaveBeenCalledWith(rotatedId);
    unsubscribeHostAdopted();
    unsubscribeHostAdopted();
    hostUpdate?.({
      sessionId: rotatedId.replace(/222222222222$/, '333333333333'),
      revision: 2,
    });
    expect(hostAdopted).toHaveBeenCalledTimes(1);
    hostConnection.dispose();

    const proposingWindow = fakeSdk();
    const adopted = { sessionId: rotatedId, revision: 1 };
    const proposalConnection = await connectPostHogSession(
      proposingWindow.sdk,
      {
        get: (): Promise<State> => Promise.resolve(initial),
        report: (): Promise<State> => Promise.resolve(adopted),
        subscribe: () => (): void => undefined,
      },
    );
    proposalConnection.start();
    const proposalAdopted = jest.fn();
    const proposalCaptureAvailable = jest.fn();
    proposalConnection.onAdopted(proposalAdopted);
    proposalConnection.onCaptureAvailable(proposalCaptureAvailable);
    proposingWindow.rotate(rotatedId);
    expect(
      proposalConnection.filter({
        uuid: 'buffered-event',
        event: 'buffered_navigation',
        properties: {
          screen_route: 'app://main/home',
          $current_url: 'app://main/home',
        },
      }),
    ).toBeNull();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proposalAdopted).toHaveBeenCalledWith(rotatedId);
    expect(proposalCaptureAvailable).toHaveBeenCalledTimes(1);
    expect(proposingWindow.sdk.capture).toHaveBeenCalledWith(
      'buffered_navigation',
      {
        screen_route: 'app://main/home',
        $current_url: 'app://main/home',
      },
      { timestamp: undefined },
    );
    expect(proposalAdopted.mock.invocationCallOrder[0]).toBeLessThan(
      (proposingWindow.sdk.capture as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(
      (proposingWindow.sdk.capture as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(proposalCaptureAvailable.mock.invocationCallOrder[0]);
    proposalConnection.dispose();
  });
});

describe('PostHog screen tracking lifecycle', () => {
  it('does not admit a filtered pageview or leave a route that was never tracked', async () => {
    const { createPostHogScreenTracker } =
      await import('../client/posthog-screen-tracking');
    const routes = createRouteSource('app://main/home');
    const pageLifecycle = new EventTarget();
    const sdk = {
      capture: jest.fn(),
      register_for_session: jest.fn(),
      unregister_for_session: jest.fn(),
    };
    let available = false;
    let captureAvailable: (() => void) | undefined;
    const options = {
      sdk,
      source: routes,
      captureEnabled: true,
      pageLifecycle,
      allowsCapture: (): boolean => available,
      onAdopted: () => (): void => undefined,
      onCaptureAvailable: (listener: () => void): (() => void) => {
        captureAvailable = listener;
        return (): void => undefined;
      },
    };
    const tracker = createPostHogScreenTracker(options);
    expect(sdk.capture).not.toHaveBeenCalled();

    routes.emit('app://settings/display');
    expect(sdk.capture).not.toHaveBeenCalled();
    available = true;
    captureAvailable?.();
    expect(sdk.capture.mock.calls).toEqual([
      [
        '$pageview',
        {
          screen_route: 'app://settings/display',
          $current_url: 'app://settings/display',
        },
      ],
    ]);

    pageLifecycle.dispatchEvent(new Event('pagehide'));
    expect(sdk.capture).toHaveBeenNthCalledWith(
      2,
      '$pageleave',
      {
        screen_route: 'app://settings/display',
        $current_url: 'app://settings/display',
      },
      { transport: 'sendBeacon' },
    );
    tracker.dispose();
  });

  it('emits ordered views and old-route leaves, re-registers on adoption, and flushes once on pagehide', async () => {
    const { createPostHogScreenTracker } =
      await import('../client/posthog-screen-tracking');
    const routes = createRouteSource('app://main/home');
    const pageLifecycle = new EventTarget();
    let adopted: ((sessionId: string) => void) | undefined;
    const unsubscribeAdopted = jest.fn();
    const sdk = {
      capture: jest.fn(),
      register_for_session: jest.fn(),
      unregister_for_session: jest.fn(),
    };
    const tracker = createPostHogScreenTracker({
      sdk,
      source: routes,
      captureEnabled: true,
      allowsCapture: () => true,
      pageLifecycle,
      onAdopted: (listener) => {
        adopted = listener;
        return unsubscribeAdopted;
      },
      onCaptureAvailable: () => (): void => undefined,
    });
    const home = {
      screen_route: 'app://main/home',
      $current_url: 'app://main/home',
    };
    const display = {
      screen_route: 'app://settings/display',
      $current_url: 'app://settings/display',
    };
    expect(sdk.register_for_session).toHaveBeenCalledWith(home);
    expect(sdk.capture).toHaveBeenCalledWith('$pageview', home);

    routes.emit('app://main/home');
    expect(sdk.capture).toHaveBeenCalledTimes(1);
    routes.emit('app://settings/display');
    expect(sdk.capture).toHaveBeenNthCalledWith(2, '$pageleave', home);
    expect(sdk.register_for_session).toHaveBeenLastCalledWith(display);
    expect(sdk.capture).toHaveBeenNthCalledWith(3, '$pageview', display);
    expect(sdk.capture.mock.invocationCallOrder[1]).toBeLessThan(
      sdk.register_for_session.mock.invocationCallOrder[1],
    );
    expect(sdk.register_for_session.mock.invocationCallOrder[1]).toBeLessThan(
      sdk.capture.mock.invocationCallOrder[2],
    );

    adopted?.('adopted-session');
    expect(sdk.register_for_session).toHaveBeenLastCalledWith(display);
    expect(sdk.register_for_session).toHaveBeenCalledTimes(3);
    pageLifecycle.dispatchEvent(new Event('pagehide'));
    pageLifecycle.dispatchEvent(new Event('pagehide'));
    expect(sdk.capture).toHaveBeenNthCalledWith(4, '$pageleave', display, {
      transport: 'sendBeacon',
    });

    tracker.dispose();
    tracker.dispose();
    expect(routes.unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeAdopted).toHaveBeenCalledTimes(1);
    expect(sdk.unregister_for_session).toHaveBeenCalledTimes(2);
    expect(sdk.unregister_for_session).toHaveBeenCalledWith('screen_route');
    expect(sdk.unregister_for_session).toHaveBeenCalledWith('$current_url');
  });

  it('reports the route being left before its pageleave, once per real change', async () => {
    const { createPostHogScreenTracker } =
      await import('../client/posthog-screen-tracking');
    const routes = createRouteSource('app://main/home');
    const order: string[] = [];
    const sdk = {
      capture: jest.fn((event: string) => {
        order.push(event);
        return undefined;
      }),
      register_for_session: jest.fn(),
      unregister_for_session: jest.fn(),
    };
    const onRouteLeave = jest.fn((route: PostHogRoute) =>
      order.push(`leave ${route}`),
    );
    const tracker = createPostHogScreenTracker({
      sdk,
      source: routes,
      captureEnabled: true,
      allowsCapture: () => true,
      onAdopted: () => (): void => undefined,
      onCaptureAvailable: () => (): void => undefined,
      onRouteLeave,
    });
    routes.emit('app://main/home');
    expect(onRouteLeave).not.toHaveBeenCalled();
    routes.emit('app://settings/display');
    expect(order).toEqual([
      '$pageview',
      'leave app://main/home',
      '$pageleave',
      '$pageview',
    ]);
    onRouteLeave.mockImplementation(() => {
      throw new Error('flush failed');
    });
    routes.emit('app://settings/account');
    expect(sdk.capture).toHaveBeenLastCalledWith('$pageview', {
      screen_route: 'app://settings/account',
      $current_url: 'app://settings/account',
    });
    tracker.dispose();
  });

  it('does not subscribe while initially disabled and resumes with only the latest route', async () => {
    const { createPostHogScreenTracker } =
      await import('../client/posthog-screen-tracking');
    const routes = createRouteSource('app://main/home');
    const sdk = {
      capture: jest.fn(),
      register_for_session: jest.fn(),
      unregister_for_session: jest.fn(),
    };
    const tracker = createPostHogScreenTracker({
      sdk,
      source: routes,
      captureEnabled: false,
      allowsCapture: () => true,
      pageLifecycle: new EventTarget(),
      onAdopted: () => (): void => undefined,
      onCaptureAvailable: () => (): void => undefined,
    });
    expect(routes.subscribe).not.toHaveBeenCalled();
    expect(sdk.capture).not.toHaveBeenCalled();

    routes.emit('app://settings/display');
    tracker.setCaptureEnabled(true);
    expect(routes.subscribe).toHaveBeenCalledTimes(1);
    expect(sdk.capture).toHaveBeenLastCalledWith('$pageview', {
      screen_route: 'app://settings/display',
      $current_url: 'app://settings/display',
    });
    tracker.setCaptureEnabled(false);
    expect(routes.unsubscribe).toHaveBeenCalledTimes(1);
    routes.emit('app://settings/account');
    expect(sdk.capture).toHaveBeenCalledTimes(1);
    tracker.setCaptureEnabled(true);
    expect(routes.subscribe).toHaveBeenCalledTimes(2);
    expect(sdk.capture).toHaveBeenLastCalledWith('$pageview', {
      screen_route: 'app://settings/account',
      $current_url: 'app://settings/account',
    });
    expect(
      sdk.capture.mock.calls.filter(([event]) => event === '$pageleave'),
    ).toEqual([]);
    tracker.dispose();
  });
});

describe('PostHog LaunchDarkly capture gate', () => {
  const posthogId = '44444444-4444-4444-8444-444444444444';
  beforeEach(() => {
    jest.resetModules();
    mockPostHogInit.mockReset();
    mockPostHogCapture.mockReset();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_DATADOG_ENABLED__: false,
    });
  });
  afterEach(() =>
    Object.assign(globalThis, { __CANOPY_POSTHOG_ENABLED__: false }),
  );

  it('waits for the authoritative flags before capturing without holding up Datadog', async () => {
    let resolveFlags!: (flags: PostHogRuntimeFlags) => void;
    const flags = new Promise<PostHogRuntimeFlags>((resolve) => {
      resolveFlags = resolve;
    });
    const reported = jest.fn();
    const options: DesktopInstrumentationClientInitOptions = {
      surface: 'main' as const,
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogFlags: {
        getSnapshot: () => flags,
        onSnapshotChanged: jest.fn(() => (): void => undefined),
      },
      onProviderInitialized: reported,
    };
    const client = await import('../client');
    const initializing = client.initializeDesktopInstrumentationClient(options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toHaveBeenCalledWith({
      enabled: false,
      provider: 'datadog',
      reason: 'disabled',
    });
    expect(mockPostHogCapture).not.toHaveBeenCalled();
    resolveFlags({ captureEnabled: false, sessionReplaySampleRate: 0 });
    await initializing;
    expect(mockPostHogCapture).not.toHaveBeenCalled();
  });

  it('does not let an older initial read overwrite a pushed disable', async () => {
    let resolveFlags!: (flags: PostHogRuntimeFlags) => void;
    let change!: (flags: PostHogRuntimeFlags) => void;
    const initial = new Promise<PostHogRuntimeFlags>((resolve) => {
      resolveFlags = resolve;
    });
    const options: DesktopInstrumentationClientInitOptions = {
      surface: 'main' as const,
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogFlags: {
        getSnapshot: () => initial,
        onSnapshotChanged: (listener: typeof change) => {
          change = listener;
          return (): void => undefined;
        },
      },
    };
    const client = await import('../client');
    const initializing = client.initializeDesktopInstrumentationClient(options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (change) change({ captureEnabled: false, sessionReplaySampleRate: 0 });
    resolveFlags({ captureEnabled: true, sessionReplaySampleRate: 100 });
    await initializing;
    expect(mockPostHogCapture).not.toHaveBeenCalled();
  });

  it('stops recording and opts out on a pushed disable, without emitting opt-in events', async () => {
    let change: ((flags: PostHogRuntimeFlags) => void) | undefined;
    const options: DesktopInstrumentationClientInitOptions = {
      surface: 'main' as const,
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogFlags: {
        getSnapshot: enabledPostHogFlags.getSnapshot,
        onSnapshotChanged: (listener: NonNullable<typeof change>) => {
          change = listener;
          return (): void => undefined;
        },
      },
    };
    const client = await import('../client');
    await client.initializeDesktopInstrumentationClient(options);
    mockPostHogStop.mockClear();
    mockPostHogOptOut.mockClear();
    change?.({ captureEnabled: false, sessionReplaySampleRate: 0 });
    expect(mockPostHogStop).toHaveBeenCalledTimes(1);
    expect(mockPostHogOptOut).toHaveBeenCalledTimes(1);
    expect(mockPostHogOptIn).toHaveBeenCalledWith({ captureEventName: false });
  });

  it('fails closed when the initial snapshot cannot be fetched', async () => {
    const options: DesktopInstrumentationClientInitOptions = {
      surface: 'main' as const,
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogFlags: {
        getSnapshot: () => Promise.reject(new Error('IPC unavailable')),
        onSnapshotChanged: jest.fn(() => (): void => undefined),
      },
    };
    const client = await import('../client');
    await client.initializeDesktopInstrumentationClient(options);
    expect(mockPostHogCapture).not.toHaveBeenCalled();
  });

  it('restores SDK transports and can reinitialize after renderer disposal', async () => {
    const { default: sdk } =
      await import('posthog-js/dist/module.full.no-external');
    /* eslint-disable @typescript-eslint/unbound-method -- this regression test verifies exact SDK method identity restoration. */
    const originalSend = sdk._send_request;
    const originalSendRetriable = sdk._send_retriable_request;
    const originalRetry = sdk._retryQueue?.retriableRequest;
    const unsubscribe = jest.fn();
    const options: DesktopInstrumentationClientInitOptions = {
      surface: 'main' as const,
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogFlags: {
        getSnapshot: enabledPostHogFlags.getSnapshot,
        onSnapshotChanged: () => unsubscribe,
      },
    };
    const client = await import('../client');

    await client.initializeDesktopInstrumentationClient(options);
    expect(sdk._send_request).not.toBe(originalSend);
    expect(sdk._send_retriable_request).not.toBe(originalSendRetriable);
    expect(sdk._retryQueue?.retriableRequest).not.toBe(originalRetry);

    client.disposePostHogInstrumentationClient();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(sdk._send_request).toBe(originalSend);
    expect(sdk._send_retriable_request).toBe(originalSendRetriable);
    expect(sdk._retryQueue?.retriableRequest).toBe(originalRetry);

    await client.initializeDesktopInstrumentationClient(options);
    expect(mockPostHogInit).toHaveBeenCalledTimes(2);
    expect(sdk._send_request).not.toBe(originalSend);
    expect(sdk._send_retriable_request).not.toBe(originalSendRetriable);
    expect(sdk._retryQueue?.retriableRequest).not.toBe(originalRetry);
    /* eslint-enable @typescript-eslint/unbound-method */
  });
});

describe('PostHog runtime session and transport policy', () => {
  const expectPublishedRate = (rate: number): void => {
    const expectedRecording: unknown = expect.objectContaining({
      sampleRate: rate,
      maskAllInputs: true,
    });
    expect(mockPostHogSetConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ session_recording: expectedRecording }),
    );
  };
  beforeEach(() => {
    jest.resetModules();
    mockPostHogSetConfig.mockClear();
    mockPostHogOnSessionId.mockClear();
    mockPostHogStart.mockClear();
    mockPostHogRemoteConfig.mockClear();
    mockPostHogRecordingStarted.mockReturnValue(false);
  });
  it('holds increases until a new session, applies decreases immediately, and never exceeds the build', async () => {
    const { createPostHogRuntimeController } =
      await import('../client/posthog-runtime');
    const { default: sdk } =
      await import('posthog-js/dist/module.full.no-external');
    const controller = createPostHogRuntimeController(
      sdk,
      {
        enabled: true,
        projectKey: 'phc_test',
        host: 'https://us.i.posthog.com',
        sessionReplaySampleRate: 20,
      },
      { captureEnabled: true, sessionReplaySampleRate: 5 },
    );
    const sessionChanged = mockPostHogOnSessionId.mock.calls[0][0];
    sessionChanged('session-one');
    expectPublishedRate(0.05);
    controller.update({ captureEnabled: true, sessionReplaySampleRate: 100 });
    expectPublishedRate(0.05);
    sessionChanged('session-two');
    expectPublishedRate(0.2);
    controller.update({ captureEnabled: true, sessionReplaySampleRate: 2 });
    expectPublishedRate(0.02);
    controller.update({ captureEnabled: false, sessionReplaySampleRate: 100 });
    expect(controller.allowsEvent('product_event')).toBe(false);
    expect(controller.allowsEvent('$snapshot')).toBe(false);
  });
  it('turns click capture on and off with the autocapture flag while capture is on', async () => {
    const { createPostHogRuntimeController } =
      await import('../client/posthog-runtime');
    const { POSTHOG_AUTOCAPTURE_OPTIONS, POSTHOG_DEAD_CLICK_OPTIONS } =
      await import('../client/posthog-autocapture-options');
    const { default: sdk } =
      await import('posthog-js/dist/module.full.no-external');
    const flags = {
      captureEnabled: true,
      sessionReplaySampleRate: 0,
      autocaptureEnabled: true,
    };
    const expectClickConfig = (enabled: boolean): void => {
      expect(mockPostHogSetConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          autocapture: enabled ? POSTHOG_AUTOCAPTURE_OPTIONS : false,
          capture_dead_clicks: enabled ? POSTHOG_DEAD_CLICK_OPTIONS : false,
          capture_heatmaps: enabled,
        }),
      );
    };
    const controller = createPostHogRuntimeController(
      sdk,
      {
        enabled: true,
        projectKey: 'phc_test',
        host: 'https://us.i.posthog.com',
        sessionReplaySampleRate: 100,
      },
      flags,
    );
    expectClickConfig(true);
    expect(POSTHOG_AUTOCAPTURE_OPTIONS).toEqual({ capture_copied_text: false });
    for (const name of ['$autocapture', '$rageclick', '$dead_click']) {
      expect(controller.allowsEvent(name)).toBe(true);
    }
    expect(controller.allowsEvent('$$heatmap')).toBe(true);
    expect(controller.allowsEvent('$copy_autocapture')).toBe(false);
    controller.update({ ...flags, autocaptureEnabled: false });
    expectClickConfig(false);
    for (const name of ['$autocapture', '$rageclick', '$dead_click']) {
      expect(controller.allowsEvent(name)).toBe(false);
    }
    expect(controller.allowsEvent('$$heatmap')).toBe(false);
    expect(controller.allowsEvent('app_opened')).toBe(true);
    controller.update(flags);
    expectClickConfig(true);
    controller.update({ ...flags, captureEnabled: false });
    expectClickConfig(false);
    expect(controller.allowsEvent('$autocapture')).toBe(false);
    controller.update(flags);
    controller.dispose();
    expectClickConfig(false);
  });
  it('starts sampled replay only at a positive rate and supplies config before starting', async () => {
    const { createPostHogRuntimeController } =
      await import('../client/posthog-runtime');
    const { default: sdk } =
      await import('posthog-js/dist/module.full.no-external');
    const config = {
      enabled: true,
      projectKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      sessionReplaySampleRate: 100,
    };
    const controller = createPostHogRuntimeController(sdk, config, {
      captureEnabled: true,
      sessionReplaySampleRate: 0,
    });
    expect(mockPostHogStart).not.toHaveBeenCalled();
    controller.update({ captureEnabled: true, sessionReplaySampleRate: 100 });
    expect(mockPostHogStart).not.toHaveBeenCalled();
    mockPostHogOnSessionId.mock.calls[0][0]('new-session');
    const expectedConfig: unknown = expect.objectContaining({
      sessionRecording: { endpoint: '/s/' },
    });
    expect(mockPostHogRemoteConfig).toHaveBeenCalledWith({
      ok: true,
      config: expectedConfig,
    });
    expect(mockPostHogStart).toHaveBeenCalledWith();
    expect(mockPostHogRemoteConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mockPostHogStart.mock.invocationCallOrder[0],
    );
    controller.dispose();
  });
  it('refreshes replay on main-driven adoption and re-supplies after rate updates', async () => {
    const { createPostHogRuntimeController } =
      await import('../client/posthog-runtime');
    const { default: sdk } =
      await import('posthog-js/dist/module.full.no-external');
    let adopted: ((id: string) => void) | undefined;
    const unsubscribeAdopted = jest.fn();
    const controller = createPostHogRuntimeController(
      sdk,
      {
        enabled: true,
        projectKey: 'phc_test',
        host: 'https://us.i.posthog.com',
        sessionReplaySampleRate: 100,
      },
      { captureEnabled: true, sessionReplaySampleRate: 0 },
      undefined,
      (listener) => {
        adopted = listener;
        return unsubscribeAdopted;
      },
    );
    controller.update({ captureEnabled: true, sessionReplaySampleRate: 100 });
    expect(mockPostHogStart).not.toHaveBeenCalled();
    adopted?.('main-adopted-session');
    expect(mockPostHogStart).toHaveBeenCalledTimes(1);
    mockPostHogRecordingStarted.mockReturnValue(true);
    const configCount = mockPostHogRemoteConfig.mock.calls.length;
    controller.update({ captureEnabled: true, sessionReplaySampleRate: 25 });
    expectPublishedRate(0.25);
    expect(mockPostHogRemoteConfig).toHaveBeenCalledTimes(configCount + 1);
    const configOrder = mockPostHogSetConfig.mock.invocationCallOrder.at(-1);
    const remoteOrder = mockPostHogRemoteConfig.mock.invocationCallOrder.at(-1);
    if (configOrder === undefined || remoteOrder === undefined) {
      throw new Error('Expected configuration calls');
    }
    expect(configOrder).toBeLessThan(remoteOrder);
    adopted?.('main-adopted-session');
    expect(mockPostHogRemoteConfig).toHaveBeenCalledTimes(configCount + 1);
    controller.dispose();
    expect(unsubscribeAdopted).toHaveBeenCalledTimes(1);
  });
  it('does not reuse a pre-disable request when a late retry arrives after re-enabling', async () => {
    const { createPostHogRuntimeController } =
      await import('../client/posthog-runtime');
    const { default: sdk } =
      await import('posthog-js/dist/module.full.no-external');
    const queue = sdk._retryQueue;
    if (!queue) throw new Error('Missing retry queue');
    const retry = jest.fn();
    queue.retriableRequest = retry;
    const controller = createPostHogRuntimeController(
      sdk,
      {
        enabled: true,
        projectKey: 'phc_test',
        host: 'https://us.i.posthog.com',
        sessionReplaySampleRate: 0,
      },
      { captureEnabled: true, sessionReplaySampleRate: 100 },
    );
    const request = {
      url: 'https://us.i.posthog.com/i/v0/e/',
      data: { event: 'before' },
    };
    queue.retriableRequest(request);
    expect(retry).toHaveBeenCalledTimes(1);
    controller.update({ captureEnabled: false, sessionReplaySampleRate: 0 });
    controller.update({ captureEnabled: true, sessionReplaySampleRate: 100 });
    queue.retriableRequest({ ...request, retriesPerformedSoFar: 1 });
    expect(retry).toHaveBeenCalledTimes(1);
    queue.retriableRequest({ ...request, data: { event: 'after' } });
    expect(retry).toHaveBeenCalledTimes(2);
  });
});

describe('PostHog operation forwarding from app windows', () => {
  const posthogId = '55555555-5555-4555-8555-555555555555';
  const context = { action: 'create', entry: 'import' };
  let client: typeof ClientModule;
  let changeFlags: ((flags: PostHogRuntimeFlags) => void) | undefined;

  function operationEvents(): Array<[string, Record<string, unknown>]> {
    return mockPostHogCapture.mock.calls.filter(
      ([event]) => event !== 'app_opened',
    );
  }

  async function initialize(
    surface: DesktopInstrumentationClientInitOptions['surface'] = 'main',
  ): Promise<void> {
    await client.initializeDesktopInstrumentationClient({
      surface,
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogFlags: {
        getSnapshot: enabledPostHogFlags.getSnapshot,
        onSnapshotChanged: (listener) => {
          changeFlags = listener;
          return (): void => undefined;
        },
      },
    });
  }

  beforeEach(async () => {
    jest.useRealTimers();
    jest.resetModules();
    mockPostHogInit.mockReset();
    mockPostHogCapture.mockReset();
    mockPostHogSetSessionId.mockReturnValue(true);
    mockPostHogOnSessionId.mockReturnValue(jest.fn());
    sessionBridge.subscribe.mockReturnValue(jest.fn());
    mockStartFeatureOperation.mockClear();
    mockSucceedFeatureOperation.mockClear();
    mockFailFeatureOperation.mockClear();
    changeFlags = undefined;
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
      __CANOPY_DATADOG_ENABLED__: true,
      __CANOPY_DATADOG_CLIENT_TOKEN__: 'client-token',
      __CANOPY_DATADOG_APPLICATION_ID__: 'application-id',
    });
    client = await import('../client');
  });

  afterEach(() => {
    jest.useRealTimers();
    client.disposePostHogInstrumentationClient();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: false,
      __CANOPY_DATADOG_ENABLED__: false,
      __CANOPY_DATADOG_CLIENT_TOKEN__: '',
      __CANOPY_DATADOG_APPLICATION_ID__: '',
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
    async (name, event) => {
      await initialize();
      client.startClientOperation(name, { operationKey: 'op_1', context });
      client.succeedClientOperation(name, { operationKey: 'op_1', context });

      expect(operationEvents().map(([captured]) => captured)).toEqual(
        event === null ? [] : [event],
      );
      expect(mockStartFeatureOperation).toHaveBeenCalledTimes(1);
      expect(mockStartFeatureOperation).toHaveBeenCalledWith(name, {
        operationKey: 'op_1',
        context,
      });
      expect(mockSucceedFeatureOperation).toHaveBeenCalledTimes(1);
      expect(mockSucceedFeatureOperation).toHaveBeenCalledWith(name, {
        operationKey: 'op_1',
        context,
      });
    },
  );

  it.each(PRODUCT_OPERATION_EVENTS)(
    '%s produces one %s failure event',
    async (name, event) => {
      await initialize();
      client.startClientOperation(name, { operationKey: 'op_1', context });
      client.failClientOperation(name, 'error', {
        operationKey: 'op_1',
        context,
      });

      const captured = operationEvents();
      expect(captured).toHaveLength(1);
      expect(captured[0]?.[0]).toBe(event);
      expect(captured[0]?.[1]).toEqual(
        expect.objectContaining({ status: 'failure', failure_reason: 'error' }),
      );
      expect(mockFailFeatureOperation).toHaveBeenCalledWith(name, 'error', {
        operationKey: 'op_1',
        context,
      });
    },
  );

  it('sends status, duration, the window surface, and the sanitized context', async () => {
    await initialize('app-advisor');
    jest.useFakeTimers({ now: 1_000 });
    client.startClientOperation('canopy.suggested_prompt', {
      context: { action: 'cta_click' },
    });
    jest.setSystemTime(1_040);
    client.succeedClientOperation('canopy.suggested_prompt', {
      context: { action: 'cta_click', suggestion_id: '/Users/private/notes' },
    });

    expect(operationEvents()).toEqual([
      [
        'chat:suggested_prompt_update',
        {
          action: 'cta_click',
          suggestion_id: '<user-home>/notes',
          status: 'success',
          duration_ms: 40,
          surface: 'app-advisor',
          app_version: '0.0.0-test',
        },
      ],
    ]);
  });

  // Release builds without Datadog secrets bundle an empty Datadog version,
  // and only internal builds bump the committed package.json version.
  it.each([
    { datadogVersion: '0.26.8', label: 'a stale Datadog version' },
    { datadogVersion: '', label: 'a blank Datadog version' },
  ])(
    'stamps the bundled app version over $label, which context cannot replace',
    async ({ datadogVersion }) => {
      jest.resetModules();
      Object.assign(globalThis, {
        __CANOPY_APP_VERSION__: '0.27.0-rc.3',
        __CANOPY_DATADOG_VERSION__: datadogVersion,
        // The version is independent of Datadog being enabled.
        __CANOPY_DATADOG_ENABLED__: false,
      });
      client = await import('../client');
      await initialize();
      client.succeedClientOperation('canopy.suggested_prompt', {
        context: { action: 'selection', app_version: '0.0.1-spoofed' },
      });

      expect(operationEvents()).toEqual([
        [
          'chat:suggested_prompt_update',
          expect.objectContaining({ app_version: '0.27.0-rc.3' }),
        ],
      ]);
    },
  );

  it('omits the app version when the build did not bundle one', async () => {
    jest.resetModules();
    Object.assign(globalThis, {
      __CANOPY_APP_VERSION__: ' ',
      __CANOPY_DATADOG_VERSION__: '0.26.8',
    });
    client = await import('../client');
    await initialize();
    client.succeedClientOperation('canopy.suggested_prompt', {
      context: { action: 'selection', app_version: '0.0.1-spoofed' },
    });

    const [event] = operationEvents();
    expect(event?.[0]).toBe('chat:suggested_prompt_update');
    expect(event?.[1]).not.toHaveProperty('app_version');
  });

  it('keeps plan hint placement separate from the window surface and drops prompt text', async () => {
    await initialize();
    client.succeedClientOperation('canopy.home_onboarding_suggestions', {
      context: {
        action: 'shown',
        entry: 'plan-mode-hint',
        surface: 'home',
        prompt: 'private text',
      },
    });
    expect(operationEvents()[0]?.[0]).toBe('home:onboarding_suggestion_update');
    expect(operationEvents()[0]?.[1]).toEqual(
      expect.objectContaining({
        action: 'shown',
        entry: 'plan-mode-hint',
        composer_surface: 'home',
        surface: 'main',
      }),
    );
    expect(operationEvents()[0]?.[1]).not.toHaveProperty('prompt');
  });

  it('keeps the suggested prompt placement separate from the window surface', async () => {
    await initialize();
    client.startClientOperation('canopy.suggested_prompt', {
      context: { surface: 'cowork', action: 'selection' },
    });
    client.succeedClientOperation('canopy.suggested_prompt', {
      context: { surface: 'cowork', action: 'selection' },
    });

    expect(operationEvents()[0]?.[1]).toEqual(
      expect.objectContaining({ prompt_surface: 'cowork', surface: 'main' }),
    );
    expect(mockSucceedFeatureOperation).toHaveBeenCalledWith(
      'canopy.suggested_prompt',
      { context: { surface: 'cowork', action: 'selection' } },
    );
  });

  it('forwards nothing while the capture flag is off', async () => {
    await initialize();
    changeFlags?.({ captureEnabled: false, sessionReplaySampleRate: 0 });
    client.succeedClientOperation('canopy.suggested_prompt');

    expect(operationEvents()).toEqual([]);
    expect(mockSucceedFeatureOperation).toHaveBeenCalledTimes(1);
  });

  it('drops import ends without an eligible start, including across capture withdrawal', async () => {
    await initialize();
    client.startClientOperation('canopy.first_run_import', {
      operationKey: 'withdrawn',
    });
    changeFlags?.({ captureEnabled: false, sessionReplaySampleRate: 0 });
    client.startClientOperation('canopy.project_import', {
      operationKey: 'disabled',
    });
    changeFlags?.({ captureEnabled: true, sessionReplaySampleRate: 0 });
    client.succeedClientOperation('canopy.first_run_import', {
      operationKey: 'withdrawn',
    });
    client.succeedClientOperation('canopy.project_import', {
      operationKey: 'disabled',
    });
    client.succeedClientOperation('canopy.project_import', {
      operationKey: 'unstarted',
    });
    expect(operationEvents()).toEqual([]);
    client.startClientOperation('canopy.project_import', {
      operationKey: 'retry',
    });
    client.succeedClientOperation('canopy.project_import', {
      operationKey: 'retry',
    });
    expect(operationEvents().map(([event]) => event)).toEqual([
      'projects:import_end',
    ]);
  });

  it('delivers operations that finish while PostHog is initializing', async () => {
    let resolveId: ((id: string) => void) | undefined;
    const initializing = client.initializeDesktopInstrumentationClient({
      surface: 'main',
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () =>
        new Promise<string>((resolve) => {
          resolveId = resolve;
        }),
      posthogFlags: enabledPostHogFlags,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.succeedClientOperation('canopy.suggested_prompt', {
      context: { action: 'impression' },
    });
    expect(operationEvents()).toEqual([]);

    resolveId?.(posthogId);
    await initializing;

    expect(operationEvents()).toEqual([
      [
        'chat:suggested_prompt_update',
        expect.objectContaining({ action: 'impression', status: 'success' }),
      ],
    ]);
  });

  it('bounds operations held during initialization', async () => {
    let resolveId: ((id: string) => void) | undefined;
    const initializing = client.initializeDesktopInstrumentationClient({
      surface: 'main',
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () =>
        new Promise<string>((resolve) => {
          resolveId = resolve;
        }),
      posthogFlags: enabledPostHogFlags,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 60; index += 1) {
      client.succeedClientOperation('canopy.suggested_prompt', {
        context: { suggestion_index: index },
      });
    }
    resolveId?.(posthogId);
    await initializing;

    const held = operationEvents();
    expect(held).toHaveLength(50);
    expect(held[0]?.[1]).toEqual(
      expect.objectContaining({ suggestion_index: 10 }),
    );
  });

  it('discards held operations when capture is disabled at startup', async () => {
    let resolveFlags: ((flags: PostHogRuntimeFlags) => void) | undefined;
    const initializing = client.initializeDesktopInstrumentationClient({
      surface: 'main',
      posthogSession: sessionBridge,
      getPostHogAnonymousId: () => Promise.resolve(posthogId),
      posthogFlags: {
        getSnapshot: () =>
          new Promise<PostHogRuntimeFlags>((resolve) => {
            resolveFlags = resolve;
          }),
        onSnapshotChanged: (listener) => {
          changeFlags = listener;
          return (): void => undefined;
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.succeedClientOperation('canopy.suggested_prompt');
    resolveFlags?.({ captureEnabled: false, sessionReplaySampleRate: 0 });
    await initializing;
    expect(changeFlags).toBeDefined();
    changeFlags?.({ captureEnabled: true, sessionReplaySampleRate: 0 });
    client.succeedClientOperation('canopy.activation_campaign');

    // Only the operation finishing after capture resumed is delivered.
    expect(operationEvents().map(([event]) => event)).toEqual([
      'activation:campaign_update',
    ]);
  });

  it('forwards nothing when PostHog is disabled or after disposal', async () => {
    Object.assign(globalThis, { __CANOPY_POSTHOG_ENABLED__: false });
    await initialize();
    client.succeedClientOperation('canopy.suggested_prompt');
    client.disposePostHogInstrumentationClient();
    jest.resetModules();
    Object.assign(globalThis, { __CANOPY_POSTHOG_ENABLED__: true });
    client = await import('../client');
    await initialize();
    client.disposePostHogInstrumentationClient();
    client.succeedClientOperation('canopy.suggested_prompt');

    expect(operationEvents()).toEqual([]);
    expect(mockPostHogInit).toHaveBeenCalledTimes(1);
  });

  it('forwards operations when Datadog is disabled', async () => {
    Object.assign(globalThis, { __CANOPY_DATADOG_ENABLED__: false });
    await initialize();
    client.succeedClientOperation('canopy.suggested_prompt');

    expect(operationEvents().map(([event]) => event)).toEqual([
      'chat:suggested_prompt_update',
    ]);
    expect(mockSucceedFeatureOperation).not.toHaveBeenCalled();
  });

  it('never forwards handled errors', async () => {
    await initialize();
    client.captureClientInstrumentationError(new Error('boom'));

    expect(operationEvents()).toEqual([]);
  });
});
