import { app, net, session as electronSession, type Session } from 'electron';
import { z } from 'zod';
import { BRAND } from '@canopy/brand/current';
import {
  SettingsOperationError,
  settingsBootstrapSchema,
  settingsOperationRequest,
  type SettingsErrorCode,
} from '@canopy/protocol/settings';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  type CanopyCloudCredentialContext,
} from './client';
import {
  getCanopyCloudCredentials,
  hasCanopyCloudIdentityChanged,
  peekCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * Desktop hosted settings session bridge.
 *
 * Main exchanges the captured desktop credential (`csk_`) for a same-account
 * web session through the existing auth-link mint and consume routes, and
 * keeps that session's cookies in an isolated, in-memory Electron partition.
 * Cookies never reach renderer content: only main issues requests from the
 * partition, and only to the configured cloud origin.
 *
 * Requests use `net.request` with the partition session rather than
 * `ses.fetch`. In Electron 42, `ses.fetch(..., { redirect: 'manual' })`
 * registers no `redirect` listener, so the request dies with "Redirect was
 * cancelled" and the consume route's 303 status and `Location` are never
 * observable. `net.request` exposes the redirect event, and its documented
 * `origin` option sends the `Origin` header Better Auth's origin check needs
 * (verified in the Electron spike; see
 * docs/planning/2026-10-16-desktop-account-organization-settings/spikes.md).
 */

export const SETTINGS_BRIDGE_PARTITION = 'canopy-settings-bridge';
/** Dispose after this long with no operation and no retained stream. */
export const SETTINGS_BRIDGE_IDLE_MS = 15 * 60 * 1000;
/** Upper bound on the best-effort sign-out during disposal. */
export const SETTINGS_BRIDGE_SIGN_OUT_TIMEOUT_MS = 2_000;
/** Upper bound on clearing the partition during disposal. */
const CLEAR_STORAGE_TIMEOUT_MS = 2_000;
/** Timeout for each request the mint makes (mint, consume, bootstrap). */
const MINT_STEP_TIMEOUT_MS = 15_000;
/**
 * A failed mint is not retried by background callers for this long, so a
 * renderer refetch loop cannot drive the auth-link mint rate limit. A user
 * action may retry immediately.
 */
const MINT_FAILURE_COOLDOWN_MS = 30_000;
/**
 * The bootstrap the mint reads to check the viewer answers the first
 * account-scoped `settings.bootstrap` read of the same mint, once, within
 * this window, so opening Settings does not fetch the bootstrap twice.
 */
export const SETTINGS_BRIDGE_MINT_BOOTSTRAP_TTL_MS = 30_000;
/** Where the minted web session would land; the redirect is never followed. */
const AUTH_LINK_REDIRECT_PATH = '/';
const SIGN_OUT_PATH = '/api/auth/sign-out';
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

export type SettingsBridgeState =
  | 'uninitialized'
  | 'minting'
  | 'ready'
  | 'expired'
  | 'disposed';

export type SettingsBridgeDisposeReason =
  | 'idle'
  | 'account_changed'
  | 'origin_changed'
  | 'quit'
  | 'identity_mismatch'
  | 'revoked';

export interface SettingsBridgeRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  /**
   * Send `Origin` = the configured web origin (Better Auth). Writes send it
   * regardless, as a browser does for a same-origin POST.
   */
  authOrigin?: boolean;
  /** A 401 rejects a typed credential, so the session stays ready. */
  rejectedCredentialOn401?: boolean;
}

const authLinkMintResponseSchema = z.looseObject({ url: z.string() });

function settingsError(
  code: SettingsErrorCode,
  message?: string,
  status?: number,
): SettingsOperationError {
  return new SettingsOperationError({
    code,
    ...(message === undefined ? {} : { message }),
    ...(status === undefined ? {} : { status }),
  });
}

function sessionEndedError(): SettingsOperationError {
  return settingsError('expired', 'The hosted settings session ended.');
}

