import type { CodeGraphRepositoryInput } from '../types/code-graph';
import type { CodeGraphBuildHostProcess } from './build-scheduler';
import type {
  CodeGraphFingerprintWorkerRequest,
  CodeGraphFingerprintWorkerResponse,
} from './fingerprint-host';

/*
 * The fingerprint host queue: one worktree fingerprint at a time, single
 * flight per key, a watchdog at the generation timeout, and awaitable cancel
 * and shutdown. Hosts inject how a fingerprint host launches and how its
 * process priority is set; Electron main and the core daemon each compose
 * one scheduler.
 */

export type CodeGraphFingerprintWorkerErrorReason =
  | 'timeout'
  | 'canceled'
  | 'worker-exit'
  | 'spawn-failed'
  | 'post-failed'
  | 'malformed-response';

export class CodeGraphFingerprintWorkerError extends Error {
  public constructor(
    public readonly reason: CodeGraphFingerprintWorkerErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'CodeGraphFingerprintWorkerError';
  }
}

export interface CodeGraphFingerprintOptions {
  /** Defaults to true. Pass false when an agent or user waits on the digest. */
  background?: boolean;
}

export interface CodeGraphFingerprintSchedulerHost {
  /** The Git executable the next fingerprint host runs. */
  resolveGitExecutable(): Promise<string>;
  /** Launches one fingerprint host with its entry, budget and Git; throws when it can't. */
  launchFingerprintHost(gitExecutable: string): CodeGraphBuildHostProcess;
  /** Lowers a spawned host's priority, entering the OS background policy when asked. */
  applyProcessPriority(pid: number, options: { background: boolean }): void;
  /** Takes a running host out of the OS background policy once a caller waits on it. */
  leaveBackgroundPolicy(pid: number): void;
  /** The watchdog, read as each fingerprint starts. */
  timeoutMs(): number;
}

export interface CodeGraphFingerprintScheduler {
  /** Fingerprints the repositories; equivalent calls for one key share one host. */
  run(
    key: string,
    repositories: readonly CodeGraphRepositoryInput[],
    options?: CodeGraphFingerprintOptions,
  ): Promise<CodeGraphFingerprintWorkerResponse>;
  /**
   * Cancels the key's fingerprint, stops any host of the key that answered
   * but has not exited yet, and resolves once each of them has exited.
   */
  cancel(key: string): Promise<void>;
  /** Cancels every fingerprint, refuses new ones and waits for every host to exit. */
  shutdown(): Promise<void>;
  /** Test seam: forgets every record and accepts work again. */
  reset(): void;
}

interface FingerprintRecord {
  key: string;
  request: CodeGraphFingerprintWorkerRequest;
  promise: Promise<CodeGraphFingerprintWorkerResponse>;
  resolve: (response: CodeGraphFingerprintWorkerResponse) => void;
  reject: (error: CodeGraphFingerprintWorkerError) => void;
  child: CodeGraphBuildHostProcess | null;
  watchdog: NodeJS.Timeout | null;
  settled: boolean;
  /** Scheduler fingerprints have no waiting caller; see `startRecord`. */
  background: boolean;
  /** The background policy was applied to the spawned worker. */
  backgroundApplied: boolean;
}

const CONCURRENCY_CAP = 1;
const EXIT_WAIT_FALLBACK_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerResponse(
  value: unknown,
): value is CodeGraphFingerprintWorkerResponse {
  return (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    (value.ok
      ? typeof value.fingerprint === 'string'
      : typeof value.message === 'string')
  );
}

