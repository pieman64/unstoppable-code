import type { WorkspaceCreationDiagnostics } from '@canopy/desktop-shared/node/w5-commit-log/reservation-diagnostics';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  W5CommitRequest,
  W5BackupPosition,
  W5Resource,
  W5ReceiptLookup,
  W5ReservationFailureDiagnostics,
} from '@canopy/desktop-shared/node/w5-commit-log';
// The errors module alone: main imports this host at startup, and the commit
// log's index would load node:sqlite there, which only the worker needs.
import {
  W5CommitLogError,
  W5CommitRefusedError,
} from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { getW5CommitLogPath, getWorkspacesRootDir } from '../lib/paths';
import {
  isW5CommitLogResponse,
  isW5CommitLogStartupMessage,
  isW5CommitOutcome,
  isW5RecoveryReport,
  isW5Revision,
  isW5ReceiptLookup,
  isW5BackupPosition,
  type W5CommitLogMethod,
  type W5CommitLogRequest,
  type W5CommitLogWorkerData,
  type W5CommitLogWorkerError,
  type W5CommitOutcome,
  type W5HostRecoveryReport,
} from './commit-log-worker-contract';

const WORKER_FILENAME = 'w5-commit-log-worker.js';
const WORKER_NAME = 'w5-commit-log';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_QUEUED_CALLS = 256;
// A worker blocked in a native SQLite call stops only once that call returns.
const WORKER_EXIT_WAIT_MS = 2_000;

export interface W5CommitLogHostOptions {
  /** The commit log the worker opens. The host itself never touches it. */
  dbPath: string;
  /** The W5 data root; every file a commit writes must be inside it. */
  root: string;
  /** Worker entry; defaults to the bundle emitted beside the main bundle. */
  workerEntry?: string;
  /** Bounds the wait for the worker to open the log and recover it. */
  startupTimeoutMs?: number;
  /** Bounds each request, from send to response. */
  requestTimeoutMs?: number;
  /** Bounds the wait for the in-flight request during shutdown. */
  shutdownTimeoutMs?: number;
  /** Calls allowed to wait for their turn before new calls are refused. */
  maxQueuedCalls?: number;
}

/**
 * Why a call failed outside the commit log itself.
 *
 * - `unavailable`: the call never reached the worker (the host is shutting
 *   down or busy, or the worker could not start), so it changed nothing.
 * - `outcome-unknown`: the call reached the worker, which stopped, did not
 *   answer in time, or failed unexpectedly. A commit may have been made; the
 *   next worker's launch recovery finishes writing it.
 * - `malformed`: the worker rejected the request before running it.
 */
export type W5CommitLogHostFailure =
  | 'unavailable'
  | 'outcome-unknown'
  | 'malformed';

export class W5CommitLogHostError extends Error {
  constructor(
    readonly reason: W5CommitLogHostFailure,
    message: string,
  ) {
    super(message);
    this.name = 'W5CommitLogHostError';
  }
}

/** A failed call: the commit log's own error, or the host's. */
type W5CommitLogCallError =
  | W5CommitLogError
  | W5CommitRefusedError
  | W5CommitLogHostError;

function toCallError(error: W5CommitLogWorkerError): W5CommitLogCallError {
  switch (error.kind) {
    case 'log':
      return new W5CommitLogError(error.code, error.message);
    case 'refused':
      return new W5CommitRefusedError(
        error.reason,
        error.message,
        error.details,
      );
    case 'malformed':
      return new W5CommitLogHostError('malformed', error.message);
    case 'failed':
      return new W5CommitLogHostError('outcome-unknown', error.message);
  }
}

function unavailable(message: string): W5CommitLogHostError {
  return new W5CommitLogHostError('unavailable', message);
}

function outcomeUnknown(message: string): W5CommitLogHostError {
  return new W5CommitLogHostError('outcome-unknown', message);
}

/** A result of the wrong shape: the call ran, but what it did is unknown. */
function unexpectedResult(): W5CommitLogHostError {
  return outcomeUnknown('The W5 commit log sent an unexpected result');
}

function positiveOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

async function waitAtMost(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PendingCall {
  readonly request: W5CommitLogRequest;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: W5CommitLogCallError) => void;
}

interface WorkerSession {
  readonly worker: Worker;
  ready: boolean;
  active: PendingCall | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly idleWaiters: Array<() => void>;
}

