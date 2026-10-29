import {
  getDesktopInstrumentationConfig,
  getPostHogInstrumentationReadiness,
  resolvePostHogRuntimePolicy,
} from '../config';

const DATADOG_RUNTIME_ENV_KEYS = [
  'CANOPY_DATADOG_ENABLED',
  'CANOPY_DATADOG_CLIENT_TOKEN',
  'CANOPY_DATADOG_APPLICATION_ID',
  'CANOPY_DATADOG_SITE',
  'CANOPY_DATADOG_SERVICE',
  'CANOPY_DATADOG_ENV',
  'CANOPY_DATADOG_VERSION',
  'CANOPY_DATADOG_PROXY',
  'CANOPY_DATADOG_SESSION_SAMPLE_RATE',
  'CANOPY_DATADOG_SESSION_REPLAY_SAMPLE_RATE',
  'CANOPY_DATADOG_TELEMETRY_SAMPLE_RATE',
  'CANOPY_DATADOG_TRACK_RESOURCES',
  'CANOPY_DATADOG_TRACK_LONG_TASKS',
  'CANOPY_DATADOG_TRACK_USER_INTERACTIONS',
  'CANOPY_DATADOG_ENABLE_PRIVACY_FOR_ACTION_NAME',
  'CANOPY_DATADOG_ALLOWED_TRACING_URLS',
  'CANOPY_DATADOG_TRACE_SAMPLE_RATE',
  'CANOPY_DATADOG_DEFAULT_PRIVACY_LEVEL',
  'CANOPY_DATADOG_ALLOWED_WEBVIEW_HOSTS',
  'CANOPY_DATADOG_SOURCEMAP_MINIFIED_PATH_PREFIX',
] as const;

const DATADOG_BUILD_CONSTANTS = [
  '__CANOPY_DATADOG_ENABLED__',
  '__CANOPY_DATADOG_CLIENT_TOKEN__',
  '__CANOPY_DATADOG_APPLICATION_ID__',
  '__CANOPY_DATADOG_SITE__',
  '__CANOPY_DATADOG_SERVICE__',
  '__CANOPY_DATADOG_ENV__',
  '__CANOPY_DATADOG_VERSION__',
  '__CANOPY_DATADOG_VARIANT__',
  '__CANOPY_DATADOG_PROXY__',
  '__CANOPY_DATADOG_SESSION_SAMPLE_RATE__',
  '__CANOPY_DATADOG_SESSION_REPLAY_SAMPLE_RATE__',
  '__CANOPY_DATADOG_TELEMETRY_SAMPLE_RATE__',
  '__CANOPY_DATADOG_TRACK_RESOURCES__',
  '__CANOPY_DATADOG_TRACK_LONG_TASKS__',
  '__CANOPY_DATADOG_TRACK_USER_INTERACTIONS__',
  '__CANOPY_DATADOG_ENABLE_PRIVACY_FOR_ACTION_NAME__',
  '__CANOPY_DATADOG_ALLOWED_TRACING_URLS__',
  '__CANOPY_DATADOG_TRACE_SAMPLE_RATE__',
  '__CANOPY_DATADOG_DEFAULT_PRIVACY_LEVEL__',
  '__CANOPY_DATADOG_ALLOWED_WEBVIEW_HOSTS__',
  '__CANOPY_DATADOG_SOURCEMAP_MINIFIED_PATH_PREFIX__',
] as const;

const POSTHOG_RUNTIME_ENV_KEYS = [
  'CANOPY_POSTHOG_ENABLED',
  'CANOPY_POSTHOG_PROJECT_KEY',
  'CANOPY_POSTHOG_HOST',
  'CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE',
] as const;

const POSTHOG_BUILD_CONSTANTS = [
  '__CANOPY_POSTHOG_ENABLED__',
  '__CANOPY_POSTHOG_PROJECT_KEY__',
  '__CANOPY_POSTHOG_HOST__',
  '__CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__',
  '__CANOPY_POSTHOG_STUB_URL__',
  '__CANOPY_E2E__',
] as const;

const RUNTIME_ENV_KEYS = [
  ...DATADOG_RUNTIME_ENV_KEYS,
  ...POSTHOG_RUNTIME_ENV_KEYS,
  'CANOPY_VERSION',
] as const;