export function createCodeGraphFingerprintScheduler(
  host: CodeGraphFingerprintSchedulerHost,
): CodeGraphFingerprintScheduler {
  const records = new Map<string, FingerprintRecord>();
  const queue: FingerprintRecord[] = [];
  const active = new Set<FingerprintRecord>();
  /** Every launched host until its exit, with the key it fingerprinted. */
  const liveChildren = new Map<CodeGraphBuildHostProcess, string>();
  const pendingExitWaits = new Map<string, Promise<void>>();
  let shuttingDown = false;

  function finalize(record: FingerprintRecord): void {
    if (record.watchdog !== null) {
      clearTimeout(record.watchdog);
      record.watchdog = null;
    }
    records.delete(record.key);
    active.delete(record);
    const queuedIndex = queue.indexOf(record);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    pumpQueue();
  }

  function resolveRecord(
    record: FingerprintRecord,
    response: CodeGraphFingerprintWorkerResponse,
  ): void {
    if (record.settled) return;
    record.settled = true;
    finalize(record);
    record.resolve(response);
  }

  function rejectRecord(
    record: FingerprintRecord,
    error: CodeGraphFingerprintWorkerError,
  ): void {
    if (record.settled) return;
    record.settled = true;
    if (record.child !== null && liveChildren.has(record.child)) {
      void registerExitWait(record.key, record.child);
    }
    try {
      record.child?.kill();
    } catch {
      // The worker may already have exited.
    }
    finalize(record);
    record.reject(error);
  }

  async function startRecord(record: FingerprintRecord): Promise<void> {
    active.add(record);
    let child: CodeGraphBuildHostProcess;
    try {
      const gitExecutable = await host.resolveGitExecutable();
      if (record.settled) return;
      child = host.launchFingerprintHost(gitExecutable);
    } catch (error) {
      rejectRecord(
        record,
        new CodeGraphFingerprintWorkerError(
          'spawn-failed',
          `Failed to spawn code-graph fingerprint worker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    record.child = child;
    liveChildren.set(child, record.key);
    // Hashing dirty files and running Git is disk-heavy. The pid only exists
    // once the host emits `spawn`.
    child.once('spawn', () => {
      // Settled before launch: the kill then reached nothing, so land it now.
      if (record.settled) {
        try {
          child.kill();
        } catch {
          // The worker may already have exited.
        }
        return;
      }
      if (typeof child.pid === 'number') {
        host.applyProcessPriority(child.pid, {
          background: record.background,
        });
        record.backgroundApplied = record.background;
      }
    });

    const timeoutMs = host.timeoutMs();
    record.watchdog = setTimeout(() => {
      rejectRecord(
        record,
        new CodeGraphFingerprintWorkerError(
          'timeout',
          `Code-graph fingerprint for "${record.key}" exceeded ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);
    record.watchdog.unref?.();

    child.on('message', (message: unknown) => {
      const payload =
        isRecord(message) && 'data' in message ? message.data : message;
      if (!isWorkerResponse(payload)) {
        rejectRecord(
          record,
          new CodeGraphFingerprintWorkerError(
            'malformed-response',
            'Code-graph fingerprint worker returned a malformed response.',
          ),
        );
        return;
      }
      resolveRecord(record, payload);
    });
    child.on('exit', (code: number) => {
      liveChildren.delete(child);
      if (!record.settled) {
        rejectRecord(
          record,
          new CodeGraphFingerprintWorkerError(
            'worker-exit',
            `Code-graph fingerprint worker exited (code ${code}) before responding.`,
          ),
        );
      }
    });

    try {
      child.postMessage(record.request);
    } catch (error) {
      rejectRecord(
        record,
        new CodeGraphFingerprintWorkerError(
          'post-failed',
          `Failed to post code-graph fingerprint request: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  function pumpQueue(): void {
    if (shuttingDown) return;
    while (active.size < CONCURRENCY_CAP) {
      const next = queue.shift();
      if (next === undefined) return;
      void startRecord(next);
    }
  }

  function waitForChildExit(child: CodeGraphBuildHostProcess): Promise<void> {
    if (!liveChildren.has(child)) return Promise.resolve();
    return new Promise((resolve) => {
      const fallback = setTimeout(resolve, EXIT_WAIT_FALLBACK_MS);
      fallback.unref?.();
      child.once('exit', () => {
        clearTimeout(fallback);
        resolve();
      });
    });
  }

  function registerExitWait(
    key: string,
    child: CodeGraphBuildHostProcess,
  ): Promise<void> {
    const previous = pendingExitWaits.get(key);
    const current = waitForChildExit(child);
    const combined =
      previous === undefined
        ? current
        : Promise.all([previous, current]).then(() => undefined);
    const tracked = combined.then(() => {
      if (pendingExitWaits.get(key) === tracked) {
        pendingExitWaits.delete(key);
      }
    });
    pendingExitWaits.set(key, tracked);
    return tracked;
  }

  return {
    run(key, repositories, options = {}) {
      if (shuttingDown) {
        return Promise.reject(
          new CodeGraphFingerprintWorkerError(
            'canceled',
            'Code-graph fingerprints are shutting down.',
          ),
        );
      }
      const existing = records.get(key);
      if (existing !== undefined) {
        // A caller now waits on this digest: run it outside the background band.
        if (options.background === false) {
          existing.background = false;
          if (
            existing.backgroundApplied &&
            typeof existing.child?.pid === 'number'
          ) {
            existing.backgroundApplied = false;
            host.leaveBackgroundPolicy(existing.child.pid);
          }
        }
        return existing.promise;
      }

      let resolveRecordPromise: (
        response: CodeGraphFingerprintWorkerResponse,
      ) => void = () => {};
      let rejectRecordPromise: (
        error: CodeGraphFingerprintWorkerError,
      ) => void = () => {};
      const promise = new Promise<CodeGraphFingerprintWorkerResponse>(
        (resolve, reject) => {
          resolveRecordPromise = resolve;
          rejectRecordPromise = reject;
        },
      );
      const record: FingerprintRecord = {
        key,
        request: { repositories },
        promise,
        resolve: resolveRecordPromise,
        reject: rejectRecordPromise,
        child: null,
        watchdog: null,
        settled: false,
        background: options.background !== false,
        backgroundApplied: false,
      };
      records.set(key, record);
      queue.push(record);
      pumpQueue();
      return promise;
    },

    async cancel(key) {
      const record = records.get(key);
      if (record !== undefined) {
        rejectRecord(
          record,
          new CodeGraphFingerprintWorkerError(
            'canceled',
            `Code-graph fingerprint for "${key}" was canceled.`,
          ),
        );
      }
      // A host answers before it exits, so one may still be exiting.
      for (const [child, childKey] of liveChildren) {
        if (childKey !== key || child === record?.child) continue;
        void registerExitWait(key, child);
        try {
          child.kill();
        } catch {
          // The worker may already have exited.
        }
      }
      await (pendingExitWaits.get(key) ?? Promise.resolve());
    },

    async shutdown() {
      shuttingDown = true;
      const pending = Array.from(records.values());
      const children = Array.from(liveChildren.keys());
      const childExitWaits = children.map(waitForChildExit);
      for (const record of pending) {
        rejectRecord(
          record,
          new CodeGraphFingerprintWorkerError(
            'canceled',
            'Code-graph fingerprint canceled during shutdown.',
          ),
        );
      }
      for (const child of children) {
        try {
          child.kill();
        } catch {
          // The worker may already have exited.
        }
      }
      await Promise.all([
        ...childExitWaits,
        ...Array.from(pendingExitWaits.values()),
      ]);
    },

    reset() {
      records.clear();
      queue.length = 0;
      active.clear();
      liveChildren.clear();
      pendingExitWaits.clear();
      shuttingDown = false;
    },
  };
}