/**
 * Owns the lazily started worker thread that holds the W5 commit log's only
 * connection, so synchronous SQLite stays off the main event loop (CAN-3805).
 * Nothing starts until the first call; the worker then opens the log and runs
 * launch recovery before it answers. There is no fallback to the main thread:
 * when the worker is unavailable, calls fail with a typed error, and the next
 * call starts a fresh worker, whose recovery finishes any commit the previous
 * one made but did not write.
 */
export class W5CommitLogHost {
  private readonly workerData: W5CommitLogWorkerData;
  private readonly workerEntry: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxQueuedCalls: number;
  private readonly queue: PendingCall[] = [];
  /** Settles when a started worker exits; removed once it has. */
  private readonly runningWorkers = new Set<Promise<void>>();
  private session: WorkerSession | undefined;
  private launching = false;
  private closing = false;
  private shutdownPromise: Promise<void> | undefined;
  private nextRequestId = 0;
  private started = 0;

  constructor(options: W5CommitLogHostOptions) {
    this.workerData = { dbPath: options.dbPath, root: options.root };
    this.workerEntry = options.workerEntry ?? join(__dirname, WORKER_FILENAME);
    this.startupTimeoutMs = positiveOption(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      'startupTimeoutMs',
    );
    this.requestTimeoutMs = positiveOption(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.shutdownTimeoutMs = positiveOption(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    );
    this.maxQueuedCalls = positiveOption(
      options.maxQueuedCalls,
      DEFAULT_MAX_QUEUED_CALLS,
      'maxQueuedCalls',
    );
  }

  /**
   * Workers that have not exited yet. Shutdown waits only a bounded time for
   * them, so a caller that needs the data root quiet must check this after it.
   */
  get runningWorkerCount(): number {
    return this.runningWorkers.size;
  }

  /** How many workers this host has started. */
  get workersStarted(): number {
    return this.started;
  }

  /** What launch recovery found when the running worker opened the log. */
  async recoveryReport(): Promise<W5HostRecoveryReport> {
    const result = await this.call('recoveryReport', []);
    if (!isW5RecoveryReport(result)) throw unexpectedResult();
    return result;
  }

  /** Commits a change and writes its files before resolving. */
  async commit(request: W5CommitRequest): Promise<W5CommitOutcome> {
    const result = await this.call('commit', [request]);
    if (!isW5CommitOutcome(result)) throw unexpectedResult();
    return result;
  }

  async lookupReceipt(
    receipt: NonNullable<W5CommitRequest['receipt']>,
  ): Promise<W5ReceiptLookup> {
    const result = await this.call('lookupReceipt', [receipt]);
    if (!isW5ReceiptLookup(result)) throw unexpectedResult();
    return result;
  }

  async reserve(input: {
    reservationId: string;
    operation: string;
    receipt?: NonNullable<W5CommitRequest['receipt']>;
    diagnostics?: unknown;
  }): Promise<void> {
    const result = await this.call('reserve', [input]);
    if (result !== null) throw unexpectedResult();
  }

  async updateReservationDiagnostics(
    reservationId: string,
    diagnostics: WorkspaceCreationDiagnostics,
  ): Promise<void> {
    const result = await this.call('updateReservationDiagnostics', [
      reservationId,
      diagnostics,
    ]);
    if (result !== null) throw unexpectedResult();
  }

  async releaseReservation(reservationId: string): Promise<void> {
    const result = await this.call('releaseReservation', [reservationId]);
    if (result !== null) throw unexpectedResult();
  }

  async markReservationRecoveryRequired(
    reservationId: string,
    diagnostics: W5ReservationFailureDiagnostics,
  ): Promise<void> {
    const result = await this.call('markReservationRecoveryRequired', [
      reservationId,
      diagnostics,
    ]);
    if (result !== null) throw unexpectedResult();
  }

  async revision(resource: W5Resource): Promise<number> {
    const result = await this.call('revision', [resource]);
    if (!isW5Revision(result)) throw unexpectedResult();
    return result;
  }

  /** Exact position and tombstone revisions for namespace backup verification. */
  async snapshot(): Promise<W5BackupPosition> {
    const result = await this.call('snapshot', []);
    if (!isW5BackupPosition(result)) throw unexpectedResult();
    return { ...result, revisions: { ...result.revisions } };
  }

  /**
   * Refuses new calls and rejects the ones still waiting for their turn, lets
   * the in-flight call finish within the shutdown bound, then stops the worker
   * so the commit log's lock is released. Repeated calls share one shutdown.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.closing = true;
      this.shutdownPromise = this.stop();
    }
    return this.shutdownPromise;
  }

  private call(
    method: W5CommitLogMethod,
    args: readonly unknown[],
  ): Promise<unknown> {
    if (this.closing) {
      return Promise.reject(unavailable('The W5 commit log is shut down'));
    }
    if (this.queue.length >= this.maxQueuedCalls) {
      return Promise.reject(unavailable('The W5 commit log is busy'));
    }
    this.nextRequestId += 1;
    const request: W5CommitLogRequest = {
      id: this.nextRequestId,
      method,
      args,
    };
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.pump();
    });
  }

  private async stop(): Promise<void> {
    this.rejectQueued(unavailable('The W5 commit log is shutting down'));
    const session = this.session;
    if (session) {
      if (session.active) {
        await waitAtMost(this.whenIdle(session), this.shutdownTimeoutMs);
      }
      this.fail(
        session,
        outcomeUnknown('The W5 commit log shut down before it answered'),
      );
    }
    await this.waitForWorkerExits();
  }

  private pump(): void {
    while (!this.closing && this.queue.length > 0) {
      const session = this.session;
      if (!session) {
        if (!this.launching) void this.launch();
        return;
      }
      if (!session.ready || session.active) return;
      const call = this.queue.shift();
      if (!call || this.send(session, call)) return;
    }
  }

  private async launch(): Promise<void> {
    this.launching = true;
    try {
      // Never run two workers at once: a stopping worker can still hold the
      // exclusive lock the new one needs.
      if (this.runningWorkers.size > 0) await this.waitForWorkerExits();
    } finally {
      this.launching = false;
    }
    if (this.closing || this.session || this.queue.length === 0) return;
    if (this.runningWorkers.size > 0) {
      // A stopped worker blocked in a native call may still hold the log's
      // lock, and every replacement would then pile up behind it. Refuse
      // until it has exited; the next call starts a worker then.
      this.rejectQueued(
        unavailable('The previous W5 commit log worker has not stopped yet'),
      );
      return;
    }
    this.start();
    this.pump();
  }

  private start(): void {
    let worker: Worker;
    this.started += 1;
    try {
      worker = new Worker(this.workerEntry, {
        workerData: this.workerData,
        name: WORKER_NAME,
      });
    } catch {
      this.rejectQueued(unavailable('The W5 commit log could not start'));
      return;
    }
    worker.unref();
    const session: WorkerSession = {
      worker,
      ready: false,
      active: undefined,
      timer: undefined,
      idleWaiters: [],
    };
    this.session = session;
    let markExited = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    this.runningWorkers.add(exited);
    worker.on('message', (message: unknown): void =>
      this.receive(session, message),
    );
    worker.on('messageerror', (): void =>
      this.fail(
        session,
        outcomeUnknown('The W5 commit log sent an unreadable message'),
      ),
    );
    // The worker's own error text is dropped: it could quote a file path.
    worker.on('error', (): void =>
      this.fail(session, outcomeUnknown('The W5 commit log stopped')),
    );
    worker.on('exit', (): void => {
      this.runningWorkers.delete(exited);
      markExited();
      this.fail(session, outcomeUnknown('The W5 commit log stopped'));
    });
    this.arm(session, this.startupTimeoutMs, 'The W5 commit log did not start');
  }

  private send(session: WorkerSession, call: PendingCall): boolean {
    session.active = call;
    this.arm(
      session,
      this.requestTimeoutMs,
      'The W5 commit log did not answer',
    );
    try {
      session.worker.postMessage(call.request);
      return true;
    } catch {
      // A request that cannot be cloned never reaches the worker, so it
      // changed nothing and the worker stays usable for the calls behind it.
      this.clearTimer(session);
      session.active = undefined;
      call.reject(
        new W5CommitLogHostError(
          'malformed',
          'The W5 commit log request could not be sent',
        ),
      );
      this.notifyIdle(session);
      return false;
    }
  }

  private receive(session: WorkerSession, message: unknown): void {
    if (this.session !== session) return;
    if (!session.ready) {
      this.receiveStartup(session, message);
      return;
    }
    const call = session.active;
    if (
      !call ||
      !isW5CommitLogResponse(message) ||
      message.id !== call.request.id
    ) {
      this.fail(
        session,
        outcomeUnknown('The W5 commit log sent an unexpected message'),
      );
      return;
    }
    if (!message.ok && message.error.kind === 'failed') {
      // The call may have committed without writing its files. Retire this
      // worker, so the next one recovers before it answers anything.
      this.fail(session, toCallError(message.error));
      return;
    }
    session.active = undefined;
    this.clearTimer(session);
    if (message.ok) {
      call.resolve(message.result);
    } else {
      call.reject(toCallError(message.error));
    }
    this.notifyIdle(session);
    this.pump();
  }

  private receiveStartup(session: WorkerSession, message: unknown): void {
    if (!isW5CommitLogStartupMessage(message)) {
      this.fail(
        session,
        outcomeUnknown('The W5 commit log sent an unexpected message'),
      );
      return;
    }
    if (message.type === 'openFailed') {
      // Keep the worker's reason: a log held by another process and one that
      // cannot be opened call for different handling. No call was sent, and
      // the next call tries to open the log again.
      const error = toCallError(message.error);
      this.fail(
        session,
        error,
        error instanceof W5CommitLogHostError
          ? unavailable(error.message)
          : error,
      );
      return;
    }
    session.ready = true;
    this.clearTimer(session);
    this.pump();
  }

  /**
   * Retires the session: rejects its in-flight call with `sentError` and every
   * waiting call with `queuedError` (by default `unavailable`, since they were
   * never sent), then terminates the worker, which releases the log's lock.
   * Events from a retired worker are ignored.
   */
  private fail(
    session: WorkerSession,
    sentError: W5CommitLogCallError,
    queuedError: W5CommitLogCallError = unavailable(sentError.message),
  ): void {
    if (this.session !== session) return;
    this.session = undefined;
    this.clearTimer(session);
    const active = session.active;
    session.active = undefined;
    active?.reject(sentError);
    this.rejectQueued(queuedError);
    this.notifyIdle(session);
    void session.worker.terminate().catch((): undefined => undefined);
  }

  private arm(
    session: WorkerSession,
    timeoutMs: number,
    message: string,
  ): void {
    this.clearTimer(session);
    session.timer = setTimeout(
      (): void => this.fail(session, outcomeUnknown(message)),
      timeoutMs,
    );
    session.timer.unref();
  }

  private clearTimer(session: WorkerSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
  }

  private rejectQueued(error: W5CommitLogCallError): void {
    for (const call of this.queue.splice(0)) call.reject(error);
  }

  private whenIdle(session: WorkerSession): Promise<void> {
    if (!session.active) return Promise.resolve();
    return new Promise<void>((resolve) => {
      session.idleWaiters.push(resolve);
    });
  }

  private notifyIdle(session: WorkerSession): void {
    for (const resolve of session.idleWaiters.splice(0)) resolve();
  }

  private waitForWorkerExits(): Promise<void> {
    return waitAtMost(Promise.all(this.runningWorkers), WORKER_EXIT_WAIT_MS);
  }
}

let defaultHost: W5CommitLogHost | undefined;
let defaultHostShutDown = false;

/**
 * The app's W5 commit log host. Getting it starts nothing: the worker starts,
 * creates the log and recovers it on the first call.
 */
export function getW5CommitLogHost(): W5CommitLogHost {
  if (defaultHost === undefined) {
    defaultHost = new W5CommitLogHost({
      dbPath: getW5CommitLogPath(),
      root: getWorkspacesRootDir(),
    });
    // A host first requested after quit refuses calls instead of starting a
    // worker.
    if (defaultHostShutDown) void defaultHost.shutdown();
  }
  return defaultHost;
}

/**
 * Stops the app's W5 commit log worker at quit, once every W5 writer has
 * drained, and releases the log's lock. Quitting before the log was used
 * touches nothing. Later calls fail instead of starting another worker.
 */
export function shutdownW5CommitLogHost(): Promise<void> {
  defaultHostShutDown = true;
  return defaultHost === undefined ? Promise.resolve() : defaultHost.shutdown();
}
