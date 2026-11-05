import { connectPostHogSession } from './posthog-session';
import {
  getDatadogInstrumentationReadiness,
  getPostHogInstrumentationReadiness,
  getDesktopInstrumentationConfig,
} from '../config';
import {
  redactRumEvent,
  sanitizeDatadogInstrumentationContext,
  sanitizeInstrumentationContext,
} from '../privacy';
import {
  createPostHogOperationTracker,
  type DesktopOperationName,
  type DesktopOperationOutcome,
  type PostHogOperationEvent,
} from '../operations';
import {
  POSTHOG_PROPERTY_DENYLIST,
  sanitizePostHogEvent,
} from '../posthog-privacy';
import { createPostHogRuntimeController } from './posthog-runtime';
import { buildPostHogSessionRecordingOptions } from './posthog-replay-options';
import { POSTHOG_CLICK_INIT_OPTIONS } from './posthog-autocapture-options';
import { createPostHogScreenTracker } from './posthog-screen-tracking';
import { flushPostHogHeatmaps } from './posthog-heatmaps';
import { buildDesktopInstrumentationUser } from '../user';
import {
  createPostHogAccountTracker,
  type PostHogAccountTracker,
} from '../posthog-account';
import {
  POSTHOG_APP_ADVISOR_ROUTE,
  POSTHOG_MAIN_ROUTE,
  POSTHOG_PAGEVIEW_EVENT,
  type PostHogRoute,
} from '../posthog-routes';
import {
  APP_ERROR_POSTHOG_EVENT,
  buildAppErrorDatadogContext,
  buildAppErrorDatadogError,
  buildAppErrorPostHogProperties,
  type AppErrorTelemetrySessions,
} from '../app-error-telemetry';
import {
  createAppErrorHandler,
  type AppErrorHandler,
  type AppErrorReport,
  type AppErrorReportOptions,
  type AppErrorSink,
} from '@canopy/protocol/app-errors';
import type * as DatadogBrowserRumModule from '@datadog/browser-rum';
import type { PostHog } from 'posthog-js/dist/module.full.no-external';
import type {
  DesktopInstrumentationClientInitOptions,
  PostHogRuntimeFlags,
  DesktopInstrumentationErrorOptions,
  DesktopInstrumentationFeatureFlagValue,
  DesktopInstrumentationFailureReason,
  DesktopInstrumentationInitResult,
  DesktopInstrumentationOperationOptions,
} from '../types';

type DatadogBrowserRum = typeof DatadogBrowserRumModule;
type FeatureFlagValue = Exclude<
  DesktopInstrumentationFeatureFlagValue,
  undefined
>;
type FeatureFlagReporter = (key: string, value: FeatureFlagValue) => void;
type OperationReporter = (operation: PostHogOperationEvent) => void;
type AppErrorPostHogEvent = {
  event: typeof APP_ERROR_POSTHOG_EVENT;
  properties: ReturnType<typeof buildAppErrorPostHogProperties>;
};
type AppErrorReporter = (event: AppErrorPostHogEvent) => void;

