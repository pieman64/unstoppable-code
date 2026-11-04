import { loadRequiredNodeModule } from '@canopy/desktop-shared/node/lib/packaged-module-loader';
import { randomUUID } from 'node:crypto';
import type { PostHog } from 'posthog-node';
import type * as PostHogNodeModule from 'posthog-node';
import type {
  PostHogInstallLaunch,
  PostHogSessionState,
} from '@canopy/desktop-shared/types/observability';
import { isPostHogSessionState } from '../posthog-session';
import { sanitizePostHogEvent } from '../posthog-privacy';
import {
  getDatadogInstrumentationReadiness,
  getDesktopInstrumentationConfig,
  getPostHogInstrumentationReadiness,
} from '../config';
import {
  sanitizeDatadogInstrumentationContext,
  sanitizeInstrumentationContext,
} from '../privacy';
import { buildDesktopInstrumentationUser } from '../user';
import {
  createPostHogAccountTracker,
  type PostHogAccountSource,
  type PostHogAccountTracker,
} from '../posthog-account';
import {
  readPostHogPlatformProperties,
  type PostHogHostPlatform,
  type PostHogPlatformProperties,
} from './posthog-platform';
import {
  createPostHogOperationTracker,
  isDesktopPostHogOperationEvent,
  type DesktopOperationName,
  type DesktopOperationOutcome,
  type PostHogOperationEvent,
} from '../operations';
import type * as DatadogElectronSdkModule from '@datadog/electron-sdk';
import type {
  DesktopInstrumentationContext,
  DesktopInstrumentationErrorOptions,
  DesktopInstrumentationFailureReason,
  DesktopInstrumentationInitResult,
  DesktopInstrumentationOperationOptions,
} from '../types';
export { createForeignCrashDumpFilter } from './crash-dumps/foreign-dump-filter';

type DatadogElectronSdk = typeof DatadogElectronSdkModule;
type DatadogElectronSdkPatchedExports = {
  notifyActivity?: () => void;
  setUser?: (user: ReturnType<typeof buildDesktopInstrumentationUser>) => void;
};

let initialized = false;
let initializationStarted = false;
let warnedMissingFlushTransport = false;
let warnedMissingNotifyActivity = false;
let warnedMissingSetUser = false;
let datadogSdk: (DatadogElectronSdk & DatadogElectronSdkPatchedExports) | null =
  null;
let anonId: string | undefined;
let userEmail: string | undefined;

function isDatadogElectronSdk(value: unknown): value is DatadogElectronSdk {
  return (
    typeof value === 'object' &&
    value !== null &&
    'init' in value &&
    typeof value.init === 'function'
  );
}

function safelyInvoke(callback: () => void): void {
  try {
    callback();
  } catch {
    // Instrumentation must never affect the app path.
  }
}

/**
 * Records the stable, anonymous, per-install identifier and attaches it to all
 * main-process telemetry. The id lands in two places:
 *
 * - `@usr.id` (plus a derived non-PII `@usr.name` and optional cloud-account
 *   `@usr.email`, see `buildDesktopInstrumentationUser`), via the vendored
 *   `setUser()` patch on the alpha `@datadog/electron-sdk` (which exposes no
 *   user API upstream). This makes Datadog attribute sessions/vitals to a
 *   "user" natively, matching the renderer SDK's `datadogRum.setUser` — same
 *   identity, same path.
 * - `@context.anon_id` on every operation, kept for continuity with existing
 *   facets/dashboards that query the custom attribute.
 *
 * Degrades gracefully (one-time warn, no throw) when `node_modules` is
 * un-patched and `setUser` is absent — `@context.anon_id` still applies.
 */
export function setDesktopInstrumentationUser(
  id: string,
  email?: string,
): void {
  anonId = id;
  userEmail = email?.trim() || undefined;
  applyUserToSdk();
}

