import {
  toAppError,
  createAppErrorHandler,
  type AppErrorHandler,
  type AppErrorReport,
  type AppErrorReportOptions,
  type AppErrorRecord,
} from '@canopy/protocol/app-errors';
import {
  APP_ERROR_POSTHOG_EVENT,
  APP_ERROR_VIEW_POSTHOG_EVENT,
  buildAppErrorPostHogProperties,
} from '../app-error-telemetry';
import { loadRequiredNodeModule } from '@canopy/desktop-shared/node/lib/packaged-module-loader';
import { randomUUID } from 'node:crypto';
import type { PostHog } from 'posthog-node';
import type * as PostHogNodeModule from 'posthog-node';
import type {
  PostHogInstallLaunch,
  PostHogSessionState,
} from '@canopy/execution-engine/types/observability';
import { isPostHogSessionState } from '../posthog-session';
import { sanitizePostHogEvent } from '../posthog-privacy';
import {
  getDesktopInstrumentationConfig,
  getPostHogInstrumentationReadiness,
} from '../config';
import { sanitizeInstrumentationContext } from '../privacy';
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
import type {
  DesktopInstrumentationContext,
  DesktopInstrumentationErrorOptions,
  DesktopInstrumentationFailureReason,
  DesktopInstrumentationInitResult,
  DesktopInstrumentationOperationOptions,
} from '../types';
export {
  createForeignCrashDumpFilter,
  hasWin32ShortNameComponent,
} from './crash-dumps/foreign-dump-filter';
export type { CrashDumpClassification } from './crash-dumps/foreign-dump-filter';
export { readMinidumpExecutablePath } from './crash-dumps/minidump';

function safelyInvoke(callback: () => void): void {
  try {
    callback();
  } catch {
    // Instrumentation must never affect the app path.
  }
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
    if (!operation) return;
    forwardGatedPostHogEvent(operation);
  });
}

function isPostHogErrorEvent(event: string): boolean {
  return (
    event === '$exception' ||
    event === APP_ERROR_POSTHOG_EVENT ||
    event === APP_ERROR_VIEW_POSTHOG_EVENT
  );
}

/** Operations and `$set` also need the LaunchDarkly capture flag. */
function isPostHogFlagGatedProductEvent(event: string): boolean {
  return isDesktopPostHogOperationEvent(event) || event === '$set';
}

/** Each category's epoch, stamped at capture and checked at delivery. */
function postHogEpochFor(event: string): number {
  if (isPostHogErrorEvent(event)) return posthogErrorsEpoch;
  return isPostHogFlagGatedProductEvent(event)
    ? posthogEventsEpoch
    : posthogLaunchEventsEpoch;
}