/** A sent mutation whose response was discarded may still have landed. */
function discardedResponseError(method: string): SettingsOperationError {
  return SAFE_METHODS.has(method)
    ? sessionEndedError()
    : settingsError('uncertain');
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw settingsError('unauthenticated', 'Cloud base URL is invalid.');
  }
}

/** Abort when any input signal aborts, or after `timeoutMs`. */
function combinedSignal(
  signals: readonly (AbortSignal | undefined)[],
  timeoutMs?: number,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const attached: AbortSignal[] = [];
  for (const signal of signals) {
    if (signal === undefined) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    attached.push(signal);
  }
  const timer =
    timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  if (timer !== undefined && typeof timer === 'object' && 'unref' in timer)
    timer.unref();
  return {
    signal: controller.signal,
    release: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      for (const signal of attached) signal.removeEventListener('abort', abort);
    },
  };
}

function headersFrom(
  raw: Readonly<Record<string, string | readonly string[]>>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers.append(name, value);
    else for (const item of value) headers.append(name, item);
  }
  return headers;
}

interface SessionRequestInit {
  method: string;
  headers: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  origin?: string;
  signal: AbortSignal;
  /** Called once when the request and any body have fully finished. */
  onDone?: () => void;
}

/**
 * One request from the isolated partition: credentials included, redirects
 * reported (never followed), no HTTP cache. A redirect resolves to a bodiless
 * response carrying the status and absolute `Location`; Electron then cancels
 * the request. The body streams, so SSE works over the same call.
 */
function requestInSession(
  ses: Session,
  url: string,
  init: SessionRequestInit,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (init.signal.aborted) {
      init.onDone?.();
      reject(abortError());
      return;
    }
    let settled = false;
    let bodyFinished = false;
    let done = false;
    let failBody: (error: Error) => void = () => undefined;
    const markDone = (): void => {
      if (done) return;
      done = true;
      init.signal.removeEventListener('abort', onAbort);
      init.onDone?.();
    };
    const request = net.request({
      session: ses,
      url,
      method: init.method,
      credentials: 'include',
      redirect: 'manual',
      cache: 'no-store',
      ...(init.origin === undefined ? {} : { origin: init.origin }),
    });
    function onAbort(): void {
      request.abort();
      if (!settled) {
        settled = true;
        markDone();
        reject(abortError());
      } else {
        failBody(abortError());
      }
    }
    init.signal.addEventListener('abort', onAbort, { once: true });

    request.on('redirect', (statusCode, _method, redirectUrl, headers) => {
      if (settled) return;
      settled = true;
      markDone();
      try {
        const responseHeaders = headersFrom(headers);
        responseHeaders.set('location', redirectUrl);
        resolve(
          new Response(null, { status: statusCode, headers: responseHeaders }),
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Invalid redirect'));
      }
      // Not calling followRedirect(): Electron cancels the request when this
      // listener returns and reports "Redirect was cancelled", ignored below.
    });
    request.on('response', (message) => {
      if (settled) return;
      settled = true;
      const finish = (): void => {
        bodyFinished = true;
        markDone();
      };
      let body: ReadableStream<Uint8Array> | null = null;
      if (
        NULL_BODY_STATUSES.has(message.statusCode) ||
        init.method === 'HEAD'
      ) {
        finish();
      } else {
        body = new ReadableStream<Uint8Array>({
          start(controller): void {
            failBody = (error: Error): void => {
              if (bodyFinished) return;
              finish();
              controller.error(error);
            };
            message.on('data', (chunk: Buffer) => {
              if (!bodyFinished) controller.enqueue(new Uint8Array(chunk));
            });
            message.on('end', () => {
              if (bodyFinished) return;
              finish();
              controller.close();
            });
            message.on('error', (error: Error) => failBody(error));
            message.on('aborted', () => failBody(abortError()));
          },
          cancel(): void {
            finish();
            request.abort();
          },
        });
      }
      try {
        resolve(
          new Response(body, {
            status: message.statusCode,
            statusText: message.statusMessage,
            headers: headersFrom(message.headers),
          }),
        );
      } catch (error) {
        finish();
        request.abort();
        reject(error instanceof Error ? error : new Error('Invalid response'));
      }
    });
    request.on('error', (error: Error) => {
      if (!settled) {
        settled = true;
        markDone();
        reject(error);
        return;
      }
      failBody(error);
    });
    try {
      for (const [name, value] of Object.entries(init.headers))
        request.setHeader(name, value);
      if (init.body !== undefined)
        request.write(
          typeof init.body === 'string' ? init.body : Buffer.from(init.body),
        );
      request.end();
    } catch (error) {
      if (!settled) {
        settled = true;
        markDone();
        request.abort();
        reject(error instanceof Error ? error : new Error('Request failed'));
      }
    }
  });
}