const BUILD_CONSTANTS = [
  ...DATADOG_BUILD_CONSTANTS,
  ...POSTHOG_BUILD_CONSTANTS,
  '__CANOPY_APP_VERSION__',
] as const;

describe('desktop instrumentation config', () => {
  const originalRuntimeEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of RUNTIME_ENV_KEYS) {
      originalRuntimeEnv.set(key, process.env[key]);
    }
    for (const key of BUILD_CONSTANTS) {
      Reflect.deleteProperty(globalThis, key);
    }
  });

  afterEach(() => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = originalRuntimeEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalRuntimeEnv.clear();

    for (const key of BUILD_CONSTANTS) {
      Reflect.deleteProperty(globalThis, key);
    }
  });

  it('ignores runtime Datadog environment values and uses only build constants', () => {
    Object.assign(process.env, {
      CANOPY_DATADOG_ENABLED: 'true',
      CANOPY_DATADOG_CLIENT_TOKEN: 'runtime-client-token',
      CANOPY_DATADOG_APPLICATION_ID: 'runtime-application-id',
      CANOPY_DATADOG_SITE: 'datadoghq.eu',
      CANOPY_DATADOG_SERVICE: 'runtime-service',
      CANOPY_DATADOG_ENV: 'runtime-env',
      CANOPY_DATADOG_VERSION: 'runtime-version',
      CANOPY_DATADOG_PROXY: 'http://127.0.0.1:8126',
      CANOPY_DATADOG_SESSION_SAMPLE_RATE: '100',
      CANOPY_DATADOG_TRACE_SAMPLE_RATE: '100',
      CANOPY_DATADOG_DEFAULT_PRIVACY_LEVEL: 'allow',
    });
    Object.assign(globalThis, {
      __CANOPY_DATADOG_ENABLED__: false,
      __CANOPY_DATADOG_CLIENT_TOKEN__: '',
      __CANOPY_DATADOG_APPLICATION_ID__: '',
      __CANOPY_DATADOG_SITE__: 'datadoghq.com',
      __CANOPY_DATADOG_SERVICE__: 'canopy-desktop',
      __CANOPY_DATADOG_ENV__: '',
      __CANOPY_DATADOG_VERSION__: '0.24.16',
      __CANOPY_DATADOG_VARIANT__: 'rc-canopy',
      __CANOPY_DATADOG_PROXY__: '',
      __CANOPY_DATADOG_SESSION_SAMPLE_RATE__: 20,
      __CANOPY_DATADOG_TRACE_SAMPLE_RATE__: 20,
      __CANOPY_DATADOG_DEFAULT_PRIVACY_LEVEL__: 'mask',
    });

    const config = getDesktopInstrumentationConfig().datadog;

    expect(config).toEqual(
      expect.objectContaining({
        enabled: false,
        clientToken: undefined,
        applicationId: undefined,
        site: 'datadoghq.com',
        service: 'canopy-desktop',
        env: undefined,
        version: '0.24.16',
        variant: 'rc-canopy',
        proxy: undefined,
        sessionSampleRate: 20,
        traceSampleRate: 20,
        defaultPrivacyLevel: 'mask',
      }),
    );
  });

  it('reads the app version only from its own build constant', () => {
    Object.assign(process.env, { CANOPY_VERSION: 'runtime-version' });
    Object.assign(globalThis, {
      __CANOPY_APP_VERSION__: ' 0.27.0-rc.3 ',
      __CANOPY_DATADOG_VERSION__: '0.26.8',
    });

    const config = getDesktopInstrumentationConfig();

    expect(config.appVersion).toBe('0.27.0-rc.3');
    expect(config.datadog.version).toBe('0.26.8');
  });

  it.each([
    { label: 'blank', value: '   ' },
    { label: 'missing', value: undefined },
  ])('leaves a $label app version unset', ({ value }) => {
    Object.assign(process.env, { CANOPY_VERSION: 'runtime-version' });
    Object.assign(globalThis, {
      __CANOPY_APP_VERSION__: value,
      __CANOPY_DATADOG_VERSION__: '0.26.8',
    });

    expect(getDesktopInstrumentationConfig().appVersion).toBeUndefined();
  });

  it('uses only bundled PostHog values and reports ready when configured', () => {
    Object.assign(process.env, {
      CANOPY_POSTHOG_ENABLED: 'false',
      CANOPY_POSTHOG_PROJECT_KEY: 'runtime-project-key',
      CANOPY_POSTHOG_HOST: 'https://example.invalid',
      CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE: '100',
    });
    Object.assign(globalThis, {
      __CANOPY_E2E__: false,
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_release_project',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
      __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 25,
      __CANOPY_POSTHOG_STUB_URL__: undefined,
    });

    const config = getDesktopInstrumentationConfig();

    expect(config.providers).toEqual(['datadog', 'posthog']);
    expect(config.posthog).toEqual({
      enabled: true,
      projectKey: 'phc_release_project',
      host: 'https://us.i.posthog.com',
      sessionReplaySampleRate: 25,
    });
    const readiness = getPostHogInstrumentationReadiness(config.posthog);

    expect(readiness).toEqual({
      enabled: true,
      config: config.posthog,
    });
    if (readiness.enabled) {
      expect(readiness.config).not.toBe(config.posthog);
    }
  });

  it('defaults PostHog off with the US host and replay disabled', () => {
    const config = getDesktopInstrumentationConfig().posthog;

    expect(config).toEqual({
      enabled: false,
      projectKey: undefined,
      host: 'https://us.i.posthog.com',
      sessionReplaySampleRate: 0,
    });
    expect(getPostHogInstrumentationReadiness(config)).toEqual({
      enabled: false,
      reason: 'disabled',
    });
  });

  it('keeps configured candidate/stable bundles disabled despite runtime overrides', () => {
    Object.assign(process.env, {
      CANOPY_POSTHOG_ENABLED: 'true',
      CANOPY_POSTHOG_PROJECT_KEY: 'phc_runtime_override',
    });
    Object.assign(globalThis, {
      __CANOPY_E2E__: false,
      __CANOPY_POSTHOG_ENABLED__: false,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_release_project',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
      __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 100,
    });

    const config = getDesktopInstrumentationConfig().posthog;

    expect(config.projectKey).toBe('phc_release_project');
    expect(config.sessionReplaySampleRate).toBe(100);
    expect(getPostHogInstrumentationReadiness(config)).toEqual({
      enabled: false,
      reason: 'disabled',
    });
    expect(
      resolvePostHogRuntimePolicy(config, {
        captureEnabled: true,
        sessionReplaySampleRate: 100,
      }),
    ).toEqual({
      captureEnabled: false,
      sessionReplaySampleRate: 0,
      autocaptureEnabled: false,
    });
  });

  it('reports a missing PostHog project key by name', () => {
    Object.assign(globalThis, {
      __CANOPY_E2E__: false,
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: '   ',
    });

    expect(
      getPostHogInstrumentationReadiness(
        getDesktopInstrumentationConfig().posthog,
      ),
    ).toEqual({ enabled: false, reason: 'missing_project_key' });
  });

  it.each([
    { input: -1, expected: 0 },
    { input: 101, expected: 100 },
    { input: Number.NaN, expected: 0 },
  ])(
    'validates PostHog replay sample rate $input as $expected',
    ({ input, expected }) => {
      Object.assign(globalThis, {
        __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: input,
      });

      expect(
        getDesktopInstrumentationConfig().posthog.sessionReplaySampleRate,
      ).toBe(expected);
    },
  );

  it('forces PostHog off in ordinary E2E builds', () => {
    Object.assign(globalThis, {
      __CANOPY_E2E__: true,
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_release_project',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
      __CANOPY_POSTHOG_STUB_URL__: undefined,
    });

    const config = getDesktopInstrumentationConfig().posthog;

    expect(config.enabled).toBe(false);
    expect(config.host).toBe('https://us.i.posthog.com');
    expect(getPostHogInstrumentationReadiness(config)).toEqual({
      enabled: false,
      reason: 'disabled',
    });
  });

  it('allows E2E PostHog only through a loopback stub', () => {
    Object.assign(globalThis, {
      __CANOPY_E2E__: true,
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_e2e_stub',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
      __CANOPY_POSTHOG_STUB_URL__: 'http://127.0.0.1:43111',
    });

    const config = getDesktopInstrumentationConfig().posthog;

    expect(config).toEqual(
      expect.objectContaining({
        enabled: true,
        projectKey: 'phc_e2e_stub',
        host: 'http://127.0.0.1:43111',
      }),
    );
    expect(getPostHogInstrumentationReadiness(config).enabled).toBe(true);
  });

  it('rejects a non-loopback PostHog E2E stub URL', () => {
    Object.assign(globalThis, {
      __CANOPY_E2E__: true,
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_e2e_stub',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
      __CANOPY_POSTHOG_STUB_URL__: 'https://posthog.example.com',
    });

    const config = getDesktopInstrumentationConfig().posthog;

    expect(config.enabled).toBe(false);
    expect(config.host).toBe('https://us.i.posthog.com');
  });

  it('rejects a release-style PostHog project key in E2E', () => {
    Object.assign(globalThis, {
      __CANOPY_E2E__: true,
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_release_project',
      __CANOPY_POSTHOG_STUB_URL__: 'http://localhost:43111',
    });

    expect(getDesktopInstrumentationConfig().posthog.enabled).toBe(false);
  });
});

