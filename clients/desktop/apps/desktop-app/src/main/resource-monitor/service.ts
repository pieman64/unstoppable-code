import { getHeapStatistics } from 'node:v8';
import { BRAND } from '@canopy/brand/current';
import {
  ExecutionAdmissionError,
  type ExecutionAccountingSnapshot,
  type ExecutionRegistrationHandle,
} from '@canopy/core-runtime';
import {
  IPC_CHANNELS,
  type ResourceGroupId,
  type ResourceMetadata,
  type ResourceMonitorSnapshot,
  type ResourcePressureLevel,
  type ResourceProcessKind,
  type ResourceProcessSnapshot,
} from '@canopy/desktop-shared/types';
import {
  createDesktopInstrumentationOperationKey,
  type DesktopInstrumentationContext,
} from '@canopy/desktop-instrumentation';
import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { getObservabilityService } from '../observability';
import {
  getExecutionAccounting,
  resetExecutionAccountingSamples,
  type DesktopExecutionAccounting,
} from '../execution-accounting';
import { getPerformanceLimits } from '../lib/performance-limits';
import { isRecord } from '../lib/type-guards';
import { sendToWebContents } from '../lib/web-contents-send';

/*
 * The desktop projection of core execution accounting (CAN-4135). Core
 * `ExecutionAccounting` owns admission, leases, registrations, the process
 * table and pressure; this service adds what stays desktop or Phase 5's:
 * chat-turn admission, Codex pool status and idle suspension, managed
 * process telemetry, pressure diagnostics, the sampling cadence that follows
 * window focus, and the renderer broadcast. Every client reads the same
 * accounting through `core.execution.*` (CAN-5080): this projection follows
 * core's sample events, whoever sampled, and `resource-monitor:get-snapshot`
 * reads through the dispatcher.
 */

const DEFAULT_SAMPLE_INTERVAL_MS = 2_000;
/**
 * Sampling runs at the base interval only while the app window is focused.
 * An unfocused/hidden window still gets fresh snapshots (guards and pressure
 * handling keep working) but at this multiple of the base interval, so a
 * backgrounded app is not forking `ps` and waking the renderer every 2s.
 */
const UNFOCUSED_SAMPLE_INTERVAL_MULTIPLIER = 5;
/**
 * Node clamps `setTimeout` delays above 2^31-1 to **1ms**. The unfocused
 * multiplier can push a large `CANOPY_RESOURCE_MONITOR_INTERVAL_MS` override
 * (the Electron specs use 2147483647 to mean "never tick") past that limit,
 * which turned the intended slow cadence into a 1ms real-sample storm that
 * overwrote injected test snapshots (resource-monitor.spec failures on
 * unfocused CI windows). Cap every computed delay at the Node maximum.
 */
const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1;
/**
 * Minimum spacing between idle codex pool suspension sweeps while pressure
 * stays critical. Sweeps are cheap (idle checks decline fast) but each
 * suspended process re-registers observability diagnostics, so once a minute
 * is plenty.
 */
const CODEX_POOL_SUSPEND_ATTEMPT_MIN_INTERVAL_MS = 60_000;
/** Same spacing for releasing idle Claude sessions under critical pressure. */
const CLAUDE_IDLE_RELEASE_ATTEMPT_MIN_INTERVAL_MS =
  CODEX_POOL_SUSPEND_ATTEMPT_MIN_INTERVAL_MS;
/**
 * Broadcasts are skipped while consecutive snapshots are materially
 * unchanged, but never suppressed longer than this, so renderer consumers
 * that surface `sampledAt` freshness cannot go arbitrarily stale.
 */
const MAX_BROADCAST_SILENCE_MS = 30_000;
/** RSS quantization for the material-change signature (32 MiB buckets). */
const RSS_SIGNATURE_BUCKET_BYTES = 32 * 1024 * 1024;
const MANAGED_PROCESS_OPERATION_NAME = 'canopy.managed_process';

