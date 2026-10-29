import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  CodexPluginMaterializationPlugin,
  CodexPluginMaterializationRequest,
  CodexPluginMaterializationResponse,
  CodexPluginMaterializationResult,
  CodexPluginMaterializationSkill,
} from './codex-plugin-materialization-protocol';

const WORKER_ENTRY_FILENAME = 'codex-plugin-materialization-worker.js';
const WORKER_SERVICE_NAME = 'codex-plugin-materialization';
export const DEFAULT_CODEX_PLUGIN_MATERIALIZATION_TIMEOUT_MS = 20_000;
const SHUTDOWN_WAIT_MS = 2_000;

interface PendingMaterialization {
  child: UtilityProcess;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: CodexPluginMaterializationResult) => void;
  reject: (error: Error) => void;
}

export class CodexPluginMaterializationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Codex plugin capability materialization exceeded its ${String(timeoutMs)}ms deadline.`,
    );
    this.name = 'CodexPluginMaterializationTimeoutError';
  }
}

let worker: UtilityProcess | null = null;
let terminatingWorker: Promise<void> | null = null;
let shuttingDown = false;
const pending = new Map<string, PendingMaterialization>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isResponse(
  value: unknown,
): value is CodexPluginMaterializationResponse {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'shutdown-complete') return true;
  return (
    (value.type === 'result' || value.type === 'error') &&
    typeof value.requestId === 'string'
  );
}

function rejectWorkerPending(child: UtilityProcess, error: Error): void {
  for (const [requestId, request] of Array.from(pending.entries())) {
    if (request.child !== child) continue;
    pending.delete(requestId);
    clearTimeout(request.timeout);
    request.reject(error);
  }
}

function handleMessage(source: UtilityProcess, message: unknown): void {
  const payload = isResponse(message)
    ? message
    : isRecord(message) && 'data' in message
      ? message.data
      : message;
  if (!isResponse(payload) || payload.type === 'shutdown-complete') return;
  const request = pending.get(payload.requestId);
  if (!request || request.child !== source) return;
  pending.delete(payload.requestId);
  clearTimeout(request.timeout);
  if (payload.type === 'result') {
    request.resolve(payload.result);
  } else {
    request.reject(new Error(payload.message));
  }
}

function terminateWorker(child: UtilityProcess): Promise<void> {
  if (terminatingWorker) {
    return terminatingWorker;
  }
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  const termination = exitPromise.finally(() => {
    if (terminatingWorker === termination) {
      terminatingWorker = null;
    }
  });
  terminatingWorker = termination;
  child.kill();
  return termination;
}

async function ensureWorker(): Promise<UtilityProcess> {
  if (shuttingDown) {
    throw new Error('Codex plugin materialization worker is shutting down.');
  }
  if (terminatingWorker) {
    await terminatingWorker;
  }
  if (shuttingDown) {
    throw new Error('Codex plugin materialization worker is shutting down.');
  }
  if (worker) return worker;
  const child = utilityProcess.fork(
    path.join(__dirname, WORKER_ENTRY_FILENAME),
    [],
    { serviceName: WORKER_SERVICE_NAME },
  );
  worker = child;
  child.on('message', (message) => handleMessage(child, message));
  child.once('exit', (code) => {
    if (worker === child) worker = null;
    rejectWorkerPending(
      child,
      new Error(
        `Codex plugin materialization worker exited before completing its work (code ${String(code)}).`,
      ),
    );
  });
  return child;
}

export function materializeCodexPluginsOffMain(options: {
  nativeProjectionRoot: string;
  plugins: CodexPluginMaterializationPlugin[];
  skills: CodexPluginMaterializationSkill[];
  timeoutMs?: number;
}): Promise<CodexPluginMaterializationResult> {
  return ensureWorker().then(
    (child) =>
      new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timeoutMs =
          options.timeoutMs ?? DEFAULT_CODEX_PLUGIN_MATERIALIZATION_TIMEOUT_MS;
        const timeout = setTimeout(() => {
          const request = pending.get(requestId);
          if (!request || request.child !== child) return;
          pending.delete(requestId);
          const timeoutError = new CodexPluginMaterializationTimeoutError(
            timeoutMs,
          );
          void terminateWorker(child).then(() => request.reject(timeoutError));
        }, timeoutMs);
        timeout.unref?.();
        pending.set(requestId, { child, timeout, resolve, reject });
        child.postMessage({
          type: 'materialize',
          requestId,
          nativeProjectionRoot: options.nativeProjectionRoot,
          plugins: options.plugins,
          skills: options.skills,
        } satisfies CodexPluginMaterializationRequest);
      }),
  );
}

export async function shutdownCodexPluginMaterializationWorker(): Promise<void> {
  shuttingDown = true;
  const child = worker;
  worker = null;
  if (!child) {
    shuttingDown = false;
    return;
  }
  rejectWorkerPending(
    child,
    new Error('Codex plugin materialization worker shut down.'),
  );
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, SHUTDOWN_WAIT_MS);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      finish();
    });
    child.postMessage({
      type: 'shutdown',
    } satisfies CodexPluginMaterializationRequest);
  });
  shuttingDown = false;
}

export function resetCodexPluginMaterializationWorkerForTests(): void {
  const child = worker;
  worker = null;
  terminatingWorker = null;
  shuttingDown = false;
  if (child) {
    child.kill();
    rejectWorkerPending(child, new Error('Test reset.'));
  }
}
