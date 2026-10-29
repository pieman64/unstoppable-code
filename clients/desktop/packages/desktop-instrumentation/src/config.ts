import type {
  DesktopInstrumentationPrivacyLevel,
  DesktopInstrumentationProvider,
  PostHogRuntimeFlags,
} from './types';

declare const __CANOPY_E2E__: boolean;

export type DatadogSite =
  | 'datadoghq.com'
  | 'datadoghq.eu'
  | 'us3.datadoghq.com'
  | 'us5.datadoghq.com'
  | 'ap1.datadoghq.com'
  | 'ap2.datadoghq.com'
  | 'ddog-gov.com';

export interface DatadogInstrumentationConfig {
  enabled: boolean;
  clientToken?: string;
  applicationId?: string;
  site: DatadogSite;
  service: string;
  env?: string;
  version?: string;
  variant?: string;
  proxy?: string;
  sessionSampleRate: number;
  sessionReplaySampleRate: number;
  telemetrySampleRate: number;
  trackResources: boolean;
  trackLongTasks: boolean;
  trackUserInteractions: boolean;
  enablePrivacyForActionName: boolean;
  allowedTracingUrls: string[];
  traceSampleRate: number;
  defaultPrivacyLevel: DesktopInstrumentationPrivacyLevel;
  allowedWebViewHosts: string[];
  sourcemapMinifiedPathPrefix: string;
}

export interface PostHogInstrumentationConfig {
  enabled: boolean;
  projectKey?: string;
  host: string;
  sessionReplaySampleRate: number;
}

export interface DesktopInstrumentationConfig {
  providers: readonly DesktopInstrumentationProvider[];
  /** Bundled release version of the app, independent of any provider. */
  appVersion?: string;
  datadog: DatadogInstrumentationConfig;
  posthog: PostHogInstrumentationConfig;
}

export type EnabledDatadogInstrumentationConfig =
  DatadogInstrumentationConfig & {
    enabled: true;
    clientToken: string;
    applicationId: string;
  };

export type DatadogInstrumentationReadiness =
  | { enabled: true; config: EnabledDatadogInstrumentationConfig }
  | { enabled: false; reason: string };

export type EnabledPostHogInstrumentationConfig =
  PostHogInstrumentationConfig & {
    enabled: true;
    projectKey: string;
  };

export type PostHogInstrumentationReadiness =
  | { enabled: true; config: EnabledPostHogInstrumentationConfig }
  | { enabled: false; reason: string };

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const POSTHOG_E2E_PROJECT_KEY_PREFIX = 'phc_e2e_';
const LOOPBACK_POSTHOG_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const VALID_DATADOG_SITES = new Set<string>([
  'datadoghq.com',
  'datadoghq.eu',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'ddog-gov.com',
]);

const VALID_PRIVACY_LEVELS = new Set<string>([
  'mask',
  'mask-user-input',
  'allow',
]);

function readBuildBoolean(
  value: boolean | undefined,
  fallback: boolean,
): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readBuildString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBuildNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : fallback;
}

function readBuildStringArray(value: string[] | undefined): string[] {
  return Array.isArray(value)
    ? value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
}