interface ResourceMonitorWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, snapshot: ResourceMonitorSnapshot): void;
  };
}
const PRESSURE_RANK: Record<ResourcePressureLevel, number> = {
  unknown: 0,
  ok: 1,
  warning: 2,
  critical: 3,
};

export interface ResourceRegistrationHandle {
  update(update: Partial<ResourceProcessRegistration>): void;
  unregister(): void;
}

export interface ResourceGuardReservation {
  release(): void;
}

export interface ResourceProcessRegistration {
  id: string;
  groupId: ResourceGroupId;
  kind: ResourceProcessKind;
  label: string;
  pid?: number;
  processGroupId?: number;
  startedAt?: string;
  metadata?: ResourceMetadata;
}

type ResourceRegistrationType = 'process' | 'work_item';

interface ChatTurnConcurrencySnapshot {
  activeTurns: number;
  pendingMessages: number;
}

interface CodexPoolResourceSnapshotSummary {
  clientCount: number;
  activeTurnCount: number;
  pid?: number;
}

interface DesktopOverlay {
  chatTurns: ChatTurnConcurrencySnapshot;
  codexPools: ResourceMonitorSnapshot['guards']['codexPools'];
}

interface ActiveManagedProcessOperation {
  operationKey: string;
  registrationType: ResourceRegistrationType;
  registeredAtMs: number;
  initialRegistration: ResourceProcessRegistration;
  handle: ExecutionRegistrationHandle<ResourceMetadata>;
}

function buildManagedProcessTelemetryContext(
  registration: ResourceProcessRegistration,
  registrationType: ResourceRegistrationType,
  status: 'started' | 'completed' | 'abandoned',
  durationMs?: number,
): DesktopInstrumentationContext {
  const metadata = registration.metadata;
  const pipelineMeta = metadata?.type === 'pipeline' ? metadata.pipeline : null;
  const codexMeta = metadata?.type === 'codex-pool' ? metadata.codexPool : null;
  return {
    registration_type: registrationType,
    kind: registration.kind,
    group_id: registration.groupId,
    metadata_type: metadata?.type,
    has_pid: typeof registration.pid === 'number',
    has_process_group_id: typeof registration.processGroupId === 'number',
    has_pipeline_id: pipelineMeta
      ? Boolean(pipelineMeta.pipelineId)
      : undefined,
    has_pipeline_job: pipelineMeta ? Boolean(pipelineMeta.jobId) : undefined,
    has_pipeline_step: pipelineMeta ? Boolean(pipelineMeta.stepId) : undefined,
    pipeline_attempt: pipelineMeta?.attempt,
    pipeline_iteration: pipelineMeta?.iteration,
    codex_pool_pooled: codexMeta?.pooled,
    codex_pool_client_count: codexMeta?.clientCount,
    codex_pool_active_turn_count: codexMeta?.activeTurnCount,
    codex_pool_initialized: codexMeta?.initialized,
    duration_ms: durationMs,
    status,
  };
}

function safelyEmitManagedProcessTelemetry(callback: () => void): void {
  try {
    callback();
  } catch {
    // Telemetry must never affect resource tracking.
  }
}

function isCodexPoolResourceSnapshotSummary(
  value: unknown,
): value is CodexPoolResourceSnapshotSummary {
  if (!isRecord(value)) {
    return false;
  }
  const { clientCount, activeTurnCount, pid } = value;
  return (
    typeof clientCount === 'number' &&
    typeof activeTurnCount === 'number' &&
    (pid === undefined || typeof pid === 'number')
  );
}

export class ResourceGuardError extends Error {
  readonly code = 'resource-guard-blocked';

  constructor(message: string) {
    super(message);
    this.name = 'ResourceGuardError';
  }
}

/**
 * Material-change signature for renderer broadcasts. CPU is rounded to whole
 * percent and RSS quantized to 32 MiB buckets so measurement jitter on an
 * otherwise-quiet system does not defeat the skip; everything the renderer
 * renders structurally (pressure, guards, group/process rows) participates.
 * `sampledAt` is deliberately excluded — it changes every sample.
 */