let bridgePartitionSession: Session | null = null;

/** The isolated in-memory partition (no `persist:` prefix, no HTTP cache). */
function bridgePartition(): Session {
  if (bridgePartitionSession !== null) return bridgePartitionSession;
  const ses = electronSession.fromPartition(SETTINGS_BRIDGE_PARTITION, {
    cache: false,
  });
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  bridgePartitionSession = ses;
  return ses;
}

/**
 * Every generation shares the one partition, so a new generation consumes
 * its auth link only after earlier teardowns cleared the jar.
 */
let partitionTeardown: Promise<void> = Promise.resolve();

function notePartitionTeardown(teardown: Promise<void>): void {
  partitionTeardown = Promise.all([partitionTeardown, teardown]).then(
    () => undefined,
    () => undefined,
  );
}

function withTimeout(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function mintFailure(error: unknown): SettingsOperationError {
  if (error instanceof SettingsOperationError) return error;
  if (error instanceof CanopyCloudClientError) {
    switch (error.code) {
      case 'cloud-not-configured':
      case 'missing-api-key':
        return settingsError('unauthenticated');
      case 'network-error':
        return settingsError('offline');
      case 'invalid-response':
        return settingsError('invalid_response');
      case 'http-error': {
        const status = error.status;
        // 403: a pending two-factor requirement or a principal that may not
        // hold a browser session. Terminal: never remint to get around it.
        if (status === 403) return settingsError('expired', undefined, 403);
        if (status === 401)
          return settingsError('unauthenticated', undefined, 401);
        if (status === 404)
          return settingsError('unsupported_server', undefined, 404);
        return settingsError('failed', undefined, status);
      }
      default:
        return settingsError('failed');
    }
  }
  return settingsError('failed');
}

/** Captured once per mint; a later stage never uses another account's key. */
export async function settingsBridgeCredentials(
  accountId: string,
): Promise<CanopyCloudCredentialContext> {
  let credentials: Awaited<ReturnType<typeof getCanopyCloudCredentials>>;
  try {
    credentials = await getCanopyCloudCredentials();
  } catch {
    throw settingsError('unauthenticated');
  }
  if (credentials.account === undefined || credentials.account.id !== accountId)
    throw settingsError('unauthenticated', 'Account changed');
  return {
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey,
    account: credentials.account,
    capabilities: credentials.capabilities,
  };
}

/** The account-scoped bootstrap read, exactly as the settings table builds it. */
function accountBootstrapRequest(): { method: string; path: string } {
  return settingsOperationRequest('settings.bootstrap', {});
}

export class SettingsBridgeSession {
  readonly accountId: string;
  /** Increments per credential generation (one session per generation). */
  readonly generation: number;
  /** Normalized cloud base URL the session was created for. */
  readonly baseUrl: string;
  /** The only origin the partition ever sends credentials to. */
  readonly origin: string;

  private currentState: SettingsBridgeState = 'uninitialized';
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(state: SettingsBridgeState) => void>();
  private minting: Promise<void> | null = null;
  /** Bumped per mint; a response from an earlier mint is discarded. */
  private mintEpoch = 0;
  /** One user-initiated remint, granted only by a 401 on a ready session. */
  private remintAvailable = false;
  private lastMintFailure: {
    error: SettingsOperationError;
    at: number;
  } | null = null;
  /** Whether the partition may hold this session's cookies. */
  private cookiesIssued = false;
  private retainedStreams = 0;
  private inFlight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  /** The mint's account-scoped bootstrap body, until one read takes it. */
  private mintBootstrap: { body: string; epoch: number; at: number } | null =
    null;

  constructor(options: {
    accountId: string;
    generation: number;
    baseUrl: string;
  }) {
    this.accountId = options.accountId;
    this.generation = options.generation;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.origin = originOf(this.baseUrl);
  }

  get state(): SettingsBridgeState {
    return this.currentState;
  }

  onStateChange(listener: (state: SettingsBridgeState) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Mint once (single-flight). An expired session remints once, and only for
   * a user-initiated call after a 401; never in a loop.
   */
  ensureReady(options: { userInitiated?: boolean } = {}): Promise<void> {
    if (this.disposed) return Promise.reject(sessionEndedError());
    if (this.minting !== null) return this.minting;
    const userInitiated = options.userInitiated === true;
    if (this.currentState === 'ready') return Promise.resolve();
    if (this.currentState === 'expired') {
      if (!userInitiated || !this.remintAvailable)
        return Promise.reject(sessionEndedError());
      this.remintAvailable = false;
    } else if (
      this.lastMintFailure !== null &&
      !userInitiated &&
      Date.now() - this.lastMintFailure.at < MINT_FAILURE_COOLDOWN_MS
    ) {
      return Promise.reject(
        new SettingsOperationError(this.lastMintFailure.error.toPayload()),
      );
    }
    const minting = this.mint().finally(() => {
      if (this.minting === minting) this.minting = null;
    });
    this.minting = minting;
    return minting;
  }

  /**
   * A same-origin request from the isolated partition. Marks activity. A 401
   * while ready moves the session to `expired`, unless the request says a 401
   * rejects a typed credential. A response that completes
   * after disposal or for an earlier mint is discarded: `expired` for a read,
   * `uncertain` for a mutation, which may have landed.
   */
  async fetch(
    path: string,
    init: SettingsBridgeRequestInit,
  ): Promise<Response> {
    if (this.disposed) throw sessionEndedError();
    const url = this.resolve(path);
    await this.ensureReady();
    if (this.disposed) throw sessionEndedError();
    const epoch = this.mintEpoch;
    const method = init.method.toUpperCase();
    const reused = this.takeMintBootstrap(method, path);
    if (reused !== null) {
      this.touch();
      return reused;
    }
    this.inFlight += 1;
    this.clearIdleTimer();
    try {
      const response = await this.sendRequest(url, {
        method,
        headers: init.headers ?? {},
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.authOrigin === true || !SAFE_METHODS.has(method)
          ? { origin: this.origin }
          : {}),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
      if (this.isStale(epoch)) {
        void response.body?.cancel().catch(() => undefined);
        throw discardedResponseError(method);
      }
      if (
        response.status === 401 &&
        init.rejectedCredentialOn401 !== true &&
        this.currentState === 'ready'
      ) {
        this.remintAvailable = true;
        this.setState('expired');
      }
      return response;
    } catch (error) {
      if (this.isStale(epoch)) throw discardedResponseError(method);
      throw error;
    } finally {
      this.inFlight -= 1;
      this.touch();
    }
  }

  /** Keep the session alive while a stream is open; returns release. */
  retainStream(): () => void {
    if (this.disposed) return () => undefined;
    this.retainedStreams += 1;
    this.clearIdleTimer();
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.retainedStreams -= 1;
      this.touch();
    };
  }

  /**
   * Abort in-flight work, sign this web session out (best effort, bounded),
   * and clear the partition. Idempotent; never rejects.
   */
  dispose(reason: SettingsBridgeDisposeReason): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    this.disposed = true;
    this.mintBootstrap = null;
    this.clearIdleTimer();
    this.lifetime.abort();
    if (currentSession === this) currentSession = null;
    const teardown = this.cookiesIssued
      ? this.signOutAndClear()
      : Promise.resolve();
    this.disposal = teardown;
    notePartitionTeardown(teardown);
    if (reason === 'identity_mismatch')
      logMainProcessWarn('[settings-bridge] Disposed: identity mismatch', {
        generation: this.generation,
      });
    this.setState('disposed');
    this.listeners.clear();
    return teardown;
  }

  private resolve(path: string): string {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.startsWith('/\\')
    )
      throw settingsError('failed', 'Invalid settings request path');
    const url = `${this.baseUrl}${path}`;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      throw settingsError('failed', 'Invalid settings request path');
    }
    if (origin !== this.origin)
      throw settingsError('failed', 'Invalid settings request path');
    return url;
  }

  /**
   * The mint's bootstrap for the first `settings.bootstrap` read after the
   * mint, when that read is account-scoped: the mint read that exact
   * request, so the payload is the same. The first bootstrap read of any
   * scope consumes the entry, so a later read (a forced refresh or Retry)
   * always goes to the network; an organization-scoped read is never
   * answered from it. A write discards it, since the mint-time payload may
   * no longer hold.
   */
  private takeMintBootstrap(method: string, path: string): Response | null {
    if (!SAFE_METHODS.has(method)) this.mintBootstrap = null;
    const entry = this.mintBootstrap;
    const bootstrapPath = accountBootstrapRequest().path;
    if (
      entry === null ||
      method !== 'GET' ||
      path.split('?')[0] !== bootstrapPath
    )
      return null;
    this.mintBootstrap = null;
    if (path !== bootstrapPath) return null;
    if (
      entry.epoch !== this.mintEpoch ||
      Date.now() - entry.at > SETTINGS_BRIDGE_MINT_BOOTSTRAP_TTL_MS
    )
      return null;
    return new Response(entry.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private isStale(epoch: number): boolean {
    return this.disposed || epoch !== this.mintEpoch;
  }

  private setState(next: SettingsBridgeState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(next);
      } catch {
        // A listener failure must not break the session lifecycle.
      }
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Restart the idle clock when nothing is in flight or retained. */
  private touch(): void {
    this.clearIdleTimer();
    if (this.disposed || this.inFlight > 0 || this.retainedStreams > 0) return;
    const timer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight === 0 && this.retainedStreams === 0)
        void this.dispose('idle');
    }, SETTINGS_BRIDGE_IDLE_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.idleTimer = timer;
  }

  private sendRequest(
    url: string,
    init: Omit<SessionRequestInit, 'signal'> & {
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<Response> {
    const { signal, timeoutMs, ...rest } = init;
    const combined = combinedSignal([this.lifetime.signal, signal], timeoutMs);
    return requestInSession(bridgePartition(), url, {
      ...rest,
      signal: combined.signal,
      onDone: combined.release,
    });
  }

  private async mint(): Promise<void> {
    this.mintEpoch += 1;
    const epoch = this.mintEpoch;
    this.mintBootstrap = null;
    this.setState('minting');
    let consumed = false;
    try {
      const credentials = await settingsBridgeCredentials(this.accountId);
      this.assertCurrent(epoch);
      if (normalizeBaseUrl(credentials.baseUrl) !== this.baseUrl) {
        void this.dispose('origin_changed');
        throw sessionEndedError();
      }
      const accountId = credentials.account?.id;
      if (accountId === undefined) throw settingsError('unauthenticated');
      const consumeUrl = await this.requestAuthLink(credentials);
      this.assertCurrent(epoch);
      await partitionTeardown;
      this.assertCurrent(epoch);
      consumed = true;
      this.cookiesIssued = true;
      await this.consumeAuthLink(consumeUrl);
      this.assertCurrent(epoch);
      const bootstrap = await this.readMintBootstrap();
      this.assertCurrent(epoch);
      if (bootstrap.viewerId !== accountId) {
        await this.dispose('identity_mismatch');
        throw settingsError('expired', 'Hosted session identity mismatch');
      }
      this.mintBootstrap = { body: bootstrap.body, epoch, at: Date.now() };
      this.lastMintFailure = null;
      this.setState('ready');
      this.touch();
    } catch (error) {
      if (this.isStale(epoch)) throw sessionEndedError();
      const failure = mintFailure(error);
      logMainProcessWarn('[settings-bridge] Session mint failed', {
        code: failure.code,
        status: failure.status,
      });
      if (consumed) {
        const teardown = this.signOutAndClear();
        notePartitionTeardown(teardown);
        await teardown;
      }
      if (failure.code === 'expired') {
        this.remintAvailable = false;
        this.setState('expired');
      } else {
        this.lastMintFailure = { error: failure, at: Date.now() };
        this.setState('uninitialized');
      }
      this.touch();
      throw failure;
    }
  }

  private assertCurrent(epoch: number): void {
    if (this.isStale(epoch)) throw sessionEndedError();
  }

  private async requestAuthLink(
    credentialContext: CanopyCloudCredentialContext,
  ): Promise<string> {
    const payload = await requestCanopyCloudJson<unknown>(
      `/api/v1/${BRAND.web.apiNamespace}/auth-link`,
      {
        method: 'POST',
        body: JSON.stringify({ redirectPath: AUTH_LINK_REDIRECT_PATH }),
        credentialContext,
        timeoutMs: MINT_STEP_TIMEOUT_MS,
        signal: this.lifetime.signal,
      },
    );
    const parsed = authLinkMintResponseSchema.safeParse(payload);
    if (!parsed.success) throw settingsError('invalid_response');
    return this.trustedConsumeUrl(parsed.data.url);
  }

  /** The consume URL must be the configured origin's consume route. */
  private trustedConsumeUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw settingsError('invalid_response');
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.origin !== this.origin ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== `/api/v1/${BRAND.web.apiNamespace}/auth-link/consume`
    )
      throw settingsError('invalid_response');
    return url.toString();
  }

  /** Accept only a same-origin 303 whose location is not `/login`. */
  private async consumeAuthLink(consumeUrl: string): Promise<void> {
    let response: Response;
    try {
      response = await this.sendRequest(consumeUrl, {
        method: 'GET',
        headers: {},
        timeoutMs: MINT_STEP_TIMEOUT_MS,
      });
    } catch {
      throw settingsError('offline');
    }
    void response.body?.cancel().catch(() => undefined);
    if (response.status !== 303)
      throw settingsError('failed', undefined, response.status);
    const location = response.headers.get('location');
    let target: URL;
    try {
      target = new URL(location ?? '', consumeUrl);
    } catch {
      throw settingsError('invalid_response');
    }
    if (location === null || target.origin !== this.origin)
      throw settingsError('invalid_response');
    if (target.pathname === '/login' || target.pathname.startsWith('/login/'))
      throw settingsError('expired', 'The sign-in link was not accepted');
  }

  /** `settings.bootstrap` through the table; its body and the viewer it names. */
  private async readMintBootstrap(): Promise<{
    viewerId: string;
    body: string;
  }> {
    const request = accountBootstrapRequest();
    let response: Response;
    try {
      response = await this.sendRequest(`${this.baseUrl}${request.path}`, {
        method: request.method,
        headers: { Accept: 'application/json' },
        timeoutMs: MINT_STEP_TIMEOUT_MS,
      });
    } catch {
      throw settingsError('offline');
    }
    if (response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      throw settingsError('unsupported_server', undefined, 404);
    }
    if (response.status === 401) {
      void response.body?.cancel().catch(() => undefined);
      throw settingsError('expired', undefined, 401);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw settingsError('failed', undefined, response.status);
    }
    let body: string;
    let json: unknown;
    try {
      body = await response.text();
      json = JSON.parse(body);
    } catch {
      throw settingsError('invalid_response');
    }
    const parsed = settingsBootstrapSchema.safeParse(json);
    if (!parsed.success) throw settingsError('invalid_response');
    return { viewerId: parsed.data.viewer.id, body };
  }

  /** Best-effort sign-out of this web session, then clear the partition. */
  private async signOutAndClear(): Promise<void> {
    const ses = bridgePartition();
    const controller = new AbortController();
    const signOut = requestInSession(ses, `${this.baseUrl}${SIGN_OUT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      origin: this.origin,
      signal: controller.signal,
    }).then((response) => response.body?.cancel());
    await withTimeout(signOut, SETTINGS_BRIDGE_SIGN_OUT_TIMEOUT_MS);
    controller.abort();
    await withTimeout(ses.clearStorageData(), CLEAR_STORAGE_TIMEOUT_MS);
  }
}

let currentSession: SettingsBridgeSession | null = null;
let generationCounter = 0;

/**
 * The live session for the current account generation, created lazily.
 * Rejects with `unauthenticated` when `accountId` is not the signed-in
 * account. A changed base URL disposes the old session.
 */
export async function acquireSettingsBridgeSession(
  accountId: string,
): Promise<SettingsBridgeSession> {
  const credentials = await settingsBridgeCredentials(accountId);
  const baseUrl = normalizeBaseUrl(credentials.baseUrl);
  const existing = currentSession;
  if (existing !== null) {
    if (existing.accountId !== accountId)
      void existing.dispose('account_changed');
    else if (existing.baseUrl !== baseUrl)
      void existing.dispose('origin_changed');
    else return existing;
  }
  generationCounter += 1;
  const created = new SettingsBridgeSession({
    accountId,
    generation: generationCounter,
    baseUrl,
  });
  currentSession = created;
  return created;
}

/** The live session, if any, without reading credentials or creating one. */
export function peekSettingsBridgeSession(): SettingsBridgeSession | null {
  return currentSession;
}

export async function disposeAllSettingsBridgeSessions(
  reason: SettingsBridgeDisposeReason,
): Promise<void> {
  const existing = currentSession;
  currentSession = null;
  if (existing !== null) await existing.dispose(reason);
}

let lifecycleTeardown: (() => void) | null = null;

/**
 * Dispose when the signed-in identity or its credential changes (sign-in,
 * sign-out, account switch, key rotation or revocation) and on `before-quit`.
 * Same-identity refreshes (status and capability merges) keep the session so
 * open streams survive them. The comparison starts from the account main has
 * already loaded; when none is loaded the previous credential is unknown, so
 * the first event disposes. Base-URL changes have no signal
 * (the URL is a build-time constant); acquisition compares it instead.
 * Idempotent.
 */
export function installSettingsBridgeLifecycle(): () => void {
  if (lifecycleTeardown !== null) return lifecycleTeardown;
  let previous: CanopyCloudAccountEntry | null | undefined =
    peekCanopyCloudAccount() ?? undefined;
  const unsubscribe = subscribeCanopyCloudAccountChanges((entry) => {
    const last = previous;
    previous = entry;
    if (entry === null) {
      void disposeAllSettingsBridgeSessions('revoked');
      return;
    }
    if (
      last === undefined ||
      last === null ||
      last.apiKey !== entry.apiKey ||
      hasCanopyCloudIdentityChanged(last, entry)
    )
      void disposeAllSettingsBridgeSessions('account_changed');
  });
  const onBeforeQuit = (): void => {
    void disposeAllSettingsBridgeSessions('quit');
  };
  app.on('before-quit', onBeforeQuit);
  const teardown = (): void => {
    if (lifecycleTeardown !== teardown) return;
    lifecycleTeardown = null;
    unsubscribe();
    app.removeListener('before-quit', onBeforeQuit);
  };
  lifecycleTeardown = teardown;
  return teardown;
}

/** Test seam: forget module state between cases. */
export function resetSettingsBridgeForTests(): void {
  lifecycleTeardown?.();
  currentSession = null;
  generationCounter = 0;
  bridgePartitionSession = null;
  partitionTeardown = Promise.resolve();
}