function readLoopbackPostHogStubUrl(
  value: string | undefined,
): string | undefined {
  const candidate = readBuildString(value);
  if (!candidate) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_POSTHOG_HOSTS.has(url.hostname) &&
      url.username.length === 0 &&
      url.password.length === 0
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function readDatadogSite(value: string | undefined): DatadogSite {
  const candidate = readBuildString(value);
  return candidate && VALID_DATADOG_SITES.has(candidate)
    ? (candidate as DatadogSite)
    : 'datadoghq.com';
}

function readPrivacyLevel(
  value: string | undefined,
): DesktopInstrumentationPrivacyLevel {
  const candidate = readBuildString(value);
  return candidate && VALID_PRIVACY_LEVELS.has(candidate)
    ? (candidate as DesktopInstrumentationPrivacyLevel)
    : 'mask';
}

export function getDesktopInstrumentationConfig(): DesktopInstrumentationConfig {
  const datadogEnabled =
    typeof __CANOPY_DATADOG_ENABLED__ !== 'undefined'
      ? readBuildBoolean(__CANOPY_DATADOG_ENABLED__, false)
      : false;
  const posthogRequestedEnabled =
    typeof __CANOPY_POSTHOG_ENABLED__ !== 'undefined'
      ? readBuildBoolean(__CANOPY_POSTHOG_ENABLED__, false)
      : false;
  const posthogProjectKey =
    typeof __CANOPY_POSTHOG_PROJECT_KEY__ !== 'undefined'
      ? readBuildString(__CANOPY_POSTHOG_PROJECT_KEY__)
      : undefined;
  const isE2e =
    typeof __CANOPY_E2E__ !== 'undefined' &&
    readBuildBoolean(__CANOPY_E2E__, false);
  const posthogStubUrl = isE2e
    ? readLoopbackPostHogStubUrl(
        typeof __CANOPY_POSTHOG_STUB_URL__ !== 'undefined'
          ? __CANOPY_POSTHOG_STUB_URL__
          : undefined,
      )
    : undefined;
  const posthogEnabled =
    posthogRequestedEnabled &&
    (!isE2e ||
      Boolean(
        posthogStubUrl &&
        posthogProjectKey?.startsWith(POSTHOG_E2E_PROJECT_KEY_PREFIX),
      ));

  return {
    providers: ['datadog', 'posthog'],
    appVersion:
      typeof __CANOPY_APP_VERSION__ !== 'undefined'
        ? readBuildString(__CANOPY_APP_VERSION__)
        : undefined,
    datadog: {
      enabled: datadogEnabled,
      clientToken:
        typeof __CANOPY_DATADOG_CLIENT_TOKEN__ !== 'undefined'
          ? readBuildString(__CANOPY_DATADOG_CLIENT_TOKEN__)
          : undefined,
      applicationId:
        typeof __CANOPY_DATADOG_APPLICATION_ID__ !== 'undefined'
          ? readBuildString(__CANOPY_DATADOG_APPLICATION_ID__)
          : undefined,
      site:
        typeof __CANOPY_DATADOG_SITE__ !== 'undefined'
          ? readDatadogSite(__CANOPY_DATADOG_SITE__)
          : 'datadoghq.com',
      service:
        (typeof __CANOPY_DATADOG_SERVICE__ !== 'undefined'
          ? readBuildString(__CANOPY_DATADOG_SERVICE__)
          : undefined) ?? 'canopy-desktop',
      env:
        typeof __CANOPY_DATADOG_ENV__ !== 'undefined'
          ? readBuildString(__CANOPY_DATADOG_ENV__)
          : undefined,
      version:
        typeof __CANOPY_DATADOG_VERSION__ !== 'undefined'
          ? readBuildString(__CANOPY_DATADOG_VERSION__)
          : undefined,
      variant:
        typeof __CANOPY_DATADOG_VARIANT__ !== 'undefined'
          ? readBuildString(__CANOPY_DATADOG_VARIANT__)
          : undefined,
      proxy:
        typeof __CANOPY_DATADOG_PROXY__ !== 'undefined'
          ? readBuildString(__CANOPY_DATADOG_PROXY__)
          : undefined,
      sessionSampleRate:
        typeof __CANOPY_DATADOG_SESSION_SAMPLE_RATE__ !== 'undefined'
          ? readBuildNumber(__CANOPY_DATADOG_SESSION_SAMPLE_RATE__, 20)
          : 20,
      sessionReplaySampleRate:
        typeof __CANOPY_DATADOG_SESSION_REPLAY_SAMPLE_RATE__ !== 'undefined'
          ? readBuildNumber(__CANOPY_DATADOG_SESSION_REPLAY_SAMPLE_RATE__, 0)
          : 0,
      telemetrySampleRate:
        typeof __CANOPY_DATADOG_TELEMETRY_SAMPLE_RATE__ !== 'undefined'
          ? readBuildNumber(__CANOPY_DATADOG_TELEMETRY_SAMPLE_RATE__, 20)
          : 20,
      trackResources:
        typeof __CANOPY_DATADOG_TRACK_RESOURCES__ !== 'undefined'
          ? readBuildBoolean(__CANOPY_DATADOG_TRACK_RESOURCES__, true)
          : true,
      trackLongTasks:
        typeof __CANOPY_DATADOG_TRACK_LONG_TASKS__ !== 'undefined'
          ? readBuildBoolean(__CANOPY_DATADOG_TRACK_LONG_TASKS__, true)
          : true,
      trackUserInteractions:
        typeof __CANOPY_DATADOG_TRACK_USER_INTERACTIONS__ !== 'undefined'
          ? readBuildBoolean(__CANOPY_DATADOG_TRACK_USER_INTERACTIONS__, false)
          : false,
      enablePrivacyForActionName:
        typeof __CANOPY_DATADOG_ENABLE_PRIVACY_FOR_ACTION_NAME__ !== 'undefined'
          ? readBuildBoolean(
              __CANOPY_DATADOG_ENABLE_PRIVACY_FOR_ACTION_NAME__,
              true,
            )
          : true,
      allowedTracingUrls:
        typeof __CANOPY_DATADOG_ALLOWED_TRACING_URLS__ !== 'undefined'
          ? readBuildStringArray(__CANOPY_DATADOG_ALLOWED_TRACING_URLS__)
          : [],
      traceSampleRate:
        typeof __CANOPY_DATADOG_TRACE_SAMPLE_RATE__ !== 'undefined'
          ? readBuildNumber(__CANOPY_DATADOG_TRACE_SAMPLE_RATE__, 20)
          : 20,
      defaultPrivacyLevel:
        typeof __CANOPY_DATADOG_DEFAULT_PRIVACY_LEVEL__ !== 'undefined'
          ? readPrivacyLevel(__CANOPY_DATADOG_DEFAULT_PRIVACY_LEVEL__)
          : 'mask',
      allowedWebViewHosts:
        typeof __CANOPY_DATADOG_ALLOWED_WEBVIEW_HOSTS__ !== 'undefined'
          ? readBuildStringArray(__CANOPY_DATADOG_ALLOWED_WEBVIEW_HOSTS__)
          : [],
      sourcemapMinifiedPathPrefix:
        (typeof __CANOPY_DATADOG_SOURCEMAP_MINIFIED_PATH_PREFIX__ !==
        'undefined'
          ? readBuildString(__CANOPY_DATADOG_SOURCEMAP_MINIFIED_PATH_PREFIX__)
          : undefined) ?? 'https://canopy.local/renderer/assets',
    },
    posthog: {
      enabled: posthogEnabled,
      projectKey: posthogProjectKey,
      host:
        posthogStubUrl ??
        (typeof __CANOPY_POSTHOG_HOST__ !== 'undefined'
          ? readBuildString(__CANOPY_POSTHOG_HOST__)
          : undefined) ??
        DEFAULT_POSTHOG_HOST,
      sessionReplaySampleRate:
        typeof __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__ !== 'undefined'
          ? readBuildNumber(__CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__, 0)
          : 0,
    },
  };
}

export function getDatadogDisabledReason(
  config: DatadogInstrumentationConfig,
): string | undefined {
  if (!config.enabled) {
    return 'disabled';
  }
  if (!config.clientToken) {
    return 'missing_client_token';
  }
  if (!config.applicationId) {
    return 'missing_application_id';
  }
  return undefined;
}

export function getDatadogInstrumentationReadiness(
  config: DatadogInstrumentationConfig,
): DatadogInstrumentationReadiness {
  const reason = getDatadogDisabledReason(config);
  return reason
    ? { enabled: false, reason }
    : {
        enabled: true,
        config: config as EnabledDatadogInstrumentationConfig,
      };
}

export function getPostHogDisabledReason(
  config: PostHogInstrumentationConfig,
): string | undefined {
  if (!config.enabled) {
    return 'disabled';
  }
  if (!config.projectKey) {
    return 'missing_project_key';
  }
  return undefined;
}

export function getPostHogInstrumentationReadiness(
  config: PostHogInstrumentationConfig,
): PostHogInstrumentationReadiness {
  if (!config.enabled) {
    return { enabled: false, reason: 'disabled' };
  }

  const { projectKey } = config;
  if (!projectKey) {
    return { enabled: false, reason: 'missing_project_key' };
  }

  return {
    enabled: true,
    config: { ...config, enabled: true, projectKey },
  };
}

export interface PostHogRuntimePolicy {
  captureEnabled: boolean;
  sessionReplaySampleRate: number;
  /** Click autocapture, rage clicks, and dead clicks. */
  autocaptureEnabled: boolean;
}

/** Runtime flags can only narrow the immutable build-time configuration. */
export function resolvePostHogRuntimePolicy(
  config: PostHogInstrumentationConfig,
  flags?: PostHogRuntimeFlags,
): PostHogRuntimePolicy {
  const captureEnabled =
    getPostHogInstrumentationReadiness(config).enabled &&
    flags?.captureEnabled === true;
  const rate = flags?.sessionReplaySampleRate;
  const validRate =
    typeof rate === 'number' &&
    Number.isFinite(rate) &&
    rate >= 0 &&
    rate <= 100;
  return {
    captureEnabled,
    sessionReplaySampleRate:
      captureEnabled && validRate
        ? Math.min(config.sessionReplaySampleRate, rate)
        : 0,
    autocaptureEnabled: captureEnabled && flags?.autocaptureEnabled === true,
  };
}