const DATADOG_UNSUPPORTED_FEATURE_FLAG_KEY_CHARS =
  /[.:+\-=><!(){}[\]^"“”~*?\\&|]/g;

let initialized = false;
let datadogRumModule: DatadogBrowserRum | null = null;

function safelyInvoke(callback: () => void): void {
  try {
    callback();
  } catch {
    // Instrumentation must never affect the app path.
  }
}

async function loadDatadogRum(): Promise<DatadogBrowserRum> {
  if (datadogRumModule) {
    return datadogRumModule;
  }
  datadogRumModule = await import('@datadog/browser-rum');
  return datadogRumModule;
}

export function normalizeDatadogFeatureFlagKey(key: string): string {
  const normalized = key
    .trim()
    .replace(DATADOG_UNSUPPORTED_FEATURE_FLAG_KEY_CHARS, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : 'feature_flag';
}

async function initializeDatadogClient(
  options: DesktopInstrumentationClientInitOptions,
): Promise<DesktopInstrumentationInitResult> {
  if (initialized) {
    return { enabled: true, provider: 'datadog' };
  }

  const config = getDesktopInstrumentationConfig().datadog;
  const readiness = getDatadogInstrumentationReadiness(config);
  if (!readiness.enabled) {
    return { enabled: false, provider: 'datadog', reason: readiness.reason };
  }
  const { clientToken, applicationId } = readiness.config;

  try {
    const { datadogRum } = await loadDatadogRum();
    datadogRum.init({
      applicationId,
      clientToken,
      site: config.site,
      service: `${config.service}-renderer`,
      env: config.env,
      version: config.version,
      variant: config.variant,
      proxy: config.proxy,
      sessionSampleRate: config.sessionSampleRate,
      sessionReplaySampleRate: config.sessionReplaySampleRate,
      telemetrySampleRate: config.telemetrySampleRate,
      trackResources: config.trackResources,
      trackLongTasks: config.trackLongTasks,
      trackUserInteractions: config.trackUserInteractions,
      enablePrivacyForActionName: config.enablePrivacyForActionName,
      ...(config.allowedTracingUrls.length > 0
        ? {
            allowedTracingUrls: config.allowedTracingUrls.map((url) => ({
              match: url,
              propagatorTypes: ['tracecontext' as const],
            })),
            traceSampleRate: config.traceSampleRate,
            traceContextInjection: 'sampled' as const,
          }
        : {}),
      defaultPrivacyLevel: config.defaultPrivacyLevel,
      trackingConsent: 'granted',
      enableExperimentalFeatures: ['feature_operation_vital'],
      beforeSend: redactRumEvent,
    });
    datadogRum.setViewName(options.surface);
    datadogRum.setViewContextProperty('surface', options.surface);
    initialized = true;
    return { enabled: true, provider: 'datadog' };
  } catch (error) {
    return {
      enabled: false,
      provider: 'datadog',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

let disposePostHog: (() => void) | undefined;
let reportPostHogFeatureFlagEvaluation: FeatureFlagReporter | undefined;
let reportPostHogOperation: OperationReporter | undefined;
let reportPostHogAppError: AppErrorReporter | undefined;
let isPostHogOperationStartEligible: (() => boolean) | undefined;
let posthogAppErrorSession: AppErrorTelemetrySessions['posthog'];
/** Bounds operations that finish while the SDK is still initializing. */
const MAX_PENDING_POSTHOG_OPERATIONS = 50;
let posthogInitialization:
  | Promise<DesktopInstrumentationInitResult>
  | undefined;

export function disposePostHogInstrumentationClient(): void {
  // Pending summaries need the provider this is about to tear down.
  disposeClientAppErrorHandler();
  const dispose = disposePostHog;
  disposePostHog = undefined;
  posthogInitialization = undefined;
  dispose?.();
}

async function initializePostHogClient(
  options: DesktopInstrumentationClientInitOptions,
): Promise<DesktopInstrumentationInitResult> {
  const readiness = getPostHogInstrumentationReadiness(
    getDesktopInstrumentationConfig().posthog,
  );
  if (!readiness.enabled) {
    return { enabled: false, provider: 'posthog', reason: readiness.reason };
  }
  let session: Awaited<ReturnType<typeof connectPostHogSession>> | undefined;
  let flags: PostHogRuntimeFlags | undefined;
  let waitingForFlags = true;
  let controller: ReturnType<typeof createPostHogRuntimeController> | undefined;
  let screenTracker: ReturnType<typeof createPostHogScreenTracker> | undefined;
  let revision = 0;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let unloadInstalled = false;
  let posthog: PostHog | undefined;
  let account: PostHogAccountTracker | undefined;
  const eligibleStart = (): boolean =>
    !disposed && (waitingForFlags || flags?.captureEnabled === true);
  isPostHogOperationStartEligible = eligibleStart;
  const pendingEvaluations = new Map<string, FeatureFlagValue>();
  const reportedEvaluations = new Map<string, FeatureFlagValue>();
  const reportEvaluation: FeatureFlagReporter = (key, value) => {
    if (disposed) return;
    if (!posthog || !controller) {
      if (!waitingForFlags && flags?.captureEnabled !== true) return;
      // Flag-store hydration need not wait for the SDK or its host identity.
      // Retain current state, not an unbounded history of startup snapshots.
      pendingEvaluations.set(key, value);
      return;
    }
    if (!controller.allowsEvent('$feature_flag_called')) return;
    // A disconnected session bridge drops the SDK event in before_send.
    // Leave this value eligible for the next evaluation after recovery.
    if (!session?.allowsCapture()) return;
    if (reportedEvaluations.has(key) && reportedEvaluations.get(key) === value)
      return;
    posthog.capture('$feature_flag_called', {
      $feature_flag: key,
      $feature_flag_response: value,
    });
    reportedEvaluations.set(key, value);
  };
  reportPostHogFeatureFlagEvaluation = reportEvaluation;
  const pendingOperations: Array<PostHogOperationEvent | AppErrorPostHogEvent> =
    [];
  const reportEvent = (
    operation: PostHogOperationEvent | AppErrorPostHogEvent,
  ): void => {
    if (disposed) return;
    if (!posthog || !controller) {
      if (!waitingForFlags && flags?.captureEnabled !== true) return;
      pendingOperations.push(operation);
      if (pendingOperations.length > MAX_PENDING_POSTHOG_OPERATIONS)
        pendingOperations.shift();
      return;
    }
    if (!controller.allowsEvent(operation.event)) return;
    posthog.capture(operation.event, operation.properties);
  };
  const reportOperation: OperationReporter = reportEvent;
  const reportAppError: AppErrorReporter = reportEvent;
  reportPostHogOperation = reportOperation;
  reportPostHogAppError = reportAppError;
  let appErrorSession: AppErrorTelemetrySessions['posthog'];
  const disposeOnUnload = (): void => {
    disposeClientAppErrorHandler();
    dispose();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (unloadInstalled && typeof window !== 'undefined') {
      window.removeEventListener('unload', disposeOnUnload);
      unloadInstalled = false;
    }
    if (posthogAppErrorSession === appErrorSession)
      posthogAppErrorSession = undefined;
    screenTracker?.dispose();
    if (reportPostHogFeatureFlagEvaluation === reportEvaluation)
      reportPostHogFeatureFlagEvaluation = undefined;
    if (reportPostHogOperation === reportOperation)
      reportPostHogOperation = undefined;
    if (reportPostHogAppError === reportAppError)
      reportPostHogAppError = undefined;
    if (isPostHogOperationStartEligible === eligibleStart)
      isPostHogOperationStartEligible = undefined;
    posthogOperations.discardAcquisitionStarts();
    pendingEvaluations.clear();
    reportedEvaluations.clear();
    pendingOperations.length = 0;
    account?.dispose();
    unsubscribe?.();
    session?.dispose();
    controller?.dispose();
  };
  disposePostHog = dispose;
  try {
    account = createPostHogAccountTracker(
      options.posthogAccount,
      (): void => undefined,
    );
    // Subscribe before reading, and never let a stale read undo a push.
    unsubscribe = options.posthogFlags?.onSnapshotChanged((next) => {
      if (disposed) return;
      revision++;
      flags = next;
      waitingForFlags = false;
      if (next.captureEnabled !== true) {
        posthogOperations.discardAcquisitionStarts();
        pendingEvaluations.clear();
        pendingOperations.length = 0;
      }
      safelyInvoke(() => {
        controller?.update(next);
        screenTracker?.setCaptureEnabled(
          controller?.allowsEvent(POSTHOG_PAGEVIEW_EVENT) ?? false,
        );
      });
    });
    const initialRevision = revision;
    try {
      const initialFlags = await options.posthogFlags?.getSnapshot();
      if (revision === initialRevision) flags = initialFlags;
    } catch {
      // Unknown configuration is not the LaunchDarkly-unconfigured mode.
      // Remain closed; a later authoritative push can recover capture.
    }
    waitingForFlags = false;
    if (flags?.captureEnabled !== true) {
      posthogOperations.discardAcquisitionStarts();
      pendingEvaluations.clear();
      pendingOperations.length = 0;
    }
    // The host owns this provider-specific UUID. Neither the SDK's own random
    // identity nor the Datadog/account identity may be used as a fallback.
    const [module, anonymousId] = await Promise.all([
      import('posthog-js/dist/module.full.no-external'),
      options.getPostHogAnonymousId?.(),
    ]);
    if (
      !anonymousId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        anonymousId,
      )
    ) {
      throw new Error('PostHog anonymous identity is unavailable');
    }
    if (disposed)
      return { enabled: false, provider: 'posthog', reason: 'disabled' };
    posthog = module.default;
    if (!options.posthogSession)
      throw new Error('PostHog session bridge is unavailable');
    session = await connectPostHogSession(posthog, options.posthogSession);
    const surfaceRoute =
      options.surface === 'app-advisor'
        ? POSTHOG_APP_ADVISOR_ROUTE
        : POSTHOG_MAIN_ROUTE;
    const currentScreenRoute = (): PostHogRoute =>
      screenTracker?.route ?? surfaceRoute;
    const replayOptions =
      buildPostHogSessionRecordingOptions(currentScreenRoute);
    posthog.init(readiness.config.projectKey, {
      api_host: readiness.config.host,
      persistence: 'localStorage',
      bootstrap: {
        distinctID: anonymousId,
        isIdentifiedID: false,
        sessionID: session.sessionId,
      },
      opt_out_capturing_by_default: true,
      capture_exceptions: false,
      capture_performance: false,
      enable_recording_console_log: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_session_recording: true,
      session_recording: replayOptions,
      ...POSTHOG_CLICK_INIT_OPTIONS,
      capture_pageview: false,
      capture_pageleave: false,
      person_profiles: 'identified_only',
      // No remote configuration or extensions are needed for explicit events.
      // Pin both switches so an SDK/project default cannot add a CDN request.
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
      property_denylist: [...POSTHOG_PROPERTY_DENYLIST],
      before_send: (event) => {
        try {
          if (
            !event ||
            !controller?.allowsEvent(event.event) ||
            event.properties.distinct_id !== anonymousId ||
            event.event === '$identify' ||
            event.event === '$set' ||
            event.event === '$unset'
          )
            return null;
          // Main alone owns the installation profile. SDK-cached person
          // properties must not restore an earlier account on a later event.
          const properties: Record<string, unknown> = { ...event.properties };
          delete properties.$set;
          delete properties.$set_once;
          const envelope = { ...event };
          delete envelope.$set;
          delete envelope.$set_once;
          return (
            session?.filter(
              sanitizePostHogEvent(
                {
                  ...envelope,
                  properties: {
                    ...properties,
                    surface: options.surface,
                    $is_identified: false,
                    $process_person_profile: account?.domain !== undefined,
                    ...(account?.domain !== undefined && {
                      email_domain: account.domain,
                    }),
                  },
                },
                {
                  preserveBrowserProjectToken: true,
                  ...(event.event === '$snapshot' && {
                    passthroughProperties: ['$snapshot_data'],
                  }),
                  screenRoute: currentScreenRoute(),
                },
              ),
            ) ?? null
          );
        } catch {
          // Fail closed: the SDK otherwise retains an event when a hook throws.
          return null;
        }
      },
    });
    const activeSession = session;
    controller = createPostHogRuntimeController(
      posthog,
      readiness.config,
      flags,
      replayOptions,
      (listener) => activeSession.onAdopted(listener),
    );
    activeSession.start();
    if (!disposed) {
      const sdk = posthog;
      const activeController = controller;
      // A session link exists only while main authorizes capture on this SDK.
      appErrorSession = {
        getSessionId: (): unknown =>
          activeSession.allowsCapture() &&
          activeController.allowsEvent(APP_ERROR_POSTHOG_EVENT)
            ? sdk.get_session_id()
            : undefined,
        isRecording: (): unknown => sdk.sessionRecordingStarted(),
        getReplayUrl: (): unknown => sdk.get_session_replay_url(),
      };
      posthogAppErrorSession = appErrorSession;
    }
    if (options.posthogRoutes) {
      const sdk = posthog;
      screenTracker = createPostHogScreenTracker({
        sdk: posthog,
        source: options.posthogRoutes,
        captureEnabled: controller.allowsEvent(POSTHOG_PAGEVIEW_EVENT),
        allowsCapture: () => activeSession.allowsCapture(),
        onAdopted: (listener): (() => void) =>
          activeSession.onAdopted(listener),
        onCaptureAvailable: (listener): (() => void) =>
          activeSession.onCaptureAvailable(listener),
        onRouteLeave: (route): void => flushPostHogHeatmaps(sdk, route),
        ...(typeof window !== 'undefined' ? { pageLifecycle: window } : {}),
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('unload', disposeOnUnload, { once: true });
      unloadInstalled = true;
    }
    if (controller.allowsEvent('app_opened')) {
      posthog.capture('app_opened', { surface: options.surface });
    }
    pendingEvaluations.forEach((value, key) => {
      safelyInvoke(() => reportEvaluation(key, value));
    });
    pendingEvaluations.clear();
    pendingOperations.splice(0).forEach((operation) => {
      safelyInvoke(() => reportOperation(operation));
    });
    return { enabled: true, provider: 'posthog' };
  } catch (error) {
    dispose();
    if (disposePostHog === dispose) disposePostHog = undefined;
    return {
      enabled: false,
      provider: 'posthog',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const posthogOperations = createPostHogOperationTracker({
  appVersion: getDesktopInstrumentationConfig().appVersion,
});
let operationSurface: DesktopInstrumentationClientInitOptions['surface'] =
  'main';

function forwardPostHogOperation(
  name: DesktopOperationName,
  outcome: DesktopOperationOutcome,
  options: DesktopInstrumentationOperationOptions | undefined,
): void {
  safelyInvoke(() => {
    // Finish even without a reporter so the start time is released.
    const operation = posthogOperations.finish(
      name,
      outcome,
      operationSurface,
      options,
    );
    if (!operation || !reportPostHogOperation) return;
    reportPostHogOperation({
      event: operation.event,
      properties:
        sanitizeInstrumentationContext(operation.properties) ??
        operation.properties,
    });
  });
}

export async function initializeDesktopInstrumentationClient(
  options: DesktopInstrumentationClientInitOptions,
): Promise<DesktopInstrumentationInitResult[]> {
  const report = (
    result: DesktopInstrumentationInitResult,
  ): DesktopInstrumentationInitResult => {
    safelyInvoke(() => options.onProviderInitialized?.(result));
    return result;
  };
  operationSurface = options.surface;
  // Start both providers before awaiting either. Consumers may retain their
  // existing Datadog-only mount gate through the provider-neutral callback.
  return Promise.all([
    initializeDatadogClient(options).then(report),
    (posthogInitialization ??= initializePostHogClient(options)).then(report),
  ]);
}

/**
 * Sets the stable, anonymous, per-install identifier on the renderer RUM SDK.
 * The browser SDK supports `setUser`, so this populates `@usr.id` (plus a
 * derived non-PII `@usr.name`, see `buildDesktopInstrumentationUser`) natively
 * on every renderer event. The main process sets the same identity via the
 * vendored `setUser()` patch on `@datadog/electron-sdk` (plus
 * `@context.anon_id` on operations for dashboard continuity).
 */
export function setClientInstrumentationUser(id: string, email?: string): void {
  if (!initialized || !datadogRumModule) {
    return;
  }
  safelyInvoke(() => {
    datadogRumModule?.datadogRum.setUser(
      buildDesktopInstrumentationUser(id, email),
    );
  });
}

export function startClientOperation(
  name: DesktopOperationName,
  options?: DesktopInstrumentationOperationOptions,
): void {
  safelyInvoke(() =>
    posthogOperations.start(
      name,
      options,
      isPostHogOperationStartEligible?.() ?? false,
    ),
  );
  if (!initialized || !datadogRumModule) {
    return;
  }
  safelyInvoke(() => {
    datadogRumModule?.datadogRum.startFeatureOperation(name, {
      ...options,
      context: sanitizeDatadogInstrumentationContext(options?.context),
    });
  });
}

export function succeedClientOperation(
  name: DesktopOperationName,
  options?: DesktopInstrumentationOperationOptions,
): void {
  forwardPostHogOperation(name, { status: 'success' }, options);
  if (!initialized || !datadogRumModule) {
    return;
  }
  safelyInvoke(() => {
    datadogRumModule?.datadogRum.succeedFeatureOperation(name, {
      ...options,
      context: sanitizeDatadogInstrumentationContext(options?.context),
    });
  });
}

export function failClientOperation(
  name: DesktopOperationName,
  failureReason: DesktopInstrumentationFailureReason,
  options?: DesktopInstrumentationOperationOptions,
): void {
  forwardPostHogOperation(name, { status: 'failure', failureReason }, options);
  if (!initialized || !datadogRumModule) {
    return;
  }
  safelyInvoke(() => {
    datadogRumModule?.datadogRum.failFeatureOperation(name, failureReason, {
      ...options,
      context: sanitizeDatadogInstrumentationContext(options?.context),
    });
  });
}

export function captureClientInstrumentationError(
  error: unknown,
  options?: DesktopInstrumentationErrorOptions,
): void {
  if (!initialized || !datadogRumModule) {
    return;
  }
  safelyInvoke(() => {
    datadogRumModule?.datadogRum.addError(
      error,
      sanitizeDatadogInstrumentationContext(options?.context),
    );
  });
}

export function addClientFeatureFlagEvaluation(
  key: string,
  value: DesktopInstrumentationFeatureFlagValue,
): void {
  if (value === undefined) return;
  if (initialized && datadogRumModule) {
    safelyInvoke(() => {
      datadogRumModule?.datadogRum.addFeatureFlagEvaluation(
        normalizeDatadogFeatureFlagKey(key),
        value,
      );
    });
  }
  safelyInvoke(() => reportPostHogFeatureFlagEvaluation?.(key, value));
}

/** Reads current SDK state at capture time; the builders tolerate failures. */
const appErrorSessions: AppErrorTelemetrySessions = {
  datadog: {
    getSessionId: () =>
      initialized
        ? datadogRumModule?.datadogRum.getInternalContext()?.session_id
        : undefined,
  },
  posthog: {
    getSessionId: () => posthogAppErrorSession?.getSessionId(),
    isRecording: () => posthogAppErrorSession?.isRecording(),
    getReplayUrl: () => posthogAppErrorSession?.getReplayUrl(),
  },
};

const captureAppErrorInDatadog: AppErrorSink = (record) => {
  if (!initialized || !datadogRumModule) return;
  datadogRumModule.datadogRum.addError(
    buildAppErrorDatadogError(record),
    buildAppErrorDatadogContext(record, appErrorSessions),
  );
};

const captureAppErrorInPostHog: AppErrorSink = (record) => {
  reportPostHogAppError?.({
    event: APP_ERROR_POSTHOG_EVENT,
    properties: buildAppErrorPostHogProperties(record, appErrorSessions),
  });
};

let appErrorHandler: AppErrorHandler | undefined;

function createClientAppErrorHandler(appVersion: string): AppErrorHandler {
  return createAppErrorHandler({
    host: 'renderer',
    appVersion,
    sinks: [captureAppErrorInDatadog, captureAppErrorInPostHog],
  });
}

/** Created on first use so importing this module starts nothing. */
export function getClientAppErrorHandler(): AppErrorHandler {
  if (appErrorHandler) return appErrorHandler;
  const appVersion = getDesktopInstrumentationConfig().appVersion ?? 'unknown';
  try {
    appErrorHandler = createClientAppErrorHandler(appVersion);
  } catch {
    // An unusable build version must not stop errors from being classified.
    appErrorHandler = createClientAppErrorHandler('unknown');
  }
  return appErrorHandler;
}

export function reportClientAppError(
  value: unknown,
  options?: AppErrorReportOptions,
): AppErrorReport | undefined {
  return getClientAppErrorHandler().report(value, options);
}

/** Flushes pending summaries; the next use reads current configuration. */
export function disposeClientAppErrorHandler(): void {
  appErrorHandler?.dispose();
  appErrorHandler = undefined;
}