function buildBroadcastSignature(snapshot: ResourceMonitorSnapshot): string {
  const signatureOfProcess = (process: ResourceProcessSnapshot): unknown[] => [
    process.id,
    process.kind,
    process.pid ?? null,
    process.status,
    Math.round(process.cpuPercent),
    Math.round(process.memoryRssBytes / RSS_SIGNATURE_BUCKET_BYTES),
    process.processCount,
    (process.children ?? []).map(signatureOfProcess),
  ];
  return JSON.stringify([
    snapshot.pressure.level,
    snapshot.pressure.reasons,
    snapshot.processCount,
    Math.round(snapshot.cpuPercent),
    Math.round(snapshot.memoryRssBytes / RSS_SIGNATURE_BUCKET_BYTES),
    snapshot.guards,
    snapshot.error ?? null,
    snapshot.groups.map((group) => [
      group.id,
      group.processCount,
      Math.round(group.cpuPercent),
      Math.round(group.memoryRssBytes / RSS_SIGNATURE_BUCKET_BYTES),
      group.items.map(signatureOfProcess),
    ]),
  ]);
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function chatGuardMessage(maxConcurrentTurns: number): string {
  return `${BRAND.displayName} is already running ${String(maxConcurrentTurns)} chat turns. Wait for one to finish before starting another.`;
}

function pipelineGuardMessage(error: ExecutionAdmissionError): string {
  return error.reason === 'limit'
    ? `${BRAND.displayName} is already running ${String(error.maxActive)} workflow executions. Wait for one to finish before starting another workflow.`
    : `${BRAND.displayName} is under high memory pressure. Stop an active chat or workflow execution before starting another workflow.`;
}

function readMaxConcurrentChatTurns(): number | null {
  return getPerformanceLimits().maxActiveChatTurns;
}

export class ResourceMonitorService {
  private readonly accounting: DesktopExecutionAccounting =
    getExecutionAccounting();
  private readonly activeOperations = new Map<
    string,
    ActiveManagedProcessOperation
  >();
  private timer: NodeJS.Timeout | null = null;
  private getWindow: (() => ResourceMonitorWindow | null) | null = null;
  private sampling = false;
  private snapshot: ResourceMonitorSnapshot;
  private lastPersistedPressureLevel: ResourcePressureLevel = 'ok';
  private lastCodexPoolSuspendAttemptAtMs = 0;
  private lastClaudeIdleReleaseAttemptAtMs = 0;
  private monitoringActive = false;
  private lastBroadcastSignature: string | null = null;
  private lastBroadcastAtMs = 0;
  private pendingChatTurnStartCount = 0;
  private lastAccounted: ExecutionAccountingSnapshot<ResourceMetadata>;
  private lastOverlay: DesktopOverlay = {
    chatTurns: { activeTurns: 0, pendingMessages: 0 },
    codexPools: { activeConnections: 0, liveProcesses: 0, activeTurns: 0 },
  };
  /** Projections run one at a time, in sample order. */
  private projectionChain: Promise<unknown> = Promise.resolve();
  private readonly projections = new WeakMap<
    ExecutionAccountingSnapshot<ResourceMetadata>,
    Promise<ResourceMonitorSnapshot>
  >();
  private unsubscribeAccounting: (() => void) | null = null;

  constructor() {
    this.lastAccounted = this.accounting.getSnapshot();
    this.snapshot = this.project(this.lastAccounted, this.lastOverlay);
  }

  start(getWindow: () => ResourceMonitorWindow | null): void {
    this.getWindow = getWindow;
    // Core samples taken for any client reach this projection too.
    this.unsubscribeAccounting ??= this.accounting.subscribe((accounted) => {
      void this.applyCoreSample(accounted).catch(() => {});
    });
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (this.timer !== null || this.monitoringActive) {
      return;
    }
    this.monitoringActive = true;
    const baseInterval =
      readPositiveIntegerEnv('CANOPY_RESOURCE_MONITOR_INTERVAL_MS') ??
      DEFAULT_SAMPLE_INTERVAL_MS;
    const scheduleNext = (): void => {
      if (!this.monitoringActive) {
        return;
      }
      // Focused window → base cadence; unfocused/hidden/destroyed window →
      // slowed cadence. Delay is re-evaluated every tick, so refocusing
      // recovers the fast cadence within one slow interval.
      const delay = Math.min(
        this.isWindowFocused()
          ? baseInterval
          : baseInterval * UNFOCUSED_SAMPLE_INTERVAL_MULTIPLIER,
        MAX_TIMEOUT_DELAY_MS,
      );
      this.timer = setTimeout((): void => {
        this.timer = null;
        void this.sampleNow()
          .catch(() => {})
          .finally((): void => {
            scheduleNext();
          });
      }, delay);
      this.timer.unref?.();
    };
    void this.sampleNow()
      .catch(() => {})
      .finally((): void => {
        scheduleNext();
      });
  }

  private isWindowFocused(): boolean {
    const window = this.getWindow?.() ?? null;
    if (
      !window ||
      typeof window.isDestroyed !== 'function' ||
      window.isDestroyed() ||
      typeof window.isFocused !== 'function'
    ) {
      return false;
    }
    return window.isFocused();
  }

  dispose(): void {
    this.monitoringActive = false;
    this.unsubscribeAccounting?.();
    this.unsubscribeAccounting = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.getWindow = null;
    this.lastBroadcastSignature = null;
    this.lastBroadcastAtMs = 0;
    this.activeOperations.forEach(
      (operation: ActiveManagedProcessOperation, id: string) => {
        const current = this.currentRegistration(id, operation);
        const durationMs = Math.max(0, Date.now() - operation.registeredAtMs);
        safelyEmitManagedProcessTelemetry(() => {
          failDesktopOperation(MANAGED_PROCESS_OPERATION_NAME, 'abandoned', {
            operationKey: operation.operationKey,
            context: buildManagedProcessTelemetryContext(
              current,
              operation.registrationType,
              'abandoned',
              durationMs,
            ),
          });
        });
      },
    );
    this.activeOperations.clear();
    this.pendingChatTurnStartCount = 0;
    resetExecutionAccountingSamples();
  }

  getSnapshot(): ResourceMonitorSnapshot {
    return this.snapshot;
  }

  /**
   * The resource monitor snapshot for a core sample read through
   * `core.execution.status.get`: the current projection when it is that
   * sample's, otherwise that sample with the last desktop guard counts.
   */
  snapshotFor(
    accounted: ExecutionAccountingSnapshot<ResourceMetadata>,
  ): ResourceMonitorSnapshot {
    return accounted === this.lastAccounted
      ? this.snapshot
      : this.project(accounted, this.lastOverlay);
  }

  registerProcess(
    registration: ResourceProcessRegistration,
  ): ResourceRegistrationHandle {
    return this.register(registration, 'process');
  }

  registerWorkItem(
    registration: ResourceProcessRegistration,
  ): ResourceRegistrationHandle {
    return this.register(registration, 'work_item');
  }

  async assertCanStartChatTurn(): Promise<void> {
    const reservation = await this.reserveChatTurnStart();
    reservation.release();
  }

  /** Chat-turn admission stays here until Phase 5 reads core accounting. */
  async reserveChatTurnStart(): Promise<ResourceGuardReservation> {
    const chatTurns = await this.readChatTurnConcurrencySnapshot();
    const maxConcurrentTurns = readMaxConcurrentChatTurns();
    const activeOrQueuedTurns =
      chatTurns.activeTurns +
      chatTurns.pendingMessages +
      this.pendingChatTurnStartCount;
    if (
      maxConcurrentTurns !== null &&
      activeOrQueuedTurns >= maxConcurrentTurns
    ) {
      this.recordGuardBlocked('resource_guard_blocked_chat');
      throw new ResourceGuardError(chatGuardMessage(maxConcurrentTurns));
    }
    if (this.accounting.isMemoryGuardBlocked()) {
      this.recordGuardBlocked('resource_guard_blocked_chat');
      throw new ResourceGuardError(
        `${BRAND.displayName} is under high memory pressure. Wait for active work to finish before starting another chat.`,
      );
    }
    this.pendingChatTurnStartCount += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.pendingChatTurnStartCount = Math.max(
          0,
          this.pendingChatTurnStartCount - 1,
        );
      },
    };
  }

  assertCanStartPipelineExecution(): void {
    const reservation = this.reservePipelineExecutionStart();
    reservation.release();
  }

  /** Core pipeline admission, with the desktop's refusal copy and diagnostic. */
  reservePipelineExecutionStart(): ResourceGuardReservation {
    try {
      return this.accounting.admit('pipeline');
    } catch (error) {
      if (!(error instanceof ExecutionAdmissionError)) {
        throw error;
      }
      this.recordGuardBlocked('resource_guard_blocked_pipeline');
      throw new ResourceGuardError(pipelineGuardMessage(error));
    }
  }

  async sampleNow(): Promise<ResourceMonitorSnapshot> {
    if (this.sampling) {
      return this.snapshot;
    }
    this.sampling = true;
    try {
      return await this.applyCoreSample(await this.accounting.sample());
    } finally {
      this.sampling = false;
    }
  }

  /** Projects one core sample once, after the samples before it. */
  private applyCoreSample(
    accounted: ExecutionAccountingSnapshot<ResourceMetadata>,
  ): Promise<ResourceMonitorSnapshot> {
    const existing = this.projections.get(accounted);
    if (existing) return existing;
    const projected = this.projectionChain
      .catch(() => {})
      .then(async (): Promise<ResourceMonitorSnapshot> => {
        const overlay: DesktopOverlay = {
          chatTurns: await this.readChatTurnConcurrencySnapshot(),
          codexPools: await this.readCodexPoolSummary(),
        };
        const snapshot = this.project(accounted, overlay);
        this.lastAccounted = accounted;
        this.lastOverlay = overlay;
        this.snapshot = snapshot;
        this.broadcast(snapshot);
        await this.handlePressureTransition(snapshot);
        return snapshot;
      });
    this.projections.set(accounted, projected);
    this.projectionChain = projected;
    return projected;
  }

  private project(
    accounted: ExecutionAccountingSnapshot<ResourceMetadata>,
    desktop: DesktopOverlay,
  ): ResourceMonitorSnapshot {
    const maxConcurrentTurns = readMaxConcurrentChatTurns();
    const pipelines = accounted.families.pipeline;
    return {
      version: 1,
      sampledAt: accounted.sampledAt,
      appPid: accounted.rootPid,
      cpuPercent: accounted.cpuPercent,
      memoryRssBytes: accounted.memoryRssBytes,
      processCount: accounted.processCount,
      pressure: accounted.pressure,
      groups: accounted.groups,
      guards: {
        chatTurns: {
          activeTurns: desktop.chatTurns.activeTurns,
          pendingMessages: desktop.chatTurns.pendingMessages,
          maxConcurrentTurns,
          blocked:
            (maxConcurrentTurns !== null &&
              desktop.chatTurns.activeTurns +
                desktop.chatTurns.pendingMessages +
                this.pendingChatTurnStartCount >=
                maxConcurrentTurns) ||
            accounted.memoryGuardBlocked,
        },
        pipelines: {
          activeExecutions: pipelines.active,
          maxConcurrentExecutions: pipelines.maxActive,
          blocked: pipelines.blocked,
        },
        codexPools: desktop.codexPools,
      },
      ...(accounted.error ? { error: accounted.error } : {}),
    };
  }

  private currentRegistration(
    id: string,
    operation: ActiveManagedProcessOperation,
  ): ResourceProcessRegistration {
    return this.accounting.getRegistration(id) ?? operation.initialRegistration;
  }

  private register(
    registration: ResourceProcessRegistration,
    registrationType: ResourceRegistrationType,
  ): ResourceRegistrationHandle {
    const registeredAtMs = Date.now();
    const operationKey = createDesktopInstrumentationOperationKey(
      `managed-process:${registration.id}:${registeredAtMs}`,
    );
    const initialRegistration = {
      ...registration,
      // Default startedAt to registration time so snapshot consumers always see
      // a value, matching the telemetry duration anchor.
      startedAt:
        registration.startedAt ?? new Date(registeredAtMs).toISOString(),
    };
    const handle = this.accounting.register(initialRegistration);
    this.activeOperations.set(registration.id, {
      operationKey,
      registrationType,
      registeredAtMs,
      initialRegistration,
      handle,
    });
    safelyEmitManagedProcessTelemetry(() => {
      startDesktopOperation(MANAGED_PROCESS_OPERATION_NAME, {
        operationKey,
        context: buildManagedProcessTelemetryContext(
          initialRegistration,
          registrationType,
          'started',
        ),
      });
    });
    return {
      update: (update): void => {
        if (!this.activeOperations.has(registration.id)) {
          return;
        }
        handle.update(update);
      },
      unregister: (): void => {
        const operation = this.activeOperations.get(registration.id);
        if (!operation) {
          return;
        }
        const current = this.currentRegistration(registration.id, operation);
        const durationMs = Math.max(0, Date.now() - operation.registeredAtMs);
        safelyEmitManagedProcessTelemetry(() => {
          succeedDesktopOperation(MANAGED_PROCESS_OPERATION_NAME, {
            operationKey: operation.operationKey,
            context: buildManagedProcessTelemetryContext(
              current,
              operation.registrationType,
              'completed',
              durationMs,
            ),
          });
        });
        this.activeOperations.delete(registration.id);
        operation.handle.unregister();
      },
    };
  }

  private async readCodexPoolSummary(): Promise<{
    activeConnections: number;
    liveProcesses: number;
    activeTurns: number;
  }> {
    let snapshots: CodexPoolResourceSnapshotSummary[] = [];
    try {
      const { getCodexRuntimeService } =
        await import('../codex/runtime-service');
      snapshots = getCodexRuntimeService()
        .admin()
        .getResourceSnapshots()
        .filter(isCodexPoolResourceSnapshotSummary);
    } catch {
      snapshots = [];
    }
    return {
      activeConnections: snapshots.reduce(
        (total, snapshot) => total + snapshot.clientCount,
        0,
      ),
      liveProcesses: snapshots.filter(
        (snapshot) => typeof snapshot.pid === 'number',
      ).length,
      activeTurns: snapshots.reduce(
        (total, snapshot) => total + snapshot.activeTurnCount,
        0,
      ),
    };
  }

  private async readChatTurnConcurrencySnapshot(): Promise<ChatTurnConcurrencySnapshot> {
    try {
      const sessionManager = await import('../agents/session-manager');
      if (typeof sessionManager.getChatTurnConcurrencySnapshot === 'function') {
        return sessionManager.getChatTurnConcurrencySnapshot();
      }
    } catch {
      // Test mocks and early shutdown paths may omit session-manager helpers.
    }
    return { activeTurns: 0, pendingMessages: 0 };
  }

  private broadcast(snapshot: ResourceMonitorSnapshot): void {
    const window = this.getWindow?.() ?? null;
    if (
      !window ||
      typeof window.isDestroyed !== 'function' ||
      window.isDestroyed() ||
      typeof window.webContents.isDestroyed !== 'function' ||
      window.webContents.isDestroyed() ||
      typeof window.webContents.send !== 'function'
    ) {
      return;
    }
    // Skip renderer wakeups while the snapshot is materially unchanged (a
    // quiet system produces identical signatures sample after sample), with a
    // bounded staleness window so freshness displays keep moving.
    const signature = buildBroadcastSignature(snapshot);
    const now = Date.now();
    if (
      signature === this.lastBroadcastSignature &&
      now - this.lastBroadcastAtMs < MAX_BROADCAST_SILENCE_MS
    ) {
      return;
    }
    this.lastBroadcastSignature = signature;
    this.lastBroadcastAtMs = now;
    sendToWebContents(
      window.webContents,
      IPC_CHANNELS.resourceMonitorSnapshot,
      snapshot,
    );
  }

  private async handlePressureTransition(
    snapshot: ResourceMonitorSnapshot,
  ): Promise<void> {
    const previous = this.lastPersistedPressureLevel;
    const current = snapshot.pressure.level;
    this.lastPersistedPressureLevel = current;
    // Reclaim idle Codex app-server processes whenever pressure is critical
    // and the dedicated timeout-bypass preference is enabled. Sustained
    // critical pressure is included, but throttled so a stuck-critical system
    // does not sweep the pool on every 2s sample. This remains independent of
    // `isMemoryPressureGuardEnabled()`, which gates blocking new work.
    let suspendedCodexPoolCount = 0;
    if (
      current === 'critical' &&
      getPerformanceLimits()
        .bypassCodexAppServerIdleTimeoutUnderCriticalPressure &&
      Date.now() - this.lastCodexPoolSuspendAttemptAtMs >=
        CODEX_POOL_SUSPEND_ATTEMPT_MIN_INTERVAL_MS
    ) {
      this.lastCodexPoolSuspendAttemptAtMs = Date.now();
      try {
        const { getCodexRuntimeService } =
          await import('../codex/runtime-service');
        suspendedCodexPoolCount = getCodexRuntimeService()
          .admin()
          .suspendIdleWorkersForMemoryPressure();
      } catch {
        suspendedCodexPoolCount = 0;
      }
    }
    // Idle Claude-harness sessions have no app-server pool; release their
    // processes.
    // Ungated by the Codex bypass preference, whose copy names Codex only.
    let idleClaudeSessionReleaseCount = 0;
    if (
      current === 'critical' &&
      Date.now() - this.lastClaudeIdleReleaseAttemptAtMs >=
        CLAUDE_IDLE_RELEASE_ATTEMPT_MIN_INTERVAL_MS
    ) {
      this.lastClaudeIdleReleaseAttemptAtMs = Date.now();
      try {
        const { releaseIdleClaudeSessionsForMemoryPressure } =
          await import('../agents/session-manager');
        idleClaudeSessionReleaseCount =
          releaseIdleClaudeSessionsForMemoryPressure();
      } catch {
        idleClaudeSessionReleaseCount = 0;
      }
    }
    if (PRESSURE_RANK[current] <= PRESSURE_RANK[previous]) {
      return;
    }
    if (current === 'warning') {
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: snapshot.sampledAt,
        kind: 'resource_pressure_warning',
        memoryRssBytes: snapshot.memoryRssBytes,
        cpuPercent: snapshot.cpuPercent,
        pressureLevel: snapshot.pressure.level,
        processCount: snapshot.processCount,
      });
      return;
    }
    if (current === 'critical') {
      const memory = process.memoryUsage();
      const heap = getHeapStatistics();
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: snapshot.sampledAt,
        kind: 'resource_pressure_critical',
        mainHeapUsedBytes: memory.heapUsed,
        mainHeapTotalBytes: memory.heapTotal,
        mainHeapLimitBytes: heap.heap_size_limit,
        mainRssBytes: memory.rss,
        mainExternalBytes: memory.external,
        mainArrayBufferBytes: memory.arrayBuffers,
        memoryRssBytes: snapshot.memoryRssBytes,
        cpuPercent: snapshot.cpuPercent,
        pressureLevel: snapshot.pressure.level,
        processCount: snapshot.processCount,
        suspendedCodexPoolCount,
        idleClaudeSessionReleaseCount,
      });
    }
  }

  private recordGuardBlocked(
    kind: 'resource_guard_blocked_chat' | 'resource_guard_blocked_pipeline',
  ): void {
    const snapshot = this.getSnapshot();
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind,
      memoryRssBytes: snapshot.memoryRssBytes,
      cpuPercent: snapshot.cpuPercent,
      pressureLevel: snapshot.pressure.level,
      processCount: snapshot.processCount,
      activeChatTurnCount: snapshot.guards.chatTurns.activeTurns,
      activePipelineExecutionCount: snapshot.guards.pipelines.activeExecutions,
    });
  }
}
