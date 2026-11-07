import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { app, powerMonitor } from 'electron';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import {
  MEMORY_SYNC_ACCOUNT_HEADER,
  MEMORY_SYNC_CAPABILITY,
  MEMORY_SYNC_LIMITS,
  MEMORY_SYNC_PROTOCOL_HEADER,
  MEMORY_SYNC_PROTOCOL_VERSION,
  MEMORY_SYNC_REALTIME_EVENT_TYPE,
  MEMORY_SYNC_ROUTES,
  MemoryAccountIdSchema,
} from '@canopy/protocol/memory-sync';
import { resolveCanopyCloudCredentialContext } from '../../canopy-cloud/client';
import {
  peekCanopyCloudAccount,
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../../lib/canopy-cloud-account-store';
import { readInstallationGeneration } from '../../lib/installation-generation';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { getMemoryReplicasRootDir } from '../../lib/paths';
import { parseSseEvents } from '../../plans/plan-realtime-subscription';
import { readPortalStateStore } from '../../portal/portal-state-store';
import {
  broadcastLocalMemoryChanged,
  retargetLocalMemoryWatches,
} from '../local/change-events';
import { setLocalMemoryReplicaHooks } from '../local/replica-hooks';
import {
  deviceLocalMemoryScopeDir,
  localMemoryScopeDir,
  setLocalMemoryReplicaLocator,
} from '../local/scope-resolver';
import {
  MemorySyncEngine,
  type MemorySyncDevice,
  type MemorySyncEngineStatus,
  type MemorySyncProblem,
} from './engine';
import { createMemoryReplicaHooks } from './note-hooks';
import {
  MemoryReplicaRegistry,
  createMemoryReplicaLocator,
} from './replica-registry';
import {
  createMemorySyncTransport,
  type MemorySyncHttp,
  type MemorySyncHttpResponse,
} from './transport';

/*
 * The desktop host of the memory sync engine (design §8, D15): the Electron
 * side the engine itself never touches. It runs while
 * `canopy-desktop-memory-sync` is on, for the signed-in account when that
 * account carries `memory-sync-v1` and is not a guest (guests never sync,
 * §8.1). It supplies the device identity (the Portal device, the
 * installation generation and a nonce per launch), the bearer key, the
 * `memory.scope` nudge stream and resume-from-sleep pulls, and installs the
 * replica locator and note hooks so the local store reads and writes the
 * account's replicas.
 */

const STREAM_RETRY_INITIAL_MS = 5_000;
const STREAM_RETRY_MAX_MS = 5 * 60_000;

/** The account memory sync runs for: signed in, not a guest, and offered sync. */
export function memorySyncAccountId(
  entry: CanopyCloudAccountEntry | null,
): string | null {
  if (entry === null || isGuestAccount(entry)) return null;
  if (!entry.capabilities.includes(MEMORY_SYNC_CAPABILITY)) return null;
  const parsed = MemoryAccountIdSchema.safeParse(entry.account?.id ?? '');
  return parsed.success ? parsed.data : null;
}

function devicePlatform(): MemorySyncDevice['platform'] {
  return hostOperatingSystem() ?? 'linux';
}

function deviceLabel(): string {
  const label = hostname().trim();
  return (label.length > 0 ? label : 'Desktop').slice(
    0,
    MEMORY_SYNC_LIMITS.deviceLabelMaxChars,
  );
}

const sessionNonce = randomUUID();

async function readDevice(): Promise<MemorySyncDevice> {
  const deviceId = (await readPortalStateStore()).clientDeviceId.toLowerCase();
  return {
    deviceId,
    installationGeneration: await readInstallationGeneration(deviceId),
    sessionNonce,
    label: deviceLabel(),
    platform: devicePlatform(),
    appVersion: app.getVersion(),
  };
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** The body as text, refusing one longer than `maxBytes`. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('The memory sync response is too large');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The memory sync response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Requests over the signed-in account's bearer key. */
const cloudHttp: MemorySyncHttp = async (request) => {
  const { baseUrl, apiKey } = await resolveCanopyCloudCredentialContext();
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([timeout, request.signal]);
  const response = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(request.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...request.headers,
    },
    ...(request.body === undefined ? {} : { body: request.body }),
    signal,
  });
  const text = await readCapped(response, request.maxResponseBytes);
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const answer: MemorySyncHttpResponse = { status: response.status, body };
  const after = retryAfterMs(response);
  return after === undefined ? answer : { ...answer, retryAfterMs: after };
};

/**
 * The `memory.scope` nudge stream (design §9.4): every signal asks the engine
 * to pull. A 404, 401 or 403 ends it quietly; the engine's periodic pull
 * covers that. Never throws.
 */
export function openMemorySyncNudgeStream(
  accountId: string,
  onNudge: () => void,
): { stop: () => void } {
  const controller = new AbortController();
  let lastEventId: string | null = null;
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      timer.unref();
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  const consume = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseEvents(buffer);
        buffer = remainder;
        for (const event of events) {
          if (event.id !== null) lastEventId = event.id;
          if (event.event === MEMORY_SYNC_REALTIME_EVENT_TYPE) onNudge();
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        const { baseUrl, apiKey } = await resolveCanopyCloudCredentialContext();
        const response = await fetch(
          `${baseUrl}${MEMORY_SYNC_ROUTES.stream()}`,
          {
            headers: {
              Accept: 'text/event-stream',
              Authorization: `Bearer ${apiKey}`,
              [MEMORY_SYNC_PROTOCOL_HEADER]: String(
                MEMORY_SYNC_PROTOCOL_VERSION,
              ),
              [MEMORY_SYNC_ACCOUNT_HEADER]: accountId,
              ...(lastEventId === null ? {} : { 'Last-Event-ID': lastEventId }),
            },
            signal: controller.signal,
          },
        );
        if ([401, 403, 404].includes(response.status)) return;
        if (response.ok && response.body !== null) {
          attempt = 0;
          // A fresh connection may have missed signals: pull once.
          onNudge();
          await consume(response.body);
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      await delay(
        Math.min(STREAM_RETRY_INITIAL_MS * 2 ** attempt, STREAM_RETRY_MAX_MS),
      );
      attempt += 1;
    }
  };
  void run();
  return {
    stop: (): void => {
      controller.abort();
    },
  };
}