function applyUserToSdk(): void {
  if (!initialized || !datadogSdk || anonId === undefined) {
    return;
  }
  const sdk = datadogSdk;
  // Local capture: the closure below outlives the narrowing of the mutable
  // module-level `anonId`.
  const id = anonId;
  safelyInvoke(() => {
    const setUser = sdk.setUser;
    if (typeof setUser !== 'function') {
      if (!warnedMissingSetUser) {
        warnedMissingSetUser = true;
        // eslint-disable-next-line no-console
        console.warn(
          'Datadog Electron SDK user API (setUser) is unavailable; RUM events will carry anon_id only as a context attribute, not as usr.id.',
        );
      }
      return;
    }
    setUser.call(sdk, buildDesktopInstrumentationUser(id, userEmail));
  });
}

function contextWithAnonId(
  context: DesktopInstrumentationContext | undefined,
): DesktopInstrumentationContext | undefined {
  if (anonId === undefined) {
    return context;
  }
  return { ...context, anon_id: anonId };
}

function loadDatadogSdk(): DatadogElectronSdk {
  if (datadogSdk) {
    return datadogSdk;
  }
  datadogSdk = loadRequiredNodeModule<DatadogElectronSdk>({
    moduleId: '@datadog/electron-sdk',
    requireFrom: __filename,
    validate: isDatadogElectronSdk,
  });
  return datadogSdk;
}

async function flushDatadogTransport(sdk: DatadogElectronSdk): Promise<void> {
  const flushTransport: unknown = sdk._flushTransport;
  if (typeof flushTransport !== 'function') {
    if (!warnedMissingFlushTransport) {
      warnedMissingFlushTransport = true;
      // eslint-disable-next-line no-console
      console.warn(
        'Datadog Electron SDK transport flush API is unavailable; shutdown telemetry flush skipped.',
      );
    }
    return;
  }
  await flushTransport.call(sdk);
}