function forwardGatedPostHogEvent(operation: PostHogOperationEvent): void {
  if (
    !(isPostHogErrorEvent(operation.event)
      ? posthogErrorsCaptureEnabled
      : posthogEventsCaptureEnabled) ||
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
}

export function succeedDesktopOperation(
  name: DesktopOperationName,
  options?: DesktopInstrumentationOperationOptions,
): void {
  forwardPostHogOperation(name, { status: 'success' }, options);
}

export function failDesktopOperation(
  name: DesktopOperationName,
  failureReason: DesktopInstrumentationFailureReason,
  options?: DesktopInstrumentationOperationOptions,
): void {
  forwardPostHogOperation(name, { status: 'failure', failureReason }, options);
}

/** Main-process errors reach PostHog `$exception` through the observability
 * port. Gated by the errors flag and epoch, independent of product events. */
export function captureDesktopInstrumentationError(
  error: unknown,
  options?: DesktopInstrumentationErrorOptions,
): void {
  safelyInvoke(() => captureDesktopPostHogException(error, options?.context));
}

export async function flushDesktopInstrumentation(): Promise<void> {
  await flushDesktopPostHog();
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
/** Operations, `$set`, and other LaunchDarkly-gated product events. */
let posthogEventsCaptureEnabled = false;
/** `$exception` and the app-error events. */
let posthogErrorsCaptureEnabled = false;
/** Product events the LaunchDarkly kill switch does not gate. */
let posthogLaunchEventsCaptureEnabled = false;
let posthogInitializationUnavailable = false;
let posthogEventsEpoch = 0;
let posthogLaunchEventsEpoch = 0;
let posthogErrorsEpoch = 0;
/** A policy restart starts a new client, not a new launch. */
let posthogAppStartCaptured = false;
/** Read by the launch's first client and kept for a later `app_start`. */
let posthogInstallLaunch: PostHogInstallLaunch | undefined;
let posthogInstallLaunchRead = false;
/** Serializes policy shutdowns and re-initializations. */
let posthogLifecycle: Promise<void> = Promise.resolve();
const POSTHOG_OPERATION_EPOCH_KEY = '__canopy_operation_epoch';
const MAX_PENDING_POSTHOG_OPERATIONS = 100;
const pendingPostHogOperations: PostHogOperationEvent[] = [];
const POSTHOG_INITIALIZATION_SHUTDOWN_TIMEOUT_MS = 5_000;
/** Unlike operations, exceptions buffer before the first flag snapshot. */
let posthogCaptureFlagKnown = false;
interface PendingPostHogException {
  error: unknown;
  context: DesktopInstrumentationContext | undefined;
}
const MAX_PENDING_POSTHOG_EXCEPTIONS = 20;
const pendingPostHogExceptions: PendingPostHogException[] = [];
/** Per-process cap, so a crash loop (a `child_process_gone` storm, for
 * example) cannot flood PostHog. Drops past it are only counted locally. */
const MAX_POSTHOG_EXCEPTIONS_PER_PROCESS = 100;
let posthogExceptionsSent = 0;
let posthogExceptionsDroppedOverCap = 0;

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
      // Errors follow Error reports; every other event follows Usage
      // analytics. Operations and `$set` also need the LaunchDarkly capture
      // flag; launch events such as `desktop:app_start` do not. An event
      // without its category's epoch, such as one posthog-node sends on its
      // own, is dropped.
      const permitted = isPostHogErrorEvent(message.event)
        ? posthogErrorsCaptureEnabled
        : isPostHogFlagGatedProductEvent(message.event)
          ? posthogEventsCaptureEnabled
          : posthogLaunchEventsCaptureEnabled;
      if (
        !permitted ||
        !('properties' in message) ||
        typeof message.properties !== 'object' ||
        message.properties === null ||
        !(POSTHOG_OPERATION_EPOCH_KEY in message.properties) ||
        message.properties[POSTHOG_OPERATION_EPOCH_KEY] !==
          postHogEpochFor(message.event)
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

export interface DesktopPostHogCapturePolicy {
  /** LaunchDarkly capture flag ∧ effective Usage analytics. */
  events: boolean;
  /** LaunchDarkly capture flag ∧ effective Error reports. */
  errors: boolean;
  /**
   * Effective Usage analytics alone, for launch events such as
   * `desktop:app_start` that the LaunchDarkly kill switch does not gate.
   */
  launchEvents: boolean;
}

/**
 * Applies the combined LaunchDarkly flag and usage-data policy to forwarded
 * operations, product events, and errors. Closed until the host supplies its
 * first policy. Narrowing a category bumps its epoch and drops its queue;
 * re-enabling events republishes `$set` and re-enabling errors drains the
 * exception buffer.
 */
export function setDesktopPostHogCapturePolicy(
  policy: DesktopPostHogCapturePolicy,
): void {
  posthogCaptureFlagKnown = true;
  const eventsNarrowed = posthogEventsCaptureEnabled && !policy.events;
  // Separate so the LaunchDarkly kill switch alone never drops a queued
  // `desktop:app_start`.
  const launchEventsNarrowed =
    posthogLaunchEventsCaptureEnabled && !policy.launchEvents;
  posthogEventsCaptureEnabled = policy.events;
  posthogLaunchEventsCaptureEnabled = policy.launchEvents;
  posthogErrorsCaptureEnabled = policy.errors;
  if (launchEventsNarrowed) posthogLaunchEventsEpoch += 1;
  if (eventsNarrowed || launchEventsNarrowed || !policy.events) {
    posthogOperations.discardAcquisitionStarts();
    if (eventsNarrowed) posthogEventsEpoch += 1;
    removePendingPostHogOperations((event) => !isPostHogErrorEvent(event));
  }
  if (!policy.errors) {
    mainAppErrorHandler?.dispose();
    mainAppErrorHandler = undefined;
    posthogErrorsEpoch += 1;
    removePendingPostHogOperations(isPostHogErrorEvent);
    pendingPostHogExceptions.length = 0;
  }
  if (policy.launchEvents) captureDesktopPostHogAppStart();
  if (policy.events) publishPostHogAccount();
  if (policy.errors) drainPendingPostHogExceptions();
}

function removePendingPostHogOperations(
  matches: (event: string) => boolean,
): void {
  const kept = pendingPostHogOperations.filter(
    (operation) => !matches(operation.event),
  );
  pendingPostHogOperations.length = 0;
  pendingPostHogOperations.push(...kept);
}

/** Eligibility for durable product milestones. Never consume one while capture is off. */
export function isDesktopPostHogOperationCaptureEnabled(): boolean {
  return Boolean(
    posthogEventsCaptureEnabled &&
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
    !posthogEventsCaptureEnabled ||
    domain === undefined ||
    !posthog ||
    !posthogAnonymousId ||
    posthogShutdownRequested ||
    (domain === publishedPostHogAccountDomain &&
      posthogEventsEpoch === publishedPostHogAccountEpoch)
  )
    return;
  captureDesktopPostHogEvent('$set');
  publishedPostHogAccountDomain = domain;
  publishedPostHogAccountEpoch = posthogEventsEpoch;
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
  const lifecycle = posthogLifecycle;
  return (posthogInitialization ??=
    (async (): Promise<DesktopInstrumentationInitResult> => {
      // A policy shutdown in flight finishes before a new client starts.
      await lifecycle;
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
        // Exceptions still waiting on the first flag snapshot stay buffered.
        if (posthogInitializationUnavailable)
          pendingPostHogExceptions.length = 0;
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
    // Install facts describe the launch, so only its first client reads them.
    if (!posthogInstallLaunchRead) {
      posthogInstallLaunchRead = true;
      posthogInstallLaunch = await readPostHogInstallLaunch(getInstallLaunch);
    }
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
      // Main's own `uncaughtException` handler reports and flushes before it
      // exits; SDK autocapture would install a listener that cannot flush.
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
    captureDesktopPostHogAppStart();
    publishPostHogAccount();
    for (const operation of pendingPostHogOperations) {
      if (
        isPostHogErrorEvent(operation.event)
          ? posthogErrorsCaptureEnabled
          : posthogEventsCaptureEnabled
      )
        captureDesktopPostHogOperation(operation);
    }
    drainPendingPostHogExceptions();
    return { enabled: true, provider: 'posthog' };
  } catch (error) {
    return {
      enabled: false,
      provider: 'posthog',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * `desktop:app_start` follows Usage analytics alone, once per process: when
 * the first client starts with launch events open, or when they open later in
 * that launch, so a session that began with analytics off keeps its install
 * facts.
 */
function captureDesktopPostHogAppStart(): void {
  if (
    posthogAppStartCaptured ||
    !posthogLaunchEventsCaptureEnabled ||
    !posthog ||
    !posthogAnonymousId ||
    posthogShutdownRequested ||
    posthogShutdown
  )
    return;
  posthogAppStartCaptured = true;
  const config = getDesktopInstrumentationConfig();
  const installLaunch = posthogInstallLaunch;
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
  captureDesktopPostHogEvent(operation.event, operation.properties);
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
      posthogEventsCaptureEnabled && event !== 'desktop:app_start'
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
          ...(event === '$set' && { $set: { email_domain: domain } }),
        }),
        // Every event carries its category's epoch so `sendPostHogRequest`
        // drops anything captured before a later narrowing.
        [POSTHOG_OPERATION_EPOCH_KEY]: postHogEpochFor(event),
      },
    });
    posthog?.capture({ distinctId, event, properties: sanitized?.properties });
  });
}

/** Buffers while the SDK, anonymous id or first policy is pending; drops
 * when error capture is off. The epoch lets `sendPostHogRequest` discard
 * an exception captured before a later off/on toggle. */
function captureDesktopPostHogException(
  error: unknown,
  context: DesktopInstrumentationContext | undefined,
): void {
  if (
    posthogShutdownRequested ||
    posthogShutdown ||
    posthogInitializationUnavailable ||
    (posthogCaptureFlagKnown && !posthogErrorsCaptureEnabled)
  )
    return;
  if (!posthog || !posthogAnonymousId || !posthogErrorsCaptureEnabled) {
    if (pendingPostHogExceptions.length >= MAX_PENDING_POSTHOG_EXCEPTIONS) {
      pendingPostHogExceptions.shift();
    }
    pendingPostHogExceptions.push({ error, context });
    return;
  }
  sendDesktopPostHogException(error, context);
}

function drainPendingPostHogExceptions(): void {
  if (!posthog || !posthogAnonymousId || !posthogErrorsCaptureEnabled) return;
  for (const { error, context } of pendingPostHogExceptions.splice(0)) {
    sendDesktopPostHogException(error, context);
  }
}

function sendDesktopPostHogException(
  error: unknown,
  context: DesktopInstrumentationContext | undefined,
): void {
  if (posthogExceptionsSent >= MAX_POSTHOG_EXCEPTIONS_PER_PROCESS) {
    posthogExceptionsDroppedOverCap += 1;
    return;
  }
  posthogExceptionsSent += 1;
  const distinctId = posthogAnonymousId;
  // The account domain and person profile follow Usage analytics, not Error
  // reports, as they do for product events.
  const domain = posthogEventsCaptureEnabled
    ? posthogAccount?.domain
    : undefined;
  safelyInvoke(() => {
    // `before_send` runs `sanitizePostHogEvent`, which also sanitizes the
    // SDK-built `$exception_*` properties.
    posthog?.captureException(error, distinctId, {
      ...sanitizeInstrumentationContext(context),
      ...posthogPlatformProperties,
      $session_id: getDesktopPostHogSession().sessionId,
      $process_person_profile: domain !== undefined,
      $is_identified: false,
      ...(domain !== undefined && { email_domain: domain }),
      [POSTHOG_OPERATION_EPOCH_KEY]: posthogErrorsEpoch,
    });
  });
}

async function flushDesktopPostHog(): Promise<void> {
  disposeMainAppErrorHandler();
  if (!posthogShutdownRequested && mainAppErrorsDroppedOverCap > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `PostHog app error cap reached; ${mainAppErrorsDroppedOverCap} main error records were not sent.`,
    );
  }
  // The fatal path flushes twice; warn only on the first.
  if (!posthogShutdownRequested && posthogExceptionsDroppedOverCap > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `PostHog exception cap reached; ${posthogExceptionsDroppedOverCap} main-process exceptions were not sent.`,
    );
  }
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