function recordProblem(problem: MemorySyncProblem): void {
  logMainProcessWarn('Memory sync problem', {
    kind: problem.kind,
    code: problem.code,
  });
}

const USER_SCOPE: LocalMemoryScopeRequest = { scope: 'user' };

/**
 * A replica was registered or removed, so a scope may resolve to another
 * folder: open explorer watches follow it and renderers list it again.
 */
function onReplicasChanged(): void {
  retargetLocalMemoryWatches(localMemoryScopeDir);
  broadcastLocalMemoryChanged(USER_SCOPE);
}

const registry = new MemoryReplicaRegistry(onReplicasChanged);
let enabled = false;
let engine: MemorySyncEngine | null = null;
let stream: { stop: () => void } | null = null;
let unsubscribers: Array<() => void> = [];
let reconciling: Promise<void> = Promise.resolve();

/**
 * The account whose replicas the resolver may use: the engine's, and only
 * while it is still the one signed in, so switching accounts stops reading
 * the old account's replicas at once.
 */
function resolvableAccountId(): string | null {
  const engineAccount = engine?.accountId ?? null;
  return engineAccount !== null &&
    memorySyncAccountId(peekCanopyCloudAccount()) === engineAccount
    ? engineAccount
    : null;
}

async function readEligibleAccountId(): Promise<string | null> {
  const result = await readCanopyCloudAccountWithStatus().catch(() => null);
  return result?.status === 'ok' ? memorySyncAccountId(result.entry) : null;
}

async function stopEngine(): Promise<void> {
  stream?.stop();
  stream = null;
  const current = engine;
  engine = null;
  if (current === null) return;
  registry.unregisterAccount(current.accountId);
  await current.stop();
}

async function startEngine(accountId: string): Promise<void> {
  const device = await readDevice();
  const next = new MemorySyncEngine({
    accountId,
    replicasRoot: getMemoryReplicasRootDir(),
    transport: createMemorySyncTransport(accountId, cloudHttp),
    device,
    registry,
    deviceLocalDir: (scope): string | null =>
      scope.kind === 'user' ? deviceLocalMemoryScopeDir(USER_SCOPE) : null,
    onScopeChanged: (scope): void => {
      if (scope.kind === 'user') broadcastLocalMemoryChanged(USER_SCOPE);
    },
    requestConsolidation: (scope, delayMs): void => {
      if (scope.kind !== 'user') return;
      // Loaded on demand: the scheduler's session imports stay off this
      // module's graph, and main has already loaded it by the time a run ends.
      void import('../local/consolidation-scheduler')
        .then((scheduler) =>
          scheduler.retryLocalMemoryConsolidation({}, delayMs),
        )
        .catch((error: unknown) => {
          logMainProcessWarn('Memory consolidation could not be rearmed', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        });
    },
    recordProblem,
  });
  engine = next;
  await next.loadReplicas();
  next.start();
  stream = openMemorySyncNudgeStream(accountId, () => {
    next.requestPull();
  });
}

async function reconcileNow(): Promise<void> {
  const desired = enabled ? await readEligibleAccountId() : null;
  if (desired !== null && desired === engine?.accountId) return;
  await stopEngine();
  if (desired !== null && enabled) {
    await startEngine(desired).catch((error: unknown) => {
      logMainProcessWarn('Memory sync could not start', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    });
  }
}

function reconcile(): Promise<void> {
  reconciling = reconciling.then(reconcileNow, reconcileNow);
  return reconciling;
}

function onResume(): void {
  engine?.requestPull();
}

/**
 * Follows `canopy-desktop-memory-sync`. Turning it off stops the engine and
 * removes the locator, so every scope resolves to its device-local folder
 * again, as on a build without sync; replicas stay on disk.
 */
export function setMemorySyncEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  if (next) {
    setLocalMemoryReplicaLocator(
      createMemoryReplicaLocator(registry, resolvableAccountId),
    );
    setLocalMemoryReplicaHooks(createMemoryReplicaHooks(registry));
    powerMonitor.on('resume', onResume);
    unsubscribers = [
      subscribeCanopyCloudAccountChanges(() => {
        void reconcile();
      }),
      (): void => {
        powerMonitor.removeListener('resume', onResume);
      },
    ];
  } else {
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    setLocalMemoryReplicaLocator(null);
    setLocalMemoryReplicaHooks(null);
  }
  void reconcile();
}

/** Stops sync at quit. Never rejects. */
export async function stopMemorySync(): Promise<void> {
  enabled = false;
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  await reconcile().catch(() => undefined);
}

export const memorySyncHostTestExports = {
  /** Runs a pass of the current engine now, once account changes applied. */
  async syncNow(): Promise<MemorySyncEngineStatus | null> {
    await reconciling;
    return (await engine?.syncNow()) ?? null;
  },
};
