import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CanopyJsonValue } from '@canopy/protocol/canopy-core';
import { getLedgerDatabasePath } from '../lib/paths';
import {
  isLedgerStorageResponse,
  isLedgerStorageStartupMessage,
  type LedgerStorageErrorReason,
  type LedgerStorageRequest,
  type LedgerStorageWorkerData,
} from './storage-worker-contract';

const WORKER_FILENAME = 'ledger-storage-worker.js';
const WORKER_NAME = 'ledger-storage';

/** Storage workers started in this process, for diagnostics and E2E checks. */
let workersStarted = 0;

/**
 * How many Ledger storage workers this process has started. With the Ledger
 * off or unused, it stays zero: nothing starts before the first call.
 */
export function ledgerStorageWorkersStarted(): number {
  return workersStarted;
}
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_QUEUED_CALLS = 256;
// A worker blocked in a native SQLite call stops only once that call returns.
const WORKER_EXIT_WAIT_MS = 2_000;

export interface LedgerStorageHostOptions {
  /** The database the worker opens. The host itself never touches it. */
  dbPath: string;
  /** Worker entry; defaults to the bundle emitted beside the main bundle. */
  workerEntry?: string;
  /** Bounds the wait for the worker to open the database. */
  startupTimeoutMs?: number;
  /** Bounds each request, from send to response. */
  requestTimeoutMs?: number;
  /** Bounds the wait for the in-flight request during shutdown. */
  shutdownTimeoutMs?: number;
  /** Calls allowed to wait for their turn before new calls are refused. */
  maxQueuedCalls?: number;
}

/**
 * A rejected Ledger storage call. When the worker could not open the
 * database, `reason` is the one it reported: `WRITER_UNAVAILABLE` while another
 * connection holds the database, `STORAGE_UNAVAILABLE` when the file cannot be
 * opened or is damaged. It is `STORAGE_UNAVAILABLE` when the worker stopped,
 * timed out or broke the protocol, the queue is full, or the host is shutting
 * down; `INTERNAL` when the request could not be sent (no method, or arguments
 * that cannot be cloned); otherwise the reason the worker reported for the
 * request.
 */
export class LedgerStorageHostError extends Error {
  readonly reason: LedgerStorageErrorReason;
  readonly details: CanopyJsonValue | undefined;

  constructor(
    reason: LedgerStorageErrorReason,
    message: string,
    details?: CanopyJsonValue,
  ) {
    super(message);
    this.name = 'LedgerStorageHostError';
    this.reason = reason;
    this.details = details;
  }
}

interface PendingCall {
  readonly request: LedgerStorageRequest;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: LedgerStorageHostError) => void;
}

interface WorkerSession {
  readonly worker: Worker;
  ready: boolean;
  active: PendingCall | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly idleWaiters: Array<() => void>;
}