/**
 * Shut the client down because the member's usage-data policy turned both
 * product events and error reports off. Unlike the quit path, a later
 * `initializePostHogMain` can start a new client. Serialized with
 * initialization so rapid toggles never leave two clients. Sends no event.
 */
export function suspendPostHogMain(): Promise<void> {
  const initialization = posthogInitialization;
  posthogInitialization = undefined;
  posthogLifecycle = posthogLifecycle.then(async (): Promise<void> => {
    if (!initialization) return;
    await initialization.catch(() => undefined);
    // Quit owns the client from here.
    if (posthogShutdownRequested) return;
    const client = posthog;
    posthogAccount?.dispose();
    posthogAccount = undefined;
    posthog = undefined;
    posthogAnonymousId = undefined;
    posthogInitializationUnavailable = false;
    publishedPostHogAccountDomain = undefined;
    publishedPostHogAccountEpoch = undefined;
    pendingPostHogOperations.length = 0;
    pendingPostHogExceptions.length = 0;
    await client?.shutdown(5_000).catch(() => {
      // Best-effort shutdown flush.
    });
  });
  // A failed suspend must not leave every later start awaiting a rejection.
  posthogLifecycle = posthogLifecycle.catch(() => undefined);
  return posthogLifecycle;
}

let mainAppErrorHandler: AppErrorHandler | undefined;
let mainAppErrorHandlerDisposed = false;
const MAX_MAIN_APP_ERROR_ADMISSIONS = 100;
let mainAppErrorAdmissions = 0;
let mainAppErrorsDroppedOverCap = 0;