export async function initializeDesktopInstrumentationMain(options?: {
  crashDumpFilter?: (filePath: string) => Promise<'process' | 'discard'>;
}): Promise<DesktopInstrumentationInitResult> {
  if (initialized) {
    return { enabled: true, provider: 'datadog' };
  }
  if (initializationStarted) {
    return { enabled: false, provider: 'datadog', reason: 'initializing' };
  }

  const config = getDesktopInstrumentationConfig().datadog;
  const readiness = getDatadogInstrumentationReadiness(config);
  if (!readiness.enabled) {
    return { enabled: false, provider: 'datadog', reason: readiness.reason };
  }
  const { clientToken, applicationId } = readiness.config;

  initializationStarted = true;
  try {
    const sdk = loadDatadogSdk();
    const didInitialize = await sdk.init({
      clientToken,
      applicationId,
      site: config.site,
      service: config.service,
      env: config.env,
      version: config.version,
      variant: config.variant,
      proxy: config.proxy,
      telemetrySampleRate: config.telemetrySampleRate,
      defaultPrivacyLevel: config.defaultPrivacyLevel,
      allowedWebViewHosts: config.allowedWebViewHosts,
      ...(options?.crashDumpFilter
        ? { crashDumpFilter: options.crashDumpFilter }
        : {}),
    });

    initialized = didInitialize;
    if (didInitialize) {
      // Covers the race where the anon id arrived before init completed.
      applyUserToSdk();
    }
    return didInitialize
      ? { enabled: true, provider: 'datadog' }
      : { enabled: false, provider: 'datadog', reason: 'init_returned_false' };
  } catch (error) {
    return {
      enabled: false,
      provider: 'datadog',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    initializationStarted = false;
  }
}

/**
 * Renews the main-process Datadog RUM session so subsequently emitted
 * operations are not silently discarded.
 *
 * The bundled alpha `@datadog/electron-sdk` expires a session after 15 min of
 * inactivity (or a 4 hr hard cap) and only renews it on renderer `click`
 * activity, which Canopy disables (`trackUserInteractions: false`). Once
 * expired, every main-process operation is dropped at assembly because the
 * RUM session/view hooks return `DISCARDED`. The vendored `notifyActivity()`
 * patch reaches the SDK's internal `sessionManager.updateActivity()`, which
 * registers a fresh session id **synchronously** before its first `await` —
 * so renewing immediately before emitting an op guarantees the op lands in a
 * live session.
 *
 * Degrades gracefully (one-time warn, no throw) when `node_modules` is
 * un-patched and `notifyActivity` is absent — mirroring the
 * `warnedMissingFlushTransport` precedent.
 */
export function keepDesktopInstrumentationSessionAlive(): void {
  if (!initialized || !datadogSdk) {
    return;
  }
  const sdk = datadogSdk;
  safelyInvoke(() => {
    const notifyActivity = sdk.notifyActivity;
    if (typeof notifyActivity !== 'function') {
      if (!warnedMissingNotifyActivity) {
        warnedMissingNotifyActivity = true;
        // eslint-disable-next-line no-console
        console.warn(
          'Datadog Electron SDK session keepalive API (notifyActivity) is unavailable; RUM sessions may expire and silently drop telemetry.',
        );
      }
      return;
    }
    notifyActivity.call(sdk);
  });
}

const posthogOperations = createPostHogOperationTracker({
  appVersion: getDesktopInstrumentationConfig().appVersion,
});

function forwardPostHogOperation(
  name: DesktopOperationName,
  outcome: DesktopOperationOutcome,
  options: DesktopInstrumentationOperationOptions | undefined,
): void {
  safelyInvoke(() => {
    // Finish even while capture is off so the start time is released.
    const operation = posthogOperations.finish(
      name,
      outcome,
      'background',
      options,
    );
    if (
      !operation ||
      !posthogOperationCaptureEnabled ||
      posthogInitializationUnavailable ||
      posthogShutdownRequested
    )
      return;
    if (!posthog || !posthogAnonymousId) {
      if (pendingPostHogOperations.length >= MAX_PENDING_POSTHOG_OPERATIONS) {
        pendingPostHogOperations.shift();
      }
      pendingPostHogOperations.push(operation);
      return;
    }
    captureDesktopPostHogOperation(operation);
  });
}

export function startDesktopOperation(
  name: DesktopOperationName,
  options?: DesktopInstrumentationOperationOptions,
): void {
  safelyInvoke(() =>
    posthogOperations.start(
      name,
      options,
      isDesktopPostHogOperationCaptureEnabled(),
    ),
  );
  if (!initialized || !datadogSdk) {
    return;
  }
  safelyInvoke(() => {
    keepDesktopInstrumentationSessionAlive();
    datadogSdk?.startOperation(name, {
      ...options,
      context: sanitizeDatadogInstrumentationContext(
        contextWithAnonId(options?.context),
      ),
    });
  });
}

export function succeedDesktopOperation(
  name: DesktopOperationName,
  options?: DesktopInstrumentationOperationOptions,
): void {
  forwardPostHogOperation(name, { status: 'success' }, options);
  if (!initialized || !datadogSdk) {
    return;
  }
  safelyInvoke(() => {
    keepDesktopInstrumentationSessionAlive();
    datadogSdk?.succeedOperation(name, {
      ...options,
      context: sanitizeDatadogInstrumentationContext(
        contextWithAnonId(options?.context),
      ),
    });
  });
}

export function failDesktopOperation(
  name: DesktopOperationName,
  failureReason: DesktopInstrumentationFailureReason,
  options?: DesktopInstrumentationOperationOptions,
): void {
  forwardPostHogOperation(name, { status: 'failure', failureReason }, options);
  if (!initialized || !datadogSdk) {
    return;
  }
  safelyInvoke(() => {
    keepDesktopInstrumentationSessionAlive();
    datadogSdk?.failOperation(name, failureReason, {
      ...options,
      context: sanitizeDatadogInstrumentationContext(
        contextWithAnonId(options?.context),
      ),
    });
  });
}

export function captureDesktopInstrumentationError(
  error: unknown,
  options?: DesktopInstrumentationErrorOptions,
): void {
  if (!initialized || !datadogSdk) {
    return;
  }
  safelyInvoke(() => {
    keepDesktopInstrumentationSessionAlive();
    datadogSdk?.addError(error, {
      context: sanitizeDatadogInstrumentationContext(
        contextWithAnonId(options?.context),
      ),
    });
  });
}

export async function flushDesktopInstrumentation(): Promise<void> {
  await Promise.allSettled([flushDesktopPostHog(), flushDesktopDatadog()]);
}

async function flushDesktopDatadog(): Promise<void> {
  if (!initialized || !datadogSdk) {
    return;
  }
  try {
    await flushDatadogTransport(datadogSdk);
  } catch {
    // Best-effort shutdown flush.
  }
}

let posthog: PostHog | undefined;
let posthogAnonymousId: string | undefined;
let posthogInitialization:
  | Promise<DesktopInstrumentationInitResult>
  | undefined;
let posthogShutdown: Promise<void> | undefined;
let posthogShutdownRequested = false;
let posthogSession: PostHogSessionState | undefined;
let posthogPlatformProperties: PostHogPlatformProperties = {};
let posthogOperationCaptureEnabled = false;
let posthogInitializationUnavailable = false;
let posthogOperationEpoch = 0;
const POSTHOG_OPERATION_EPOCH_KEY = '__canopy_operation_epoch';
const MAX_PENDING_POSTHOG_OPERATIONS = 100;
const pendingPostHogOperations: PostHogOperationEvent[] = [];
const POSTHOG_INITIALIZATION_SHUTDOWN_TIMEOUT_MS = 5_000;

/** The SDK retries the same batch body, so filter it on every network attempt. */
async function sendPostHogRequest(
  url: string,
  options: Parameters<typeof fetch>[1] & {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  },
): Promise<Response> {
  if (!url.endsWith('/batch/')) {
    return fetch(url, options);
  }
  if (typeof options.body !== 'string') {
    // A batch we cannot inspect must fail closed while operation capture is off.
    return new Response('{}', { status: 200 });
  }
  try {
    const payload: unknown = JSON.parse(options.body);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('batch' in payload) ||
      !Array.isArray(payload.batch)
    ) {
      return new Response('{}', { status: 200 });
    }
    const batch: unknown[] = payload.batch;
    const allowed = batch.flatMap((message) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('event' in message) ||
        typeof message.event !== 'string'
      )
        return [];
      if (
        !isDesktopPostHogOperationEvent(message.event) &&
        message.event !== '$set'
      )
        return [message];
      if (
        !posthogOperationCaptureEnabled ||
        !('properties' in message) ||
        typeof message.properties !== 'object' ||
        message.properties === null ||
        !(POSTHOG_OPERATION_EPOCH_KEY in message.properties) ||
        message.properties[POSTHOG_OPERATION_EPOCH_KEY] !==
          posthogOperationEpoch
      )
        return [];
      if (
        message.event === '$set' &&
        (!('email_domain' in message.properties) ||
          message.properties.email_domain !== posthogAccount?.domain)
      )
        return [];
      const properties = { ...message.properties };
      delete properties[POSTHOG_OPERATION_EPOCH_KEY];
      return [{ ...message, properties }];
    });
    if (allowed.length === 0) return new Response('{}', { status: 200 });
    return fetch(url, {
      ...options,
      body: JSON.stringify({ ...payload, batch: allowed }),
    });
  } catch {
    return new Response('{}', { status: 200 });
  }
}

