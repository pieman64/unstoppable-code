import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MEMORY_SYNC_PROTOCOL_VERSION,
  MEMORY_SYNC_TIMINGS,
  checkMemoryChangesPage,
  type MemoryAccountPolicy,
  type MemoryDevicePlatformSchema,
  type MemoryDocument,
  type MemoryNoteRecord,
  type MemoryScopeRef,
  type MemorySyncSettings,
  type MemorySyncStateFile,
} from '@canopy/protocol/memory-sync';
import type { z } from 'zod';
import { withMemoryWriteLock } from '../local/edit-coordination';
import { isMemoryMarkdownFileName, isNodeError } from '../local/memory-files';
import { createReplicaManifest } from '../local/scope-manifest';
import {
  LocalMemoryScopeLockTimeoutError,
  acquireMemoryScopeLock,
  withMemoryScopeLock,
  type MemoryScopeLock,
} from '../local/scope-lock';
import {
  finishMemoryLocalDeletes,
  readQueuedMemoryNoteOps,
  settleMemoryPush,
  takeMemoryPushBatch,
} from './outbox';
import {
  initialMemorySyncState,
  readMemoryReplicaAccount,
  readMemorySyncState,
  writeMemoryReplicaAccount,
  writeMemorySyncState,
  type MemoryReplicaBinding,
} from './replica-files';
import {
  memoryReplicaAccountDir,
  memoryReplicaScopeDir,
  memoryScopeKey,
} from './replica-layout';
import type { MemoryReplicaRegistry } from './replica-registry';
import {
  MemoryReplicaGapError,
  applyMemoryReplicaChanges,
  applyMemoryReplicaSnapshot,
  type MemoryReplicaWriteOptions,
} from './replica-writer';
import type { MemorySyncFailure, MemorySyncTransport } from './transport';

/*
 * The desktop memory sync engine for one account (design §8–§10, §16). It
 * keeps that account's replicas in step with Canopy Cloud: it registers this
 * launch's device session, creates a replica from the cloud snapshot, pulls
 * the change feed (on a nudge, every five minutes, on resume) and pushes each
 * scope's outbox, one pass at a time and off every turn's path.
 *
 * It holds no Electron handle: the file system is the replica, and the
 * transport, timers and clock are passed in (D15), so it can move to the core
 * daemon. Only the holder of the account's sync engine lock
 * (`memory-replicas/<accountId>/.lock`) runs passes; another process on the
 * same data saves notes into the replica and its outbox and leaves sending
 * to the holder.
 */

type MemoryDevicePlatform = z.output<typeof MemoryDevicePlatformSchema>;

export interface MemorySyncDevice {
  deviceId: string;
  installationGeneration: number;
  /** Minted once per launch. */
  sessionNonce: string;
  label: string;
  platform: MemoryDevicePlatform;
  appVersion: string;
}

export interface MemorySyncTimer {
  cancel(): void;
}

export interface MemorySyncEngineTiming {
  launchQuietMs: number;
  pushDebounceMs: number;
  pullFallbackIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  serverRetryAfterMaxMs: number;
}

export const MEMORY_SYNC_ENGINE_TIMING: MemorySyncEngineTiming = {
  launchQuietMs: MEMORY_SYNC_TIMINGS.launchQuietMs,
  pushDebounceMs: MEMORY_SYNC_TIMINGS.pushDebounceMs,
  pullFallbackIntervalMs: MEMORY_SYNC_TIMINGS.pullFallbackIntervalMs,
  retryBaseMs: MEMORY_SYNC_TIMINGS.retryBaseMs,
  retryMaxMs: MEMORY_SYNC_TIMINGS.retryMaxMs,
  serverRetryAfterMaxMs: MEMORY_SYNC_TIMINGS.serverRetryAfterMaxMs,
};

export type MemorySyncEngineState =
  /** Waiting for its first pass. */
  | 'starting'
  | 'running'
  /** Another process on this data runs the engine for the account. */
  | 'standby'
  /** Sync is off for the account; replicas keep working locally. */
  | 'paused'
  /** Memory sync is not available to the account (rollout). */
  | 'unavailable'
  /** The server needs a newer app; local memory keeps working. */
  | 'update_required'
  | 'stopped';

export type MemorySyncScopeMode =
  | MemorySyncStateFile['mode']
  /** Device-local memory exists; merging it is the first-enable flow. */
  | 'needs_first_enable';