function captureMainAppError(record: AppErrorRecord): void {
  if (
    !posthogErrorsCaptureEnabled ||
    posthogInitializationUnavailable ||
    posthogShutdownRequested ||
    posthogShutdown
  )
    return;
  if (mainAppErrorAdmissions >= MAX_MAIN_APP_ERROR_ADMISSIONS) {
    mainAppErrorsDroppedOverCap++;
    return;
  }
  // Admission includes closing summaries and precedes queueing. Ownership is
  // local recording, not an acknowledgement of telemetry delivery.
  mainAppErrorAdmissions++;
  forwardGatedPostHogEvent({
    event: APP_ERROR_POSTHOG_EVENT,
    properties: buildAppErrorPostHogProperties(record),
  });
}

function createMainAppErrorHandler(appVersion: string): AppErrorHandler {
  return createAppErrorHandler({
    host: 'main',
    appVersion,
    sinks: [captureMainAppError],
    scheduler: {
      schedule(callback, delayMs): () => void {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return (): void => clearTimeout(timer);
      },
    },
  });
}

const disposedMainAppErrorHandler: AppErrorHandler = {
  report(value, options): AppErrorReport | undefined {
    const error = toAppError(value, options);
    return error ? { error, disposition: 'none' } : undefined;
  },
  flush(): void {},
  dispose(): void {},
};