function storageUnavailable(
  message: string,
  details?: CanopyJsonValue,
): LedgerStorageHostError {
  return new LedgerStorageHostError('STORAGE_UNAVAILABLE', message, details);
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

/**
 * Owns the lazily started worker thread that holds the Ledger database's only
 * connection, so synchronous SQLite stays off the main event loop. Nothing
 * starts until the first call, and there is no fallback to the main thread:
 * when the worker is unavailable, calls fail with a typed error, and the next
 * call starts a fresh worker.
 */
export class LedgerStorageHost {
  private readonly dbPath: string;
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

  constructor(options: LedgerStorageHostOptions) {
    this.dbPath = options.dbPath;
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
   * Runs one storage method in the worker, starting the worker first if it is
   * not running. Calls are sent one at a time, in the order they were made.
   */
  call(method: string, args: unknown): Promise<unknown> {
    if (method.length === 0) {
      return Promise.reject(
        new LedgerStorageHostError(
          'INTERNAL',
          'A Ledger storage method is required',
        ),
      );
    }
    if (this.closing) {
      return Promise.reject(storageUnavailable('Ledger storage is shut down'));
    }
    if (this.queue.length >= this.maxQueuedCalls) {
      return Promise.reject(storageUnavailable('Ledger storage is busy'));
    }
    this.nextRequestId += 1;
    const request: LedgerStorageRequest = {
      id: this.nextRequestId,
      method,
      args,
    };
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.pump();
    });
  }

  /**
   * Refuses new calls and rejects the ones still waiting for their turn, lets
   * the in-flight call finish within the shutdown bound, then stops the worker
   * so the database lock is released. Repeated calls share one shutdown.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.closing = true;
      this.shutdownPromise = this.stop();
    }
    return this.shutdownPromise;
  }

  private async stop(): Promise<void> {
    const error = storageUnavailable('Ledger storage is shutting down');
    this.rejectQueued(error);
    const session = this.session;
    if (session) {
      if (session.active) {
        await waitAtMost(this.whenIdle(session), this.shutdownTimeoutMs);
      }
      this.fail(session, error);
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
      // Never run two storage workers at once: a stopping worker can still
      // hold the database lock the new one needs.
      if (this.runningWorkers.size > 0) await this.waitForWorkerExits();
    } finally {
      this.launching = false;
    }
    if (this.closing || this.session || this.queue.length === 0) return;
    this.start();
    this.pump();
  }

  private start(): void {
    const workerData: LedgerStorageWorkerData = { dbPath: this.dbPath };
    let worker: Worker;
    workersStarted += 1;
    try {
      worker = new Worker(this.workerEntry, { workerData, name: WORKER_NAME });
    } catch {
      this.rejectQueued(storageUnavailable('Ledger storage could not start'));
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
        storageUnavailable('Ledger storage sent an unreadable message'),
      ),
    );
    // The worker's own error text is dropped: it could quote stored content.
    worker.on('error', (): void =>
      this.fail(session, storageUnavailable('Ledger storage stopped')),
    );
    worker.on('exit', (exitCode: number): void => {
      this.runningWorkers.delete(exited);
      markExited();
      this.fail(
        session,
        storageUnavailable('Ledger storage stopped', { exitCode }),
      );
    });
    this.arm(session, this.startupTimeoutMs, 'Ledger storage did not start');
  }

  private send(session: WorkerSession, call: PendingCall): boolean {
    session.active = call;
    this.arm(session, this.requestTimeoutMs, 'Ledger storage did not answer');
    try {
      session.worker.postMessage(call.request);
      return true;
    } catch {
      // Arguments that cannot be cloned never reach the worker, so it stays
      // usable for the calls behind this one.
      this.clearTimer(session);
      session.active = undefined;
      call.reject(
        new LedgerStorageHostError(
          'INTERNAL',
          'The Ledger storage request could not be sent',
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
      !isLedgerStorageResponse(message) ||
      message.id !== call.request.id
    ) {
      this.fail(
        session,
        storageUnavailable('Ledger storage sent an unexpected message'),
      );
      return;
    }
    session.active = undefined;
    this.clearTimer(session);
    if (message.ok) {
      call.resolve(message.result);
    } else {
      call.reject(
        new LedgerStorageHostError(
          message.error.reason,
          message.error.message,
          message.error.details,
        ),
      );
    }
    this.notifyIdle(session);
    this.pump();
  }

  private receiveStartup(session: WorkerSession, message: unknown): void {
    if (!isLedgerStorageStartupMessage(message)) {
      this.fail(
        session,
        storageUnavailable('Ledger storage sent an unexpected message'),
      );
      return;
    }
    if (message.type === 'openFailed') {
      // Keep the worker's reason: lock contention and a database that cannot
      // be opened call for different retries. The next call tries to open the
      // database again.
      this.fail(
        session,
        new LedgerStorageHostError(
          message.error.reason,
          message.error.message,
          message.error.details,
        ),
      );
      return;
    }
    session.ready = true;
    this.clearTimer(session);
    this.pump();
  }

  /**
   * Retires the session: rejects its in-flight call and every waiting call,
   * then terminates the worker, which releases the database lock. Events from
   * a retired worker are ignored.
   */
  private fail(session: WorkerSession, error: LedgerStorageHostError): void {
    if (this.session !== session) return;
    this.session = undefined;
    this.clearTimer(session);
    const active = session.active;
    session.active = undefined;
    active?.reject(error);
    this.rejectQueued(error);
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
      (): void => this.fail(session, storageUnavailable(message)),
      timeoutMs,
    );
    session.timer.unref();
  }

  private clearTimer(session: WorkerSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
  }

  private rejectQueued(error: LedgerStorageHostError): void {
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

let defaultHost: LedgerStorageHost | undefined;
let defaultHostShutDown = false;

/**
 * The app's Ledger storage host. Getting it starts nothing: the worker starts,
 * and creates the database, on the first Ledger call.
 */
export function getLedgerStorageHost(): LedgerStorageHost {
  if (defaultHost === undefined) {
    defaultHost = new LedgerStorageHost({ dbPath: getLedgerDatabasePath() });
    // A host first requested after quit refuses calls instead of starting a
    // worker.
    if (defaultHostShutDown) void defaultHost.shutdown();
  }
  return defaultHost;
}

/**
 * Stops the app's Ledger storage worker at quit and releases the database
 * lock. Quitting before the Ledger was used touches nothing. Later calls fail
 * instead of starting another worker.
 */
export function shutdownLedgerStorageHost(): Promise<void> {
  defaultHostShutDown = true;
  return defaultHost === undefined ? Promise.resolve() : defaultHost.shutdown();
}