/**
 * Applies the LaunchDarkly PostHog capture flag to forwarded operations.
 * Closed until the host supplies its first flag snapshot.
 */
export function setDesktopPostHogOperationCaptureEnabled(
  enabled: boolean,
): void {
  posthogOperationCaptureEnabled = enabled;
  if (!enabled) {
    posthogOperations.discardAcquisitionStarts();
    posthogOperationEpoch += 1;
    pendingPostHogOperations.length = 0;
  } else {
    publishPostHogAccount();
  }
}

/** Eligibility for durable product milestones. Never consume one while capture is off. */
export function isDesktopPostHogOperationCaptureEnabled(): boolean {
  return Boolean(
    posthogOperationCaptureEnabled &&
    posthog &&
    posthogAnonymousId &&
    !posthogInitializationUnavailable &&
    !posthogShutdownRequested &&
    !posthogShutdown,
  );
}

let posthogAccount: PostHogAccountTracker | undefined;
let publishedPostHogAccountDomain: string | null | undefined;
let publishedPostHogAccountEpoch: number | undefined;

export async function getDesktopPostHogEmailDomain(): Promise<string | null> {
  await posthogAccount?.ready;
  return posthogAccount?.domain ?? null;
}

function publishPostHogAccount(): void {
  const domain = posthogAccount?.domain;
  if (
    !posthogOperationCaptureEnabled ||
    domain === undefined ||
    !posthog ||
    !posthogAnonymousId ||
    posthogShutdownRequested ||
    (domain === publishedPostHogAccountDomain &&
      posthogOperationEpoch === publishedPostHogAccountEpoch)
  )
    return;
  captureDesktopPostHogEvent('$set');
  publishedPostHogAccountDomain = domain;
  publishedPostHogAccountEpoch = posthogOperationEpoch;
}