export interface MemorySyncScopeStatus {
  scope: MemoryScopeRef;
  mode: MemorySyncScopeMode;
  queuedOps: number;
  localOnlyNotes: number;
  conflicts: number;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
  lastError: { code: string; at: string } | null;
}

export interface MemorySyncEngineStatus {
  accountId: string;
  state: MemorySyncEngineState;
  /** Why the engine stopped or pauses, as a code. */
  reason: string | null;
  scopes: MemorySyncScopeStatus[];
}

/** A content-free event for diagnostics: a kind and a code, never an ID. */
export interface MemorySyncProblem {
  kind:
    | 'page_check'
    | 'replica_gap'
    | 'replica_unreadable'
    | 'push_refused'
    | 'snapshot_inconsistent'
    | 'pass_failed'
    | 'local_edit_unsettled'
    | 'stopped';
  code: string;
}

export interface MemorySyncEngineOptions {
  accountId: string;
  /** `<data>/memory-replicas`. */
  replicasRoot: string;
  transport: MemorySyncTransport;
  device: MemorySyncDevice;
  registry: MemoryReplicaRegistry;
  /**
   * The scope's device-local folder. A replica is created on its own only
   * when that folder holds no memory; otherwise merging it is the first
   * enable flow's job (design §17).
   */
  deviceLocalDir: (scope: MemoryScopeRef) => string | null;
  now?: () => number;
  /** In [0, 1); jitters a retry. */
  random?: () => number;
  setTimer?: (run: () => void, delayMs: number) => MemorySyncTimer;
  timing?: Partial<MemorySyncEngineTiming>;
  onStatusChanged?: (status: MemorySyncEngineStatus) => void;
  /** A pull wrote into the scope's replica: what shows it should refresh. */
  onScopeChanged?: (scope: MemoryScopeRef) => void;
  recordProblem?: (problem: MemorySyncProblem) => void;
}

type PassOutcome =
  | { kind: 'ok' }
  | { kind: 'retry'; retryAfterMs?: number }
  | { kind: 'standby' }
  | { kind: 'halt'; state: MemorySyncEngineState; reason: string };

const MAX_PAGES_PER_PASS = 1_000;
const MAX_PUSHES_PER_PASS = 100;
/** The scopes an engine keeps replicas of; project scopes follow in PR 12. */
const SYNCED_SCOPES: readonly MemoryScopeRef[] = [{ kind: 'user' }];

function defaultSetTimer(run: () => void, delayMs: number): MemorySyncTimer {
  const handle = setTimeout(run, delayMs);
  handle.unref();
  return {
    cancel: (): void => {
      clearTimeout(handle);
    },
  };
}

/** Whether a scope folder holds any memory: an index, a topic, a note or an import. */
export async function scopeFolderHasMemory(dir: string): Promise<boolean> {
  try {
    if ((await stat(join(dir, 'MEMORY.md'))).isFile()) return true;
  } catch (error) {
    if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTDIR')) {
      throw error;
    }
  }
  for (const folder of ['topics', 'inbox', 'imported']) {
    try {
      const names = await readdir(join(dir, folder));
      if (names.some(isMemoryMarkdownFileName)) return true;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTDIR')) {
        throw error;
      }
    }
  }
  return false;
}

function isReady(state: MemorySyncStateFile): boolean {
  return (
    state.cursor !== null &&
    (state.firstEnable === null || state.firstEnable.state === 'done')
  );
}

/** A replica created here that has not been registered for the first time. */
function awaitsFirstEnable(state: MemorySyncStateFile): boolean {
  return state.firstEnable !== null && state.firstEnable.state !== 'done';
}

function firstEnableStarted(
  at: Date,
): NonNullable<MemorySyncStateFile['firstEnable']> {
  return {
    state: 'uploading',
    startedAt: at.toISOString(),
    preMergeRevision: null,
  };
}

function abortError(): Error {
  const error = new Error('Memory sync pass cancelled');
  error.name = 'AbortError';
  return error;
}

export class MemorySyncEngine {
  private readonly timing: MemorySyncEngineTiming;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (
    run: () => void,
    delayMs: number,
  ) => MemorySyncTimer;
  private readonly accountDir: string;
  private engineState: MemorySyncEngineState = 'starting';
  private reason: string | null = null;
  private lock: MemoryScopeLock | null = null;
  private deviceSessionId: string | null = null;
  private settings: MemorySyncSettings | null = null;
  private policy: MemoryAccountPolicy | null = null;
  private quietUntil = 0;
  /** After a failed pass, no trigger runs another before this time. */
  private retryNotBefore = 0;
  private timer: MemorySyncTimer | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private running: Promise<void> | null = null;
  private rerunAt: number | null = null;
  private failures = 0;
  private controller = new AbortController();
  private stopped = false;
  /** Stopped by the server (a newer client, another session): no more passes. */
  private halted = false;
  private readonly scopeStatus = new Map<string, MemorySyncScopeStatus>();

