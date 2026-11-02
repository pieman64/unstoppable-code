import { totalmem } from 'node:os';
import { getResolvedGitExecutableForSpawn } from '../lib/git-executable';
import type { ExecutionHostProcess } from '@canopy/desktop-shared/node/execution-host/port';
import { getExecutionHostPort } from '../execution-host/utility-process-host';
import { codeGraphHostBudget } from '@canopy/code-graph/host/budgets';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import type {
  CodeGraphFingerprintWorkerRequest,
  CodeGraphFingerprintWorkerResponse,
} from '@canopy/code-graph/host/fingerprint-host';
import { getCodeGraphGenerationTimeoutMs } from '../lib/code-graph-availability';
import {
  leaveBackgroundProcessPolicy,
  lowerSpawnedProcessPriority,
} from '../lib/background-process';

export type {
  CodeGraphFingerprintWorkerRequest,
  CodeGraphFingerprintWorkerResponse,
} from '@canopy/code-graph/host/fingerprint-host';

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

interface FingerprintRecord {
  key: string;
  request: CodeGraphFingerprintWorkerRequest;
  promise: Promise<CodeGraphFingerprintWorkerResponse>;
  resolve: (response: CodeGraphFingerprintWorkerResponse) => void;
  reject: (error: CodeGraphFingerprintWorkerError) => void;
  child: ExecutionHostProcess | null;
  watchdog: NodeJS.Timeout | null;
  settled: boolean;
  /** Scheduler fingerprints have no waiting caller; see `startRecord`. */
  background: boolean;
  /** The background policy was applied to the spawned worker. */
  backgroundApplied: boolean;
}

export interface CodeGraphFingerprintOptions {
  /** Defaults to true. Pass false when an agent or user waits on the digest. */
  background?: boolean;
}

const WORKER_ENTRY_FILENAME = 'code-graph-fingerprint-worker.js';
const WORKER_SERVICE_NAME = 'code-graph-fingerprint';
const CONCURRENCY_CAP = 1;
const EXIT_WAIT_FALLBACK_MS = 2_000;

const records = new Map<string, FingerprintRecord>();
const queue: FingerprintRecord[] = [];
const active = new Set<FingerprintRecord>();
const liveChildren = new Set<ExecutionHostProcess>();
const pendingExitWaits = new Map<string, Promise<void>>();
let shuttingDown = false;

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
  let child: ExecutionHostProcess;
  try {
    const gitExecutable = await getResolvedGitExecutableForSpawn();
    if (record.settled) return;
    child = getExecutionHostPort().launch({
      entry: WORKER_ENTRY_FILENAME,
      serviceName: WORKER_SERVICE_NAME,
      budget: codeGraphHostBudget('fingerprint', {
        totalMemoryBytes: totalmem(),
      }),
      env: { CANOPY_GIT_EXECUTABLE: gitExecutable },
    });
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
  liveChildren.add(child);
  // Hashing dirty files and running Git is disk-heavy. The pid only exists
  // once Electron emits `spawn`.
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
      lowerSpawnedProcessPriority(child.pid, {
        background: record.background,
      });
      record.backgroundApplied = record.background;
    }
  });

  const timeoutMs = getCodeGraphGenerationTimeoutMs();
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

export function runCodeGraphWorkerFingerprint(
  key: string,
  repositories: readonly CodeGraphRepositoryInput[],
  options: CodeGraphFingerprintOptions = {},
): Promise<CodeGraphFingerprintWorkerResponse> {
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
        leaveBackgroundProcessPolicy(existing.child.pid);
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
}

function waitForChildExit(child: ExecutionHostProcess): Promise<void> {
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
  child: ExecutionHostProcess,
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

export async function cancelCodeGraphFingerprint(key: string): Promise<void> {
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
  await (pendingExitWaits.get(key) ?? Promise.resolve());
}

export async function shutdownCodeGraphFingerprintWorkers(): Promise<void> {
  shuttingDown = true;
  const pending = Array.from(records.values());
  const children = Array.from(liveChildren);
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
}

export function resetCodeGraphFingerprintRunnerForTests(): void {
  records.clear();
  queue.length = 0;
  active.clear();
  liveChildren.clear();
  pendingExitWaits.clear();
  shuttingDown = false;
}