export function getDesktopPostHogSession(): PostHogSessionState {
  if (!posthogSession) {
    // UUIDv7's first 48 bits are milliseconds; the remaining random bits and
    // RFC variant come from Node's cryptographically random UUID.
    const timestamp = Date.now().toString(16).padStart(12, '0');
    const random = randomUUID();
    posthogSession = {
      sessionId: `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15)}`,
      revision: 0,
    };
  }
  return { ...posthogSession };
}

/** Synchronous compare-and-swap on main's event loop. Concurrent or delayed
 * proposals receive the winning state and cannot resurrect an old session. */
export function adoptDesktopPostHogSession(
  proposal: PostHogSessionState,
): PostHogSessionState {
  if (!isPostHogSessionState(proposal))
    throw new Error('Invalid PostHog session proposal');
  const current = getDesktopPostHogSession();
  if (
    proposal.revision === current.revision &&
    proposal.sessionId !== current.sessionId
  ) {
    posthogSession = {
      sessionId: proposal.sessionId,
      revision: current.revision + 1,
    };
  }
  return getDesktopPostHogSession();
}

export function initializePostHogMain(
  getAnonymousId: () => Promise<string>,
  accountSource?: PostHogAccountSource,
  getInstallLaunch?: () => Promise<PostHogInstallLaunch>,
  getHostPlatform?: () => PostHogHostPlatform,
): Promise<DesktopInstrumentationInitResult> {
  return (posthogInitialization ??=
    (async (): Promise<DesktopInstrumentationInitResult> => {
      try {
        const result = await initializePostHogMainClient(
          getAnonymousId,
          accountSource,
          getInstallLaunch,
          getHostPlatform,
        );
        posthogInitializationUnavailable = !result.enabled;
        return result;
      } finally {
        pendingPostHogOperations.length = 0;
      }
    })());
}