describe('PostHog runtime policy', () => {
  const config = {
    enabled: true,
    projectKey: 'phc_test',
    host: 'https://us.i.posthog.com',
    sessionReplaySampleRate: 20,
  };
  it.each([undefined, null, false, '20', NaN, Infinity, -1, 101])(
    'fails closed for invalid sample rate %s',
    (rate) => {
      expect(
        resolvePostHogRuntimePolicy(config, {
          captureEnabled: true,
          sessionReplaySampleRate: rate,
        }),
      ).toEqual({
        captureEnabled: true,
        sessionReplaySampleRate: 0,
        autocaptureEnabled: false,
      });
    },
  );
  it.each([
    [0, 0],
    [5, 5],
    [20, 20],
    [100, 20],
  ])('caps rate %s at the build-time ceiling', (rate, expected) => {
    expect(
      resolvePostHogRuntimePolicy(config, {
        captureEnabled: true,
        sessionReplaySampleRate: rate,
      }).sessionReplaySampleRate,
    ).toBe(expected);
  });
  it('cannot enable a disabled build or a build without a project key', () => {
    for (const disabled of [
      { ...config, enabled: false },
      { ...config, projectKey: undefined },
    ]) {
      expect(
        resolvePostHogRuntimePolicy(disabled, {
          captureEnabled: true,
          sessionReplaySampleRate: 100,
        }),
      ).toEqual({
        captureEnabled: false,
        sessionReplaySampleRate: 0,
        autocaptureEnabled: false,
      });
    }
  });
  it('requires an explicit true capture flag and keeps missing snapshots closed', () => {
    expect(resolvePostHogRuntimePolicy(config)).toEqual({
      captureEnabled: false,
      sessionReplaySampleRate: 0,
      autocaptureEnabled: false,
    });
    for (const captureEnabled of [false, undefined, 'true', 1]) {
      expect(
        resolvePostHogRuntimePolicy(config, {
          captureEnabled,
          sessionReplaySampleRate: 100,
        }),
      ).toEqual({
        captureEnabled: false,
        sessionReplaySampleRate: 0,
        autocaptureEnabled: false,
      });
    }
  });
  it('enables click capture only for an explicit true flag while capture is on', () => {
    const flags = {
      captureEnabled: true,
      sessionReplaySampleRate: 0,
      autocaptureEnabled: true,
    };
    expect(resolvePostHogRuntimePolicy(config, flags).autocaptureEnabled).toBe(
      true,
    );
    for (const autocaptureEnabled of [false, undefined, 'true', 1]) {
      expect(
        resolvePostHogRuntimePolicy(config, { ...flags, autocaptureEnabled })
          .autocaptureEnabled,
      ).toBe(false);
    }
    expect(
      resolvePostHogRuntimePolicy(config, { ...flags, captureEnabled: false })
        .autocaptureEnabled,
    ).toBe(false);
    expect(
      resolvePostHogRuntimePolicy({ ...config, enabled: false }, flags)
        .autocaptureEnabled,
    ).toBe(false);
  });
});