const captureDisabledMainAppErrorHandler: AppErrorHandler = {
  ...disposedMainAppErrorHandler,
  report(value, options): AppErrorReport | undefined {
    const report = disposedMainAppErrorHandler.report(value, options);
    if (!report || report.error.kind === 'input' || report.error.recordedBy)
      return report;
    // Preserve local ownership without retaining or emitting disabled-period data.
    return { ...report, error: { ...report.error, recordedBy: 'main' } };
  },
};

export function getMainAppErrorHandler(): AppErrorHandler {
  if (mainAppErrorHandlerDisposed)
    return mainAppErrorHandler ?? disposedMainAppErrorHandler;
  if (!posthogErrorsCaptureEnabled) return captureDisabledMainAppErrorHandler;
  if (!mainAppErrorHandler) {
    try {
      mainAppErrorHandler = createMainAppErrorHandler(
        getDesktopInstrumentationConfig().appVersion ?? 'unknown',
      );
    } catch {
      mainAppErrorHandler = createMainAppErrorHandler('unknown');
    }
  }
  return mainAppErrorHandler;
}

export function reportMainAppError(
  value: unknown,
  options?: AppErrorReportOptions,
): AppErrorReport | undefined {
  return getMainAppErrorHandler().report(value, options);
}

export function disposeMainAppErrorHandler(): void {
  if (mainAppErrorHandlerDisposed) return;
  mainAppErrorHandlerDisposed = true;
  mainAppErrorHandler?.dispose();
}