async function initializePostHogMainClient(
  getAnonymousId: () => Promise<string>,
  accountSource?: PostHogAccountSource,
  getInstallLaunch?: () => Promise<PostHogInstallLaunch>,
  getHostPlatform?: () => PostHogHostPlatform,
): Promise<DesktopInstrumentationInitResult> {
  const config = getDesktopInstrumentationConfig();
  const readiness = getPostHogInstrumentationReadiness(config.posthog);
  if (!readiness.enabled)
    return {
      enabled: false,
      provider: 'posthog',
      reason: readiness.reason,
    };
  if (posthogShutdownRequested)
    return {
      enabled: false,
      provider: 'posthog',
      reason: 'shutdown',
    };
  try {
    posthogAccount = createPostHogAccountTracker(
      accountSource,
      publishPostHogAccount,
    );
    getDesktopPostHogSession();
    const id = await getAnonymousId();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new Error('PostHog anonymous identity is unavailable');
    }
    const installLaunch = await readPostHogInstallLaunch(getInstallLaunch);
    posthogPlatformProperties = readPostHogPlatformProperties(getHostPlatform);
    const sdk = loadRequiredNodeModule<typeof PostHogNodeModule>({
      moduleId: 'posthog-node',
      requireFrom: __filename,
      validate: (value): value is typeof PostHogNodeModule =>
        typeof value === 'object' &&
        value !== null &&
        'PostHog' in value &&
        typeof value.PostHog === 'function',
    });
    posthog = new sdk.PostHog(readiness.config.projectKey, {
      host: readiness.config.host,
      disableGeoip: false,
      isServer: false,
      flushAt: 20,
      flushInterval: 5_000,
      disableCompression: true,
      fetch: sendPostHogRequest,
      requestTimeout: 5_000,
      enableExceptionAutocapture: false,
      before_send: (event): typeof event | null => {
        try {
          return sanitizePostHogEvent(event);
        } catch {
          return null;
        }
      },
    });
    posthog.on('error', () => {
      /* Delivery failure must not affect the app. */
    });
    posthogAnonymousId = id;
    if (posthogShutdownRequested) {
      void shutdownDesktopPostHogClient();
      return {
        enabled: false,
        provider: 'posthog',
        reason: 'shutdown',
      };
    }
    captureDesktopPostHogEvent('desktop:app_start', {
      ...(config.appVersion === undefined
        ? {}
        : { app_version: config.appVersion }),
      ...(config.releaseChannel === undefined
        ? {}
        : { release_channel: config.releaseChannel }),
      ...(installLaunch === undefined
        ? {}
        : {
            is_first_launch: installLaunch.isFirstLaunch,
            is_reinstall: installLaunch.isReinstall,
            ...(typeof installLaunch.isInvitedInstall === 'boolean'
              ? { is_invited_install: installLaunch.isInvitedInstall }
              : {}),
          }),
    });
    publishPostHogAccount();
    if (posthogOperationCaptureEnabled) {
      for (const operation of pendingPostHogOperations) {
        captureDesktopPostHogOperation(operation);
      }
    }
    return { enabled: true, provider: 'posthog' };
  } catch (error) {
    return {
      enabled: false,
      provider: 'posthog',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Launch facts are best-effort; a failed read never blocks startup. */
async function readPostHogInstallLaunch(
  getInstallLaunch: (() => Promise<PostHogInstallLaunch>) | undefined,
): Promise<PostHogInstallLaunch | undefined> {
  if (!getInstallLaunch) return undefined;
  try {
    return await getInstallLaunch();
  } catch {
    return undefined;
  }
}

function captureDesktopPostHogOperation(
  operation: PostHogOperationEvent,
): void {
  captureDesktopPostHogEvent(operation.event, {
    ...operation.properties,
    [POSTHOG_OPERATION_EPOCH_KEY]: posthogOperationEpoch,
  });
}

/** Explicit product events. Operations reach PostHog only through the
 * `DESKTOP_OPERATIONS` allowlist, never by calling this directly. */
export function captureDesktopPostHogEvent(
  event: string,
  context?: DesktopInstrumentationContext,
): void {
  if (
    !posthog ||
    !posthogAnonymousId ||
    posthogShutdownRequested ||
    posthogShutdown
  )
    return;
  const distinctId = posthogAnonymousId;
  safelyInvoke(() => {
    const domain =
      posthogOperationCaptureEnabled && event !== 'desktop:app_start'
        ? posthogAccount?.domain
        : undefined;
    const sanitized = sanitizePostHogEvent({
      properties: {
        ...sanitizeInstrumentationContext(context),
        ...posthogPlatformProperties,
        distinct_id: posthogAnonymousId,
        $session_id: getDesktopPostHogSession().sessionId,
        $process_person_profile: domain !== undefined,
        $is_identified: false,
        ...(domain !== undefined && {
          email_domain: domain,
          ...(event === '$set' && {
            $set: { email_domain: domain },
            [POSTHOG_OPERATION_EPOCH_KEY]: posthogOperationEpoch,
          }),
        }),
      },
    });
    posthog?.capture({ distinctId, event, properties: sanitized?.properties });
  });
}

async function flushDesktopPostHog(): Promise<void> {
  posthogShutdownRequested = true;
  posthogAccount?.dispose();
  await waitForPostHogInitializationDuringShutdown();
  await shutdownDesktopPostHogClient();
}

async function waitForPostHogInitializationDuringShutdown(): Promise<void> {
  const initialization = posthogInitialization;
  if (!initialization) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(
      finish,
      POSTHOG_INITIALIZATION_SHUTDOWN_TIMEOUT_MS,
    );
    void initialization.then(finish, finish);
  });
}

function shutdownDesktopPostHogClient(): Promise<void> {
  if (!posthog) return Promise.resolve();
  return (posthogShutdown ??= posthog.shutdown(5_000).catch(() => {
    // Best-effort shutdown flush.
  }));
}