  constructor(private readonly options: MemorySyncEngineOptions) {
    this.timing = { ...MEMORY_SYNC_ENGINE_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.accountDir = memoryReplicaAccountDir(
      options.replicasRoot,
      options.accountId,
    );
  }

  get accountId(): string {
    return this.options.accountId;
  }

  /**
   * Registers the account's ready replicas, so the resolver finds them now.
   * Reads local files only. Every standby pass runs it again, so a process
   * that lost the lock race finds a replica the holder made ready later.
   */
  async loadReplicas(): Promise<void> {
    for (const scope of SYNCED_SCOPES) await this.registerReplica(scope);
  }

  /**
   * Settles the local deletes and edits cut short in every replica of this
   * account, whatever the pass does next: sync off, a device-only or deleted
   * scope, a failed request and standby all return before the scope syncs.
   */
  private async finishLocalDeletes(): Promise<void> {
    for (const scope of SYNCED_SCOPES) {
      const dir = this.scopeDir(scope);
      const state = await readMemorySyncState(dir);
      if (
        state === undefined ||
        state === null ||
        state.binding.accountId !== this.options.accountId
      ) {
        continue;
      }
      const unsettled = await finishMemoryLocalDeletes(
        dir,
        new Date(this.now()),
      );
      if (unsettled > 0) {
        this.options.recordProblem?.({
          kind: 'local_edit_unsettled',
          code: 'replacement_missing',
        });
      }
    }
  }

  /** Starts passes after the launch quiet period. Reads nothing before. */
  start(): void {
    if (this.stopped) return;
    this.quietUntil = this.now() + this.timing.launchQuietMs;
    this.schedule(0);
  }

  /** Cancels what is in flight and releases the account's engine lock. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    this.controller.abort();
    await this.running?.catch(() => undefined);
    await this.lock?.release().catch(() => undefined);
    this.lock = null;
    this.engineState = 'stopped';
    this.reason ??= 'stopped';
    this.emitStatus();
  }

  /** A note changed here: push after the debounce. */
  requestPush(): void {
    this.schedule(this.timing.pushDebounceMs);
  }

  /** A nudge, a resume or a network change: pull now. */
  requestPull(): void {
    this.schedule(0);
  }

  /**
   * Runs a pass now, past the launch quiet period and any retry wait, once
   * any pass in flight has finished. Resolves with the status after it.
   */
  async syncNow(): Promise<MemorySyncEngineStatus> {
    if (this.stopped || this.halted) return this.status();
    await this.running?.catch(() => undefined);
    if (this.running === null && !this.stopped && !this.halted) {
      this.timer?.cancel();
      this.timer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      await this.runPass();
    }
    return this.status();
  }

  status(): MemorySyncEngineStatus {
    return {
      accountId: this.options.accountId,
      state: this.engineState,
      reason: this.reason,
      scopes: [...this.scopeStatus.values()],
    };
  }

  private emitStatus(): void {
    this.options.onStatusChanged?.(this.status());
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.halted) return;
    const at = Math.max(
      this.now() + delayMs,
      this.quietUntil,
      this.retryNotBefore,
    );
    if (this.running !== null) {
      this.rerunAt = Math.min(this.rerunAt ?? Number.POSITIVE_INFINITY, at);
      return;
    }
    if (this.timer !== null && this.timerAt <= at) return;
    this.timer?.cancel();
    this.timerAt = at;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.timerAt = Number.POSITIVE_INFINITY;
        void this.runPass();
      },
      Math.max(0, at - this.now()),
    );
  }

  private runPass(): Promise<void> {
    if (this.stopped || this.running !== null) {
      return this.running ?? Promise.resolve();
    }
    this.running = this.pass(this.controller.signal)
      .catch((error: unknown): PassOutcome => {
        if (error instanceof Error && error.name === 'AbortError') {
          return { kind: 'halt', state: 'stopped', reason: 'stopped' };
        }
        this.options.recordProblem?.({
          kind: 'pass_failed',
          code: error instanceof Error ? error.name : 'unknown',
        });
        return { kind: 'retry' };
      })
      .then((outcome) => {
        this.running = null;
        this.afterPass(outcome);
      });
    return this.running;
  }

  private afterPass(outcome: PassOutcome): void {
    let nextDelay: number | null;
    switch (outcome.kind) {
      case 'ok':
        this.failures = 0;
        this.retryNotBefore = 0;
        this.engineState = 'running';
        this.reason = null;
        nextDelay = this.timing.pullFallbackIntervalMs;
        break;
      case 'standby':
        this.engineState = 'standby';
        nextDelay = this.timing.pullFallbackIntervalMs;
        break;
      case 'retry':
        this.failures += 1;
        nextDelay = this.retryDelay(outcome.retryAfterMs);
        this.retryNotBefore = this.now() + nextDelay;
        break;
      case 'halt':
        this.engineState = outcome.state;
        this.reason = outcome.reason;
        nextDelay =
          outcome.state === 'paused' || outcome.state === 'unavailable'
            ? this.timing.pullFallbackIntervalMs
            : null;
        if (nextDelay === null && !this.stopped) {
          this.halted = true;
          this.options.recordProblem?.({
            kind: 'stopped',
            code: outcome.reason,
          });
          void this.lock?.release().catch(() => undefined);
          this.lock = null;
        }
        break;
    }
    this.emitStatus();
    if (this.stopped || nextDelay === null) return;
    const rerunAt = this.rerunAt;
    this.rerunAt = null;
    this.schedule(
      rerunAt !== null && outcome.kind !== 'retry'
        ? Math.min(rerunAt - this.now(), nextDelay)
        : nextDelay,
    );
  }

  private retryDelay(retryAfterMs: number | undefined): number {
    const exponential = Math.min(
      this.timing.retryBaseMs * 2 ** Math.max(0, this.failures - 1),
      this.timing.retryMaxMs,
    );
    const jittered = exponential * (0.5 + this.random() / 2);
    return retryAfterMs === undefined
      ? jittered
      : Math.max(
          jittered,
          Math.min(retryAfterMs, this.timing.serverRetryAfterMaxMs),
        );
  }

  private checkAborted(signal: AbortSignal): void {
    if (signal.aborted || this.stopped) throw abortError();
  }

  private writeOptions(): MemoryReplicaWriteOptions {
    return {
      deviceId: this.options.device.deviceId,
      blockedOriginOrganizationIds: new Set(
        this.policy?.blockedOriginOrganizationIds ?? [],
      ),
      now: () => new Date(this.now()),
    };
  }

  private async takeLock(): Promise<boolean> {
    if (this.lock !== null && !this.lock.lost) return true;
    if (this.lock !== null) await this.lock.release().catch(() => undefined);
    try {
      this.lock = await acquireMemoryScopeLock(this.accountDir, {
        timeoutMs: 0,
      });
      return true;
    } catch (error) {
      this.lock = null;
      if (error instanceof LocalMemoryScopeLockTimeoutError) return false;
      throw error;
    }
  }

  private async pass(signal: AbortSignal): Promise<PassOutcome> {
    await this.finishLocalDeletes();
    if (!(await this.takeLock())) {
      await this.loadReplicas();
      return { kind: 'standby' };
    }
    this.checkAborted(signal);
    if (this.deviceSessionId === null) {
      const registered = await this.register(signal);
      if (registered !== null) return registered;
    } else {
      const settings = await this.options.transport.settings(signal);
      if (!settings.ok) return this.engineOutcome(settings.failure);
      this.settings = settings.value.settings;
      this.policy = settings.value.policy;
    }
    this.checkAborted(signal);
    const settings = this.settings;
    if (settings === null) return { kind: 'retry' };
    const userScope: MemoryScopeRef = { kind: 'user' };
    const syncUser = settings.enabled && settings.userScope === 'sync';
    if (!settings.enabled) {
      await this.setIdleMode(userScope, 'paused');
      return { kind: 'halt', state: 'paused', reason: 'memory_sync_disabled' };
    }
    if (!syncUser) {
      await this.setIdleMode(userScope, 'device_only');
      return { kind: 'ok' };
    }
    return this.syncScope(userScope, signal);
  }

  private async register(signal: AbortSignal): Promise<PassOutcome | null> {
    const { device, transport } = this.options;
    const result = await transport.register(
      {
        protocolVersion: MEMORY_SYNC_PROTOCOL_VERSION,
        device: {
          deviceId: device.deviceId,
          installationGeneration: device.installationGeneration,
          sessionNonce: device.sessionNonce,
          label: device.label,
          platform: device.platform,
          appVersion: device.appVersion,
        },
      },
      signal,
    );
    if (!result.ok) return this.engineOutcome(result.failure);
    if (result.value.minimumProtocolVersion > MEMORY_SYNC_PROTOCOL_VERSION) {
      return {
        kind: 'halt',
        state: 'update_required',
        reason: 'memory_unsupported_protocol',
      };
    }
    this.deviceSessionId = result.value.deviceSessionId;
    transport.setDeviceSession(result.value.deviceSessionId);
    this.settings = result.value.settings;
    this.policy = result.value.policy;
    return null;
  }

  /** What a failure means for the whole engine. */
  private engineOutcome(failure: MemorySyncFailure): PassOutcome {
    switch (failure.kind) {
      case 'retry':
        return failure.retryAfterMs === undefined
          ? { kind: 'retry' }
          : { kind: 'retry', retryAfterMs: failure.retryAfterMs };
      case 'register':
        this.deviceSessionId = null;
        this.options.transport.setDeviceSession(null);
        return { kind: 'retry' };
      case 'update_required':
        return {
          kind: 'halt',
          state: 'update_required',
          reason: 'memory_unsupported_protocol',
        };
      case 'unavailable':
        return { kind: 'halt', state: 'unavailable', reason: 'not_found' };
      case 'paused':
        return { kind: 'halt', state: 'paused', reason: failure.code };
      case 'stop':
        return { kind: 'halt', state: 'stopped', reason: failure.code };
      case 'conflict':
        return { kind: 'retry' };
      case 'snapshot':
      case 'device_only':
      case 'scope_deleted':
      case 'refused':
        return { kind: 'retry' };
    }
  }

  private scopeDir(scope: MemoryScopeRef): string {
    return memoryReplicaScopeDir(
      this.options.replicasRoot,
      this.options.accountId,
      scope,
    );
  }

  /** Puts a replica the account no longer syncs into an idle mode. */
  private async setIdleMode(
    scope: MemoryScopeRef,
    mode: 'paused' | 'device_only',
  ): Promise<void> {
    const dir = this.scopeDir(scope);
    const state = await readMemorySyncState(dir);
    if (state === undefined || state === null) return;
    if (state.mode !== mode && state.mode !== 'deleted_in_cloud') {
      await this.updateState(dir, { mode });
    }
    await this.refreshScopeStatus(scope);
  }

  private async updateState(
    dir: string,
    patch: Partial<MemorySyncStateFile>,
  ): Promise<void> {
    await withMemoryWriteLock(dir, async () => {
      const state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return;
      await writeMemorySyncState(dir, { ...state, ...patch });
    });
  }

  private async recordScopeError(dir: string, code: string): Promise<void> {
    await this.updateState(dir, {
      lastError: { code, at: new Date(this.now()).toISOString() },
    });
  }

  /**
   * Registers a replica that is ready (pulled at least once, first enable
   * done) and bound to this account, so the resolver uses it. A stopped
   * engine registers nothing: its host has already unregistered its
   * replicas, also when a pass in flight gets here after that.
   */
  private async registerReplica(scope: MemoryScopeRef): Promise<boolean> {
    const dir = this.scopeDir(scope);
    const state = await readMemorySyncState(dir);
    if (
      this.stopped ||
      state === undefined ||
      state === null ||
      state.binding.accountId !== this.options.accountId ||
      !isReady(state)
    ) {
      return false;
    }
    this.options.registry.register({
      accountId: this.options.accountId,
      scope,
      dir,
      binding: state.binding,
      device: {
        deviceId: this.options.device.deviceId,
        label: this.options.device.label,
      },
      onLocalChange: () => {
        this.requestPush();
      },
    });
    return true;
  }

  private async syncScope(
    scope: MemoryScopeRef,
    signal: AbortSignal,
  ): Promise<PassOutcome> {
    const dir = this.scopeDir(scope);
    const key = memoryScopeKey(scope);
    let state = await readMemorySyncState(dir);
    if (state === null) {
      this.options.recordProblem?.({ kind: 'replica_unreadable', code: key });
      return { kind: 'ok' };
    }
    if (state === undefined) {
      const created = await this.createReplica(scope, signal);
      if (created.kind !== 'ok') return created;
      state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return { kind: 'ok' };
    }
    if (state.binding.accountId !== this.options.accountId) {
      this.options.recordProblem?.({
        kind: 'replica_unreadable',
        code: 'binding',
      });
      return { kind: 'ok' };
    }
    if (state.mode === 'deleted_in_cloud') {
      await this.registerReplica(scope);
      await this.refreshScopeStatus(scope);
      return { kind: 'ok' };
    }
    if (state.firstEnable === null && state.cursor === null) {
      // An earlier build created replicas without a pending first enable.
      state = {
        ...state,
        firstEnable: firstEnableStarted(new Date(this.now())),
      };
      await this.updateState(dir, { firstEnable: state.firstEnable });
    }
    const firstEnable = awaitsFirstEnable(state);
    if (firstEnable && (await this.deviceLocalHasMemory(scope))) {
      this.markNeedsFirstEnable(scope);
      return { kind: 'ok' };
    }
    if (state.mode !== 'syncing' && state.mode !== 'repair_needed') {
      await this.updateState(dir, { mode: 'syncing' });
    }
    const pulled = await this.pull(scope, signal);
    if (pulled !== null) return this.scopeOutcome(scope, pulled);
    if (!firstEnable) {
      await this.registerReplica(scope);
    } else if (!(await this.finishFirstEnable(scope))) {
      this.markNeedsFirstEnable(scope);
      return { kind: 'ok' };
    }
    this.checkAborted(signal);
    const pushed = await this.push(scope, signal);
    await this.refreshScopeStatus(scope);
    return pushed === null ? { kind: 'ok' } : this.scopeOutcome(scope, pushed);
  }

  /** What a scope's failure means: scope modes here, the rest engine-wide. */
  private async scopeOutcome(
    scope: MemoryScopeRef,
    failure: MemorySyncFailure,
  ): Promise<PassOutcome> {
    const dir = this.scopeDir(scope);
    switch (failure.kind) {
      case 'scope_deleted':
        await this.updateState(dir, { mode: 'deleted_in_cloud' });
        await this.registerReplica(scope);
        await this.refreshScopeStatus(scope);
        return { kind: 'ok' };
      case 'device_only':
        await this.updateState(dir, { mode: 'device_only' });
        await this.refreshScopeStatus(scope);
        return { kind: 'ok' };
      case 'paused':
        await this.updateState(dir, { mode: 'paused' });
        await this.refreshScopeStatus(scope);
        return { kind: 'halt', state: 'paused', reason: failure.code };
      case 'refused':
        this.options.recordProblem?.({
          kind: 'push_refused',
          code: failure.code,
        });
        await this.recordScopeError(dir, failure.code);
        await this.refreshScopeStatus(scope);
        return { kind: 'ok' };
      default:
        await this.refreshScopeStatus(scope);
        return this.engineOutcome(failure);
    }
  }

  /**
   * Creates the replica of a scope this device has no memory in yet: the
   * cloud scope, its folder bound to it, then its snapshot.
   */
  private async createReplica(
    scope: MemoryScopeRef,
    signal: AbortSignal,
  ): Promise<PassOutcome> {
    if (await this.deviceLocalHasMemory(scope)) {
      this.markNeedsFirstEnable(scope);
      return { kind: 'ok' };
    }
    const resolved = await this.options.transport.resolveScope(
      scope,
      true,
      signal,
    );
    if (!resolved.ok) return this.engineOutcome(resolved.failure);
    this.checkAborted(signal);
    const record = resolved.value.scope;
    const binding: MemoryReplicaBinding = {
      accountId: this.options.accountId,
      scopeId: record.scopeId,
      kind: record.kind,
      projectId: record.projectId,
    };
    await this.ensureAccountFile();
    const dir = this.scopeDir(scope);
    await withMemoryScopeLock(dir, async () => {
      await createReplicaManifest(dir, binding);
      if ((await readMemorySyncState(dir)) === undefined) {
        await writeMemorySyncState(dir, {
          ...initialMemorySyncState(binding, this.options.device.deviceId),
          firstEnable: firstEnableStarted(new Date(this.now())),
        });
      }
    });
    return { kind: 'ok' };
  }

  private async deviceLocalHasMemory(scope: MemoryScopeRef): Promise<boolean> {
    const localDir = this.options.deviceLocalDir(scope);
    return localDir !== null && (await scopeFolderHasMemory(localDir));
  }

  /** Device-local memory exists: merging it is the first-enable flow's job. */
  private markNeedsFirstEnable(scope: MemoryScopeRef): void {
    this.scopeStatus.set(memoryScopeKey(scope), {
      scope,
      mode: 'needs_first_enable',
      queuedOps: 0,
      localOnlyNotes: 0,
      conflicts: 0,
      lastPulledAt: null,
      lastPushedAt: null,
      lastError: null,
    });
  }

  /**
   * Registers a replica created here for the first time, in one critical
   * section under the device-local folder's scope lock, which every writer
   * to that folder holds while it writes: the folder must still hold no
   * memory, otherwise the first enable stays pending (design §17) and the
   * device keeps its device-local memory. A save that waited for the lock
   * finds the scope resolving to the replica. The bare scope lock, unlike
   * `withMemoryWriteLock`, neither backfills the device-local folder nor
   * refuses one a newer build made read-only.
   */
  private async finishFirstEnable(scope: MemoryScopeRef): Promise<boolean> {
    const dir = this.scopeDir(scope);
    const localDir = this.options.deviceLocalDir(scope);
    const finish = async (): Promise<boolean> => {
      if (localDir !== null && (await scopeFolderHasMemory(localDir))) {
        return false;
      }
      await withMemoryWriteLock(dir, async () => {
        const state = await readMemorySyncState(dir);
        if (state === undefined || state === null) return;
        await writeMemorySyncState(dir, {
          ...state,
          firstEnable: {
            ...(state.firstEnable ?? firstEnableStarted(new Date(this.now()))),
            state: 'done',
          },
        });
      });
      return this.registerReplica(scope);
    };
    return localDir === null ? finish() : withMemoryScopeLock(localDir, finish);
  }

  private async ensureAccountFile(): Promise<void> {
    if ((await readMemoryReplicaAccount(this.accountDir)) !== undefined) return;
    await writeMemoryReplicaAccount(this.accountDir, {
      version: 1,
      accountId: this.options.accountId,
      deviceId: this.options.device.deviceId,
      createdAt: new Date(this.now()).toISOString(),
      settingsRevision: this.settings?.revision ?? 0,
    });
  }

  /** Pulls to the head; takes a snapshot when there is no usable cursor. */
  private async pull(
    scope: MemoryScopeRef,
    signal: AbortSignal,
  ): Promise<MemorySyncFailure | null> {
    const dir = this.scopeDir(scope);
    let snapshotTaken = false;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page += 1) {
      this.checkAborted(signal);
      const state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return null;
      if (state.cursor !== null && state.mode !== 'repair_needed') {
        const step = await this.pullPage(
          scope,
          state.binding.scopeId,
          state.cursor,
          signal,
        );
        if (step === 'done') return null;
        if (step !== 'more') return step;
        continue;
      }
      if (snapshotTaken) return { kind: 'retry', code: 'snapshot_repeated' };
      snapshotTaken = true;
      const failure = await this.snapshot(scope, state.binding.scopeId, signal);
      if (failure !== null) {
        return failure.kind === 'snapshot'
          ? { kind: 'retry', code: failure.code }
          : failure;
      }
    }
    return null;
  }

  /**
   * Pulls and applies one page from `fromCursor`. A page that does not
   * continue the replica marks it for a snapshot ('more' then takes it).
   */
  private async pullPage(
    scope: MemoryScopeRef,
    scopeId: string,
    fromCursor: string,
    signal: AbortSignal,
  ): Promise<'done' | 'more' | MemorySyncFailure> {
    const dir = this.scopeDir(scope);
    const needsSnapshot = async (
      problem: MemorySyncProblem,
    ): Promise<'more'> => {
      this.options.recordProblem?.(problem);
      await this.updateState(dir, { mode: 'repair_needed' });
      return 'more';
    };
    const result = await this.options.transport.changesPage(
      scopeId,
      fromCursor,
      signal,
    );
    if (!result.ok) {
      return result.failure.kind === 'snapshot'
        ? needsSnapshot({ kind: 'page_check', code: result.failure.code })
        : result.failure;
    }
    const problem = checkMemoryChangesPage(fromCursor, result.value);
    if (problem !== null)
      return needsSnapshot({ kind: 'page_check', code: problem });
    try {
      await applyMemoryReplicaChanges(
        dir,
        {
          fromCursor,
          nextCursor: result.value.nextCursor,
          changes: result.value.changes,
        },
        this.writeOptions(),
      );
    } catch (error) {
      if (!(error instanceof MemoryReplicaGapError)) throw error;
      return needsSnapshot({ kind: 'replica_gap', code: error.reason });
    }
    if (result.value.changes.length > 0) this.options.onScopeChanged?.(scope);
    return result.value.hasMore ? 'more' : 'done';
  }

  /** Reads every page of a snapshot pinned at one revision and applies it. */
  private async snapshot(
    scope: MemoryScopeRef,
    scopeId: string,
    signal: AbortSignal,
  ): Promise<MemorySyncFailure | null> {
    const documents: MemoryDocument[] = [];
    const pendingNotes: MemoryNoteRecord[] = [];
    let pinned: { revision: number; cursor: string } | null = null;
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page += 1) {
      this.checkAborted(signal);
      const result = await this.options.transport.snapshotPage(
        scopeId,
        pageToken,
        signal,
      );
      if (!result.ok) return result.failure;
      const value = result.value;
      if (
        pinned !== null &&
        (pinned.revision !== value.revision || pinned.cursor !== value.cursor)
      ) {
        this.options.recordProblem?.({
          kind: 'snapshot_inconsistent',
          code: 'pin_moved',
        });
        return { kind: 'retry', code: 'snapshot_inconsistent' };
      }
      pinned = { revision: value.revision, cursor: value.cursor };
      documents.push(...value.documents);
      pendingNotes.push(...value.pendingNotes);
      pageToken = value.nextPageToken;
      if (pageToken === null) break;
    }
    if (pinned === null || pageToken !== null) {
      return { kind: 'retry', code: 'snapshot_incomplete' };
    }
    const dir = this.scopeDir(scope);
    await applyMemoryReplicaSnapshot(
      dir,
      { ...pinned, documents, pendingNotes },
      this.writeOptions(),
    );
    this.options.onScopeChanged?.(scope);
    await this.updateState(dir, { mode: 'syncing' });
    return null;
  }

  /**
   * Sends the scope's outbox in order, one batch at a time. Each batch is
   * taken from the outbox as it is then, under the account's current origin
   * policy, so a note queued during a push is held back like any other.
   * When an answer replays a note the last snapshot kept for the outbox's
   * sake, the scope pulls again afterwards, which settles that note.
   */
  private async push(
    scope: MemoryScopeRef,
    signal: AbortSignal,
  ): Promise<MemorySyncFailure | null> {
    const dir = this.scopeDir(scope);
    let replayedKept = false;
    for (let push = 0; push < MAX_PUSHES_PER_PASS; push += 1) {
      this.checkAborted(signal);
      const state = await readMemorySyncState(dir);
      if (state === undefined || state === null) return null;
      const batch = await takeMemoryPushBatch(
        dir,
        new Set(this.policy?.blockedOriginOrganizationIds ?? []),
      );
      if (batch.length === 0) break;
      const result = await this.options.transport.pushNotes(
        state.binding.scopeId,
        { ops: batch.map(({ op }) => op) },
        signal,
      );
      if (!result.ok) return result.failure;
      const settled = await settleMemoryPush(
        dir,
        batch,
        result.value.results,
        new Date(this.now()),
        result.value.cursor,
      );
      if (settled.snapshotKeptReplayed > 0) replayedKept = true;
      if (settled.rejectedCode !== null) {
        this.options.recordProblem?.({
          kind: 'push_refused',
          code: settled.rejectedCode,
        });
      }
      if (settled.acknowledged + settled.keptLocal === 0) {
        return { kind: 'retry', code: 'push_unacknowledged' };
      }
    }
    return replayedKept ? this.pull(scope, signal) : null;
  }

  private async refreshScopeStatus(scope: MemoryScopeRef): Promise<void> {
    const dir = this.scopeDir(scope);
    const state = await readMemorySyncState(dir).catch(() => null);
    if (state === undefined || state === null) return;
    const queued = await readQueuedMemoryNoteOps(dir, state.binding).catch(
      () => [],
    );
    this.scopeStatus.set(memoryScopeKey(scope), {
      scope,
      mode: state.mode,
      queuedOps: queued.length,
      localOnlyNotes: state.localOnlyNoteIds.length,
      conflicts: state.conflicts.length,
      lastPulledAt: state.lastPulledAt,
      lastPushedAt: state.lastPushedAt,
      lastError:
        state.lastError === null
          ? null
          : { code: state.lastError.code, at: state.lastError.at },
    });
  }
}
